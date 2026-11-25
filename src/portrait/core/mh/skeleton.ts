/**
 * Posing with the MakeHuman default skeleton (CC0 data) and linear blend skinning — our own code.
 * Joints are recomputed from the morphed body, so the skeleton always fits the current shape.
 * Bones rotate about their head joints with rotations expressed in the rest frame:
 *   G_bone = G_parent · T(head) · s·R · T(−head)
 * Units follow the input positions (MakeHuman decimeters). +Y up, the figure faces +Z, +X is the
 * figure's left.
 */
import type { MhSkeleton } from './assets.ts';

/** 3×4 affine matrix, row-major: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export type Mat = Float64Array;
/** 3×3 rotation, row-major. */
export type Rot = [number, number, number, number, number, number, number, number, number];
export type V3 = [number, number, number];

export const IDENTITY_ROT: Rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const DEG = Math.PI / 180;

export function identity(): Mat {
  return Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
}

/** a ∘ b (apply b first). */
export function mul(a: Mat, b: Mat): Mat {
  const o = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]!;
      if (c === 3) v += a[r * 4 + 3]!;
      o[r * 4 + c] = v;
    }
  }
  return o;
}

export function rotMul(a: Rot, b: Rot): Rot {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Rot;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}

export function rotApply(R: Rot, v: V3): V3 {
  return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
}

export function rotTranspose(R: Rot): Rot {
  return [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
}

/** Rotation by `angle` radians about a unit axis (right-handed). */
export function rotAxis(axis: V3, angle: number): Rot {
  const [x, y, z] = axis;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

/**
 * Head-style rotation in degrees: yaw + turns toward the figure's left (counter-clockwise seen
 * from above), pitch + lifts the chin, roll + tilts the top toward the figure's left shoulder.
 */
export function headRot(yaw: number, pitch: number, roll: number): Rot {
  return rotMul(rotMul(rotAxis([0, 1, 0], yaw * DEG), rotAxis([1, 0, 0], -pitch * DEG)), rotAxis([0, 0, 1], -roll * DEG));
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Shortest rotation taking unit vector a to unit vector b; also returns its axis and angle. */
export function rotFromTo(a: V3, b: V3): { R: Rot; axis: V3; angle: number } {
  const c = Math.min(1, Math.max(-1, dot(a, b)));
  let axis = crossV(a, b);
  if (Math.hypot(...axis) < 1e-9) axis = Math.abs(a[0]) < 0.9 ? crossV(a, [1, 0, 0]) : crossV(a, [0, 1, 0]);
  axis = norm(axis);
  const angle = Math.acos(c);
  return { R: rotAxis(axis, angle), axis, angle };
}

/** T(p) · s·R · T(−p) */
export function about(R: Rot, p: V3, s = 1): Mat {
  const m = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) m[r * 4 + c] = R[r * 3 + c]! * s;
    m[r * 4 + 3] = p[r]! - (m[r * 4]! * p[0] + m[r * 4 + 1]! * p[1] + m[r * 4 + 2]! * p[2]);
  }
  return m;
}

export function matApply(m: Mat, p: V3): V3 {
  return [m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!, m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!, m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!];
}

/** Rotation part of an affine matrix with its uniform scale removed. */
export function matRot(m: Mat): Rot {
  const s = Math.cbrt(m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!)) || 1;
  return [m[0]! / s, m[1]! / s, m[2]! / s, m[4]! / s, m[5]! / s, m[6]! / s, m[8]! / s, m[9]! / s, m[10]! / s];
}

/** Joint positions (xyz per joint) as the mean of each joint's vertices. */
export function jointPositions(sk: MhSkeleton, P: Float32Array): Float64Array {
  const J = new Float64Array(sk.joints.length * 3);
  sk.joints.forEach((verts, j) => {
    if (!verts.length) return;
    let x = 0, y = 0, z = 0;
    for (const v of verts) {
      x += P[v * 3]!;
      y += P[v * 3 + 1]!;
      z += P[v * 3 + 2]!;
    }
    J[j * 3] = x / verts.length;
    J[j * 3 + 1] = y / verts.length;
    J[j * 3 + 2] = z / verts.length;
  });
  return J;
}

export interface PoseSpec {
  /** Head turn in degrees (see headRot); spread over the three neck bones and the head. */
  headYaw?: number;
  headPitch?: number;
  headRoll?: number;
  /** Uniform head scale about the top of the neck (used for heads-tall). */
  headScale?: number;
  /**
   * Upper arm angle from vertical in degrees (0 = hanging straight down, about 40 = the MakeHuman
   * rest A-pose, 90 = T-pose). null/undefined keeps the rest pose.
   */
  armAngle?: number | null;
  /** Arms swung forward (degrees). */
  armForward?: number;
  /** Elbow flexion (degrees), the forearm bending forward. Used with armAngle. */
  elbow?: number;
  /** Shoulders moved outward (+) or inward, in units of SHOULDER_STEP per side. */
  shoulderWidth?: number;
  /** Shoulders raised (+, square) or dropped (sloping), in units of SHOULDER_LIFT degrees. */
  shoulderLift?: number;
}

/** Shoulder width step per side (model units: decimeters) and shoulder lift step (degrees). */
export const SHOULDER_STEP = 0.22;
export const SHOULDER_LIFT = 9;

/** Share of the head turn taken by each bone (sums to 1). */
const HEAD_CHAIN: [string, number][] = [
  ['neck01', 0.15],
  ['neck02', 0.2],
  ['neck03', 0.25],
  ['head', 0.4],
];
/** Share of the arm lowering done by the shoulder girdle (the rest by the upper arm). */
const SHOULDER_SHARE = 0.22;

export interface PoseResult {
  /** World matrix per bone. */
  mats: Mat[];
  /** Rest joints of the morphed body. */
  joints: Float64Array;
}

/** Bone matrices for a pose. Returns null when the pose is the rest pose. */
export function poseMatrices(sk: MhSkeleton, J: Float64Array, pose: PoseSpec): PoseResult | null {
  const yaw = pose.headYaw ?? 0, pitch = pose.headPitch ?? 0, roll = pose.headRoll ?? 0;
  const hs = pose.headScale ?? 1;
  const arms = pose.armAngle !== undefined && pose.armAngle !== null;
  const sw = pose.shoulderWidth ?? 0, lift = pose.shoulderLift ?? 0;
  if (!yaw && !pitch && !roll && hs === 1 && !arms && !sw && !lift) return null;
  const jp = (j: number): V3 => [J[j * 3]!, J[j * 3 + 1]!, J[j * 3 + 2]!];
  const bi = (name: string) => {
    const i = sk.index.get(name);
    if (i === undefined) throw new Error(`skeleton has no bone ${name}`);
    return i;
  };
  const headOf = (b: number) => jp(sk.head[b]!);
  const local: (Mat | null)[] = new Array(sk.names.length).fill(null);

  if (yaw || pitch || roll || hs !== 1) {
    for (const [name, k] of HEAD_CHAIN) {
      const b = bi(name);
      local[b] = about(headRot(yaw * k, pitch * k, roll * k), headOf(b), name === 'head' ? hs : 1);
    }
  }

  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1;
    const cl = bi(`clavicle.${side}`), sh = bi(`shoulder01.${side}`), ua = bi(`upperarm01.${side}`), la = bi(`lowerarm01.${side}`), wr = bi(`wrist.${side}`);
    // shoulder girdle: lift rotates the clavicle in the frontal plane, width shifts the shoulder
    const Rcl = lift ? rotAxis([0, 0, 1], sx * lift * SHOULDER_LIFT * DEG) : IDENTITY_ROT;
    if (lift) local[cl] = about(Rcl, headOf(cl));
    const shift = sw ? Float64Array.of(1, 0, 0, sx * sw * SHOULDER_STEP, 0, 1, 0, 0, 0, 0, 1, 0) : null;
    let Rsh: Rot = IDENTITY_ROT;
    if (arms) {
      const alpha = Math.max(-10, Math.min(120, pose.armAngle!)) * DEG;
      const beta = (pose.armForward ?? 0) * DEG;
      const flex = Math.max(0, Math.min(150, pose.elbow ?? 0)) * DEG;
      const pShoulder = headOf(ua), pElbow = headOf(la), pWrist = headOf(wr);
      const d0 = norm(sub(pElbow, pShoulder));
      // target direction in world, expressed in the (possibly lifted) clavicle frame
      const d1 = rotApply(rotTranspose(Rcl), norm([sx * Math.sin(alpha) * Math.cos(beta), -Math.cos(alpha) * Math.cos(beta), Math.sin(beta)]));
      const total = rotFromTo(d0, d1);
      Rsh = rotAxis(total.axis, total.angle * SHOULDER_SHARE);
      local[ua] = about(rotFromTo(d0, rotApply(rotTranspose(Rsh), d1)).R, pShoulder);
      // elbow: a hinge about the axis normal to the rest arm plane
      const f0 = norm(sub(pWrist, pElbow));
      const hinge = crossV(d0, f0);
      if (Math.hypot(...hinge) > 1e-6) {
        const flex0 = Math.acos(Math.min(1, Math.max(-1, dot(d0, f0))));
        local[la] = about(rotAxis(norm(hinge), flex - flex0), pElbow);
      }
    }
    if (arms || shift) {
      const m = about(Rsh, headOf(sh));
      local[sh] = shift ? mul(shift, m) : m;
    }
  }

  const mats: Mat[] = [];
  for (let b = 0; b < sk.names.length; b++) {
    const p = sk.parent[b]!;
    const parent = p >= 0 ? mats[p]! : null;
    const l = local[b];
    mats.push(parent ? (l ? mul(parent, l) : parent) : (l ?? identity()));
  }
  return { mats, joints: J };
}

/** Linear blend skinning of all vertices. */
export function skin(P: Float32Array, sk: MhSkeleton, mats: Mat[], out = new Float32Array(P.length)): Float32Array {
  const n = P.length / 3;
  const { bones, weights } = sk;
  for (let v = 0; v < n; v++) {
    const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
    let ox = 0, oy = 0, oz = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k]!;
      if (w <= 0) continue;
      const m = mats[bones[v * 4 + k]!]!;
      ox += w * (m[0]! * x + m[1]! * y + m[2]! * z + m[3]!);
      oy += w * (m[4]! * x + m[5]! * y + m[6]! * z + m[7]!);
      oz += w * (m[8]! * x + m[9]! * y + m[10]! * z + m[11]!);
      wsum += w;
    }
    if (wsum > 0) {
      out[v * 3] = ox / wsum;
      out[v * 3 + 1] = oy / wsum;
      out[v * 3 + 2] = oz / wsum;
    } else {
      out[v * 3] = x;
      out[v * 3 + 1] = y;
      out[v * 3 + 2] = z;
    }
  }
  return out;
}
