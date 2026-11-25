/**
 * Photo fitting (pure; browser and Node). Given MediaPipe landmarks of one or more photos, find
 * the camera of each photo and the face parameters that make the sculpture's landmarks project
 * onto the photo's landmarks:
 *  - landmarks on the model: fixed surface points (photo/landmarkMap.ts) evaluated through
 *    subdivision stencils, so they follow every parameter;
 *  - the lower face outline (jaw, chin, cheeks): MediaPipe's oval points lie on the silhouette,
 *    so each is compared with the outermost of its candidate surface points (photo/contourMap.ts)
 *    along the outline's normal — sliding along the outline is free;
 *  - camera: rotation, translation and focal length by Levenberg–Marquardt (several starting yaws);
 *  - shape: regularized Gauss–Newton on the semantic parameters (finite-difference Jacobian,
 *    prior = the starting values), alternating with the camera; expressions are fitted per photo
 *    (started from MediaPipe's blendshapes) so a smile is not mistaken for mouth shape.
 * Errors are in % of the photo's pupil distance (iris centres).
 */
import { buildSpec } from '../core/agent.ts';
import { browLandmark, GUIDE_K, guideCurves, type BrowLandmark } from '../core/mh/brows.ts';
import type { HumanBuilder, HumanSpec } from '../core/mh/human.ts';
import type { V3 as MV3 } from '../core/mh/measure.ts';
import { PARAM_BY_KEY, PARAMS, type ParamGroup } from '../core/params/registry.ts';
import type { ParamValues } from '../core/params/resolve.ts';
import { CONTOUR_LEVEL, CONTOUR_MAP } from './contourMap.ts';
import { LANDMARK_LEVEL, LANDMARK_MAP } from './landmarkMap.ts';
import { BROW_POINTS, FACE_OVAL_ORDER, IRIS_CENTER } from './regions.ts';

export interface Observation {
  width: number;
  height: number;
  /** 478 MediaPipe landmarks: x, y in pixels (z unused). */
  points: ArrayLike<number>;
  blendshapes?: Record<string, number>;
  /** 35 mm-equivalent focal length (from EXIF) if known: a firm prior for the camera. */
  focal35?: number | null;
}

type V3 = [number, number, number];
type M3 = number[]; // row-major 3×3

// ---- small linear algebra --------------------------------------------------------------------

function rodrigues(w: readonly number[]): M3 {
  const th = Math.hypot(w[0]!, w[1]!, w[2]!);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = w[0]! / th, y = w[1]! / th, z = w[2]! / th;
  const c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

/** Solve A x = b for a symmetric positive definite A (n×n, row-major) by Cholesky. */
function solveSPD(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= L[i * n + k]! * L[j * n + k]!;
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i * n + j] = s / L[j * n + j]!;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * y[k]!;
    y[i] = s / L[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * x[k]!;
    x[i] = s / L[i * n + i]!;
  }
  return x;
}

/** Diagonal of the inverse of an SPD matrix (for posterior variances). */
function inverseDiagonal(A: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    e.fill(0);
    e[i] = 1;
    out[i] = solveSPD(A, e, n)[i]!;
  }
  return out;
}

// ---- camera ------------------------------------------------------------------------------------

/**
 * Pinhole camera, image y down. Model frame: mm, +Y up, the face looks along +Z (toward a frontal
 * camera). R = Rodrigues(rot) · diag(1, −1, −1); X_cam = R·X + t; u = f·x/z + cx, v = f·y/z + cy.
 */
export interface Camera {
  rot: V3;
  t: V3;
  f: number;
  cx: number;
  cy: number;
}

export function cameraRotation(cam: Camera): M3 {
  const r = rodrigues(cam.rot);
  // r · diag(1, −1, −1)
  return [r[0]!, -r[1]!, -r[2]!, r[3]!, -r[4]!, -r[5]!, r[6]!, -r[7]!, -r[8]!];
}

export function projectPoints(cam: Camera, X: ArrayLike<number>, out = new Float64Array((X.length / 3) * 2)): Float64Array {
  const R = cameraRotation(cam);
  const n = X.length / 3;
  for (let i = 0; i < n; i++) {
    const x = X[i * 3]!, y = X[i * 3 + 1]!, z = X[i * 3 + 2]!;
    const px = R[0]! * x + R[1]! * y + R[2]! * z + cam.t[0];
    const py = R[3]! * x + R[4]! * y + R[5]! * z + cam.t[1];
    const pz = Math.max(1, R[6]! * x + R[7]! * y + R[8]! * z + cam.t[2]);
    out[i * 2] = (cam.f * px) / pz + cam.cx;
    out[i * 2 + 1] = (cam.f * py) / pz + cam.cy;
  }
  return out;
}

/** Head angles relative to the camera (degrees; yaw + = toward the subject's left), 35 mm-equivalent focal length, distance to the face (mm). */
export function cameraInfo(cam: Camera, obs: Observation, X?: ArrayLike<number>) {
  const R = cameraRotation(cam);
  const F: V3 = [R[2]!, R[5]!, R[8]!]; // model +Z (face direction) in camera coordinates
  const U: V3 = [R[1]!, R[4]!, R[7]!]; // model +Y (up) in camera coordinates
  const deg = 180 / Math.PI;
  return {
    yaw: Math.round(Math.atan2(F[0], -F[2]) * deg),
    pitch: Math.round(Math.atan2(-F[1], Math.hypot(F[0], F[2])) * deg),
    roll: Math.round(Math.atan2(U[0], -U[1]) * deg),
    focal35mm: Math.round((cam.f / Math.max(obs.width, obs.height)) * 36),
    distanceMm: Math.round(X ? faceDistance(cam, X) : Math.hypot(...cam.t)),
  };
}

/** Mean camera-space depth of points (mm). */
function faceDistance(cam: Camera, X: ArrayLike<number>): number {
  const R = cameraRotation(cam);
  let z = 0;
  const n = X.length / 3;
  for (let i = 0; i < n; i++) z += (R[6]! * X[i * 3]! + R[7]! * X[i * 3 + 1]! + R[8]! * X[i * 3 + 2]! + cam.t[2]) / n;
  return z;
}

// ---- the landmark model -----------------------------------------------------------------------

function centroid(X: ArrayLike<number>, n: number): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) {
    x += X[i * 3]! / n;
    y += X[i * 3 + 1]! / n;
    z += X[i * 3 + 2]! / n;
  }
  return [x, y, z];
}

/**
 * Whether vertex v of positions P lies below the jaw line — under the plane through the menton and
 * both gonions, by more than 6 mm (the neck and the throat; the jaw border itself is kept).
 */
export function jawPlaneTest(L: Record<string, readonly number[]>): (P: ArrayLike<number>, v: number) => boolean {
  const A = L.menton, B = L.gonionL, C = L.gonionR;
  if (!A || !B || !C) return () => false;
  const u = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!], w = [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!];
  let n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
  const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
  n = n.map((x) => x / l);
  if (n[1]! < 0) n = n.map((x) => -x); // pointing up, into the head
  return (P, v) => (P[v * 3]! - A[0]!) * n[0]! + (P[v * 3 + 1]! - A[1]!) * n[1]! + (P[v * 3 + 2]! - A[2]!) * n[2]! < -6;
}

/**
 * Whether surface vertex v of subdivision `level` lies on an ear: more than half of its stencil
 * weight on MakeHuman vertices that MakeHuman's ear translation targets move by more than half
 * their full shift (the ear moves rigidly; the head around it only fades along). MediaPipe's face
 * oval passes in front of the ears, so an ear rim must never stand in for the cheek's outline.
 */
export function earTest(builder: HumanBuilder, level: number): (v: number) => boolean {
  const A = builder.assets;
  const ear = new Uint8Array(A.meta.vertexCount);
  for (const name of ['ears/l-ear-trans-up', 'ears/r-ear-trans-up']) {
    const t = A.targetByName.get(name);
    if (!t) continue;
    const d = new Float64Array(t.count);
    let max = 0;
    for (let i = 0; i < t.count; i++) {
      const j = (t.offset + i) * 3;
      d[i] = Math.hypot(A.tDelta[j]!, A.tDelta[j + 1]!, A.tDelta[j + 2]!);
      if (d[i]! > max) max = d[i]!;
    }
    for (let i = 0; i < t.count; i++) if (d[i]! > 0.5 * max) ear[A.tIndex[t.offset + i]!] = 1;
  }
  const cache = new Map<number, boolean>();
  return (v) => {
    let r = cache.get(v);
    if (r === undefined) {
      let on = 0, all = 0;
      for (const [u, w] of builder.surfaceStencil([v], [1], level)) {
        all += w;
        if (ear[u]) on += w;
      }
      r = on > 0.5 * all;
      cache.set(v, r);
    }
    return r;
  };
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

export interface ContourItem {
  /** MediaPipe landmark and its neighbours along the face oval. */
  k: number;
  prev: number;
  next: number;
  /** Candidate silhouette points: indices into LandmarkModel.points(). */
  points: number[];
  /** Calibration observations, 4 per entry: candidate (index into `points`), azimuth, elevation, offset (% pupil distance). */
  obs: Float32Array;
}

/**
 * The outline as seen from one camera direction: per contour item, the candidates and the
 * MediaPipe bias / weight observed from similar directions during calibration (no candidates when
 * the calibration never looked from there).
 */
export interface ContourPlan {
  az: number;
  el: number;
  idx: number[][];
  bias: Float64Array;
  weight: Float64Array;
}

/** What a photo shows, prepared for fitting. */
export interface Observed {
  /** Pixel positions of the mapped surface landmarks. */
  uv: Float64Array;
  /** Pupil distance in pixels. */
  iod: number;
  /** Per contour item: outward normal of the outline (nx, ny) and n·u. */
  contour: Float64Array;
  /** Per contour item: the photo's outline point (pixels). */
  points: Float64Array;
}

/** MediaPipe's points at the brows' inner ends: unreliable on photos (see BROW_FITTED), so light. */
const BROW_INNER = new Set([336, 285, 107, 55]);

export class LandmarkModel {
  readonly builder: HumanBuilder;
  /** MediaPipe indices and weights of the mapped surface landmarks (the first nSurface points). */
  readonly ks: number[];
  readonly weights: Float64Array;
  readonly nSurface: number;
  /** Lower face outline items (their candidate points follow the surface landmarks). */
  readonly contour: ContourItem[] = [];
  private readonly stencils: [number, number][][];
  /** Brow landmarks among the surface points: compared with the sculpted brow's outline (index in ks, guide side 0 = +x). */
  private readonly browItems: { i: number; side: number; m: BrowLandmark }[] = [];
  /** Where the brow guide's stencils start in `stencils`. */
  private guideStart = -1;
  /** Head centre minus the surface landmarks' centroid (mm, neutral face): the pivot of view directions. */
  private readonly headOffset: V3 = [0, 0, 0];

  constructor(builder: HumanBuilder) {
    this.builder = builder;
    this.ks = LANDMARK_MAP.map((r) => r[0]);
    this.weights = Float64Array.from(LANDMARK_MAP, (r) => r[3]);
    this.nSurface = this.ks.length;
    this.stencils = LANDMARK_MAP.map((r) => builder.surfaceStencil([r[1]], [1], LANDMARK_LEVEL));
    const n = FACE_OVAL_ORDER.length;
    // outline candidates must belong to the face: not the neck below the jaw line (neutral face)
    // and not the ears
    let below: ((v: number) => boolean) | null = null;
    if (CONTOUR_MAP.length) {
      const neutral = buildSpec({}).spec;
      const m = builder.build({ ...neutral, level: CONTOUR_LEVEL, bust: null, carveEyes: false });
      const test = jawPlaneTest(m.landmarks);
      const onEar = earTest(builder, CONTOUR_LEVEL);
      below = (v) => test(m.positions, v) || onEar(v);
    }
    for (const [k, all] of CONTOUR_MAP) {
      const i = FACE_OVAL_ORDER.indexOf(k);
      const flat: number[] = [];
      for (let o = 0; o < all.length; o += 4) if (!below!(all[o]!)) flat.push(all[o]!, all[o + 1]!, all[o + 2]!, all[o + 3]!);
      if (i < 0 || !flat.length) continue;
      const local = new Map<number, number>();
      const points: number[] = [];
      const obs = new Float32Array(flat.length);
      for (let o = 0; o < flat.length; o += 4) {
        const v = flat[o]!;
        let li = local.get(v);
        if (li === undefined) {
          li = points.length;
          local.set(v, li);
          points.push(this.stencils.length);
          this.stencils.push(builder.surfaceStencil([v], [1], CONTOUR_LEVEL));
        }
        obs[o] = li;
        obs[o + 1] = flat[o + 1]!;
        obs[o + 2] = flat[o + 2]!;
        obs[o + 3] = flat[o + 3]!;
      }
      this.contour.push({ k, prev: FACE_OVAL_ORDER[(i + n - 1) % n]!, next: FACE_OVAL_ORDER[(i + 1) % n]!, points, obs });
    }
    // brow landmarks: the brow outline instead of fixed vertices (side from where MediaPipe's
    // point sits on the neutral face; the guide's side 0 is the figure's left, +x)
    const browOf = new Map(BROW_POINTS.map((b) => [b.k, b]));
    const guide = builder.browGuide();
    if (this.ks.some((k) => browOf.has(k))) {
      const neutral = buildSpec({}).spec;
      const at = builder.stencilPoints(neutral, this.stencils.slice(0, this.nSurface));
      this.ks.forEach((k, i) => {
        const b = browOf.get(k);
        if (!b) return;
        this.browItems.push({ i, side: at[i * 3]! >= 0 ? 0 : 1, m: b.m });
        this.weights[i] = BROW_INNER.has(k) ? 0.25 : 1;
      });
      this.guideStart = this.stencils.length;
      for (const side of guide.stencils) for (const row of side) for (const st of row) this.stencils.push(st);
    }
    if (this.contour.length) {
      const neutral = buildSpec({}).spec;
      const head = builder.build({ ...neutral, level: 0 }).headCenter;
      const c = centroid(this.points(neutral), this.nSurface);
      this.headOffset = [head[0] - c[0], head[1] - c[1], head[2] - c[2]];
    }
  }

  /** The camera's direction around the head (azimuth, elevation in degrees, as in calibration renders). */
  viewAngles(cam: Camera, X: Float64Array): [number, number] {
    const R = cameraRotation(cam);
    const t = cam.t;
    const C: V3 = [-(R[0]! * t[0] + R[3]! * t[1] + R[6]! * t[2]), -(R[1]! * t[0] + R[4]! * t[1] + R[7]! * t[2]), -(R[2]! * t[0] + R[5]! * t[1] + R[8]! * t[2])];
    const c = centroid(X, this.nSurface);
    const dx = C[0] - c[0] - this.headOffset[0], dy = C[1] - c[1] - this.headOffset[1], dz = C[2] - c[2] - this.headOffset[2];
    const deg = 180 / Math.PI;
    return [Math.atan2(dx, dz) * deg, Math.atan2(dy, Math.hypot(dx, dz)) * deg];
  }

  /** Outline candidates, bias and weight for a camera: calibration views within ±12° / ±10° (widened to ±20° / ±16° when sparse). */
  plan(cam: Camera, X: Float64Array): ContourPlan {
    const [az, el] = this.viewAngles(cam, X);
    const idx: number[][] = [];
    const bias = new Float64Array(this.contour.length);
    const weight = new Float64Array(this.contour.length);
    this.contour.forEach((c, i) => {
      idx[i] = [];
      for (const [wa, we] of [[12, 10], [20, 16]] as const) {
        const cand = new Set<number>();
        const off: number[] = [];
        for (let o = 0; o < c.obs.length; o += 4) {
          if (Math.abs(c.obs[o + 1]! - az) > wa || Math.abs(c.obs[o + 2]! - el) > we) continue;
          cand.add(c.points[c.obs[o]!]!);
          off.push(c.obs[o + 3]!);
        }
        if (off.length < 4) continue;
        const b = median(off);
        const spread = median(off.map((x) => Math.abs(x - b)));
        idx[i] = [...cand];
        bias[i] = b;
        weight[i] = 1 / (spread * spread + 0.25);
        break;
      }
    });
    return { az: Math.round(az), el: Math.round(el), idx, bias, weight };
  }

  /** Model points (mm, the frame of built meshes) for a spec: the surface landmarks, then the outline candidates. */
  points(spec: HumanSpec): Float64Array {
    const X = this.builder.stencilPoints(spec, this.stencils);
    if (this.guideStart >= 0 && spec.brows) {
      const g = this.builder.browGuide();
      const o = this.guideStart;
      const rows = [0, 1].map((side) => [0, 1].map((row) => Array.from({ length: GUIDE_K }, (_, k): MV3 => {
        const j = o + (side * 2 + row) * GUIDE_K + k;
        return [X[j * 3]!, X[j * 3 + 1]!, X[j * 3 + 2]!];
      })));
      const curves = guideCurves(rows);
      for (const b of this.browItems) {
        const p = browLandmark(curves[b.side]!, g, spec.brows, b.side, b.m);
        X[b.i * 3] = p[0];
        X[b.i * 3 + 1] = p[1];
        X[b.i * 3 + 2] = p[2];
      }
    }
    return X;
  }

  /** The surface landmarks of points(). */
  surface(X: Float64Array): Float64Array {
    return X.length > this.nSurface * 3 ? X.subarray(0, this.nSurface * 3) : X;
  }

  observed(obs: Observation): Observed {
    const P = obs.points;
    const uv = new Float64Array(this.ks.length * 2);
    this.ks.forEach((k, i) => {
      uv[i * 2] = P[k * 3]!;
      uv[i * 2 + 1] = P[k * 3 + 1]!;
    });
    const L = IRIS_CENTER.left * 3, Rr = IRIS_CENTER.right * 3;
    const iod = Math.hypot(P[L]! - P[Rr]!, P[L + 1]! - P[Rr + 1]!) || 1;
    // outline normals point away from the face centre (mean of the face mesh points)
    let cx = 0, cy = 0;
    for (let k = 0; k < 468; k++) {
      cx += P[k * 3]! / 468;
      cy += P[k * 3 + 1]! / 468;
    }
    const contour = new Float64Array(this.contour.length * 3);
    const points = new Float64Array(this.contour.length * 2);
    this.contour.forEach((c, i) => {
      const tx = P[c.next * 3]! - P[c.prev * 3]!, ty = P[c.next * 3 + 1]! - P[c.prev * 3 + 1]!;
      const l = Math.hypot(tx, ty) || 1;
      let nx = ty / l, ny = -tx / l;
      const ux = P[c.k * 3]!, uy = P[c.k * 3 + 1]!;
      if (nx * (ux - cx) + ny * (uy - cy) < 0) {
        nx = -nx;
        ny = -ny;
      }
      contour[i * 3] = nx;
      contour[i * 3 + 1] = ny;
      contour[i * 3 + 2] = nx * ux + ny * uy;
      points[i * 2] = ux;
      points[i * 2 + 1] = uy;
    });
    return { uv, iod, contour, points };
  }
}

/** Weighted residuals (% of pupil distance) of projected model points against observations. */
function residuals(cam: Camera, X: Float64Array, uv: Float64Array, iod: number, sw: Float64Array, out?: Float64Array, offset = 0): Float64Array {
  const p = projectPoints(cam, X.length > uv.length * 1.5 ? X.subarray(0, uv.length * 1.5) : X);
  const r = out ?? new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) r[offset + i] = ((uv[i]! - p[i]!) / iod) * 100 * sw[i >> 1]!;
  return r;
}

/**
 * Outline residuals: for each contour item, the photo point's distance outside the model's
 * silhouette along the outline normal (% of pupil distance, minus MediaPipe's bias for this view),
 * weighted. The silhouette point is the candidate that projects furthest out along the normal.
 * Items without candidates in the plan give 0 (NaN when unweighted). With `points`, also returns
 * the silhouette point (pixels) per item.
 */
function contourResiduals(model: LandmarkModel, plan: ContourPlan, cam: Camera, X: Float64Array, ob: Observed, out: Float64Array, offset: number, weighted = true, points?: Float64Array) {
  const R = cameraRotation(cam);
  model.contour.forEach((_, i) => {
    const cand = plan.idx[i]!;
    if (!cand.length) {
      out[offset + i] = weighted ? 0 : NaN;
      return;
    }
    const nx = ob.contour[i * 3]!, ny = ob.contour[i * 3 + 1]!, nu = ob.contour[i * 3 + 2]!;
    const tu = -ny * ob.points[i * 2]! + nx * ob.points[i * 2 + 1]!;
    // the outermost candidate along the normal within a band across the photo point (as calibrated),
    // widened when the band holds none
    const proj = cand.map((j) => {
      const x = X[j * 3]!, y = X[j * 3 + 1]!, z = X[j * 3 + 2]!;
      const pz = Math.max(1, R[6]! * x + R[7]! * y + R[8]! * z + cam.t[2]);
      return [(cam.f * (R[0]! * x + R[1]! * y + R[2]! * z + cam.t[0])) / pz + cam.cx, (cam.f * (R[3]! * x + R[4]! * y + R[5]! * z + cam.t[1])) / pz + cam.cy] as const;
    });
    let best = -Infinity, bx = 0, by = 0;
    for (const band of [0.06, 0.12, Infinity]) {
      for (const [px, py] of proj) {
        if (Math.abs(-ny * px + nx * py - tu) > band * ob.iod) continue;
        const s = nx * px + ny * py;
        if (s > best) {
          best = s;
          bx = px;
          by = py;
        }
      }
      if (best > -Infinity) break;
    }
    out[offset + i] = ((100 * (nu - best)) / ob.iod - plan.bias[i]!) * (weighted ? Math.sqrt(plan.weight[i]!) : 1);
    if (points) {
      points[i * 2] = bx;
      points[i * 2 + 1] = by;
    }
  });
}

const sumSq = (r: Float64Array) => r.reduce((s, x) => s + x * x, 0);

/** Camera by Levenberg–Marquardt; tries several starting yaws when no initial camera is given. */
export function fitCamera(Xall: Float64Array, obs: Observation, model: LandmarkModel, init?: Camera, o: { focalPrior?: number } = {}): { cam: Camera; cost: number } {
  const { uv, iod } = model.observed(obs);
  const X = model.surface(Xall);
  const sw = model.weights.map(Math.sqrt);
  const n = X.length / 3;
  // focal length prior: EXIF when known (firm), else ≈ 43 mm equivalent (weak)
  const f0 = o.focalPrior ?? (obs.focal35 ? (obs.focal35 / 36) * Math.max(obs.width, obs.height) : 1.2 * Math.max(obs.width, obs.height));
  const starts: Camera[] = [];
  if (init) starts.push(init);
  else {
    // place the model so its landmark centroid lands on the observed centroid at a plausible distance
    let mx = 0, my = 0, mz = 0, ux = 0, uy = 0;
    for (let i = 0; i < n; i++) {
      mx += X[i * 3]! / n;
      my += X[i * 3 + 1]! / n;
      mz += X[i * 3 + 2]! / n;
      ux += uv[i * 2]! / n;
      uy += uv[i * 2 + 1]! / n;
    }
    const d = (f0 * 62) / iod; // ~62 mm between the pupils
    const cx = obs.width / 2, cy = obs.height / 2;
    for (const yaw of [0, -0.6, 0.6]) {
      const cam: Camera = { rot: [0, yaw, 0], t: [0, 0, 0], f: f0, cx, cy };
      const R = cameraRotation(cam);
      const c: V3 = [R[0]! * mx + R[1]! * my + R[2]! * mz, R[3]! * mx + R[4]! * my + R[5]! * mz, R[6]! * mx + R[7]! * my + R[8]! * mz];
      cam.t = [((ux - cx) * d) / f0 - c[0], ((uy - cy) * d) / f0 - c[1], d - c[2]];
      starts.push(cam);
    }
  }
  const pack = (c: Camera) => [c.rot[0], c.rot[1], c.rot[2], c.t[0], c.t[1], c.t[2], Math.log(c.f)];
  const unpack = (q: number[], c: Camera): Camera => ({ rot: [q[0]!, q[1]!, q[2]!], t: [q[3]!, q[4]!, q[5]!], f: Math.exp(q[6]!), cx: c.cx, cy: c.cy });
  // a prior keeps the focal length plausible (single photos barely constrain it)
  const focalWeight = obs.focal35 ? 150 : 30;
  const cost = (c: Camera) => sumSq(residuals(c, X, uv, iod, sw)) + (focalWeight * Math.log(c.f / f0)) ** 2;
  let best: { cam: Camera; cost: number } | null = null;
  for (const start of starts) {
    let q = pack(start);
    let c = start;
    let e = cost(c);
    let mu = 1e-3;
    for (let it = 0; it < 40; it++) {
      const r0 = residuals(c, X, uv, iod, sw);
      const m = r0.length;
      // numeric Jacobian (7 columns)
      const J = new Float64Array(m * 7);
      const steps = [1e-4, 1e-4, 1e-4, 0.05, 0.05, 0.05, 1e-4];
      for (let j = 0; j < 7; j++) {
        const qq = [...q];
        qq[j]! += steps[j]!;
        const rj = residuals(unpack(qq, c), X, uv, iod, sw);
        for (let i = 0; i < m; i++) J[i * 7 + j] = (rj[i]! - r0[i]!) / steps[j]!;
      }
      // Gauss–Newton with Levenberg damping: (JᵀJ + μ·diag) Δ = −Jᵀr − prior gradient
      const A = new Float64Array(49), g = new Float64Array(7);
      for (let i = 0; i < m; i++) {
        for (let a = 0; a < 7; a++) {
          g[a]! -= J[i * 7 + a]! * r0[i]!;
          for (let b = 0; b <= a; b++) A[a * 7 + b]! += J[i * 7 + a]! * J[i * 7 + b]!;
        }
      }
      A[48]! += focalWeight * focalWeight;
      g[6]! -= focalWeight * focalWeight * (q[6]! - Math.log(f0));
      for (let a = 0; a < 7; a++) for (let b = 0; b < a; b++) A[b * 7 + a] = A[a * 7 + b]!;
      let improved = false;
      for (let tries = 0; tries < 8; tries++) {
        const H = A.slice();
        for (let a = 0; a < 7; a++) H[a * 8]! += mu * (A[a * 8]! + 1e-6);
        const d = solveSPD(H, g, 7);
        const qn = q.map((v, a) => v + d[a]!);
        const cn = unpack(qn, c);
        const en = cost(cn);
        if (en < e) {
          q = qn;
          c = cn;
          mu = Math.max(1e-7, mu / 3);
          improved = e - en > 1e-9 * e;
          e = en;
          break;
        }
        mu *= 4;
      }
      if (!improved) break;
    }
    if (!best || e < best.cost) best = { cam: c, cost: e };
  }
  return best!;
}

// ---- shape fit ------------------------------------------------------------------------------------

export const FIT_GROUPS: ParamGroup[] = ['head', 'brow', 'eyes', 'nose', 'mouth', 'cheek', 'chin'];
/** Parameters a face photo cannot inform (global scale) or that act on hidden parts. */
export const NOT_FITTED = new Set(['head.size', 'face.eyes.gazeYaw', 'face.eyes.gazePitch']);
/**
 * Brow shape parameters the brow landmarks pin down: the arch. MediaPipe's brow contour follows a
 * brow's thickness and length only loosely, and on photos it puts the inner end where the hair
 * gets dense (faint inner ends read as a wider gap), so gap, thickness, length, density, the inner
 * end and the strands are left to the eye (compare view).
 */
export const BROW_FITTED = new Set(['face.brow.arch', 'face.brow.peak']);
/** Whether the fit adjusts a parameter (by default). */
export const isFitted = (d: { key: string; mh?: unknown; def: number | null }) => (!!d.mh || BROW_FITTED.has(d.key)) && d.def !== null && !NOT_FITTED.has(d.key);
const EXPRESSIONS = ['expr.smile', 'expr.mouthOpen', 'expr.browRaise', 'expr.frown', 'expr.squint'];

/** First guess of the expression from MediaPipe's blendshapes. */
export function expressionFromBlendshapes(b: Record<string, number> = {}): Record<string, number> {
  const g = (k: string) => b[k] ?? 0;
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
  return {
    'expr.smile': c(((g('mouthSmileLeft') + g('mouthSmileRight')) / 2) * 1.4),
    'expr.mouthOpen': c(g('jawOpen') * 1.6),
    'expr.browRaise': c(((g('browInnerUp') + g('browOuterUpLeft') + g('browOuterUpRight')) / 3) * 1.6),
    'expr.frown': c(((g('browDownLeft') + g('browDownRight')) / 2) * 1.6),
    'expr.squint': c(((g('eyeSquintLeft') + g('eyeSquintRight')) / 2) * 1.5),
  };
}

export interface FitOptions {
  groups?: ParamGroup[];
  /** Fit only these parameters (instead of groups). */
  keys?: string[];
  /** estimate (default): fit per photo, keep the first photo's; neutral: fit, then drop; keep: do not fit, keep the current one. */
  expression?: 'estimate' | 'neutral' | 'keep';
  /** Prior strength: higher keeps parameters closer to their starting values. */
  lambda?: number;
  iterations?: number;
  /**
   * Also fit the lower face outline (jaw, chin, cheeks). Off by default: on the synthetic test it
   * matched the silhouette but did not improve the face's proportions on average (see
   * docs/PORTRAIT_PLAN.md, phase 4 log).
   */
  contour?: boolean;
  /**
   * How the outline is used: widths (default) = a second pass that fits only the face-width
   * parameters to the outline, after the landmarks set everything else; all = in the main fit.
   */
  outlineMode?: 'widths' | 'all';
  /** Weight of the outline relative to the surface landmarks (default 1). */
  outlineWeight?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface FitResult {
  /** The complete parameter set to apply (start values with the fitted ones replaced). */
  params: ParamValues;
  /** Fitted parameters that moved noticeably: from → to, with confidence 0…1 (how much the photos determined them). */
  changed: { key: string; label: string; from: number; to: number; confidence: number }[];
  photos: { camera: ReturnType<typeof cameraInfo>; expression: Record<string, number>; before: number; after: number; outlineBefore: number | null; outlineAfter: number | null }[];
  /** Median landmark error over all photos, % of pupil distance. */
  error: { before: number; after: number };
  /** Median face-outline distance (jaw, chin, cheeks), % of pupil distance (null without the contour map). */
  outline: { before: number; after: number } | null;
  iterations: number;
}


function medianError(cam: Camera, X: Float64Array, uv: Float64Array, iod: number): number {
  const p = projectPoints(cam, X.subarray(0, uv.length * 1.5));
  const e: number[] = [];
  for (let i = 0; i < p.length / 2; i++) e.push((Math.hypot(uv[i * 2]! - p[i * 2]!, uv[i * 2 + 1]! - p[i * 2 + 1]!) / iod) * 100);
  return Math.round(median(e) * 100) / 100;
}

/**
 * The parameters cameras are fitted in: no absolute height / heads-tall and no head turn (the
 * camera has them). Build a mesh from these to render with a fitted camera.
 */
export function alignedParams(values: ParamValues): ParamValues {
  const v: ParamValues = { ...values };
  delete v['body.heightCm'];
  delete v['body.headsTall'];
  for (const k of ['pose.headYaw', 'pose.headPitch', 'pose.headRoll']) delete v[k];
  return v;
}

const fitSpec = (values: ParamValues): HumanSpec => buildSpec(alignedParams(values)).spec;

/** Parameters the second (outline) pass may change. */
export const OUTLINE_KEYS = ['head.width', 'face.jaw.width', 'face.chin.width', 'face.cheek.fullness'];

export function fitPortrait(model: LandmarkModel, start: ParamValues, photos: Observation[], o: FitOptions = {}): FitResult {
  if (!photos.length) throw new Error('no photos to fit');
  const useOutline = !!o.contour && model.contour.length > 0;
  if (!useOutline) return fitOnce(model, start, photos, { ...o, contour: false });
  if ((o.outlineMode ?? 'widths') === 'widths' && !o.keys) {
    // pass 1: landmarks for everything; pass 2: the outline for the face widths only
    const first = fitOnce(model, start, photos, { ...o, contour: false });
    const keys = OUTLINE_KEYS.filter((k) => (o.groups ?? FIT_GROUPS).includes(PARAM_BY_KEY.get(k)!.group));
    if (!keys.length) return first;
    const second = fitOnce(model, first.params, photos, { ...o, keys, contour: true, expression: 'keep' });
    const changed = new Map(first.changed.map((c) => [c.key, c]));
    for (const c of second.changed) changed.set(c.key, { ...c, from: changed.get(c.key)?.from ?? c.from });
    return {
      ...second,
      changed: [...changed.values()].filter((c) => Math.abs(c.to - c.from) >= 0.05).sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)),
      photos: second.photos.map((p, i) => ({ ...p, expression: first.photos[i]!.expression, before: first.photos[i]!.before })),
      error: { before: first.error.before, after: second.error.after },
      iterations: first.iterations + second.iterations,
    };
  }
  return fitOnce(model, start, photos, { ...o, contour: true });
}

function fitOnce(model: LandmarkModel, start: ParamValues, photos: Observation[], o: FitOptions): FitResult {
  const groups = o.groups ?? FIT_GROUPS;
  const keys = (o.keys ?? PARAMS.filter((d) => groups.includes(d.group) && isFitted(d)).map((d) => d.key)).filter((k) => {
    const d = PARAM_BY_KEY.get(k);
    if (!d) throw new Error(`unknown parameter ${k}`);
    return !k.startsWith('expr.');
  });
  const exprMode = o.expression ?? 'estimate';
  const fitExpr = exprMode !== 'keep';
  const nS = keys.length;
  const nE = fitExpr ? EXPRESSIONS.length : 0;
  const nP = photos.length;
  const n = nS + nE * nP;
  const lambda = o.lambda ?? 8;
  const iterations = o.iterations ?? 5;
  const valueOf = (k: string) => (start[k] as number | undefined) ?? (PARAM_BY_KEY.get(k)!.def as number);
  // parameter vector, priors and bounds
  const p = new Float64Array(n);
  const prior = new Float64Array(n);
  const sigma = new Float64Array(n);
  const lo = new Float64Array(n), hi = new Float64Array(n);
  keys.forEach((k, j) => {
    const d = PARAM_BY_KEY.get(k)!;
    p[j] = prior[j] = valueOf(k);
    sigma[j] = d.range[0] === 0 ? 0.25 : 0.5;
    lo[j] = d.range[0];
    hi[j] = d.range[1];
  });
  photos.forEach((ph, i) => {
    if (!fitExpr) return;
    const e0 = expressionFromBlendshapes(ph.blendshapes);
    EXPRESSIONS.forEach((k, a) => {
      const j = nS + i * nE + a;
      p[j] = prior[j] = e0[k]!;
      sigma[j] = 0.35;
      lo[j] = 0;
      hi[j] = 1;
    });
  });
  const valuesFor = (q: Float64Array, photo: number): ParamValues => {
    const v: ParamValues = { ...start };
    keys.forEach((k, j) => (v[k] = q[j]!));
    if (fitExpr) EXPRESSIONS.forEach((k, a) => (v[k] = q[nS + photo * nE + a]!));
    return v;
  };
  const obs = photos.map((ph) => model.observed(ph));
  const sw = model.weights.map(Math.sqrt);
  const useContour = (o.contour ?? true) && model.contour.length > 0;
  const nC = useContour ? model.contour.length : 0;
  const rows = 2 * model.nSurface + nC;
  const points = (q: Float64Array, photo: number) => model.points(fitSpec(valuesFor(q, photo)));
  let plans: ContourPlan[] = [];
  const ow = Math.sqrt(o.outlineWeight ?? 1);
  /** All weighted residuals of one photo: surface landmarks, then the outline. */
  const photoResiduals = (cam: Camera, X: Float64Array, i: number) => {
    const out = new Float64Array(rows);
    residuals(cam, X, obs[i]!.uv, obs[i]!.iod, sw, out, 0);
    if (nC) {
      contourResiduals(model, plans[i]!, cam, X, obs[i]!, out, 2 * model.nSurface);
      if (ow !== 1) for (let k = 2 * model.nSurface; k < rows; k++) out[k]! *= ow;
    }
    return out;
  };
  const outlineError = (cam: Camera, X: Float64Array, i: number) => {
    if (!nC) return null;
    const out = new Float64Array(nC);
    contourResiduals(model, plans[i]!, cam, X, obs[i]!, out, 0, false);
    const e = [...out].filter((x) => !Number.isNaN(x)).map(Math.abs);
    return e.length ? Math.round(median(e) * 100) / 100 : null;
  };

  let X = photos.map((_, i) => points(p, i));
  let cams = photos.map((ph, i) => fitCamera(X[i]!, ph, model).cam);
  if (nC) plans = cams.map((c, i) => model.plan(c, X[i]!));
  const before = photos.map((_, i) => medianError(cams[i]!, X[i]!, obs[i]!.uv, obs[i]!.iod));
  const outlineBefore = photos.map((_, i) => outlineError(cams[i]!, X[i]!, i));
  const delta = 0.2;
  let it = 0;
  for (; it < iterations; it++) {
    o.onProgress?.(it, iterations);
    // Jacobian of the weighted residuals with respect to every parameter (cameras fixed)
    const m = rows * nP;
    const r = new Float64Array(m);
    const J = new Float64Array(m * n);
    let row = 0;
    photos.forEach((_, i) => {
      const ri = photoResiduals(cams[i]!, X[i]!, i);
      r.set(ri, row);
      const cols = [...keys.map((_, j) => j), ...(fitExpr ? EXPRESSIONS.map((_, a) => nS + i * nE + a) : [])];
      for (const j of cols) {
        const qp = p.slice(), qm = p.slice();
        qp[j] = Math.min(hi[j]! + delta, p[j]! + delta);
        qm[j] = Math.max(lo[j]! - delta, p[j]! - delta);
        const rp = photoResiduals(cams[i]!, points(qp, i), i);
        const rm = photoResiduals(cams[i]!, points(qm, i), i);
        const span = qp[j]! - qm[j]!;
        // residual = observed − model, so d(model)/dq = −d(residual)/dq
        for (let k = 0; k < ri.length; k++) J[(row + k) * n + j] = -(rp[k]! - rm[k]!) / span;
      }
      row += ri.length;
    });
    // normal equations with the prior: (JᵀJ + λΣ⁻²) Δ = Jᵀr − λΣ⁻²(p − prior)
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let k = 0; k < m; k++) {
      const rk = r[k]!;
      for (let a = 0; a < n; a++) {
        const ja = J[k * n + a]!;
        if (!ja) continue;
        g[a]! += ja * rk;
        for (let b = 0; b <= a; b++) A[a * n + b]! += ja * J[k * n + b]!;
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) A[b * n + a] = A[a * n + b]!;
      const reg = lambda / (sigma[a]! * sigma[a]!);
      A[a * n + a]! += reg;
      g[a]! -= reg * (p[a]! - prior[a]!);
    }
    const d = solveSPD(A, g, n);
    let moved = 0;
    for (let a = 0; a < n; a++) {
      const step = Math.max(-0.4, Math.min(0.4, d[a]!));
      const next = Math.max(lo[a]!, Math.min(hi[a]!, p[a]! + step));
      moved = Math.max(moved, Math.abs(next - p[a]!));
      p[a] = next;
    }
    X = photos.map((_, i) => points(p, i));
    cams = photos.map((ph, i) => fitCamera(X[i]!, ph, model, cams[i]).cam);
    if (nC) plans = cams.map((c, i) => model.plan(c, X[i]!));
    if (moved < 0.01) {
      it++;
      break;
    }
  }
  o.onProgress?.(iterations, iterations);

  // confidence from the posterior variance (last linearization)
  const confidence = new Float64Array(n);
  {
    const m = rows * nP;
    const A = new Float64Array(n * n);
    const J = new Float64Array(m * n);
    let row = 0;
    photos.forEach((_, i) => {
      const cols = [...keys.map((_, j) => j), ...(fitExpr ? EXPRESSIONS.map((_, a) => nS + i * nE + a) : [])];
      const len = rows;
      for (const j of cols) {
        const qp = p.slice(), qm = p.slice();
        qp[j]! += delta;
        qm[j]! -= delta;
        const rp = photoResiduals(cams[i]!, points(qp, i), i);
        const rm = photoResiduals(cams[i]!, points(qm, i), i);
        for (let k = 0; k < len; k++) J[(row + k) * n + j] = (rp[k]! - rm[k]!) / (2 * delta);
      }
      row += len;
    });
    for (let k = 0; k < m; k++) for (let a = 0; a < n; a++) {
      const ja = J[k * n + a]!;
      if (!ja) continue;
      for (let b = 0; b <= a; b++) A[a * n + b]! += ja * J[k * n + b]!;
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) A[b * n + a] = A[a * n + b]!;
      A[a * n + a]! += lambda / (sigma[a]! * sigma[a]!);
    }
    const post = inverseDiagonal(A, n);
    for (let a = 0; a < n; a++) confidence[a] = Math.max(0, Math.min(1, 1 - post[a]! / ((sigma[a]! * sigma[a]!) / lambda)));
  }

  const params: ParamValues = { ...start };
  const changed: FitResult['changed'] = [];
  keys.forEach((k, j) => {
    const v = Math.round(p[j]! * 100) / 100;
    params[k] = v;
    if (Math.abs(v - valueOf(k)) >= 0.05) changed.push({ key: k, label: PARAM_BY_KEY.get(k)!.label, from: valueOf(k), to: v, confidence: Math.round(confidence[j]! * 100) / 100 });
  });
  const exprOf = (i: number) => (fitExpr ? Object.fromEntries(EXPRESSIONS.map((k, a) => [k, Math.round(p[nS + i * nE + a]! * 100) / 100])) : {});
  if (exprMode === 'estimate') Object.assign(params, exprOf(0));
  if (exprMode === 'neutral') for (const k of EXPRESSIONS) delete params[k];
  for (const k of Object.keys(params)) if (PARAM_BY_KEY.get(k)?.def === params[k]) delete params[k];
  const after = photos.map((_, i) => medianError(cams[i]!, X[i]!, obs[i]!.uv, obs[i]!.iod));
  const outlineAfter = photos.map((_, i) => outlineError(cams[i]!, X[i]!, i));
  const med2 = (a: (number | null)[]) => Math.round(median(a.filter((x): x is number => x !== null)) * 100) / 100;
  return {
    params,
    changed: changed.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)),
    photos: photos.map((ph, i) => ({ camera: cameraInfo(cams[i]!, ph, model.surface(X[i]!)), expression: exprOf(i), before: before[i]!, after: after[i]!, outlineBefore: outlineBefore[i]!, outlineAfter: outlineAfter[i]! })),
    error: { before: med2(before), after: med2(after) },
    outline: nC ? { before: med2(outlineBefore), after: med2(outlineAfter) } : null,
    iterations: it,
  };
}

/**
 * Camera and errors for the current parameters (no fitting) — for comparisons. `proj` / `uv` are
 * the model's and the photo's surface landmarks (pixels); `outline` the model's silhouette points
 * and the photo's outline points per contour item, with their normal distances (% pupil distance).
 */
export function alignPhoto(model: LandmarkModel, values: ParamValues, photo: Observation, init?: Camera) {
  const X = model.points(fitSpec(values));
  const { cam } = fitCamera(X, photo, model, init);
  const ob = model.observed(photo);
  const Xs = model.surface(X);
  const proj = projectPoints(cam, Xs);
  const nC = model.contour.length;
  const dist = new Float64Array(nC);
  const silhouette = new Float64Array(nC * 2);
  const plan = nC ? model.plan(cam, X) : null;
  if (plan) contourResiduals(model, plan, cam, X, ob, dist, 0, false, silhouette);
  const outline = model.contour
    .map((c, i) => ({ k: c.k, model: [silhouette[i * 2]!, silhouette[i * 2 + 1]!] as [number, number], photo: [photo.points[c.k * 3]!, photo.points[c.k * 3 + 1]!] as [number, number], distance: Math.round(dist[i]! * 100) / 100 }))
    .filter((c) => !Number.isNaN(c.distance));
  return {
    cam,
    X: Xs,
    proj,
    uv: ob.uv,
    iod: ob.iod,
    error: medianError(cam, Xs, ob.uv, ob.iod),
    outlineError: outline.length ? Math.round(median(outline.map((c) => Math.abs(c.distance))) * 100) / 100 : null,
    outline,
    view: plan ? { az: plan.az, el: plan.el } : null,
    info: cameraInfo(cam, photo, Xs),
  };
}
