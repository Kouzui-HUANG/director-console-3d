/**
 * Sculpted eyebrows: a shallow relief on the skin. MakeHuman's base mesh has no eyebrows (its
 * brows are textured cards, useless on a white sculpture), so they are modelled here.
 *
 * - Guide: per side, a row of surface points along a straight default brow line and a row about
 *   7 mm above it, found once on the neutral mesh (frontal rays from anatomical positions
 *   relative to the pupils) and kept as stencils over MakeHuman vertices — so the guide follows
 *   every shape parameter, expression and head turn.
 * - Chart: per build, each vertex near a brow gets x = arc length along the guide and y = height
 *   above it in the skin's tangent plane (mm; x runs from the inner end outward on both sides).
 * - Shape: head and tail positions along x, arch rise and peak, a thickness profile, a soft lower
 *   and a feathered upper edge → a height field h(x, y), displaced along the vertex normal. Edge
 *   transitions never get narrower than the mesh can show (no jaggies on a 1 mm mesh).
 * - The chart coordinates also go to the renderer, which engraves the hair strands with light
 *   (render/browShader.ts); the same shape gives the brow outline for photo fitting.
 */
import type { V3 } from './measure.ts';

export interface BrowShape {
  /** 0 = no brows (a classical plaster look), 1 = standard, up to 1.5. */
  relief: number;
  /** Relief height at full density before `relief` (mm). */
  height: number;
  /** Inner end moved along the brow (mm, + = away from the midline). */
  headShift: number;
  /** Outer end moved along the brow (mm, + = longer). */
  tailShift: number;
  /** Arch: how far the peak rises above the head–tail line (mm). */
  rise: number;
  /** Peak position along the brow (0 = head … 1 = tail). */
  peak: number;
  /** Vertical thickness at the head, the body and the tail (mm). */
  thick: [number, number, number];
  /** Inner end: 0 = blunt, 1 = thin and fading in. */
  headTaper: number;
  /** Lower and upper edge transitions (mm). */
  soft: [number, number];
  /** Strand engraving strength (0…1), used by the renderer. */
  texture: number;
  /** Vertical offset of the whole brow (mm): figure's left, right. */
  lift: [number, number];
}

/** Guide rows: points per row, their pupil-relative frontal x (outward, mm) and heights. */
export const GUIDE_K = 9;
const GUIDE_X0 = -30, GUIDE_X1 = 32;
const HEAD_X = -15, TAIL_X = 23;
const BASE_Y_HEAD = 15.5, BASE_Y_TAIL = 14.5;
const UPPER_DY = 7;
const SAMPLES = 97;

export interface BrowGuide {
  /** [side][row][k] → stencil over MakeHuman vertices; side 0 = figure's left (+x), row 0 = brow line, 1 = upper row. */
  stencils: [number, number][][][][];
  /** Default inner and outer ends as fractions of the guide length. */
  headFrac: number;
  tailFrac: number;
}

/** A guide row pair evaluated on one mesh: centre-line samples with arc length and tangent frames (mm). */
export interface GuideCurve {
  n: number;
  P: Float64Array;
  T: Float64Array;
  U: Float64Array;
  X: Float64Array;
  len: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Find the guide on the neutral mesh: P = positions of all MakeHuman vertices in mm (neutral,
 * unposed), quads = body quads (MakeHuman indices), pupils = [left, right] pupil centres (mm).
 */
export function makeBrowGuide(P: ArrayLike<number>, quads: ArrayLike<number>, pupils: [V3, V3]): BrowGuide {
  // candidate quads: the front of the head around the brows
  const eyeY = (pupils[0][1] + pupils[1][1]) / 2;
  const front: number[] = [];
  for (let f = 0; f < quads.length; f += 4) {
    let ok = true;
    for (let c = 0; c < 4 && ok; c++) {
      const v = quads[f + c]!;
      const y = P[v * 3 + 1]! - eyeY;
      if (y < -5 || y > 40 || Math.abs(P[v * 3]!) > 80) ok = false;
    }
    if (ok) front.push(f);
  }
  const cast = (x: number, y: number): [number, number][] => {
    let best = -Infinity;
    let hit: [number, number][] | null = null;
    for (const f of front) {
      for (const [i, j, l] of [
        [0, 1, 2],
        [0, 2, 3],
      ] as const) {
        const a = quads[f + i]!, b = quads[f + j]!, c = quads[f + l]!;
        // barycentric of (x, y) in the frontal projection of triangle abc
        const ax = P[a * 3]!, ay = P[a * 3 + 1]!, bx = P[b * 3]!, by = P[b * 3 + 1]!, cx = P[c * 3]!, cy = P[c * 3 + 1]!;
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(det) < 1e-9) continue;
        const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const wc = 1 - wa - wb;
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        const z = wa * P[a * 3 + 2]! + wb * P[b * 3 + 2]! + wc * P[c * 3 + 2]!;
        if (z > best) {
          best = z;
          hit = [
            [a, wa],
            [b, wb],
            [c, wc],
          ];
        }
      }
    }
    if (hit) return hit;
    // no surface under the point (should not happen): the nearest vertex in the projection
    let bd = Infinity, bv = 0;
    for (const f of front) for (let c = 0; c < 4; c++) {
      const v = quads[f + c]!;
      const d = (P[v * 3]! - x) ** 2 + (P[v * 3 + 1]! - y) ** 2 - P[v * 3 + 2]! * 1e-6;
      if (d < bd) [bd, bv] = [d, v];
    }
    return [[bv, 1]];
  };
  const stencils = pupils.map((pu) => {
    const out = Math.sign(pu[0]) || 1;
    return [0, 1].map((row) =>
      Array.from({ length: GUIDE_K }, (_, k) => {
        const xr = GUIDE_X0 + ((GUIDE_X1 - GUIDE_X0) * k) / (GUIDE_K - 1);
        const yr = BASE_Y_HEAD + ((BASE_Y_TAIL - BASE_Y_HEAD) * (xr - HEAD_X)) / (TAIL_X - HEAD_X) + row * UPPER_DY;
        return cast(pu[0] + out * xr, pu[1] + yr);
      }),
    );
  });
  return { stencils, headFrac: (HEAD_X - GUIDE_X0) / (GUIDE_X1 - GUIDE_X0), tailFrac: (TAIL_X - GUIDE_X0) / (GUIDE_X1 - GUIDE_X0) };
}

/** Catmull–Rom through K points at SAMPLES evenly spaced parameters. */
function spline(pts: V3[], out: Float64Array) {
  const K = pts.length;
  for (let s = 0; s < SAMPLES; s++) {
    const t = (s / (SAMPLES - 1)) * (K - 1);
    const i = Math.min(K - 2, Math.floor(t));
    const f = t - i;
    const p0 = pts[Math.max(0, i - 1)]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[Math.min(K - 1, i + 2)]!;
    const f2 = f * f, f3 = f2 * f;
    for (let c = 0; c < 3; c++) {
      out[s * 3 + c] = 0.5 * (2 * p1[c]! + (-p0[c]! + p2[c]!) * f + (2 * p0[c]! - 5 * p1[c]! + 4 * p2[c]! - p3[c]!) * f2 + (-p0[c]! + 3 * p1[c]! - 3 * p2[c]! + p3[c]!) * f3);
    }
  }
}

/** Evaluate both guides from the positions of their stencil points: rows[side][row][k] (mm). */
export function guideCurves(rows: V3[][][]): GuideCurve[] {
  return rows.map(([centre, upper]) => {
    const n = SAMPLES;
    const P = new Float64Array(n * 3), Q = new Float64Array(n * 3);
    spline(centre!, P);
    spline(upper!, Q);
    const T = new Float64Array(n * 3), U = new Float64Array(n * 3), X = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      const a = Math.max(0, s - 1), b = Math.min(n - 1, s + 1);
      let tx = P[b * 3]! - P[a * 3]!, ty = P[b * 3 + 1]! - P[a * 3 + 1]!, tz = P[b * 3 + 2]! - P[a * 3 + 2]!;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      let ux = Q[s * 3]! - P[s * 3]!, uy = Q[s * 3 + 1]! - P[s * 3 + 1]!, uz = Q[s * 3 + 2]! - P[s * 3 + 2]!;
      const d = ux * tx + uy * ty + uz * tz;
      ux -= d * tx;
      uy -= d * ty;
      uz -= d * tz;
      const ul = Math.hypot(ux, uy, uz) || 1;
      T.set([tx, ty, tz], s * 3);
      U.set([ux / ul, uy / ul, uz / ul], s * 3);
      if (s > 0) X[s] = X[s - 1]! + Math.hypot(P[s * 3]! - P[s * 3 - 3]!, P[s * 3 + 1]! - P[s * 3 - 2]!, P[s * 3 + 2]! - P[s * 3 - 1]!);
    }
    return { n, P, T, U, X, len: X[n - 1]! };
  });
}

/** Ends of the brow on a guide (mm along it). */
export function browEnds(c: GuideCurve, g: BrowGuide, shape: BrowShape): [number, number] {
  const head = g.headFrac * c.len + shape.headShift;
  const tail = Math.max(head + 8, g.tailFrac * c.len + shape.tailShift);
  return [head, tail];
}

/** Height of the brow's centre line above the guide at u (mm, before the side's lift). */
function archAt(shape: BrowShape, u: number): number {
  const p = clamp(shape.peak, 0.25, 0.9);
  const x = clamp(u, 0, 1);
  if (x <= p) {
    const s = x / p;
    return shape.rise * (1 - (1 - s) * (1 - s));
  }
  const s = (x - p) / (1 - p);
  return shape.rise * (1 - 0.9 * s * s);
}

/** Vertical thickness at u (mm). */
function thickAt(shape: BrowShape, u: number): number {
  const [th, tb, tt] = shape.thick;
  if (u <= 0.1) return th;
  if (u <= 0.45) return th + (tb - th) * smoothstep(0.1, 0.45, u);
  return tb + (tt - tb) * Math.pow(clamp((u - 0.45) / 0.55, 0, 1), 1.3);
}

export interface BrowSample {
  /** Relief height (mm). */
  h: number;
  /** mm from the inner end along the brow, mm above the centre line, position 0…1, coverage 0…1. */
  x: number;
  y: number;
  u: number;
  mask: number;
}

/**
 * The brow at chart point (x, y) of a guide (mm along it, mm above it); aa = the narrowest edge
 * transition the mesh can show (mm). Writes into `out` and returns it.
 */
export function browAt(shape: BrowShape, ends: [number, number], lift: number, x: number, y: number, aa: number, out: BrowSample): BrowSample {
  const [xh, xt] = ends;
  const L = xt - xh;
  const u = (x - xh) / L;
  out.u = u;
  out.x = x - xh;
  out.h = 0;
  out.mask = 0;
  out.y = 0;
  if (u < -0.15 || u > 1.15) return out;
  // along: crisp or fading inner end, thinning tail, a clean stop just past the tail
  const ramp = 0.8 + 6 * shape.headTaper;
  const dh = x - xh, dt = xt - x;
  let A = smoothstep(-0.6, ramp, dh);
  A *= 1 - 0.55 * (1 - smoothstep(0, 0.3 * L, dt));
  A *= smoothstep(-1.2, 0.5, dt);
  if (A <= 0) return out;
  // across: soft lower edge, feathered upper edge, a slight dome
  const taper = 1 - 0.45 * shape.headTaper * (1 - smoothstep(0, ramp * 1.5, dh));
  const T = thickAt(shape, u) * taper;
  const yc = lift + archAt(shape, u);
  out.y = y - yc;
  const lo = yc - T / 2, hi = yc + T / 2;
  const dl = Math.max(aa, shape.soft[0]), du = Math.max(aa, shape.soft[1]);
  const e = smoothstep(lo - dl / 2, lo + dl / 2, y) * (1 - smoothstep(hi - du / 2, hi + du / 2, y));
  if (e <= 0) return out;
  // highest a little below the centre: the hairs lie up and out from a crisp lower edge
  const d = (y - yc) / (T / 2);
  const dome = 1 - 0.3 * Math.min(1, ((d + 0.3) / 1.3) ** 2);
  out.mask = A * e;
  out.h = shape.relief * shape.height * out.mask * dome;
  return out;
}

/**
 * Chart coordinates of point p on a guide: arc length along it and height above it in the
 * tangent plane (mm), and the distance off the tangent plane; null when p is not near the guide.
 */
export function chartOf(c: GuideCurve, px: number, py: number, pz: number, out: { x: number; y: number; off: number }): boolean {
  const { n, P, T, U, X } = c;
  let best = Infinity, bj = 0;
  for (let j = 0; j < n; j += 6) {
    const d = (px - P[j * 3]!) ** 2 + (py - P[j * 3 + 1]!) ** 2 + (pz - P[j * 3 + 2]!) ** 2;
    if (d < best) [best, bj] = [d, j];
  }
  for (let j = Math.max(0, bj - 6); j <= Math.min(n - 1, bj + 6); j++) {
    const d = (px - P[j * 3]!) ** 2 + (py - P[j * 3 + 1]!) ** 2 + (pz - P[j * 3 + 2]!) ** 2;
    if (d < best) [best, bj] = [d, j];
  }
  if (best > 30 * 30) return false;
  // project onto the segment next to the nearest sample (extrapolating past the ends)
  const j0 = bj === n - 1 ? n - 2 : bj === 0 ? 0 : (px - P[bj * 3]!) * T[bj * 3]! + (py - P[bj * 3 + 1]!) * T[bj * 3 + 1]! + (pz - P[bj * 3 + 2]!) * T[bj * 3 + 2]! >= 0 ? bj : bj - 1;
  const j1 = j0 + 1;
  const sx = P[j1 * 3]! - P[j0 * 3]!, sy = P[j1 * 3 + 1]! - P[j0 * 3 + 1]!, sz = P[j1 * 3 + 2]! - P[j0 * 3 + 2]!;
  const sl = Math.hypot(sx, sy, sz) || 1;
  let t = ((px - P[j0 * 3]!) * sx + (py - P[j0 * 3 + 1]!) * sy + (pz - P[j0 * 3 + 2]!) * sz) / (sl * sl);
  if (j0 > 0 && j1 < n - 1) t = clamp(t, 0, 1);
  const cx = P[j0 * 3]! + sx * t, cy = P[j0 * 3 + 1]! + sy * t, cz = P[j0 * 3 + 2]! + sz * t;
  const w = clamp(t, 0, 1);
  let ux = U[j0 * 3]! * (1 - w) + U[j1 * 3]! * w, uy = U[j0 * 3 + 1]! * (1 - w) + U[j1 * 3 + 1]! * w, uz = U[j0 * 3 + 2]! * (1 - w) + U[j1 * 3 + 2]! * w;
  const tx = sx / sl, ty = sy / sl, tz = sz / sl;
  const du = ux * tx + uy * ty + uz * tz;
  ux -= du * tx;
  uy -= du * ty;
  uz -= du * tz;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const rx = px - cx, ry = py - cy, rz = pz - cz;
  out.x = X[j0]! + t * sl;
  out.y = rx * ux + ry * uy + rz * uz;
  // normal = T × U
  const nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
  out.off = rx * nx + ry * ny + rz * nz;
  return true;
}

/** Height of the brow's centre line above the guide at u (mm). */
export function browCenterY(shape: BrowShape, side: number, u: number): number {
  return shape.lift[side]! + archAt(shape, clamp(u, 0, 1));
}

/** Half the brow's vertical thickness at u (mm), with the inner end's taper. */
export function browHalf(shape: BrowShape, ends: [number, number], u: number): number {
  const x = ends[0] + u * (ends[1] - ends[0]);
  const taper = 1 - 0.45 * shape.headTaper * (1 - smoothstep(0, (0.8 + 6 * shape.headTaper) * 1.5, x - ends[0]));
  return (thickAt(shape, clamp(u, 0, 1)) * taper) / 2;
}

/** Chart height (mm above the guide) of the brow's edge at u: edge −1 = lower, 0 = centre line, +1 = upper. */
export function browEdgeY(shape: BrowShape, side: number, ends: [number, number], u: number, edge: number): number {
  return browCenterY(shape, side, u) + edge * browHalf(shape, ends, u);
}

/** Point of the skin (mm) at u along the brow and y mm above the guide (extrapolating past its ends). */
export function browPoint(c: GuideCurve, ends: [number, number], u: number, y: number): V3 {
  const x = ends[0] + u * (ends[1] - ends[0]);
  const { n, P, U, X } = c;
  let j = 0;
  while (j < n - 2 && X[j + 1]! < x) j++;
  const sl = X[j + 1]! - X[j]! || 1;
  const t = (x - X[j]!) / sl;
  const w = clamp(t, 0, 1);
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = P[j * 3 + k]! + (P[(j + 1) * 3 + k]! - P[j * 3 + k]!) * t + (U[j * 3 + k]! * (1 - w) + U[(j + 1) * 3 + k]! * w) * y;
  return out;
}

/**
 * Where MediaPipe puts one of its brow points (calibrated, photo/regions.ts): along the brow
 * x = along + alongPerLength·L mm from the inner end (L = brow length), and above the centre line
 * y = across + acrossPerHalf·(half thickness) mm. The calibration uses a fixed fraction along the
 * brow (along = 0) and a fixed offset from the edge (acrossPerHalf = ±1).
 */
export interface BrowLandmark {
  along: number;
  alongPerLength: number;
  across: number;
  acrossPerHalf: number;
}

/** The point of a brow landmark on the skin (mm). */
export function browLandmark(c: GuideCurve, g: BrowGuide, shape: BrowShape, side: number, m: BrowLandmark): V3 {
  const ends = browEnds(c, g, shape);
  const L = ends[1] - ends[0];
  const u = (m.along + m.alongPerLength * L) / L;
  return browPoint(c, ends, u, browCenterY(shape, side, u) + m.across + m.acrossPerHalf * browHalf(shape, ends, u));
}

/** A point of the brow outline (mm): u along the brow, edge −1 = lower, 0 = centre, +1 = upper. */
export function browOutline(c: GuideCurve, g: BrowGuide, shape: BrowShape, side: number, u: number, edge: number): V3 {
  const ends = browEnds(c, g, shape);
  return browPoint(c, ends, u, browEdgeY(shape, side, ends, u, edge));
}
