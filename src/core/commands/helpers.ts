import { getAssetType, paramSchema, suggestType } from '../assetTypes.ts';
import { normalizeColor } from '../colors.ts';
import { sampleProp } from '../evaluate.ts';
import { sameFrame, snapTime, sortKeys } from '../interpolate.ts';
import { coercePropValue, propDef, propDefsFor, setAtPath, toVec3, type PropDef } from '../properties.ts';
import type { Ease, Project, SceneObject } from '../schema.ts';
import { CommandError, type CommandContext } from './types.ts';

export function fpsOf(project: Project): number {
  return project.settings.fps;
}

export function vec3Arg(raw: unknown, what: string): [number, number, number] {
  const v = toVec3(raw);
  if (!v) throw new CommandError('INVALID_ARGS', `${what} must be [x, y, z] (meters)`, 'Example: [1.5, 0, -2]');
  return v;
}

export function colorArg(raw: unknown): string {
  const c = normalizeColor(raw);
  if (!c) throw new CommandError('INVALID_ARGS', `invalid color "${String(raw)}"`, 'Use "#rrggbb" or a name such as "red", "blue", "gray".');
  return c;
}

export function timeArg(ctx: CommandContext, t: number | undefined): number {
  const fps = fpsOf(ctx.draft);
  const v = t ?? ctx.time;
  if (!(v >= 0 && v <= 30)) throw new CommandError('INVALID_ARGS', `time ${v} is outside 0..30 seconds`);
  return snapTime(v, fps);
}

export function requireType(type: string) {
  const def = getAssetType(type);
  if (!def) {
    const s = suggestType(type);
    throw new CommandError('UNKNOWN_TYPE', `unknown object type "${type}"`, s ? `Did you mean "${s}"? list_asset_types (MCP) / director.assetTypes() lists all types.` : 'Call list_asset_types (MCP) / director.assetTypes() to list valid types.');
  }
  return def;
}

export function requireCamera(ctx: CommandContext, id: string): SceneObject {
  const o = ctx.obj(id);
  if (o.type !== 'camera') throw new CommandError('NOT_A_CAMERA', `"${id}" is a ${o.type}, not a camera`);
  return o;
}

export function requireProp(obj: SceneObject, path: string): PropDef {
  const def = propDef(obj, path);
  if (!def) {
    const valid = propDefsFor(obj).map((d) => d.path);
    throw new CommandError('UNKNOWN_PROPERTY', `"${path}" is not an animatable property of ${obj.type} "${obj.id}"`, `Valid: ${valid.join(', ')}`);
  }
  return def;
}

export function coerce(def: PropDef, raw: unknown): unknown {
  try {
    return coercePropValue(def, raw);
  } catch (e) {
    throw new CommandError('INVALID_VALUE', (e as Error).message);
  }
}

/** Insert or replace a keyframe (same frame = replace). Returns the stored time. */
export function upsertKey(project: Project, obj: SceneObject, path: string, t: number, v: unknown, ease?: Ease): number {
  const fps = fpsOf(project);
  const track = obj.tracks[path] ?? (obj.tracks[path] = { keys: [] });
  const existing = track.keys.find((k) => sameFrame(k.t, t, fps));
  if (existing) {
    existing.v = v;
    if (ease) existing.ease = ease;
    return existing.t;
  }
  track.keys.push(ease ? { t, v, ease } : { t, v });
  sortKeys(track.keys);
  return t;
}

export function removeKeysInside(project: Project, obj: SceneObject, path: string, t0: number, t1: number): void {
  const track = obj.tracks[path];
  if (!track) return;
  const fps = fpsOf(project);
  track.keys = track.keys.filter((k) => !(k.t > t0 + 0.5 / fps && k.t < t1 - 0.5 / fps));
}

/**
 * Set a property value the way a director expects:
 * animated property (or forceKey) → keyframe at t; otherwise → static value.
 */
export function setProp(
  ctx: CommandContext,
  obj: SceneObject,
  path: string,
  value: unknown,
  opts: { t?: number; forceKey?: boolean; ease?: Ease } = {},
): 'keyed' | 'static' {
  const def = requireProp(obj, path);
  const v = coerce(def, value);
  const animated = (obj.tracks[path]?.keys.length ?? 0) > 0;
  if (animated || opts.forceKey) {
    upsertKey(ctx.draft, obj, path, timeArg(ctx, opts.t), v, opts.ease);
    return 'keyed';
  }
  setAtPath(obj as unknown as Record<string, unknown>, path, v);
  return 'static';
}

export function currentValue(obj: SceneObject, path: string, t: number): unknown {
  return sampleProp(obj, path, t);
}

/** Validate and normalize params for a type (fills defaults). */
export function normalizeParams(type: string, params: Record<string, unknown>): Record<string, unknown> {
  const schema = paramSchema(type);
  if (!schema) return params;
  const r = schema.safeParse(params);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    const key = issue.path.join('.');
    throw new CommandError('INVALID_PARAMS', `params.${key}: ${issue.message}`, describeParams(type), ['params', ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))]);
  }
  return r.data as Record<string, unknown>;
}

export function describeParams(type: string): string {
  const def = getAssetType(type);
  if (!def || def.fields.length === 0) return `${type} has no params`;
  return `${type} params: ${def.fields
    .map((f) => {
      if (f.kind === 'number') return `${f.key} (${f.min}..${f.max}${f.unit ? ' ' + f.unit : ''}, default ${f.default})`;
      if (f.kind === 'enum') return `${f.key} (${f.options.map((o) => o[0]).join('|')})`;
      return `${f.key} (${f.kind})`;
    })
    .join(', ')}`;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, everything else (arrays, null, primitives) replaces. */
export function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/** Flatten an object into dotted paths of its leaves (arrays are leaves). */
export function flattenPaths(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push(...flattenPaths(v, p));
    else out.push([p, v]);
  }
  return out;
}

/** Remove a dotted path from a plain object (and empty parents). */
export function deletePath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  const stack: Record<string, unknown>[] = [obj];
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]!];
    if (!isPlainObject(next)) return;
    cur = next;
    stack.push(cur);
  }
  delete cur[parts[parts.length - 1]!];
  for (let i = stack.length - 1; i > 0; i--) {
    if (Object.keys(stack[i]!).length === 0) delete stack[i - 1]![parts[i - 1]!];
  }
}

/** Clear references to a removed object everywhere; returns warnings. */
export function clearReferences(project: Project, id: string): string[] {
  const warnings: string[] = [];
  for (const o of project.objects) {
    const cam = o.camera;
    if (!cam) continue;
    if (cam.lookAt?.target === id) {
      cam.lookAt = null;
      warnings.push(`${o.id}: lookAt target removed`);
    }
    if (cam.follow?.target === id) {
      cam.follow = null;
      warnings.push(`${o.id}: follow target removed`);
    }
  }
  const before = project.cuts.length;
  project.cuts = project.cuts.filter((c) => c.camera !== id);
  if (project.cuts.length !== before) warnings.push(`removed ${before - project.cuts.length} cut(s) using "${id}"`);
  return warnings;
}

export function checkRefExists(project: Project, id: string | null | undefined, what: string, selfId?: string): void {
  if (!id) return;
  if (id === selfId) throw new CommandError('INVALID_REFERENCE', `${what} cannot reference the camera itself`);
  if (!project.objects.some((o) => o.id === id)) {
    throw new CommandError('NOT_FOUND', `${what}: no object with id "${id}"`, `Existing ids: ${project.objects.map((o) => o.id).join(', ')}`);
  }
}
