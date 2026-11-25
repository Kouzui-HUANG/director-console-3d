/**
 * Builds the portrait mesh from MakeHuman assets: modifier values → target weights → morphed base
 * mesh → height / heads-tall solve → pose (skinning) → Catmull–Clark subdivision → normals →
 * optional bust cut with caps → sculpted eyeballs. Output is in millimeters with the soles at
 * y = 0, +Y up, the figure faces +Z (+X = the figure's left). Pure computation (browser, worker
 * or Node).
 */
import type { MhAssets } from './assets.ts';
import { browAt, browEnds, chartOf, guideCurves, makeBrowGuide, type BrowGuide, type BrowSample, type BrowShape, type GuideCurve } from './brows.ts';
import { clipWithCap, type TriMesh } from './clip.ts';
import { eyeball, sphereOf } from './eyes.ts';
import { buildLandmarkIndex, chinBottomY, measure, type LandmarkIndex, type Measures, type V3 } from './measure.ts';
import { buildModifiers, morph, targetWeights, type ModifierDef } from './modifiers.ts';
import { IDENTITY_ROT, headRot, jointPositions, matRot, poseMatrices, rotApply, rotMul, skin, type Mat, type PoseSpec, type Rot } from './skeleton.ts';
import { applyLevel, buildLevel, deepStencil, quadNormals, type SubdivLevel } from './subdivide.ts';

const MM = 100; // MakeHuman units are decimeters

export interface BustCut {
  /** Bottom cut below the eye line, as a fraction of body height (0.19 ≈ mid-chest). */
  below: number;
  /** Side cuts from the median plane at the bottom cut, as a fraction of body height. */
  half: number;
  /**
   * Side cut angle from horizontal in degrees: 90 = vertical planes; smaller angles run outward
   * and up from the bottom corners, cutting hanging arms obliquely below the deltoids.
   */
  sideAngle?: number;
}

export interface HumanSpec {
  /** MakeHuman modifier values (see modifiers.ts). */
  values: Record<string, number>;
  /** Catmull–Clark levels (0–2). */
  level: number;
  bust?: BustCut | null;
  carveEyes?: boolean;
  /** Add sculpted eyeballs (default true). */
  eyes?: boolean;
  /** Absolute body height (cm): solved with the MakeHuman height macro, then a uniform scale. */
  heightCm?: number | null;
  /** Body height divided by head height (vertex to chin): solved with a head scale. */
  headsTall?: number | null;
  pose?: Omit<PoseSpec, 'headScale'>;
  /** Gaze relative to the head, degrees (yaw + = toward the figure's left, pitch + = up). */
  gaze?: { yaw?: number; pitch?: number };
  /** Per MakeHuman vertex weight (0…1) carried to the output as `highlight` (see displacement()). */
  highlight?: Float32Array | null;
  /** Sculpted eyebrows (see brows.ts); none when absent or relief 0. */
  brows?: BrowShape | null;
  /**
   * Skull width above the brows, −2…+2 (0 = unchanged; +1 ≈ 12 % wider from the upper forehead
   * up, −1 ≈ 7 % narrower): our own deformation, the face and the ears stay put (see widenCranium()).
   */
  cranium?: number;
}

export interface HumanMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  missing: number;
  bounds: [number, number, number, number, number, number];
  eyes: { center: [number, number, number]; radius: number }[];
  /** Camera targets (mm): head center and a face close-up point. */
  headCenter: [number, number, number];
  faceCenter: [number, number, number];
  /** Body height in mm (sole to vertex, standing upright) before any cut. */
  height: number;
  /** Measurements in rest orientation (mm, degrees). */
  measures: Measures;
  /** Landmarks in rest orientation (as measured). */
  landmarks: Record<string, V3>;
  /** The same landmarks following the head pose (for display on the posed mesh). */
  posedLandmarks: Record<string, V3>;
  /** How the absolute targets were met: MakeHuman height macro, head scale, uniform scale. */
  solve: { heightMacro: number; headScale: number; scale: number };
  /** Per output vertex weight when the spec asked for a highlight. */
  highlight?: Float32Array;
  /**
   * Eyebrow chart per output vertex, 4 values: mm from the brow's inner end along it, mm above its
   * centre line, position along it (0…1), coverage (0 = no brow) — for engraving strands.
   */
  brow?: Float32Array;
  /** Strand engraving strength for the renderer (0…1). */
  browStrands?: number;
  timing: { morph: number; subdivide: number; finish: number; total: number };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Skull widening per unit of `cranium` (narrowing is gentler: a strongly narrowed top turns into a
 * cone with a dent at the temples), and where it ramps in (fraction of pupils → vertex).
 */
const CRANIUM_PER_UNIT: [number, number] = [0.07, 0.12];
const CRANIUM_RAMP: [number, number] = [0.2, 0.6];

export class HumanBuilder {
  readonly assets: MhAssets;
  readonly modifiers: ModifierDef[];
  readonly landmarks: LandmarkIndex;
  private readonly bodyVerts: Uint32Array;
  private readonly levels: SubdivLevel[] = [];
  private browGuideCache: BrowGuide | null = null;
  /** Compact level-0 body vertices that may carry a brow (front of the head around the brows). */
  private browMask0: Uint32Array | null = null;
  private readonly browCand = new Map<number, { verts: Uint32Array; index: Int32Array; off: Uint32Array; nbr: Uint32Array; fOff: Uint32Array; faces: Uint32Array }>();
  private earMaskCache: Float32Array | null = null;

  constructor(assets: MhAssets) {
    this.assets = assets;
    this.modifiers = buildModifiers(assets);
    this.landmarks = buildLandmarkIndex(assets);
    // compact the body vertices (helpers are not part of the surface)
    const used = Uint32Array.from(new Set(assets.bodyQuads)).sort();
    const map = new Int32Array(assets.meta.vertexCount).fill(-1);
    used.forEach((v, i) => (map[v] = i));
    this.bodyVerts = used;
    const quads = new Uint32Array(assets.bodyQuads.length);
    for (let i = 0; i < quads.length; i++) quads[i] = map[assets.bodyQuads[i]!]!;
    this.levels.push(buildLevel(quads, used.length));
  }

  private level(i: number): SubdivLevel {
    while (this.levels.length <= i) {
      const prev = this.levels[this.levels.length - 1]!;
      this.levels.push(buildLevel(prev.outQuads, prev.nOut));
    }
    return this.levels[i]!;
  }

  /** Body vertex count of a subdivision level (the first vertices of a built mesh without cuts). */
  surfaceVertexCount(level: number): number {
    return level <= 0 ? this.bodyVerts.length : this.level(level - 1).nOut;
  }


  /**
   * A point on the subdivided surface (triangle of level-`level` vertices + barycentric weights)
   * as weights over MakeHuman vertices: position = Σ w · P[v] for any shape of the base mesh.
   */
  surfaceStencil(tri: readonly number[], bary: readonly number[], level: number): [number, number][] {
    const acc = new Map<number, number>();
    for (let i = 0; i < tri.length; i++) {
      if (!bary[i]) continue;
      const st = level > 0 ? (this.level(level - 1), deepStencil(this.levels, tri[i]!, level)) : new Map([[tri[i]!, 1]]);
      for (const [c, x] of st) acc.set(c, (acc.get(c) ?? 0) + x * bary[i]!);
    }
    return [...acc].filter(([, x]) => Math.abs(x) > 1e-6).map(([c, x]) => [this.bodyVerts[c]!, x]);
  }

  /**
   * Positions (mm, soles at y = 0, posed — the frame of built meshes) of stencil points for a
   * spec, without subdividing or meshing: for photo fitting.
   */
  stencilPoints(spec: HumanSpec, stencils: [number, number][][]): Float64Array {
    const { posed, k, soles } = this.prepare(spec, { measure: false });
    const out = new Float64Array(stencils.length * 3);
    stencils.forEach((st, i) => {
      let x = 0, y = 0, z = 0;
      for (const [v, w] of st) {
        x += posed[v * 3]! * w;
        y += posed[v * 3 + 1]! * w;
        z += posed[v * 3 + 2]! * w;
      }
      out[i * 3] = x * k;
      out[i * 3 + 1] = (y - soles) * k;
      out[i * 3 + 2] = z * k;
    });
    return out;
  }

  /** Vertex top, soles, chin (menton) and the head pivot (top of the neck) heights of positions P. */
  private heights(P: Float32Array) {
    let top = -Infinity, soles = Infinity;
    for (const v of this.bodyVerts) {
      const y = P[v * 3 + 1]!;
      if (y > top) top = y;
      if (y < soles) soles = y;
    }
    const menton = chinBottomY(P);
    const sk = this.assets.skeleton;
    let pivot = top - 0.09 * (top - soles); // without a skeleton: about the base of the skull
    if (sk) {
      const verts = sk.joints[sk.head[sk.index.get('head')!]!]!;
      pivot = 0;
      for (const v of verts) pivot += P[v * 3 + 1]! / verts.length;
    }
    return { top, soles, H: top - soles, a: top - pivot, h0: top - menton };
  }

  /**
   * Morph, then meet the absolute targets.
   * Height: P(h) = P0 + max(0, 1−2h)·Dmin + max(0, 2h−1)·Dmax with the MakeHuman height corners,
   * searched for the target minus what the head scale adds; a final uniform scale makes it exact
   * (also beyond the macro's range).
   * Heads-tall r: scaling the head by s about the top of the neck makes it s·h0 tall and the body
   * H − a + s·a (a = vertex above the pivot), so s = (H − a) / (r·h0 − a).
   */
  private shape(spec: HumanSpec) {
    const A = this.assets;
    const values = spec.values;
    const target = spec.heightCm ? spec.heightCm / 10 : null; // decimeters
    const ratio = spec.headsTall && A.skeleton ? clamp(spec.headsTall, 3, 12) : null;
    let heightMacro = clamp(values['macro/Height'] ?? 0.5, 0, 1);
    const headScaleFor = (g: { H: number; a: number; h0: number }) => (ratio === null ? 1 : clamp((g.H - g.a) / (ratio * g.h0 - g.a), 0.5, 2.5));
    let P: Float32Array;
    if (target === null) {
      P = morph(A, targetWeights(A, this.modifiers, values));
    } else {
      P = morph(A, targetWeights(A, this.modifiers, { ...values, 'macro/Height': 0.5 }));
      const corners = (h: number) => new Map([...targetWeights(A, this.modifiers, { ...values, 'macro/Height': h })].filter(([key]) => key.startsWith('macrodetails/height/')));
      const dMin = morph(A, corners(0), undefined, true);
      const dMax = morph(A, corners(1), undefined, true);
      const base = P;
      const body = this.bodyVerts;
      const heightAt = (h: number) => {
        const a = Math.max(0, 1 - 2 * h), b = Math.max(0, 2 * h - 1);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < body.length; i++) {
          const j = body[i]! * 3 + 1;
          const y = base[j]! + a * dMin[j]! + b * dMax[j]!;
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
        return hi - lo;
      };
      // monotone in h: pick the half, then regula falsi
      const solve = (want: number) => {
        const f0 = heightAt(0), f5 = heightAt(0.5), f1 = heightAt(1);
        if (want <= f0) return 0;
        if (want >= f1) return 1;
        let [lo, hi, flo, fhi] = want < f5 ? [0, 0.5, f0, f5] : [0.5, 1, f5, f1];
        let h = lo;
        for (let i = 0; i < 10; i++) {
          h = fhi === flo ? (lo + hi) / 2 : lo + ((want - flo) * (hi - lo)) / (fhi - flo);
          const fh = heightAt(h);
          if (Math.abs(fh - want) < 1e-4) break;
          if (fh < want) [lo, flo] = [h, fh];
          else [hi, fhi] = [h, fh];
        }
        return h;
      };
      heightMacro = solve(target);
      if (ratio !== null) {
        // the head scale adds (s − 1)·a; the head itself barely changes with h
        const g = this.heights(base);
        for (let it = 0; it < 2; it++) {
          const s = headScaleFor({ ...g, H: heightAt(heightMacro) });
          heightMacro = solve(target - (s - 1) * g.a);
        }
      }
      const a = Math.max(0, 1 - 2 * heightMacro), b = Math.max(0, 2 * heightMacro - 1);
      for (let i = 0; i < base.length; i++) base[i] = base[i]! + a * dMin[i]! + b * dMax[i]!;
    }
    // only x changes, so the heights solved above stay exact
    if (spec.cranium) this.widenCranium(P, spec.cranium);
    const g = this.heights(P);
    let headScale = headScaleFor(g);
    let standing = g.H - g.a + headScale * g.a;
    const sk = A.skeleton;
    if (ratio !== null && sk) {
      // the neck blends into the head, so the closed form is approximate: refine on the skinned mesh
      const J = jointPositions(sk, P);
      const at = (s: number) => {
        const m = poseMatrices(sk, J, { headScale: s });
        const h = this.heights(m ? skin(P, sk, m.mats) : P);
        return { r: h.H / h.h0, H: h.H };
      };
      let s0 = 1, r0 = g.H / g.h0;
      let s1 = headScale, m1 = at(s1);
      for (let it = 0; it < 3 && Math.abs(m1.r - ratio) > 1e-3 && m1.r !== r0; it++) {
        const s2 = clamp(s1 + ((ratio - m1.r) * (s1 - s0)) / (m1.r - r0), 0.5, 2.5);
        [s0, r0] = [s1, m1.r];
        s1 = s2;
        m1 = at(s1);
      }
      headScale = s1;
      standing = m1.H;
    }
    return { P, heightMacro, headScale, scale: target !== null ? target / standing : 1, soles: g.soles, standing };
  }

  /**
   * Widen (+) or narrow (−) the skull above the brows without touching the face: x is scaled about
   * the median plane by 1 + k·c·w (k = 0.12 widening, 0.07 narrowing), with w rising smoothly from 20 % to 60 % of the way from the
   * pupils to the vertex (≈ brow level → upper forehead) and fading out on the ears. MakeHuman has
   * no such target: its head width scales the face with the skull, so a photo fit cancels it.
   */
  private widenCranium(P: Float32Array, c: number) {
    const A = this.assets;
    const eyeY = (sphereOf(P, A.eyeVerts[0], 1).center[1] + sphereOf(P, A.eyeVerts[1], 1).center[1]) / 2;
    let top = -Infinity;
    for (const v of this.bodyVerts) if (P[v * 3 + 1]! > top) top = P[v * 3 + 1]!;
    const span = top - eyeY;
    if (!(span > 0)) return;
    const ear = this.earMask();
    const k = (c < 0 ? CRANIUM_PER_UNIT[0] : CRANIUM_PER_UNIT[1]) * c;
    const [t0, t1] = CRANIUM_RAMP;
    for (let v = 0, n = P.length / 3; v < n; v++) {
      const t = (P[v * 3 + 1]! - eyeY) / span;
      if (t <= t0) continue;
      const u = Math.min(1, (t - t0) / (t1 - t0));
      P[v * 3] = P[v * 3]! * (1 + k * u * u * (3 - 2 * u) * (1 - ear[v]!));
    }
  }

  /** 0…1 per vertex: how far the (rigid) ear translation targets move it — 1 on the ears, fading at their roots. */
  private earMask(): Float32Array {
    if (this.earMaskCache) return this.earMaskCache;
    const A = this.assets;
    const m = new Float32Array(A.meta.vertexCount);
    const mag = (e: number) => Math.hypot(A.tDelta[e * 3]!, A.tDelta[e * 3 + 1]!, A.tDelta[e * 3 + 2]!);
    for (const name of ['ears/l-ear-trans-up', 'ears/r-ear-trans-up']) {
      const t = A.targetByName.get(name);
      if (!t) continue;
      let max = 0;
      for (let e = t.offset; e < t.offset + t.count; e++) max = Math.max(max, mag(e));
      if (max > 0) for (let e = t.offset; e < t.offset + t.count; e++) m[A.tIndex[e]!] = Math.max(m[A.tIndex[e]!]!, mag(e) / max);
    }
    return (this.earMaskCache = m);
  }

  /** Shape, solve and pose the level-0 mesh (all vertices, model units) — the first half of build(). */
  private prepare(spec: HumanSpec, o: { measure?: boolean } = {}) {
    const A = this.assets;
    const sk = A.skeleton;
    const { P, heightMacro, headScale, scale, soles, standing } = this.shape(spec);
    const k = MM * scale;
    const toMm = (p: V3): V3 => [p[0] * k, (p[1] - soles) * k, p[2] * k];

    // pose (and head scale) by skinning the level-0 mesh, helpers included
    let posed = P;
    let headR: Rot = IDENTITY_ROT;
    let eyeR: [Rot, Rot] = [IDENTITY_ROT, IDENTITY_ROT];
    let measured = P;
    /** Head bone transforms: measured (rest orientation) → posed. */
    let headPose: { full: Mat; rest: Mat | null } | null = null;
    if (sk) {
      const J = jointPositions(sk, P);
      const pose = poseMatrices(sk, J, { ...spec.pose, headScale });
      if (pose) {
        posed = skin(P, sk, pose.mats);
        headR = matRot(pose.mats[sk.index.get('head')!]!);
        eyeR = [matRot(pose.mats[sk.index.get('eye.L')!]!), matRot(pose.mats[sk.index.get('eye.R')!]!)];
        // measure in rest orientation, with the shape-changing parts of the pose (head scale, shoulders)
        const rest = o.measure !== false && (headScale !== 1 || spec.pose?.shoulderWidth || spec.pose?.shoulderLift) ? poseMatrices(sk, J, { headScale, shoulderWidth: spec.pose?.shoulderWidth, shoulderLift: spec.pose?.shoulderLift }) : null;
        measured = rest ? skin(P, sk, rest.mats) : P;
        headPose = { full: pose.mats[sk.index.get('head')!]!, rest: rest ? rest.mats[sk.index.get('head')!]! : null };
      }
    }
    const gaze = spec.gaze ? headRot(spec.gaze.yaw ?? 0, spec.gaze.pitch ?? 0, 0) : IDENTITY_ROT;
    const eyes = A.eyeVerts.map((vs, i) => {
      const s = sphereOf(posed, vs, 1);
      return { center: toMm(s.center), radius: s.radius * k, basis: rotMul(eyeR[i]!, gaze) };
    });
    const { landmarks, measures } = o.measure === false ? ({ landmarks: {}, measures: null } as unknown as ReturnType<typeof measure>) : measure(measured, this.landmarks, A.eyeVerts, toMm);
    // landmarks on the posed head: mm → raw, undo the rest transform, apply the posed one, → mm
    let posedLandmarks = landmarks;
    if (headPose) {
      const { full, rest } = headPose;
      const inv = rest ? invertAffine(rest) : null;
      posedLandmarks = Object.fromEntries(
        Object.entries(landmarks).map(([name, p]) => {
          let q: V3 = [p[0] / k, p[1] / k + soles, p[2] / k];
          if (inv) q = applyAffine(inv, q);
          return [name, toMm(applyAffine(full, q))];
        }),
      );
    }
    return { posed, headR, eyes, landmarks, posedLandmarks, measures, k, soles, standing, heightMacro, headScale, scale };
  }

  /**
   * How far each MakeHuman vertex moves between two specs (mm, posed, before subdivision),
   * normalized to 0…1 — for "what does this parameter change" highlights.
   */
  displacement(a: HumanSpec, b: HumanSpec): Float32Array {
    const pa = this.prepare(a, { measure: false }), pb = this.prepare(b, { measure: false });
    const n = pa.posed.length / 3;
    const out = new Float32Array(n);
    let max = 0;
    for (let v = 0; v < n; v++) {
      const dx = pa.posed[v * 3]! * pa.k - pb.posed[v * 3]! * pb.k;
      const dy = (pa.posed[v * 3 + 1]! - pa.soles) * pa.k - (pb.posed[v * 3 + 1]! - pb.soles) * pb.k;
      const dz = pa.posed[v * 3 + 2]! * pa.k - pb.posed[v * 3 + 2]! * pb.k;
      out[v] = Math.hypot(dx, dy, dz);
      if (out[v]! > max) max = out[v]!;
    }
    if (max > 0) for (let v = 0; v < n; v++) out[v] = out[v]! / max;
    return out;
  }

  /** The eyebrow guide (brows.ts), found once on the neutral mesh. */
  browGuide(): BrowGuide {
    if (this.browGuideCache) return this.browGuideCache;
    const { posed, landmarks, k, soles } = this.prepare({ values: {}, level: 0 });
    const mm = new Float32Array(posed.length);
    for (let i = 0; i < posed.length; i += 3) {
      mm[i] = posed[i]! * k;
      mm[i + 1] = (posed[i + 1]! - soles) * k;
      mm[i + 2] = posed[i + 2]! * k;
    }
    this.browGuideCache = makeBrowGuide(mm, this.assets.bodyQuads, [landmarks.pupilL!, landmarks.pupilR!]);
    // vertices that may carry a brow: a generous band above the eyes, front of the head
    const eyeY = (landmarks.pupilL![1] + landmarks.pupilR![1]) / 2;
    const front = landmarks.glabella![2] - 50;
    const band: number[] = [];
    this.bodyVerts.forEach((v, i) => {
      const y = mm[v * 3 + 1]! - eyeY;
      if (y > 3 && y < 38 && Math.abs(mm[v * 3]!) < 74 && mm[v * 3 + 2]! > front) band.push(i);
    });
    this.browMask0 = Uint32Array.from(band);
    return this.browGuideCache;
  }

  /** Brow candidates of a subdivision level (compact body indices) and their neighbours along quad edges. */
  private browCandidates(level: number) {
    const cached = this.browCand.get(level);
    if (cached) return cached;
    this.browGuide();
    let M: Float32Array = new Float32Array(this.bodyVerts.length * 3);
    for (const i of this.browMask0!) M[i * 3] = 1;
    for (let l = 0; l < level; l++) M = applyLevel(this.level(l), M);
    const quads = level === 0 ? this.levels[0]!.quads : this.level(level - 1).outQuads;
    const n = M.length / 3;
    const idx = new Int32Array(n).fill(-1);
    const verts: number[] = [];
    for (let v = 0; v < n; v++) {
      if (M[v * 3]! > 1e-4) {
        idx[v] = verts.length;
        verts.push(v);
      }
    }
    const sets = verts.map(() => new Set<number>());
    const inc: number[][] = verts.map(() => []);
    for (let f = 0; f < quads.length; f += 4) {
      for (let c = 0; c < 4; c++) {
        const ia = idx[quads[f + c]!]!, ib = idx[quads[f + ((c + 1) & 3)]!]!;
        if (ia >= 0) inc[ia]!.push(f);
        if (ia >= 0 && ib >= 0) {
          sets[ia]!.add(ib);
          sets[ib]!.add(ia);
        }
      }
    }
    const fOff = new Uint32Array(verts.length + 1);
    inc.forEach((fs, i) => (fOff[i + 1] = fOff[i]! + fs.length));
    const faces = new Uint32Array(fOff[verts.length]!);
    inc.forEach((fs, i) => faces.set(fs, fOff[i]!));
    const off = new Uint32Array(verts.length + 1);
    sets.forEach((st, i) => (off[i + 1] = off[i]! + st.size));
    const nbr = new Uint32Array(off[verts.length]!);
    sets.forEach((st, i) => nbr.set([...st], off[i]!));
    const out = { verts: Uint32Array.from(verts), index: idx, off, nbr, fOff, faces };
    this.browCand.set(level, out);
    return out;
  }

  /**
   * Displace the subdivided body B (mm, compact indices, quads, normals N — updated) by the brow
   * relief; returns the brow chart of the candidates (for the renderer), or null when no vertex
   * carries a brow.
   */
  private sculptBrows(shape: BrowShape, posed: Float32Array, k: number, soles: number, B: Float32Array, N: Float32Array, quads: Uint32Array, level: number): BrowContext | null {
    const g = this.browGuide();
    const at = (st: [number, number][]): V3 => {
      let x = 0, y = 0, z = 0;
      for (const [v, w] of st) {
        x += posed[v * 3]! * w;
        y += posed[v * 3 + 1]! * w;
        z += posed[v * 3 + 2]! * w;
      }
      return [x * k, (y - soles) * k, z * k];
    };
    const curves = guideCurves(g.stencils.map((side) => side.map((row) => row.map(at))));
    const ends = curves.map((c) => browEnds(c, g, shape));
    const cand = this.browCandidates(level);
    // the narrowest edge transition the mesh can show (about 4 / 2 / 1 mm spacing at levels 0–2)
    const aa = 1.05 * [4, 2, 1][Math.min(2, level)]!;
    const n = cand.verts.length;
    const h = new Float32Array(n);
    const chart = new Float32Array(n * 4);
    const ch = { x: 0, y: 0, off: 0 };
    const s: BrowSample = { h: 0, x: 0, y: 0, u: 0, mask: 0 };
    const boxes = guideBoxes(curves);
    let any = false;
    for (let i = 0; i < n; i++) {
      const v = cand.verts[i]!;
      const px = B[v * 3]!, py = B[v * 3 + 1]!, pz = B[v * 3 + 2]!;
      const side = px >= 0 ? 0 : 1;
      const bx = boxes[side]!;
      if (px < bx[0]! || px > bx[3]! || py < bx[1]! || py > bx[4]! || pz < bx[2]! || pz > bx[5]!) continue;
      if (!chartOf(curves[side]!, px, py, pz, ch) || Math.abs(ch.off) > 4) continue;
      browAt(shape, ends[side]!, shape.lift[side]!, ch.x, ch.y, aa, s);
      if (s.mask <= 0) continue;
      h[i] = s.h;
      chart[i * 4] = s.x;
      chart[i * 4 + 1] = s.y;
      chart[i * 4 + 2] = s.u;
      chart[i * 4 + 3] = s.mask;
      any = true;
    }
    if (!any) return null;
    // one smoothing pass along the mesh: the relief follows the surface without stair steps
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const a = cand.off[i]!, b = cand.off[i + 1]!;
      for (let j = a; j < b; j++) sum += h[cand.nbr[j]!]!;
      const hs = b > a ? 0.5 * h[i]! + (0.5 * sum) / (b - a) : h[i]!;
      if (!hs) continue;
      const v = cand.verts[i]!;
      B[v * 3] = B[v * 3]! + N[v * 3]! * hs;
      B[v * 3 + 1] = B[v * 3 + 1]! + N[v * 3 + 1]! * hs;
      B[v * 3 + 2] = B[v * 3 + 2]! + N[v * 3 + 2]! * hs;
    }
    // normals of the candidates again (as quadNormals: area-weighted); the band is wide enough
    // that faces outside it never move
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0, z = 0;
      for (let j = cand.fOff[i]!; j < cand.fOff[i + 1]!; j++) {
        const f = cand.faces[j]!;
        const a = quads[f]! * 3, b = quads[f + 1]! * 3, c = quads[f + 2]! * 3, d = quads[f + 3]! * 3;
        const ux = B[c]! - B[a]!, uy = B[c + 1]! - B[a + 1]!, uz = B[c + 2]! - B[a + 2]!;
        const vx = B[d]! - B[b]!, vy = B[d + 1]! - B[b + 1]!, vz = B[d + 2]! - B[b + 2]!;
        x += uy * vz - uz * vy;
        y += uz * vx - ux * vz;
        z += ux * vy - uy * vx;
      }
      const l = Math.hypot(x, y, z) || 1;
      const v = cand.verts[i]!;
      N[v * 3] = x / l;
      N[v * 3 + 1] = y / l;
      N[v * 3 + 2] = z / l;
    }
    return { index: cand.index, chart };
  }

  build(spec: HumanSpec): HumanMesh {
    const t0 = performance.now();
    const { posed, headR, eyes, landmarks, posedLandmarks, measures, k, soles, standing, heightMacro, headScale, scale } = this.prepare(spec);
    const t1 = performance.now();

    let B: Float32Array = new Float32Array(this.bodyVerts.length * 3);
    for (let i = 0; i < this.bodyVerts.length; i++) {
      const v = this.bodyVerts[i]! * 3;
      B[i * 3] = posed[v]! * k;
      B[i * 3 + 1] = (posed[v + 1]! - soles) * k;
      B[i * 3 + 2] = posed[v + 2]! * k;
    }
    // optional highlight weights ride along through the subdivision (as the x of a vector)
    let H: Float32Array | null = null;
    if (spec.highlight) {
      H = new Float32Array(this.bodyVerts.length * 3);
      for (let i = 0; i < this.bodyVerts.length; i++) H[i * 3] = spec.highlight[this.bodyVerts[i]!] ?? 0;
    }
    let quads = this.levels[0]!.quads;
    const levels = Math.max(0, Math.min(2, Math.round(spec.level)));
    for (let l = 0; l < levels; l++) {
      const L = this.level(l);
      B = applyLevel(L, B);
      if (H) H = applyLevel(L, H);
      quads = L.outQuads;
    }
    const N = quadNormals(B, quads, B.length / 3);
    const browCtx = spec.brows && spec.brows.relief > 0 ? this.sculptBrows(spec.brows, posed, k, soles, B, N, quads, levels) : null;
    const tris = new Uint32Array((quads.length / 4) * 6);
    for (let f = 0, o = 0; f < quads.length; f += 4) {
      tris[o++] = quads[f]!;
      tris[o++] = quads[f + 1]!;
      tris[o++] = quads[f + 2]!;
      tris[o++] = quads[f]!;
      tris[o++] = quads[f + 2]!;
      tris[o++] = quads[f + 3]!;
    }
    const t2 = performance.now();

    let mesh: TriMesh = { positions: B, normals: N, indices: tris };
    if (H) {
      const extra = new Float32Array(H.length / 3);
      for (let i = 0; i < extra.length; i++) extra[i] = H[i * 3]!;
      mesh.extra = extra;
    }
    let source: Int32Array | null = null;
    const mid: V3 = [(eyes[0]!.center[0] + eyes[1]!.center[0]) / 2, (eyes[0]!.center[1] + eyes[1]!.center[1]) / 2, (eyes[0]!.center[2] + eyes[1]!.center[2]) / 2];
    const height = standing * k;
    if (spec.bust) {
      // cut relative to the upright eye line, so a turned head does not move the cut
      const eyeY = (landmarks.pupilL![1] + landmarks.pupilR![1]) / 2;
      const bottom = eyeY - spec.bust.below * height;
      const half = spec.bust.half * height;
      const th = ((spec.bust.sideAngle ?? 90) * Math.PI) / 180;
      const track = !!browCtx;
      mesh = clipWithCap(mesh, { n: [0, 1, 0], d: bottom }, track);
      source = mesh.source ?? null;
      // keep the inner side of lines through (±half, bottom) running outward-up at angle th
      for (const sx of [1, -1]) {
        const n: [number, number, number] = [-sx * Math.sin(th), Math.cos(th), 0];
        mesh = clipWithCap(mesh, { n, d: n[0] * sx * half + n[1] * bottom }, track);
        if (source && mesh.source) source = composeSource(source, mesh.source);
      }
    }
    const bodyCount = mesh.positions.length / 3;
    const parts: TriMesh[] = [mesh, ...(spec.eyes === false ? [] : eyes.map((e) => eyeball(e.center, e.radius * 0.97, { carve: spec.carveEyes !== false }, 96, 64, e.basis)))];
    const merged = mergeMeshes(parts);
    // the brow chart of the final vertices (after the cuts), for engraving strands
    const brow = browCtx ? browChart(merged.positions.length / 3, bodyCount, source, browCtx) : null;
    const bounds: HumanMesh['bounds'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const p = merged.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[i + a]!;
        if (v < bounds[a]!) bounds[a] = v;
        if (v > bounds[a + 3]!) bounds[a + 3] = v;
      }
    }
    const t3 = performance.now();
    const hs = headScale * scale;
    const offset = (o: V3): V3 => {
      const r = rotApply(headR, [o[0] * hs, o[1] * hs, o[2] * hs]);
      return [mid[0] + r[0], mid[1] + r[1], mid[2] + r[2]];
    };
    return {
      ...merged,
      vertexCount: p.length / 3,
      triangleCount: merged.indices.length / 3,
      missing: 0,
      bounds,
      eyes: eyes.map((e) => ({ center: e.center, radius: e.radius })),
      headCenter: offset([0, 5, -35]),
      faceCenter: offset([0, -28, 12]),
      height,
      measures,
      landmarks,
      posedLandmarks,
      solve: { heightMacro, headScale, scale },
      ...(merged.extra ? { highlight: merged.extra } : {}),
      ...(brow ? { brow, browStrands: spec.brows!.texture * Math.min(1, spec.brows!.relief) } : {}),
      timing: { morph: t1 - t0, subdivide: t2 - t1, finish: t3 - t2, total: t3 - t0 },
    };
  }
}

export function mergeMeshes(parts: TriMesh[]): TriMesh {
  const nv = parts.reduce((a, m) => a + m.positions.length, 0);
  const ni = parts.reduce((a, m) => a + m.indices.length, 0);
  const positions = new Float32Array(nv);
  const normals = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  const xs = parts.find((m) => m.extra)?.extraSize ?? 1;
  const extra = parts.some((m) => m.extra) ? new Float32Array((nv / 3) * xs) : null;
  let vo = 0, io = 0;
  for (const m of parts) {
    positions.set(m.positions, vo);
    normals.set(m.normals, vo);
    if (extra && m.extra) extra.set(m.extra, (vo / 3) * xs);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return extra ? { positions, normals, indices, extra, extraSize: xs } : { positions, normals, indices };
}

interface BrowContext {
  /** Compact body vertex → candidate (−1 when not a candidate). */
  index: Int32Array;
  /** Per candidate: brow chart (4 values, see HumanMesh.brow). */
  chart: Float32Array;
}

/** Each guide's bounding box, grown by how far a brow can reach from it (mm). */
function guideBoxes(curves: GuideCurve[]): number[][] {
  return curves.map((c) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let j = 0; j < c.n; j++) {
      for (let a = 0; a < 3; a++) {
        b[a] = Math.min(b[a]!, c.P[j * 3 + a]! - 16);
        b[a + 3] = Math.max(b[a + 3]!, c.P[j * 3 + a]! + 16);
      }
    }
    return b;
  });
}

/** Chain two tracked cuts: output vertex → original vertex. */
function composeSource(first: Int32Array, second: Int32Array): Int32Array {
  const out = new Int32Array(second.length);
  for (let i = 0; i < second.length; i++) out[i] = second[i]! >= 0 ? first[second[i]!]! : -1;
  return out;
}

/** Brow chart of every output vertex (4 values; zeros away from the brows and on the eyes). */
function browChart(total: number, bodyCount: number, source: Int32Array | null, ctx: BrowContext): Float32Array {
  const out = new Float32Array(total * 4);
  for (let o = 0; o < bodyCount; o++) {
    const v = source ? source[o]! : o;
    if (v < 0) continue;
    const i = ctx.index[v]!;
    if (i < 0) continue;
    out.set(ctx.chart.subarray(i * 4, i * 4 + 4), o * 4);
  }
  return out;
}

/** p' = M·p for a row-major 3×4 affine matrix. */
function applyAffine(m: Mat, p: V3): V3 {
  return [m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!, m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!, m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!];
}

/** Inverse of a row-major 3×4 affine matrix. */
function invertAffine(m: Mat): Mat {
  const [a, b, c, , d, e, f, , g, h, i] = [m[0]!, m[1]!, m[2]!, 0, m[4]!, m[5]!, m[6]!, 0, m[8]!, m[9]!, m[10]!];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  const r = [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  const t = [m[3]!, m[7]!, m[11]!];
  const out = new Float64Array(12);
  for (let row = 0; row < 3; row++) {
    out[row * 4] = r[row * 3]!;
    out[row * 4 + 1] = r[row * 3 + 1]!;
    out[row * 4 + 2] = r[row * 3 + 2]!;
    out[row * 4 + 3] = -(r[row * 3]! * t[0]! + r[row * 3 + 1]! * t[1]! + r[row * 3 + 2]! * t[2]!);
  }
  return out;
}
