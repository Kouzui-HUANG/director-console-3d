/**
 * Text and structured scene analysis for agents: where things are, which way they face,
 * and what each camera actually sees (screen-space boxes, shot size). Pure math.
 */
import { getAssetType, isCharacterType, localAnchor } from './assetTypes.ts';
import {
  cameraObjects,
  evaluateCamera,
  evaluateObject,
  frameAspect,
  isAnimated,
  programCameraAt,
  type EvalCamera,
  type EvalObject,
} from './evaluate.ts';
import { classifyShot, SHOT_SIZES } from './framing.ts';
import { equivalentFocal } from './lens.ts';
import { CommandError } from './commands/types.ts';
import { cameraBasis, DEG2RAD, dot, RAD2DEG, roundTo, roundVec, sub, transformPoint, wrapDeg, type Vec3 } from './math.ts';
import type { Project } from './schema.ts';

export interface ObjectView {
  id: string;
  /** "full" = entirely in frame, "partial" = cut by the frame edge, "none" = not visible. */
  inFrame: 'full' | 'partial' | 'none';
  /** Normalized frame box [x0, y0, x1, y1] (0..1, origin top-left), clipped to the frame. */
  box: [number, number, number, number] | null;
  /** Share of the frame area covered by the box (0..1). */
  coverage: number;
  /** Center of the box in frame coordinates. */
  center: [number, number] | null;
  /** Distance from the camera (meters). */
  distance: number;
  /** For characters: estimated shot size and how much of the frame height they fill. */
  shot?: string;
  heightFraction?: number;
  /** Filled in by the browser renderer (raycast): share of sample points hidden behind other objects. */
  occluded?: number;
  /** A character cut by the frame and much bigger than the shot's subject (e.g. the shoulder in an over-the-shoulder). */
  foreground?: boolean;
}

export interface CameraView {
  camera: string;
  t: number;
  lens: string;
  focalLength: number;
  objects: ObjectView[];
}

function worldCorners(e: EvalObject): Vec3[] {
  const def = getAssetType(e.type);
  if (!def) return [e.position];
  const b = def.bounds(e.params);
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) out.push(transformPoint([x, y, z], e.position, e.rotation, e.scale));
  return out;
}

/** Project a world point for a standard-lens camera. Returns frame coords (0..1, top-left) and depth. */
export function projectPoint(cam: EvalCamera, p: Vec3): { u: number; v: number; depth: number } {
  const { right, up, forward } = cameraBasis(cam.rotation);
  const d = sub(p, cam.position);
  const depth = dot(d, forward);
  const tx = Math.tan((cam.hfov * DEG2RAD) / 2);
  const ty = Math.tan((cam.vfov * DEG2RAD) / 2);
  const z = Math.max(depth, 1e-4);
  const x = dot(d, right) / (z * tx);
  const y = dot(d, up) / (z * ty);
  return { u: (x + 1) / 2, v: (1 - y) / 2, depth };
}

/** Angular projection for fisheye / panorama lenses (approximate frame position). */
function projectWide(cam: EvalCamera, p: Vec3): { u: number; v: number; visible: boolean } {
  const { right, up, forward } = cameraBasis(cam.rotation);
  const d = sub(p, cam.position);
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const fx = dot(d, right) / len;
  const fy = dot(d, up) / len;
  const fz = dot(d, forward) / len;
  if (cam.lens === 'panorama') {
    const lon = Math.atan2(fx, fz);
    const lat = Math.asin(Math.max(-1, Math.min(1, fy)));
    return { u: 0.5 + lon / (2 * Math.PI), v: 0.5 - lat / Math.PI, visible: true };
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, fz)));
  const half = (cam.fisheye.fov * DEG2RAD) / 2;
  const r = theta / half;
  const phi = Math.atan2(fy, fx);
  const rx = cam.fisheye.circular ? Math.min(1, 1 / cam.aspect) : Math.hypot(1, 1 / cam.aspect);
  return { u: 0.5 + (Math.cos(phi) * r * rx) / 2, v: 0.5 - (Math.sin(phi) * r * rx * cam.aspect) / 2, visible: theta <= half };
}

export function viewObject(cam: EvalCamera, e: EvalObject): ObjectView {
  const corners = worldCorners(e);
  const center = corners.reduce<Vec3>((a, c) => [a[0] + c[0] / corners.length, a[1] + c[1] / corners.length, a[2] + c[2] / corners.length], [0, 0, 0]);
  const distance = Math.hypot(center[0] - cam.position[0], center[1] - cam.position[1], center[2] - cam.position[2]);
  const none: ObjectView = { id: e.id, inFrame: 'none', box: null, coverage: 0, center: null, distance: roundTo(distance, 2) };
  if (!e.visible) return none;

  let pts: { u: number; v: number }[];
  if (cam.lens === 'standard') {
    const NEAR = 0.05;
    const proj = corners.map((c) => projectPoint(cam, c));
    const front = proj.filter((p) => p.depth > NEAR);
    if (front.length === 0) return none;
    pts = front;
    if (front.length < proj.length) {
      // The box straddles the camera plane: clip its edges at the near plane and project the cut
      // points too, so the on-screen extent is right (it may still be entirely outside the frame).
      for (let i = 0; i < 8; i++) {
        for (const bit of [1, 2, 4]) {
          const j = i ^ bit;
          if (j < i) continue;
          const a = proj[i]!;
          const b = proj[j]!;
          if ((a.depth > NEAR) === (b.depth > NEAR)) continue;
          const s = (NEAR - a.depth) / (b.depth - a.depth);
          const ca = corners[i]!;
          const cb = corners[j]!;
          pts.push(projectPoint(cam, [ca[0] + (cb[0] - ca[0]) * s, ca[1] + (cb[1] - ca[1]) * s, ca[2] + (cb[2] - ca[2]) * s]));
        }
      }
    }
  } else {
    const proj = corners.map((c) => projectWide(cam, c));
    if (!proj.some((p) => p.visible)) return none;
    pts = proj;
  }
  const u0 = Math.min(...pts.map((p) => p.u));
  const u1 = Math.max(...pts.map((p) => p.u));
  const v0 = Math.min(...pts.map((p) => p.v));
  const v1 = Math.max(...pts.map((p) => p.v));
  const cu0 = Math.max(0, u0);
  const cu1 = Math.min(1, u1);
  const cv0 = Math.max(0, v0);
  const cv1 = Math.min(1, v1);
  if (cu1 <= cu0 || cv1 <= cv0) return none;
  const full = u0 >= -0.001 && u1 <= 1.001 && v0 >= -0.001 && v1 <= 1.001;
  const view: ObjectView = {
    id: e.id,
    inFrame: full ? 'full' : 'partial',
    box: [roundTo(cu0, 3), roundTo(cv0, 3), roundTo(cu1, 3), roundTo(cv1, 3)],
    coverage: roundTo((cu1 - cu0) * (cv1 - cv0), 3),
    center: [roundTo((cu0 + cu1) / 2, 3), roundTo((cv0 + cv1) / 2, 3)],
    distance: roundTo(distance, 2),
  };
  if (isCharacterType(e.type) && cam.lens === 'standard') {
    const head = transformPoint(localAnchor(e.type, e.params, 'head'), e.position, e.rotation, e.scale);
    const top: Vec3 = [head[0], head[1] + 0.08 * e.scale[1], head[2]];
    const feet = transformPoint(localAnchor(e.type, e.params, 'feet'), e.position, e.rotation, e.scale);
    const pt = projectPoint(cam, top);
    const pf = projectPoint(cam, feet);
    if (pt.depth > 0.05 && pf.depth > 0.05) {
      const hf = Math.abs(pf.v - pt.v);
      view.heightFraction = roundTo(hf, 3);
      view.shot = classifyShot(hf);
    }
  }
  return view;
}

export function cameraView(project: Project, cameraId: string, t: number): CameraView | null {
  const camObj = project.objects.find((o) => o.id === cameraId && o.type === 'camera');
  if (!camObj) return null;
  const cam = evaluateCamera(project, camObj, t, frameAspect(project));
  const objects = project.objects
    .filter((o) => o.id !== cameraId && o.type !== 'camera' && !getAssetType(o.type)?.editorOnly && !['ground', 'hills', 'water'].includes(o.type))
    .map((o) => viewObject(cam, evaluateObject(o, t)))
    .filter((v) => v.inFrame !== 'none')
    .sort((a, b) => b.coverage - a.coverage);
  markForeground(project, camObj.camera?.lookAt?.target ?? null, objects);
  return { camera: cameraId, t, lens: cam.lens, focalLength: roundTo(cam.focalLength, 1), objects };
}

/**
 * The shot's subject is the lookAt target (if it is a character in frame), otherwise the
 * character nearest the frame center. Characters cut by the frame edge that are much bigger
 * than the subject are foreground (over-the-shoulder), not close-ups.
 */
function markForeground(project: Project, lookAtTarget: string | null, objects: ObjectView[]): void {
  const chars = objects.filter((v) => v.heightFraction !== undefined && isCharacterType(project.objects.find((o) => o.id === v.id)?.type ?? ''));
  if (chars.length < 2) return;
  const dist = (v: ObjectView) => (v.center ? Math.hypot(v.center[0] - 0.5, v.center[1] - 0.45) : 9);
  const subject = chars.find((v) => v.id === lookAtTarget) ?? [...chars].sort((a, b) => dist(a) - dist(b))[0]!;
  for (const v of chars) {
    if (v !== subject && v.inFrame === 'partial' && v.heightFraction! > 1.5 * subject.heightFraction!) v.foreground = true;
  }
}

/** Throw NOT_FOUND (listing existing ids) if any requested id is not in the project. */
export function requireIds(project: Project, ids: readonly string[]): void {
  const missing = ids.filter((id) => !project.objects.some((o) => o.id === id));
  if (missing.length) {
    throw new CommandError('NOT_FOUND', `no object with id ${missing.map((m) => `"${m}"`).join(', ')}`, `Existing ids: ${project.objects.map((o) => o.id).slice(0, 60).join(', ')}`);
  }
}

/**
 * Exact resolved state at a time (animation, follow, lookAt and shake applied), optionally
 * limited to some ids. For precise math; describeScene is the readable summary.
 */
export function resolvedScene(project: Project, t: number, opts: { ids?: readonly string[] } = {}) {
  const want = opts.ids?.length ? new Set(opts.ids) : null;
  if (opts.ids?.length) requireIds(project, opts.ids);
  const pick = (id: string) => !want || want.has(id);
  return {
    t,
    programCamera: programCameraAt(project, t),
    objects: project.objects
      .filter((o) => o.type !== 'camera' && pick(o.id))
      .map((o) => {
        const e = evaluateObject(o, t);
        return { id: o.id, type: o.type, name: o.name, position: roundVec(e.position, 3), rotation: roundVec(e.rotation, 2), scale: roundVec(e.scale, 3), visible: e.visible, params: e.params };
      }),
    cameras: cameraObjects(project)
      .filter((c) => pick(c.id))
      .map((c) => {
        const e = evaluateCamera(project, c, t);
        return { id: c.id, name: c.name, position: roundVec(e.position, 3), rotation: roundVec(e.rotation, 2), lens: e.lens, focalLength: roundTo(e.focalLength, 2), hfov: roundTo(e.hfov, 2), vfov: roundTo(e.vfov, 2), aimPoint: e.aimPoint ? roundVec(e.aimPoint, 3) : null };
      }),
  };
}

const BACKGROUND_TYPES = new Set(['road', 'cityBlock', 'building', 'house', 'room', 'wall', 'crowd']);

/** Scenery rather than a subject: buildings, roads, crowds, or anything filling the whole frame. */
export function isBackgroundView(type: string, v: Pick<ObjectView, 'coverage'>): boolean {
  return BACKGROUND_TYPES.has(type) || (v.coverage >= 0.98 && !isCharacterType(type));
}

const COMPASS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

/** Compass word for an object's facing yaw (0 = +Z = south, 90 = +X = east). */
export function facingWord(yaw: number): string {
  const a = ((yaw % 360) + 360) % 360;
  return COMPASS[Math.round(a / 45) % 8]!;
}

/** Compass word for a camera pan (0 = looking -Z = north, 90 = west). */
export function lookingWord(pan: number): string {
  return facingWord(pan + 180);
}

function fmt(v: Vec3): string {
  return `(${v.map((n) => roundTo(n, 2)).join(', ')})`;
}

function placement(u: number): string {
  return u < 0.36 ? 'left' : u > 0.64 ? 'right' : 'center';
}

export function describeScene(project: Project, t: number, opts: { camera?: string } = {}): string {
  const s = project.settings;
  const lines: string[] = [];
  const program = programCameraAt(project, t);
  lines.push(
    `Project "${project.name}" (${project.id}) — ${s.duration}s @ ${s.fps}fps, ${s.resolution[0]}×${s.resolution[1]} (${s.aspect}). Time ${t.toFixed(2)}s. Program camera: ${program ?? '(none)'}.`,
  );
  lines.push('Units: meters/degrees/seconds. Y up; +X east, -Z north. Object yaw 0 faces +Z (south); camera pan 0 looks -Z (north).');
  const others = project.objects.filter((o) => o.type !== 'camera');
  lines.push(`Objects (${others.length}):`);
  for (const o of others) {
    const e = evaluateObject(o, t);
    const asset = getAssetType(o.type);
    const anim = Object.keys(o.tracks).filter((p) => isAnimated(o, p));
    const bits = [`${o.id} (${o.type}${o.name ? ` "${o.name}"` : ''})`, `at ${fmt(e.position)}`];
    if (asset?.category === 'character' || asset?.category === 'prop') bits.push(`facing ${roundTo(wrapDeg(e.rotation[1]), 1)}° (${facingWord(e.rotation[1])})`);
    if (typeof e.params.pose === 'string') bits.push(`pose ${e.params.pose}`);
    if (!e.visible) bits.push('HIDDEN');
    if (anim.length) bits.push(`animated: ${anim.join(', ')}`);
    lines.push(`- ${bits.join(', ')}`);
  }
  const cams = cameraObjects(project).filter((c) => !opts.camera || c.id === opts.camera);
  lines.push(`Cameras (${cams.length}):`);
  for (const c of cams) {
    const cam = evaluateCamera(project, c, t);
    const settings = c.camera!;
    const aim = settings.lookAt?.target ? `looking at ${settings.lookAt.target}` : `looking ${lookingWord(cam.rotation[1])} (pan ${roundTo(cam.rotation[1], 1)}°, tilt ${roundTo(cam.rotation[0], 1)}°)`;
    const lens =
      cam.lens === 'standard'
        ? `${roundTo(cam.focalLength, 1)}mm on ${cam.sensor} (≈${Math.round(equivalentFocal(cam.focalLength, cam.sensor))}mm FF, hfov ${roundTo(cam.hfov, 1)}°)`
        : cam.lens === 'fisheye'
          ? `fisheye ${roundTo(cam.fisheye.fov, 0)}° ${cam.fisheye.mapping}`
          : '360° panorama';
    const extras = [
      settings.follow ? `following ${settings.follow.target}` : '',
      settings.shake.preset !== 'none' ? `shake ${settings.shake.preset}` : '',
    ].filter(Boolean);
    lines.push(`- ${c.id}${c.name ? ` "${c.name}"` : ''}${c.id === program ? ' [LIVE]' : ''}: at ${fmt(cam.position)}, ${aim}, ${lens}${extras.length ? ', ' + extras.join(', ') : ''}`);
    const view = cameraView(project, c.id, t);
    if (view && view.objects.length) {
      const typeOf = (id: string) => project.objects.find((o) => o.id === id)?.type ?? '';
      const isBackground = (v: ObjectView) => isBackgroundView(typeOf(v.id), v);
      const main = view.objects
        .filter((v) => !isBackground(v))
        .sort((a, b) => Number(isCharacterType(typeOf(b.id))) - Number(isCharacterType(typeOf(a.id))) || b.coverage - a.coverage)
        .slice(0, 8)
        .map((v) => {
          const parts = [v.id];
          if (v.foreground) parts.push('foreground (over the shoulder)');
          else if (v.shot) parts.push(`${v.shot} (${SHOT_SIZES[v.shot as keyof typeof SHOT_SIZES].en})`);
          if (v.center) parts.push(placement(v.center[0]));
          parts.push(`${Math.round(v.coverage * 100)}% of frame`);
          if (v.inFrame === 'partial') parts.push('cut by frame edge');
          return parts.join(' ');
        });
      const bg = view.objects.filter(isBackground).map((v) => v.id);
      lines.push(`    sees: ${main.length ? main.join('; ') : '(no characters or props)'}${bg.length ? ` | background: ${bg.slice(0, 8).join(', ')}` : ''}`);
    } else lines.push('    sees: nothing notable');
  }
  if (project.cuts.length) lines.push(`Cuts: ${project.cuts.map((c) => `${roundTo(c.t, 3)}s→${c.camera}`).join(', ')}`);
  if (project.markers.length) lines.push(`Markers: ${project.markers.map((m) => `${roundTo(m.t, 3)}s "${m.label}"`).join(', ')}`);
  return lines.join('\n');
}

export function radToDeg(r: number): number {
  return r * RAD2DEG;
}
