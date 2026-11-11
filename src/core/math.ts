/**
 * Basic vector / angle math. Pure, dependency-free.
 * Units: meters and degrees. Coordinate system: Y up, ground at y = 0,
 * +X = east (right), -Z = north (away from the default camera).
 * Euler order is YXZ everywhere (yaw, then pitch, then roll) — same as three.js `rotation.order = 'YXZ'`.
 */
export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function mul(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function mulVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function lerpVec(a: Vec3, b: Vec3, u: number): Vec3 {
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}
export function roundTo(v: number, digits = 4): number {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}
export function roundVec(v: Vec3, digits = 4): Vec3 {
  return [roundTo(v[0], digits), roundTo(v[1], digits), roundTo(v[2], digits)];
}
export function vecEquals(a: Vec3, b: Vec3, eps = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
}

/** Rotate a vector around +Y by `deg` (counter-clockwise seen from above = turning left). */
export function rotateY(v: Vec3, deg: number): Vec3 {
  const r = deg * DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/** Forward vector of an object (its front faces +Z at yaw 0). */
export function objectForward(yawDeg: number): Vec3 {
  return rotateY([0, 0, 1], yawDeg);
}

/** Forward vector of a camera (it looks down -Z at pan 0, tilt 0). */
export function cameraForward(panDeg: number, tiltDeg: number): Vec3 {
  const y = panDeg * DEG2RAD;
  const p = tiltDeg * DEG2RAD;
  return [-Math.cos(p) * Math.sin(y), Math.sin(p), -Math.cos(p) * Math.cos(y)];
}

/** Pan (yaw) and tilt (pitch) in degrees for a camera at `from` to look at `to`. */
export function lookAngles(from: Vec3, to: Vec3): { pan: number; tilt: number } {
  const d = sub(to, from);
  const flat = Math.hypot(d[0], d[2]);
  if (flat < 1e-9 && Math.abs(d[1]) < 1e-9) return { pan: 0, tilt: 0 };
  const pan = flat < 1e-9 ? 0 : Math.atan2(-d[0], -d[2]) * RAD2DEG;
  const tilt = Math.atan2(d[1], flat) * RAD2DEG;
  return { pan, tilt };
}

/** Yaw in degrees for an object at `from` to face `to` (front = +Z). */
export function faceYaw(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return Math.atan2(dx, dz) * RAD2DEG;
}

/** Shift `next` by a multiple of 360 so it is the closest equivalent angle to `prev`. */
export function unwrapDeg(prev: number, next: number): number {
  const d = ((((next - prev + 180) % 360) + 360) % 360) - 180;
  return prev + d;
}

/** Normalize an angle to (-180, 180]. */
export function wrapDeg(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

/** Rotation matrix (row-major) for Euler angles [x, y, z] in degrees, order YXZ: R = Ry · Rx · Rz. */
export function eulerYXZ(rot: Vec3): Mat3 {
  const x = rot[0] * DEG2RAD;
  const y = rot[1] * DEG2RAD;
  const z = rot[2] * DEG2RAD;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mat3Mul(ry, mat3Mul(rx, rz));
}

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** World-space basis vectors of a camera with Euler rotation [tilt, pan, roll]. */
export function cameraBasis(rot: Vec3): { right: Vec3; up: Vec3; forward: Vec3 } {
  const m = eulerYXZ(rot);
  return {
    right: [m[0], m[3], m[6]],
    up: [m[1], m[4], m[7]],
    forward: [-m[2], -m[5], -m[8]],
  };
}

/** Transform a local point by position / Euler YXZ rotation / scale. */
export function transformPoint(p: Vec3, position: Vec3, rotation: Vec3, scale: Vec3): Vec3 {
  return add(position, mat3MulVec(eulerYXZ(rotation), mulVec(p, scale)));
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}
