/**
 * Full project validation + normalization (defaults filled, keys sorted).
 * Used when loading files, importing, project.replace, and by the server
 * when an agent edits projects/*.json directly.
 */
import { getAssetType, paramSchema, suggestType } from './assetTypes.ts';
import { sameFrame } from './interpolate.ts';
import { randomProjectId } from './ids.ts';
import { coercePropValue, propDef } from './properties.ts';
import { defaultCamera, FORMAT, FORMAT_VERSION, ProjectSchema, type Project } from './schema.ts';

export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  project?: Project;
  errors: Issue[];
  warnings: Issue[];
}

/** Tracks of camera features that were removed (old files may still have them). */
const REMOVED_TRACK = /^camera\.(dof|tiltShift)\./;

function fmtPath(path: readonly PropertyKey[]): string {
  let s = '';
  for (const p of path) s += typeof p === 'number' ? `[${p}]` : s ? `.${String(p)}` : String(p);
  return s || '(root)';
}

export function migrateProject(raw: unknown): { data: unknown; notes: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: raw, notes: [] };
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const notes: string[] = [];
  delete o.$schema;
  if (o.format === undefined) o.format = FORMAT;
  if (o.version === undefined) o.version = FORMAT_VERSION;
  if (typeof o.version === 'number' && o.version > FORMAT_VERSION) {
    notes.push(`file format version ${o.version} is newer than this app supports (${FORMAT_VERSION})`);
  }
  if (typeof o.id !== 'string' || !o.id) {
    o.id = randomProjectId();
    notes.push('missing project id; generated a new one');
  }
  return { data: o, notes };
}

export function validateProject(raw: unknown): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const { data, notes } = migrateProject(raw);
  for (const n of notes) warnings.push({ path: '(root)', message: n });

  const parsed = ProjectSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) errors.push({ path: fmtPath(issue.path), message: issue.message });
    return { ok: false, errors, warnings };
  }
  const p = parsed.data;
  const fps = p.settings.fps;
  const ids = new Set<string>();

  p.objects.forEach((o, i) => {
    const at = `objects[${i}](${o.id})`;
    if (ids.has(o.id)) errors.push({ path: `${at}.id`, message: `duplicate id "${o.id}"` });
    ids.add(o.id);
    const asset = getAssetType(o.type);
    if (!asset) {
      const s = suggestType(o.type);
      errors.push({ path: `${at}.type`, message: `unknown type "${o.type}"${s ? ` (did you mean "${s}"?)` : ''}` });
      return;
    }
    const ps = paramSchema(o.type);
    if (ps) {
      const r = ps.safeParse(o.params);
      if (!r.success) {
        for (const issue of r.error.issues.slice(0, 5)) errors.push({ path: `${at}.params.${fmtPath(issue.path)}`, message: issue.message });
      } else o.params = r.data as Record<string, unknown>;
    }
    if (o.type === 'camera') {
      if (!o.camera) o.camera = defaultCamera();
    } else if (o.camera) {
      warnings.push({ path: `${at}.camera`, message: 'camera block ignored on a non-camera object' });
      delete o.camera;
    }
    for (const [path, track] of Object.entries(o.tracks)) {
      if (REMOVED_TRACK.test(path)) {
        warnings.push({ path: `${at}.tracks.${path}`, message: 'depth of field / tilt-shift are no longer supported; track dropped' });
        delete o.tracks[path];
        continue;
      }
      const def = propDef(o, path);
      if (!def) {
        errors.push({ path: `${at}.tracks.${path}`, message: `"${path}" is not an animatable property of ${o.type}` });
        continue;
      }
      track.keys.sort((a, b) => a.t - b.t);
      const deduped: typeof track.keys = [];
      for (const k of track.keys) {
        try {
          k.v = coercePropValue(def, k.v);
        } catch (e) {
          errors.push({ path: `${at}.tracks.${path}@${k.t}s`, message: (e as Error).message });
        }
        const last = deduped[deduped.length - 1];
        if (last && sameFrame(last.t, k.t, fps)) {
          warnings.push({ path: `${at}.tracks.${path}`, message: `two keys on the same frame (${k.t}s); kept the later one` });
          deduped[deduped.length - 1] = k;
        } else deduped.push(k);
      }
      track.keys = deduped;
      if (track.keys.length === 0) delete o.tracks[path];
    }
  });

  const byId = new Map(p.objects.map((o) => [o.id, o]));
  p.cuts = p.cuts
    .filter((c, i) => {
      const cam = byId.get(c.camera);
      if (!cam || cam.type !== 'camera') {
        warnings.push({ path: `cuts[${i}]`, message: `camera "${c.camera}" does not exist; cut dropped` });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.t - b.t);
  p.markers.sort((a, b) => a.t - b.t);

  for (const o of p.objects) {
    const cam = o.camera;
    if (!cam) continue;
    if (cam.lookAt?.target && (!byId.has(cam.lookAt.target) || cam.lookAt.target === o.id)) {
      warnings.push({ path: `${o.id}.camera.lookAt`, message: `target "${cam.lookAt.target}" not found; lookAt cleared` });
      cam.lookAt = null;
    }
    if (cam.follow && (!byId.has(cam.follow.target) || cam.follow.target === o.id)) {
      warnings.push({ path: `${o.id}.camera.follow`, message: `target "${cam.follow.target}" not found; follow cleared` });
      cam.follow = null;
    }
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, project: p, errors, warnings };
}

/** Cheap structural checks run after every command batch. */
export function checkInvariants(p: Project): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const o of p.objects) {
    if (ids.has(o.id)) problems.push(`duplicate id "${o.id}"`);
    ids.add(o.id);
    for (const [path, tr] of Object.entries(o.tracks)) {
      for (let i = 1; i < tr.keys.length; i++) {
        if (tr.keys[i]!.t < tr.keys[i - 1]!.t) problems.push(`${o.id}.${path}: keys out of order`);
      }
    }
  }
  for (const c of p.cuts) if (!ids.has(c.camera)) problems.push(`cut at ${c.t}s references missing camera "${c.camera}"`);
  return problems;
}
