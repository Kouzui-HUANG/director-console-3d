/** Keyframe interpolation. */
import { lerpColor } from './colors.ts';
import { clamp, lerp, type Vec3 } from './math.ts';
import type { PropDef } from './properties.ts';
import type { Ease, Keyframe, Track } from './schema.ts';

export const DEFAULT_EASE: Ease = 'inOut';

export function applyEase(u: number, ease: Ease): number {
  const x = clamp(u, 0, 1);
  switch (ease) {
    case 'linear':
      return x;
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    case 'hold':
      return 0;
    case 'inOut':
    default:
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  }
}

/** Index of the last key with key.t <= t (or -1). Keys must be sorted. */
export function segmentIndex(keys: readonly Keyframe[], t: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  if (hi < 0 || t < keys[0]!.t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Centripetal Catmull–Rom between p1 and p2. */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const alpha = 0.5;
  const dt = (a: Vec3, b: Vec3) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) ** alpha, 1e-4);
  const t0 = 0;
  const t1 = t0 + dt(p0, p1);
  const t2 = t1 + dt(p1, p2);
  const t3 = t2 + dt(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const a1 = ((t1 - t) / (t1 - t0)) * p0[i]! + ((t - t0) / (t1 - t0)) * p1[i]!;
    const a2 = ((t2 - t) / (t2 - t1)) * p1[i]! + ((t - t1) / (t2 - t1)) * p2[i]!;
    const a3 = ((t3 - t) / (t3 - t2)) * p2[i]! + ((t - t2) / (t3 - t2)) * p3[i]!;
    const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[i] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
  return out;
}

function reflect(a: Vec3, b: Vec3): Vec3 {
  return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
}

/** Sample a track at time t. Returns undefined when the track has no keys. */
export function sampleTrack(track: Track, t: number, def: Pick<PropDef, 'kind' | 'interp'>): unknown {
  const keys = track.keys;
  if (keys.length === 0) return undefined;
  const i = segmentIndex(keys, t);
  if (i < 0) return keys[0]!.v;
  if (i >= keys.length - 1) return keys[keys.length - 1]!.v;
  const k0 = keys[i]!;
  const k1 = keys[i + 1]!;
  const ease = k0.ease ?? DEFAULT_EASE;
  if (def.interp === 'step' || ease === 'hold' || def.kind === 'bool' || def.kind === 'enum') return k0.v;
  const span = k1.t - k0.t;
  const u = applyEase(span > 0 ? (t - k0.t) / span : 1, ease);
  switch (def.kind) {
    case 'number':
      return lerp(k0.v as number, k1.v as number, u);
    case 'color':
      return lerpColor(k0.v as string, k1.v as string, u);
    case 'vec3': {
      const a = k0.v as Vec3;
      const b = k1.v as Vec3;
      if (track.path === 'smooth' && keys.length >= 3) {
        const p0 = i > 0 ? (keys[i - 1]!.v as Vec3) : reflect(a, b);
        const p3 = i + 2 < keys.length ? (keys[i + 2]!.v as Vec3) : reflect(b, a);
        return catmullRom(p0, a, b, p3, u);
      }
      return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
    }
  }
  return k0.v;
}

/** Keys sorted by time (stable). */
export function sortKeys(keys: Keyframe[]): Keyframe[] {
  return keys.sort((a, b) => a.t - b.t);
}

/** Snap a time to the frame grid. */
export function snapTime(t: number, fps: number): number {
  return Math.round((Math.round(t * fps) / fps) * 10000) / 10000;
}

/** Tolerance used to decide if two keyframe times are "the same frame". */
export function sameFrame(a: number, b: number, fps: number): boolean {
  return Math.abs(a - b) < 0.5 / fps;
}
