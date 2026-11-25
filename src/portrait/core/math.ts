/**
 * Small vector helpers for building sculpts (plain tuples, no allocation-sensitive code here:
 * the hot paths live in sdf/evaluate.ts and mesher/).
 * Head frame: millimeters, +Y up, +Z forward (the face looks toward +Z), +X = the figure's left.
 */
export type V3 = [number, number, number];
/** Rotation as three rows: the local x, y, z axes expressed in world coordinates (= world→local matrix). */
export type Basis = [V3, V3, V3];

export const DEG = Math.PI / 180;
export const IDENTITY: Basis = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** Mirror a point across the median plane (x → −x) when s = −1. */
export const mx = (p: V3, s: number): V3 => [p[0] * s, p[1], p[2]];

/** Basis from Euler angles in degrees, order YXZ (yaw, then pitch, then roll), like the director. */
export function basisEuler(rxDeg: number, ryDeg: number, rzDeg = 0): Basis {
  const [cx, sx] = [Math.cos(rxDeg * DEG), Math.sin(rxDeg * DEG)];
  const [cy, sy] = [Math.cos(ryDeg * DEG), Math.sin(ryDeg * DEG)];
  const [cz, sz] = [Math.cos(rzDeg * DEG), Math.sin(rzDeg * DEG)];
  // R = Ry · Rx · Rz; the local axes are the columns of R.
  const r00 = cy * cz + sy * sx * sz;
  const r01 = -cy * sz + sy * sx * cz;
  const r02 = sy * cx;
  const r10 = cx * sz;
  const r11 = cx * cz;
  const r12 = -sx;
  const r20 = -sy * cz + cy * sx * sz;
  const r21 = sy * sz + cy * sx * cz;
  const r22 = cy * cx;
  return [
    [r00, r10, r20],
    [r01, r11, r21],
    [r02, r12, r22],
  ];
}

/** Basis whose local z points along `forward` and local y as close as possible to `up`. */
export function basisZY(forward: V3, up: V3): Basis {
  const z = norm(forward);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [x, y, z];
}

/** Basis whose local y points along `axis` and local z as close as possible to `front`. */
export function basisYZ(axis: V3, front: V3): Basis {
  const y = norm(axis);
  const x = norm(cross(y, front));
  const z = cross(x, y);
  return [x, y, z];
}

/**
 * Mirror a basis across the median plane (for the figure's right side when s = −1). Every axis is
 * reflected (x → −x), so a local axis that pointed lateral on the left side points lateral on the
 * right. The result is left-handed, which is fine for distance functions.
 */
export function mirrorBasis(b: Basis, s: number): Basis {
  if (s > 0) return b;
  return [
    [-b[0][0], b[0][1], b[0][2]],
    [-b[1][0], b[1][1], b[1][2]],
    [-b[2][0], b[2][1], b[2][2]],
  ];
}

/** Apply a basis (world→local rows) transposed: local vector → world vector. */
export function toWorld(b: Basis, v: V3): V3 {
  return [b[0][0] * v[0] + b[1][0] * v[1] + b[2][0] * v[2], b[0][1] * v[0] + b[1][1] * v[1] + b[2][1] * v[2], b[0][2] * v[0] + b[1][2] * v[1] + b[2][2] * v[2]];
}
