/**
 * Automatic scene checks (pure math, works without a browser): things a director or AD would
 * flag — bodies walking through furniture, floating or sunken objects, cameras inside walls,
 * shots that show nobody or hide their subject, cuts that cross the 180° line or jump-cut, and
 * timing slips. Each issue carries ids, the time range and a concrete hint.
 */
import { getAssetType, isCharacterType, localAnchor } from './assetTypes.ts';
import { cameraView, describeScene, type CameraView, type ObjectView } from './describe.ts';
import { cameraObjects, evaluateCamera, evaluateObject } from './evaluate.ts';
import { roundTo, transformPoint, wrapDeg, type Vec3 } from './math.ts';
import type { Project } from './schema.ts';
import { footprintDistance, footprintOf, footprintsOverlap, pointInBox, sceneGeometry, segmentHitsBox, type SolidBox } from './solids.ts';
import { groundHeightAt } from './terrain.ts';

export const ISSUE_CODES = [
  'OVERLAP',
  'FLOATING',
  'BELOW_GROUND',
  'CAMERA_INSIDE',
  'CAMERA_UNDERGROUND',
  'EMPTY_SHOT',
  'SUBJECT_HIDDEN',
  'CROSSED_LINE',
  'JUMP_CUT',
  'SHORT_SHOT',
  'SAME_CAMERA_CUT',
  'CUT_AFTER_END',
  'KEYS_AFTER_END',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface SceneIssue {
  code: IssueCode;
  severity: 'warning' | 'info';
  message: string;
  ids: string[];
  /** First time (s) the problem occurs. */
  t: number;
  /** Last sampled time it still occurs (ranges). */
  until?: number;
  hint?: string;
}

export interface CheckOptions {
  /** Sampling step for physical checks (seconds, default 0.25). */
  step?: number;
  /** Only run these checks. */
  codes?: readonly string[];
}

export interface CheckResult {
  issues: SceneIssue[];
  counts: { warning: number; info: number };
}

/** Furniture you may sit or lie on (or in): no overlap reported for seated / lying characters. */
const SEATS = new Set(['chair', 'sofa', 'bench', 'bed', 'car']);
const SEATED = new Set(['sit', 'lie']);
const NOT_GROUNDED = new Set(['ground', 'hills', 'water', 'road', 'camera', 'target', 'mark', 'plane']);

const fmt = (t: number) => `${roundTo(t, 2)}s`;
const range = (a: number, b?: number) => (b === undefined || b - a < 1e-6 ? `at ${fmt(a)}` : `${fmt(a)}–${fmt(b)}`);
const m = (v: number) => `${roundTo(v, 2)} m`;

interface Shot {
  index: number;
  camera: string;
  t0: number;
  t1: number;
}

/** The edit as shots (one per cut, or the first camera for the whole duration). */
export function shotsOf(project: Project): Shot[] {
  const d = project.settings.duration;
  const cuts = [...project.cuts].filter((c) => c.t < d).sort((a, b) => a.t - b.t);
  if (!cuts.length) {
    const first = cameraObjects(project)[0];
    return first ? [{ index: 1, camera: first.id, t0: 0, t1: d }] : [];
  }
  if (cuts[0]!.t > 0) cuts.unshift({ t: 0, camera: cuts[0]!.camera });
  return cuts.map((c, i) => ({ index: i + 1, camera: c.camera, t0: c.t, t1: cuts[i + 1]?.t ?? d }));
}

class Collector {
  private map = new Map<string, SceneIssue & { worst: number }>();

  /** Record that a condition holds at time t; ranges merge per key, keeping the worst value. */
  hit(key: string, t: number, worst: number, make: () => Omit<SceneIssue, 't' | 'until'>, describe: (i: SceneIssue, worst: number) => string) {
    const cur = this.map.get(key);
    if (cur) {
      cur.until = t;
      if (worst > cur.worst) cur.worst = worst;
      cur.message = describe(cur, cur.worst);
      return;
    }
    const base = { ...make(), t, until: t, worst } as SceneIssue & { worst: number };
    base.message = describe(base, worst);
    this.map.set(key, base);
  }

  add(issue: SceneIssue) {
    this.map.set(`${issue.code}|${issue.ids.join(',')}|${issue.t}`, { ...issue, worst: 0 });
  }

  list(): SceneIssue[] {
    return [...this.map.values()].map(({ worst: _w, ...i }) => (i.until !== undefined && i.until - i.t < 1e-6 ? { ...i, until: undefined } : i));
  }
}

function sampleTimes(project: Project, step: number): number[] {
  const d = project.settings.duration;
  const animated = project.objects.some((o) => Object.values(o.tracks).some((tr) => tr.keys.length > 1) || !!o.camera?.follow);
  if (!animated) return [0];
  const out: number[] = [];
  for (let t = 0; t <= d + 1e-9; t += step) out.push(roundTo(t, 4));
  return out;
}

function physicalChecks(project: Project, times: number[], want: (c: IssueCode) => boolean, out: Collector) {
  const hasHills = project.objects.some((o) => o.type === 'hills' && o.visible);
  for (const t of times) {
    const { boxes, bodies, evals } = sceneGeometry(project, t);
    const ground = (x: number, z: number) => (hasHills ? groundHeightAt(project, x, z) : 0);

    if (want('OVERLAP')) {
      for (const b of bodies) {
        if (b.pose === 'lie') continue;
        for (const box of boxes) {
          if (!box.body || (SEATED.has(b.pose) && SEATS.has(box.type))) continue;
          // Held or worn items (a bag, glasses) start well above the feet: not an obstacle.
          if (box.y0 > b.y0 + 0.3) continue;
          if (Math.min(b.y1, box.y1) - Math.max(b.y0, box.y0) < 0.05) continue;
          const dist = footprintDistance(box, b.x, b.z);
          // Seated on / in it (a scooter made of boxes, a car seat).
          if (b.pose === 'sit' && dist < 0 && box.y0 <= b.y0 + 0.06) continue;
          const pen = b.r - dist;
          if (pen <= 0.03) continue;
          out.hit(`OVERLAP|${b.id}|${box.id}`, t, pen, () => ({
            code: 'OVERLAP',
            severity: 'warning',
            message: '',
            ids: [b.id, box.id],
            hint: isMoving(project, b.id)
              ? `${b.id}'s path goes through ${box.id}: adjust its waypoints (object.followPath / object.moveTo) or move ${box.id}.`
              : `Move it clear, e.g. {"cmd":"object.place","args":{"id":"${b.id}","relativeTo":"${box.id}","side":"front"}}`,
          }), (i, w) => `${b.id} intersects ${box.id} (${m(w)} deep) ${range(i.t, i.until)}`);
        }
      }
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i]!;
          const c = bodies[j]!;
          if (a.pose === 'lie' || c.pose === 'lie') continue;
          if (Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0) < 0.2) continue;
          const pen = a.r + c.r - Math.hypot(a.x - c.x, a.z - c.z);
          if (pen <= 0.05) continue;
          out.hit(`OVERLAP|${a.id}|${c.id}`, t, pen, () => ({
            code: 'OVERLAP',
            severity: 'warning',
            message: '',
            ids: [a.id, c.id],
            hint: `Give them at least ${m(a.r + c.r + 0.1)} between their positions, e.g. {"cmd":"object.place","args":{"id":"${c.id}","relativeTo":"${a.id}","side":"front","distance":0.6}}`,
          }), (iss, w) => `${a.id} and ${c.id} stand inside each other (${m(w)} deep) ${range(iss.t, iss.until)}`);
        }
      }
    }

    if (want('FLOATING') || want('BELOW_GROUND')) {
      const cityBlocks = project.objects.filter((o) => o.type === 'cityBlock' && evals.get(o.id)?.visible);
      for (const o of project.objects) {
        const def = getAssetType(o.type);
        if (!def?.groundBased || NOT_GROUNDED.has(o.type) || def.category === 'helper') continue;
        const e = evals.get(o.id);
        if (!e || !e.visible) continue;
        const own = boxes.filter((b) => b.id === o.id);
        const isChar = isCharacterType(o.type);
        const base = own.length ? Math.min(...own.map((b) => b.y0)) : e.position[1] + def.bounds(e.params).min[1] * e.scale[1];
        const [x, , z] = e.position;
        const g = ground(x, z);
        let support = g;
        // Held, worn or attached (touching a character, or built into another object): skip.
        if (!isChar && own.some((ob) => bodies.some((bd) => footprintDistance(ob, bd.x, bd.z) < bd.r + 0.05 && Math.min(ob.y1, bd.y1) - Math.max(ob.y0, bd.y0) > -0.05))) continue;
        if (!isChar && own.some((ob) => boxes.some((b) => b.id !== o.id && Math.min(ob.y1, b.y1) - Math.max(ob.y0, b.y0) > 0.02 && footprintsOverlap(ob, b, -0.01)))) continue;
        for (const box of boxes) {
          if (box.id === o.id) continue;
          // Characters stand on what is under their feet; objects rest on anything under their footprint.
          if (box.y1 > base + 0.06 && box.type !== 'stairs' && !(isChar && String(e.params.pose) === 'sit')) continue;
          const under = isChar ? footprintDistance(box, x, z) < -0.02 : own.some((ob) => footprintsOverlap(ob, box, -0.01));
          if (!under) continue;
          if (box.type === 'stairs' && base >= box.y0 - 0.06 && base <= box.y1 + 0.06) support = Math.max(support, base);
          else if (isChar && String(e.params.pose) === 'sit' && box.y0 <= base + 0.06) support = Math.max(support, base);
          else if (box.y1 <= base + 0.06) support = Math.max(support, box.y1);
        }
        // City blocks: sidewalks and lots are raised 0.15 m above the streets.
        for (const cb of cityBlocks) {
          const f = footprintOf(cb, t);
          if (!f || base < 0.09) continue;
          if (Math.abs(x - f.cx) <= f.hx && Math.abs(z - f.cz) <= f.hz) support = Math.max(support, Math.min(base, f.base + 0.15));
        }
        for (const r of project.objects) {
          if (r.type !== 'room' || r.id === o.id) continue;
          const re = evals.get(r.id);
          if (!re?.visible) continue;
          const w = Number(re.params.width ?? 6) / 2;
          const d = Number(re.params.depth ?? 5) / 2;
          const local = [x - re.position[0], z - re.position[2]];
          const yawRad = (-re.rotation[1] * Math.PI) / 180;
          const lx = local[0]! * Math.cos(yawRad) + local[1]! * Math.sin(yawRad);
          const lz = -local[0]! * Math.sin(yawRad) + local[1]! * Math.cos(yawRad);
          if (Math.abs(lx) <= w * re.scale[0] && Math.abs(lz) <= d * re.scale[2] && re.position[1] <= base + 0.06) support = Math.max(support, re.position[1]);
        }
        if (want('FLOATING') && base - support > 0.05) {
          out.hit(`FLOATING|${o.id}`, t, base - support, () => ({
            code: 'FLOATING',
            severity: 'warning',
            message: '',
            ids: [o.id],
            hint: `Set its position y to ${roundTo(support, 2)}, or rest it on something: {"cmd":"object.place","args":{"id":"${o.id}","on":"<id>"}}`,
          }), (i, w) => `${o.id} floats ${m(w)} above the surface below it ${range(i.t, i.until)}`);
        }
        if (want('BELOW_GROUND') && base < g - 0.05) {
          out.hit(`BELOW_GROUND|${o.id}`, t, g - base, () => ({
            code: 'BELOW_GROUND',
            severity: 'warning',
            message: '',
            ids: [o.id],
            hint: `Use ground_height for [${roundTo(x, 2)}, ${roundTo(z, 2)}] and set position y to it.`,
          }), (i, w) => `${o.id} is ${m(w)} below the ${hasHills ? 'terrain' : 'ground'} ${range(i.t, i.until)}`);
        }
      }
    }

    if (want('CAMERA_INSIDE') || want('CAMERA_UNDERGROUND')) {
      for (const c of cameraObjects(project)) {
        const p = evaluateCamera(project, c, t).position;
        if (want('CAMERA_INSIDE')) {
          const box = boxes.find((b) => b.view && pointInBox(b, p, -0.02));
          const body = bodies.find((b) => Math.hypot(p[0] - b.x, p[2] - b.z) < b.r && p[1] > b.y0 && p[1] < b.y1);
          const inside = box?.id ?? body?.id;
          if (inside) {
            out.hit(`CAMERA_INSIDE|${c.id}|${inside}`, t, 1, () => ({
              code: 'CAMERA_INSIDE',
              severity: 'warning',
              message: '',
              ids: [c.id, inside],
              hint: `Move ${c.id} out of ${inside} (camera.frame re-places it), or hide ${inside} during this shot.`,
            }), (i) => `${c.id} is inside ${inside} ${range(i.t, i.until)}, so its view is blocked`);
          }
        }
        if (want('CAMERA_UNDERGROUND')) {
          const g = ground(p[0], p[2]);
          if (p[1] < g + 0.02) {
            out.hit(`CAMERA_UNDERGROUND|${c.id}`, t, g - p[1], () => ({
              code: 'CAMERA_UNDERGROUND',
              severity: 'warning',
              message: '',
              ids: [c.id],
              hint: `Raise ${c.id} above y = ${roundTo(g + 0.1, 2)}.`,
            }), (i, w) => `${c.id} is ${m(Math.max(w, 0))} below the ${hasHills ? 'terrain' : 'ground'} ${range(i.t, i.until)}`);
          }
        }
      }
    }
  }
}

function isMoving(project: Project, id: string): boolean {
  const o = project.objects.find((x) => x.id === id);
  return !!o && (o.tracks.position?.keys.length ?? 0) > 1;
}

const typeOf = (project: Project, id: string) => project.objects.find((o) => o.id === id)?.type ?? '';

function characters(project: Project, view: CameraView): ObjectView[] {
  return view.objects.filter((v) => isCharacterType(typeOf(project, v.id))).sort((a, b) => b.coverage - a.coverage);
}

/** The shot's subject: the lookAt target if it is a character in frame, else the biggest non-foreground character. */
function subjectOf(project: Project, cameraId: string, chars: ObjectView[]): ObjectView | undefined {
  const target = project.objects.find((o) => o.id === cameraId)?.camera?.lookAt?.target;
  return chars.find((v) => v.id === target) ?? chars.find((v) => !v.foreground) ?? chars[0];
}

function hiddenBy(project: Project, cameraId: string, subjectId: string, t: number, boxes: SolidBox[]): string | null {
  const cam = project.objects.find((o) => o.id === cameraId)!;
  const subject = project.objects.find((o) => o.id === subjectId)!;
  const c = evaluateCamera(project, cam, t).position;
  const e = evaluateObject(subject, t);
  const pts: Vec3[] = (['head', 'chest', 'center'] as const).map((a) => transformPoint(localAnchor(subject.type, e.params, a), e.position, e.rotation, e.scale));
  const counts = new Map<string, number>();
  let blocked = 0;
  for (const p of pts) {
    // Ignore what the subject stands or sits in (a sofa, a car), which would otherwise hide its own torso.
    const hit = boxes.find((b) => b.view && b.id !== subjectId && footprintDistance(b, e.position[0], e.position[2]) >= 0 && segmentHitsBox(b, c, p));
    if (hit) {
      blocked++;
      counts.set(hit.id, (counts.get(hit.id) ?? 0) + 1);
    }
  }
  if (blocked < 2) return null;
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

function editingChecks(project: Project, want: (c: IssueCode) => boolean, out: Collector) {
  const d = project.settings.duration;
  const shots = shotsOf(project);
  const hasCharacters = project.objects.some((o) => isCharacterType(o.type) && o.visible);
  const label = (s: Shot) => `shot ${s.index} (${s.camera}, ${fmt(s.t0)}–${fmt(s.t1)})`;

  for (const c of project.cuts) {
    if (want('CUT_AFTER_END') && c.t >= d) {
      out.add({ code: 'CUT_AFTER_END', severity: 'warning', message: `The cut at ${fmt(c.t)} (${c.camera}) is at or after the end (${fmt(d)}) and never plays`, ids: [c.camera], t: c.t, hint: `Extend the duration: {"cmd":"project.update","args":{"settings":{"duration":${Math.min(30, Math.ceil(c.t + 2))}}}} or {"cmd":"cut.remove","args":{"t":${c.t}}}` });
    }
  }
  if (want('KEYS_AFTER_END')) {
    const late = project.objects.filter((o) => Object.values(o.tracks).some((tr) => tr.keys.some((k) => k.t > d + 1e-6)));
    if (late.length) {
      const last = Math.max(...late.flatMap((o) => Object.values(o.tracks).flatMap((tr) => tr.keys.map((k) => k.t))));
      out.add({ code: 'KEYS_AFTER_END', severity: 'info', message: `Keyframes after the end (${fmt(d)}) are never reached on: ${late.map((o) => o.id).join(', ')}`, ids: late.map((o) => o.id), t: d, hint: `{"cmd":"project.update","args":{"settings":{"duration":${Math.min(30, Math.ceil(last))}}}} or move the keys (key.move).` });
    }
  }

  shots.forEach((s, i) => {
    const len = s.t1 - s.t0;
    if (want('SHORT_SHOT') && len > 0 && len < 0.5) {
      out.add({ code: 'SHORT_SHOT', severity: 'warning', message: `${label(s)} lasts only ${fmt(len)} (a flash frame)`, ids: [s.camera], t: s.t0, hint: `Remove or move the cut: {"cmd":"cut.remove","args":{"t":${s.t0}}}` });
    }
    const prev = shots[i - 1];
    if (prev && want('SAME_CAMERA_CUT') && prev.camera === s.camera) {
      out.add({ code: 'SAME_CAMERA_CUT', severity: 'info', message: `The cut at ${fmt(s.t0)} switches ${s.camera} → ${s.camera} (no visible change)`, ids: [s.camera], t: s.t0, hint: `{"cmd":"cut.remove","args":{"t":${s.t0}}}` });
    }
    if (!cameraObjects(project).some((c) => c.id === s.camera)) return;

    if (hasCharacters && (want('EMPTY_SHOT') || want('SUBJECT_HIDDEN'))) {
      const n = Math.max(1, Math.min(4, Math.round(len / 2)));
      for (let k = 0; k < n; k++) {
        const t = s.t0 + ((k + 0.5) / n) * len;
        const view = cameraView(project, s.camera, t);
        if (!view) continue;
        const chars = characters(project, view);
        if (!chars.length) {
          if (want('EMPTY_SHOT')) {
            out.hit(`EMPTY_SHOT|${s.index}`, t, 1, () => ({ code: 'EMPTY_SHOT', severity: 'info', message: '', ids: [s.camera], hint: `Fine for an establishing shot or cutaway; otherwise frame someone: {"cmd":"camera.frame","args":{"camera":"${s.camera}","target":"<character id>","shot":"MS"}}` }), (iss) => `${label(s)} shows no character ${range(iss.t, iss.until)}`);
          }
          continue;
        }
        if (!want('SUBJECT_HIDDEN')) continue;
        const subject = subjectOf(project, s.camera, chars)!;
        const blocker = hiddenBy(project, s.camera, subject.id, t, sceneGeometry(project, t).boxes);
        if (blocker) {
          out.hit(`SUBJECT_HIDDEN|${s.index}|${subject.id}`, t, 1, () => ({ code: 'SUBJECT_HIDDEN', severity: 'warning', message: '', ids: [subject.id, s.camera, blocker], hint: `Move ${s.camera} (e.g. camera.frame with another side) or move ${blocker} out of the line of sight.` }), (iss) => `In ${label(s)}, ${subject.id} is mostly hidden behind ${blocker} ${range(iss.t, iss.until)}`);
        }
      }
    }

    if (!prev || prev.camera === s.camera || !(want('CROSSED_LINE') || want('JUMP_CUT'))) return;
    if (!cameraObjects(project).some((c) => c.id === prev.camera)) return;
    const t = s.t0;
    const va = cameraView(project, prev.camera, t);
    const vb = cameraView(project, s.camera, t);
    if (!va || !vb) return;
    const ca = characters(project, va);
    const cb = characters(project, vb);
    const sa = subjectOf(project, prev.camera, ca);
    const sb = subjectOf(project, s.camera, cb);
    if (!sa || !sb) return;
    const posOf = (id: string) => evaluateObject(project.objects.find((o) => o.id === id)!, t).position;
    const camA = evaluateCamera(project, project.objects.find((o) => o.id === prev.camera)!, t).position;
    const camB = evaluateCamera(project, project.objects.find((o) => o.id === s.camera)!, t).position;

    let pair: [string, string] | null = null;
    if (sa.id !== sb.id) pair = [sa.id, sb.id];
    else {
      const other = [...ca, ...cb].filter((v) => v.id !== sa.id).sort((x, y) => y.coverage - x.coverage)[0];
      if (other) pair = [sa.id, other.id];
    }
    if (pair && want('CROSSED_LINE')) {
      const p1 = posOf(pair[0]);
      const p2 = posOf(pair[1]);
      const lx = p2[0] - p1[0];
      const lz = p2[2] - p1[2];
      const len = Math.hypot(lx, lz);
      if (len > 0.3) {
        const side = (c: Vec3) => (lx * (c[2] - p1[2]) - lz * (c[0] - p1[0])) / len;
        const a = side(camA);
        const b = side(camB);
        if (Math.abs(a) > 0.3 && Math.abs(b) > 0.3 && Math.sign(a) !== Math.sign(b)) {
          out.add({
            code: 'CROSSED_LINE',
            severity: 'warning',
            message: `The cut at ${fmt(t)} ${prev.camera} → ${s.camera} crosses the 180° line between ${pair[0]} and ${pair[1]} (the cameras are on opposite sides, so screen directions flip)`,
            ids: [prev.camera, s.camera, pair[0], pair[1]],
            t,
            hint: `Keep both cameras on one side of the ${pair[0]}–${pair[1]} line (camera.frame side/over on that side), or cut through a neutral shot on the line. plan_view shows the line.`,
          });
        }
      }
    }
    if (sa.id === sb.id && want('JUMP_CUT')) {
      const sp = posOf(sa.id);
      const angA = Math.atan2(camA[0] - sp[0], camA[2] - sp[2]);
      const angB = Math.atan2(camB[0] - sp[0], camB[2] - sp[2]);
      const diff = Math.abs(wrapDeg(((angA - angB) * 180) / Math.PI));
      const ha = sa.heightFraction ?? 0;
      const hb = sb.heightFraction ?? 0;
      const ratio = ha && hb ? Math.max(ha, hb) / Math.min(ha, hb) : 99;
      if (diff < 30 && ratio < 1.4) {
        out.add({
          code: 'JUMP_CUT',
          severity: 'warning',
          message: `The cut at ${fmt(t)} ${prev.camera} → ${s.camera} keeps the same subject (${sa.id}) at a similar size (${sa.shot ?? '?'} → ${sb.shot ?? '?'}) only ${Math.round(diff)}° apart — it reads as a jump cut`,
          ids: [prev.camera, s.camera, sa.id],
          t,
          hint: 'Change the camera angle by 30° or more, or the shot size by at least one step (e.g. MS → CU).',
        });
      }
    }
  });
}

/** Run every check (or `codes`) over the whole timeline. */
export function checkScene(project: Project, opts: CheckOptions = {}): CheckResult {
  const want = (c: IssueCode) => !opts.codes?.length || opts.codes.includes(c);
  const out = new Collector();
  physicalChecks(project, sampleTimes(project, Math.max(0.05, opts.step ?? 0.25)), want, out);
  editingChecks(project, want, out);
  const issues = out.list().sort((a, b) => (a.severity === b.severity ? a.t - b.t : a.severity === 'warning' ? -1 : 1));
  return { issues, counts: { warning: issues.filter((i) => i.severity === 'warning').length, info: issues.filter((i) => i.severity === 'info').length } };
}

/** Stable identity of an issue, for "what did this change introduce / fix". */
export const issueKey = (i: SceneIssue) => `${i.code}|${i.ids.join(',')}`;

const cache = new WeakMap<Project, CheckResult>();

/** checkScene with a per-project-object cache (projects are immutable snapshots). */
export function checkSceneCached(project: Project): CheckResult {
  let r = cache.get(project);
  if (!r) {
    r = checkScene(project);
    cache.set(project, r);
  }
  return r;
}

/** Issues present after a change but not before it, plus how many were fixed. */
export function issueDiff(before: Project, after: Project): { new: SceneIssue[]; resolved: number } {
  const a = checkSceneCached(before).issues;
  const b = checkSceneCached(after).issues;
  const had = new Set(a.map(issueKey));
  const has = new Set(b.map(issueKey));
  return { new: b.filter((i) => !had.has(issueKey(i))), resolved: a.filter((i) => !has.has(issueKey(i))).length };
}

/** describeScene plus a one-line summary of scene checks (what describe_scene returns). */
export function describeSceneWithChecks(project: Project, t: number, opts: { camera?: string } = {}): string {
  const summary = checksSummary(project);
  return summary ? `${describeScene(project, t, opts)}\n${summary}` : describeScene(project, t, opts);
}

/** One line for describe_scene: the most important issues. */
export function checksSummary(project: Project, max = 3): string | null {
  const { issues, counts } = checkSceneCached(project);
  if (!issues.length) return null;
  const head = issues.slice(0, max).map((i) => `${i.code} (${i.message.length > 90 ? `${i.message.slice(0, 87)}…` : i.message})`);
  return `Checks: ${counts.warning} warning(s), ${counts.info} note(s) — ${head.join('; ')}${issues.length > max ? '; …' : ''}. Run check_scene for all, with hints.`;
}

