/**
 * Evaluates a compiled Program at a point. Hot path for the mesher: no allocation, flat typed
 * arrays, one switch per primitive. `list` is a (possibly culled) sequence of node indices in
 * evaluation order (see cull.ts); Program.all evaluates everything.
 */
import { NODE, OP, PRIM, type Program } from './program.ts';

const STACK = new Float64Array(128);

/** Polynomial smooth minimum (exactly min() when |a − b| ≥ k, so culling far shapes is exact). */
export function smin(a: number, b: number, k: number): number {
  const m = a < b ? a : b;
  if (k <= 0) return m;
  const h = k - Math.abs(a - b);
  return h > 0 ? m - (h * h) / (4 * k) : m;
}

export function smax(a: number, b: number, k: number): number {
  const m = a > b ? a : b;
  if (k <= 0) return m;
  const h = k - Math.abs(a - b);
  return h > 0 ? m + (h * h) / (4 * k) : m;
}

function combine(acc: number, d: number, op: number, k: number): number {
  if (op === OP.union) return smin(acc, d, k);
  if (op === OP.sub) return smax(acc, -d, k);
  return smax(acc, d, k);
}

/** Distance from a point to primitive node i. */
export function evalPrim(P: Program, i: number, x: number, y: number, z: number): number {
  const p = P.params;
  const o = P.pOff[i]!;
  switch (P.type[i]) {
    case PRIM.sphere: {
      const dx = x - p[o]!, dy = y - p[o + 1]!, dz = z - p[o + 2]!;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - p[o + 3]!;
    }
    case PRIM.ellipsoid: {
      const px = x - p[o + 9]!, py = y - p[o + 10]!, pz = z - p[o + 11]!;
      const qx = p[o]! * px + p[o + 1]! * py + p[o + 2]! * pz;
      const qy = p[o + 3]! * px + p[o + 4]! * py + p[o + 5]! * pz;
      const qz = p[o + 6]! * px + p[o + 7]! * py + p[o + 8]! * pz;
      const rx = p[o + 12]!, ry = p[o + 13]!, rz = p[o + 14]!;
      const ax = qx / rx, ay = qy / ry, az = qz / rz;
      const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
      const bx = ax / rx, by = ay / ry, bz = az / rz;
      const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
      if (k1 < 1e-12) return -Math.min(rx, ry, rz);
      return (k0 * (k0 - 1)) / k1;
    }
    case PRIM.capsule: {
      const ax = p[o]!, ay = p[o + 1]!, az = p[o + 2]!;
      const bax = p[o + 3]! - ax, bay = p[o + 4]! - ay, baz = p[o + 5]! - az;
      const pax = x - ax, pay = y - ay, paz = z - az;
      let h = (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz);
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - p[o + 6]!;
    }
    case PRIM.roundCone: {
      // Inigo Quilez, "round cone" with arbitrary end points.
      const pax = x - p[o]!, pay = y - p[o + 1]!, paz = z - p[o + 2]!;
      const bax = p[o + 3]!, bay = p[o + 4]!, baz = p[o + 5]!;
      const r1 = p[o + 6]!, r2 = p[o + 7]!, l2 = p[o + 8]!, rr = p[o + 9]!, a2 = p[o + 10]!, il2 = p[o + 11]!;
      const yy = pax * bax + pay * bay + paz * baz;
      const zz = yy - l2;
      const wx = pax * l2 - bax * yy, wy = pay * l2 - bay * yy, wz = paz * l2 - baz * yy;
      const x2 = wx * wx + wy * wy + wz * wz;
      const y2 = yy * yy * l2;
      const z2 = zz * zz * l2;
      const k = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
      if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
      return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
    }
    case PRIM.roundBox: {
      const px = x - p[o + 9]!, py = y - p[o + 10]!, pz = z - p[o + 11]!;
      const r = p[o + 15]!;
      const qx = Math.abs(p[o]! * px + p[o + 1]! * py + p[o + 2]! * pz) - p[o + 12]! + r;
      const qy = Math.abs(p[o + 3]! * px + p[o + 4]! * py + p[o + 5]! * pz) - p[o + 13]! + r;
      const qz = Math.abs(p[o + 6]! * px + p[o + 7]! * py + p[o + 8]! * pz) - p[o + 14]! + r;
      const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
      const inner = Math.max(qx, qy, qz);
      return Math.sqrt(mx * mx + my * my + mz * mz) + (inner < 0 ? inner : 0) - r;
    }
    case PRIM.bezier:
      return bezierTube(p, o, x, y, z);
    case PRIM.plane:
      return p[o]! * x + p[o + 1]! * y + p[o + 2]! * z - p[o + 3]!;
    case PRIM.torus: {
      const px = x - p[o + 9]!, py = y - p[o + 10]!, pz = z - p[o + 11]!;
      const qx = p[o]! * px + p[o + 1]! * py + p[o + 2]! * pz;
      const qy = p[o + 3]! * px + p[o + 4]! * py + p[o + 5]! * pz;
      const qz = p[o + 6]! * px + p[o + 7]! * py + p[o + 8]! * pz;
      const ring = Math.sqrt(qx * qx + qy * qy) - p[o + 12]!;
      return Math.sqrt(ring * ring + qz * qz) - p[o + 13]!;
    }
    case PRIM.eyelid:
      return eyelidDist(p, o, x, y, z);
    default:
      return Infinity;
  }
}

/** Quadratic Bézier tube (closest point by Inigo Quilez's closed form), elliptical section. */
function bezierTube(p: Float64Array, o: number, x: number, y: number, z: number): number {
  const Ax = p[o]!, Ay = p[o + 1]!, Az = p[o + 2]!;
  const ax = p[o + 9]!, ay = p[o + 10]!, az = p[o + 11]!;
  const bx = p[o + 12]!, by = p[o + 13]!, bz = p[o + 14]!;
  const kk = p[o + 15]!, kx = p[o + 16]!, aa = p[o + 17]!;
  const dx = Ax - x, dy = Ay - y, dz = Az - z;
  const ky = (kk * (2 * aa + dx * bx + dy * by + dz * bz)) / 3;
  const kz = kk * (dx * ax + dy * ay + dz * az);
  const pp = ky - kx * kx;
  const q = kx * (2 * kx * kx - 3 * ky) + kz;
  let h = q * q + 4 * pp * pp * pp;
  let t: number;
  if (h >= 0) {
    h = Math.sqrt(h);
    t = Math.cbrt((h - q) / 2) + Math.cbrt((-h - q) / 2) - kx;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  } else {
    const zz = Math.sqrt(-pp);
    let c = q / (pp * zz * 2);
    c = c < -1 ? -1 : c > 1 ? 1 : c;
    const v = Math.acos(c) / 3;
    const m = Math.cos(v);
    const n = Math.sin(v) * 1.732050808;
    let t0 = (m + m) * zz - kx;
    let t1 = (-n - m) * zz - kx;
    t0 = t0 < 0 ? 0 : t0 > 1 ? 1 : t0;
    t1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
    // distance² to B(t) − pos = d + (2a + b t) t
    const e0x = dx + (2 * ax + bx * t0) * t0, e0y = dy + (2 * ay + by * t0) * t0, e0z = dz + (2 * az + bz * t0) * t0;
    const e1x = dx + (2 * ax + bx * t1) * t1, e1y = dy + (2 * ay + by * t1) * t1, e1z = dz + (2 * az + bz * t1) * t1;
    t = e0x * e0x + e0y * e0y + e0z * e0z <= e1x * e1x + e1y * e1y + e1z * e1z ? t0 : t1;
  }
  // offset from the curve point to the sample (pos − B(t))
  const vx = -(dx + (2 * ax + bx * t) * t), vy = -(dy + (2 * ay + by * t) * t), vz = -(dz + (2 * az + bz * t) * t);
  const mt = 1 - t;
  const r = mt * mt * p[o + 18]! + 2 * mt * t * p[o + 19]! + t * t * p[o + 20]!;
  const ws = p[o + 24]!, wu = p[o + 25]!;
  if (ws === 1 && wu === 1) return Math.sqrt(vx * vx + vy * vy + vz * vz) - r;
  // local frame: T along the curve, U ≈ up, S = T × U
  let tx = ax + bx * t, ty = ay + by * t, tz = az + bz * t;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  const upx = p[o + 21]!, upy = p[o + 22]!, upz = p[o + 23]!;
  const ud = upx * tx + upy * ty + upz * tz;
  let ux = upx - ud * tx, uy = upy - ud * ty, uz = upz - ud * tz;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const sx = ty * uz - tz * uy, sy = tz * ux - tx * uz, sz = tx * uy - ty * ux;
  const es = (vx * sx + vy * sy + vz * sz) / ws;
  const eu = (vx * ux + vy * uy + vz * uz) / wu;
  const et = vx * tx + vy * ty + vz * tz;
  return (Math.sqrt(es * es + eu * eu + et * et) - r) * (ws < wu ? ws : wu);
}

/** Eyelids of one eye (see shapes `eyelid`). */
function eyelidDist(p: Float64Array, o: number, x: number, y: number, z: number): number {
  const px = x - p[o + 9]!, py = y - p[o + 10]!, pz = z - p[o + 11]!;
  const qx = p[o]! * px + p[o + 1]! * py + p[o + 2]! * pz;
  const qy = p[o + 3]! * px + p[o + 4]! * py + p[o + 5]! * pz;
  const qz = p[o + 6]! * px + p[o + 7]! * py + p[o + 8]! * pz;
  const R = p[o + 12]!, t = p[o + 13]!, edge = p[o + 14]!;
  const aMed = p[o + 15]!, aLat = p[o + 16]!, eMed = p[o + 17]!, eLat = p[o + 18]!;
  const hUp = p[o + 19]!, hLo = p[o + 20]!, gUp = p[o + 21]!, gLo = p[o + 22]!;
  const crease = p[o + 23]!, cDepth = p[o + 24]!, cWidth = p[o + 25]!, back = p[o + 26]!;
  const rh = Math.sqrt(qx * qx + qz * qz);
  const r = Math.sqrt(rh * rh + qy * qy);
  const a = Math.atan2(qx, qz);
  const e = Math.atan2(qy, rh);
  const u = (a - aMed) / (aLat - aMed);
  const uc = u < 0 ? 0 : u > 1 ? 1 : u;
  const base = eMed + (eLat - eMed) * uc;
  let eu = base;
  let el = base;
  let s = 0;
  if (u > 0 && u < 1) {
    eu = base + hUp * Math.sin(Math.PI * Math.pow(u, gUp));
    el = base - hLo * Math.sin(Math.PI * Math.pow(u, gLo));
    s = Math.sin(Math.PI * u);
  }
  const Rm = R + t * 0.5;
  const dOpen = Math.max(e - eu, el - e) * Rm; // < 0 inside the opening
  const dShell = Math.abs(r - Rm) - t * 0.5;
  let d = smax(dShell, -dOpen, edge);
  const dBack = -(qz + back);
  if (dBack > d) d = dBack;
  if (crease > 0 && s > 0) {
    const w = ((e - eu - crease) * Rm) / cWidth;
    d += cDepth * s * Math.exp(-w * w);
  }
  return d;
}

/** Distance of the (culled) node list at a point. */
export function evalList(P: Program, list: Int32Array, n: number, x: number, y: number, z: number): number {
  let acc = Infinity;
  let sp = 0;
  const kind = P.kind;
  for (let li = 0; li < n; li++) {
    const i = list[li]!;
    const kd = kind[i];
    let d: number;
    if (kd === NODE.prim) d = evalPrim(P, i, x, y, z);
    else if (kd === NODE.begin) {
      STACK[sp++] = acc;
      acc = Infinity;
      continue;
    } else {
      d = acc;
      acc = STACK[--sp]!;
    }
    acc = combine(acc, d, P.op[i]!, P.k[i]!);
  }
  return acc;
}

/** Distance of the whole program at a point (no culling). */
export function evalAll(P: Program, x: number, y: number, z: number): number {
  return evalList(P, P.all, P.count, x, y, z);
}

/** Outward unit normal from the distance gradient (tetrahedral finite differences). */
export function gradient(P: Program, list: Int32Array, n: number, x: number, y: number, z: number, eps = 0.05): [number, number, number] {
  const a = evalList(P, list, n, x + eps, y - eps, z - eps);
  const b = evalList(P, list, n, x - eps, y - eps, z + eps);
  const c = evalList(P, list, n, x - eps, y + eps, z - eps);
  const d = evalList(P, list, n, x + eps, y + eps, z + eps);
  const gx = a - b - c + d, gy = -a - b + c + d, gz = -a + b - c + d;
  const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  return [gx / l, gy / l, gz / l];
}
