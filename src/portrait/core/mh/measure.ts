/**
 * Anthropometric landmarks and measurements on the hm08 topology. MakeHuman targets move
 * vertices consistently, so landmarks are picked from small candidate sets of base-mesh vertices
 * (found once by inspecting the base mesh) with a geometric rule per build — e.g. the nasion is
 * the deepest point of the median profile between glabella and nose. Bilateral landmarks are
 * defined on the figure's left (+X) and mirrored.
 */
import type { MhAssets } from './assets.ts';
import { sphereOf } from './eyes.ts';

export type V3 = [number, number, number];

/**
 * Median-profile candidate vertices (base-mesh indices, top to bottom). Convex points use the
 * most anterior candidate; concave points (nasion, subnasale, labiomental fold) the deepest one
 * behind the chord between their neighbours; the menton is the chin corner furthest outside the
 * chord from pogonion to the throat.
 */
const PROFILE = {
  glabella: [251, 5192, 244, 3750, 5320, 237, 234, 227, 220],
  bridge: [237, 234, 227, 220, 169, 136, 132, 133, 134, 135, 131, 5063],
  pronasale: [5063, 164, 201, 291, 5134, 294, 5054, 297, 302, 307],
  columella: [302, 307, 312, 317, 343, 5072, 5342, 362],
  labraleSuperius: [362, 455, 466, 467, 509, 468],
  labraleInferius: [494, 513, 495, 496, 492],
  labiomental: [496, 492, 5337, 491, 724, 733],
  pogonion: [733, 5162, 5211, 5171],
  chinBottom: [5211, 5171, 5225, 5296, 732, 747, 780, 991, 783],
  opisthocranion: [948, 955, 5389, 962, 5379, 969],
} as const;
/** Throat point closing the chin-bottom chord. */
const THROAT = 787;
/** Lips meet between these two median vertices: the upper lip's edge and the lower lip's edge. */
const STOMION: [number, number] = [474, 493];
/** Left-side fixed points: nasal ala (widest), mouth corner. */
const ALARE_L = 7057;
const CHEILION_L = 7129;
/** Eyelid margin sampling: directions around the gaze axis. */
const LID_SECTORS = 48;

/**
 * The visible opening of the left eye seen from the front: for directions around the gaze,
 * march from the cornea outward until a ray toward the viewer (+Z) is blocked by the lids; the
 * lid vertex nearest that boundary point is a margin vertex. Run once on the base mesh.
 */
function lidMargin(A: MhAssets, isBody: Uint8Array): number[] {
  const P = A.base;
  const eye = sphereOf(P, A.eyeVerts[0], 1);
  const [cx, cy, cz] = eye.center;
  const R = eye.radius;
  const gap = (v: number) => Math.hypot(P[v * 3]! - cx, P[v * 3 + 1]! - cy, P[v * 3 + 2]! - cz) - R;
  const near = (v: number) => gap(v) < 0.6 * R && P[v * 3 + 2]! > cz;
  // blockers: lid skin in front of the eyeball (the caruncle and the inner lid surfaces touch or
  // sink into the eyeball and belong to the opening)
  const skin = (v: number) => gap(v) > 0.00025;
  const tris: number[] = [];
  const Q = A.bodyQuads;
  for (let f = 0; f < Q.length; f += 4) {
    const q = [Q[f]!, Q[f + 1]!, Q[f + 2]!, Q[f + 3]!];
    if (!q.some(near)) continue;
    if (skin(q[0]!) && skin(q[1]!) && skin(q[2]!)) tris.push(q[0]!, q[1]!, q[2]!);
    if (skin(q[0]!) && skin(q[2]!) && skin(q[3]!)) tris.push(q[0]!, q[2]!, q[3]!);
  }
  const lids = [...new Set(tris)].filter((v) => isBody[v]);
  // is the ray from (x, y, z) toward +Z blocked?
  const blocked = (x: number, y: number, z: number) => {
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]! * 3, b = tris[t + 1]! * 3, c = tris[t + 2]! * 3;
      const x0 = P[a]!, y0 = P[a + 1]!, x1 = P[b]!, y1 = P[b + 1]!, x2 = P[c]!, y2 = P[c + 1]!;
      const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(den) < 1e-12) continue;
      const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / den;
      const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      if (l0 * P[a + 2]! + l1 * P[b + 2]! + l2 * P[c + 2]! > z) return true;
    }
    return false;
  };
  const out = new Set<number>();
  const step = (0.5 * Math.PI) / 180;
  for (let i = 0; i < LID_SECTORS; i++) {
    const phi = (2 * Math.PI * i) / LID_SECTORS;
    let last: [number, number] | null = null;
    for (let th = 0; th < (80 * Math.PI) / 180; th += step) {
      const r = R + 1e-4;
      const x = cx + r * Math.sin(th) * Math.cos(phi), y = cy + r * Math.sin(th) * Math.sin(phi), z = cz + r * Math.cos(th);
      if (blocked(x, y, z)) break;
      last = [x, y];
    }
    if (!last) continue;
    let best = -1, bd = Infinity;
    for (const v of lids) {
      const d = Math.hypot(P[v * 3]! - last[0], P[v * 3 + 1]! - last[1]);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best >= 0) out.add(best);
  }
  return [...out];
}

export interface LandmarkIndex {
  /** Mirror vertex (x → −x) for every vertex (itself when none). */
  mirror: Uint32Array;
  /** Eyelid margin of the left eye (the boundary of the visible opening), all / upper / lower lid. */
  lidMargin: Uint32Array;
  lidUpper: Uint32Array;
  lidLower: Uint32Array;
  /** Vertices of the left ear. */
  ear: Uint32Array;
  /** Vertices driven mainly by the jaw / by the head (and its children). */
  jaw: Uint32Array;
  head: Uint32Array;
  /** Body surface vertices. */
  body: Uint32Array;
}

export function buildLandmarkIndex(A: MhAssets): LandmarkIndex {
  const P = A.base;
  const n = P.length / 3;
  const isBody = new Uint8Array(n);
  for (const v of A.bodyQuads) isBody[v] = 1;
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const byPos = new Map<string, number>();
  for (let v = 0; v < n; v++) byPos.set(key(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!), v);
  const mirror = new Uint32Array(n);
  for (let v = 0; v < n; v++) mirror[v] = byPos.get(key(-P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!)) ?? v;

  const ring = lidMargin(A, isBody);
  const eyeY = sphereOf(P, A.eyeVerts[0], 1).center[1];

  // ear: the vertices the (rigid) ear translation target moves by ≥ 90 % of its maximum
  const ear: number[] = [];
  const t = A.targetByName.get('ears/l-ear-trans-up');
  if (t) {
    let max = 0;
    const mag = (e: number) => Math.hypot(A.tDelta[e * 3]!, A.tDelta[e * 3 + 1]!, A.tDelta[e * 3 + 2]!);
    for (let e = t.offset; e < t.offset + t.count; e++) if (isBody[A.tIndex[e]!]) max = Math.max(max, mag(e));
    for (let e = t.offset; e < t.offset + t.count; e++) if (isBody[A.tIndex[e]!] && mag(e) >= 0.9 * max) ear.push(A.tIndex[e]!);
  }

  // dominant bone per vertex: jaw / head descendants
  const jaw: number[] = [];
  const head: number[] = [];
  const sk = A.skeleton;
  if (sk) {
    const headBone = sk.index.get('head')!;
    const jawBone = sk.index.get('jaw')!;
    const underHead = new Uint8Array(sk.names.length);
    for (let b = 0; b < sk.names.length; b++) {
      const p = sk.parent[b]!;
      underHead[b] = b === headBone || (p >= 0 && underHead[p]) ? 1 : 0;
    }
    for (let v = 0; v < n; v++) {
      if (!isBody[v]) continue;
      let hw = 0;
      for (let k = 0; k < 4; k++) if (underHead[sk.bones[v * 4 + k]!]) hw += sk.weights[v * 4 + k]!;
      if (hw > 0.95) head.push(v);
      if (sk.bones[v * 4] === jawBone && sk.weights[v * 4]! > 0.5) jaw.push(v);
    }
  }
  const body: number[] = [];
  for (let v = 0; v < n; v++) if (isBody[v]) body.push(v);
  return { mirror, lidMargin: Uint32Array.from(ring), lidUpper: Uint32Array.from(ring.filter((v) => P[v * 3 + 1]! > eyeY)), lidLower: Uint32Array.from(ring.filter((v) => P[v * 3 + 1]! <= eyeY)), ear: Uint32Array.from(ear), jaw: Uint32Array.from(jaw), head: Uint32Array.from(head), body: Uint32Array.from(body) };
}

export interface Measures {
  /** Sole to vertex, mm. */
  height: number;
  /** Vertex to menton. */
  headHeight: number;
  headsTall: number;
  headWidth: number;
  headLength: number;
  /** Nasion to menton. */
  faceHeight: number;
  /** Bizygomatic width. */
  faceWidth: number;
  /** Bigonial (jaw) width. */
  jawWidth: number;
  /** Glabella to subnasale, subnasale to menton. */
  midFace: number;
  lowerFace: number;
  /** Pupil distance, inner and outer eye corners. */
  ipd: number;
  intercanthal: number;
  biocular: number;
  eyeWidth: number;
  /** Palpebral opening (upper to lower lid margin). */
  eyeOpening: number;
  /** Outer corner above the inner corner, degrees. */
  canthalTilt: number;
  noseWidth: number;
  noseHeight: number;
  noseProtrusion: number;
  mouthWidth: number;
  /** Subnasale to stomion. */
  upperLipHeight: number;
  upperLip: number;
  lowerLip: number;
  /** Labiomental fold to menton. */
  chinHeight: number;
  /** Pogonion ahead of subnasale (negative = receding chin). */
  chinProjection: number;
  earLength: number;
  /** Ear top above the eye center. */
  earTop: number;
  /** Upper lip edge above the lower lip edge at the midline (negative = the lips cross). */
  lipGap: number;
}

export interface MeasureResult {
  landmarks: Record<string, V3>;
  measures: Measures;
}

/** Lowest chin point (menton) height of positions P, raw units — the same rule as `measure`. */
export function chinBottomY(P: Float32Array): number {
  const at = (v: number): V3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  let pog = at(PROFILE.pogonion[0]);
  for (const v of PROFILE.pogonion) if (P[v * 3 + 2]! > pog[2]) pog = at(v);
  const t = at(THROAT);
  const du = t[2] - pog[2], dw = t[1] - pog[1];
  let best = -Infinity, y = pog[1];
  for (const v of PROFILE.chinBottom) {
    const p = at(v);
    const s = du * (p[1] - pog[1]) - dw * (p[2] - pog[2]);
    if (s > best) {
      best = s;
      y = p[1];
    }
  }
  return y;
}

/**
 * Measure a body in rest orientation. `P`: all vertex positions; `toMm` maps a stored position to
 * millimeters with the soles at y = 0.
 */
export function measure(P: Float32Array, idx: LandmarkIndex, eyeVerts: [Uint32Array, Uint32Array], toMm: (p: V3) => V3): MeasureResult {
  const at = (v: number): V3 => toMm([P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
  const pick = (verts: readonly number[] | Uint32Array, score: (p: V3) => number): V3 => {
    let best: V3 = at(verts[0]!);
    let bs = -Infinity;
    for (const v of verts) {
      const p = at(v);
      const s = score(p);
      if (s > bs) {
        bs = s;
        best = p;
      }
    }
    return best;
  };
  const front = (p: V3) => p[2];
  /** Signed distance from the chord a→b in the profile plane (z forward, y up): + = outside/forward. */
  const chord = (a: V3, b: V3) => {
    const du = b[2] - a[2], dw = b[1] - a[1];
    const l = Math.hypot(du, dw) || 1;
    return (p: V3) => (du * (p[1] - a[1]) - dw * (p[2] - a[2])) / l;
  };
  const L: Record<string, V3> = {};
  L.glabella = pick(PROFILE.glabella, front);
  L.pronasale = pick(PROFILE.pronasale, front);
  L.labraleSuperius = pick(PROFILE.labraleSuperius, front);
  L.labraleInferius = pick(PROFILE.labraleInferius, front);
  L.pogonion = pick(PROFILE.pogonion, front);
  L.opisthocranion = pick(PROFILE.opisthocranion, (p) => -p[2]);
  const behind = (a: V3, b: V3) => {
    const f = chord(a, b);
    return (p: V3) => -f(p);
  };
  L.nasion = pick(PROFILE.bridge, behind(L.glabella, L.pronasale));
  L.subnasale = pick(PROFILE.columella, behind(L.pronasale, L.labraleSuperius));
  L.labiomental = pick(PROFILE.labiomental, behind(L.labraleInferius, L.pogonion));
  L.menton = pick(PROFILE.chinBottom, chord(L.pogonion, at(THROAT)));
  const a = at(STOMION[0]), b = at(STOMION[1]);
  L.stomion = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  let top: V3 = [0, -Infinity, 0];
  let soles = Infinity;
  for (const v of idx.body) {
    const p = at(v);
    if (p[1] > top[1]) top = p;
    if (p[1] < soles) soles = p[1];
  }
  L.vertex = top;
  const both = (name: string, verts: Uint32Array | number[], score: (p: V3) => number, mirrored: (p: V3) => number) => {
    L[`${name}L`] = pick(verts, score);
    L[`${name}R`] = pick(Array.from(verts, (v) => idx.mirror[v]!), mirrored);
  };
  both('exocanthion', idx.lidMargin, (p) => p[0], (p) => -p[0]);
  both('endocanthion', idx.lidMargin, (p) => -p[0], (p) => p[0]);
  L.alareL = at(ALARE_L);
  L.alareR = at(idx.mirror[ALARE_L]!);
  L.cheilionL = at(CHEILION_L);
  L.cheilionR = at(idx.mirror[CHEILION_L]!);
  if (idx.ear.length) {
    both('superaurale', idx.ear, (p) => p[1], (p) => p[1]);
    both('subaurale', idx.ear, (p) => -p[1], (p) => -p[1]);
  }
  const eyes = eyeVerts.map((vs) => {
    const c: V3 = [0, 0, 0];
    for (const v of vs) {
      const p = at(v);
      for (let k = 0; k < 3; k++) c[k]! += p[k]! / vs.length;
    }
    return c;
  });
  L.pupilL = eyes[0]!;
  L.pupilR = eyes[1]!;
  // lid margins straight above / below the pupil (stays right when the lids close or cross)
  const atPupil = (verts: Uint32Array, mirrored: boolean, px: number) => pick(mirrored ? Array.from(verts, (v) => idx.mirror[v]!) : verts, (p) => -Math.abs(p[0] - px));
  L.palpebraleSuperiusL = atPupil(idx.lidUpper, false, eyes[0]![0]);
  L.palpebraleSuperiusR = atPupil(idx.lidUpper, true, eyes[1]![0]);
  L.palpebraleInferiusL = atPupil(idx.lidLower, false, eyes[0]![0]);
  L.palpebraleInferiusR = atPupil(idx.lidLower, true, eyes[1]![0]);
  const eyeY = (eyes[0]![1] + eyes[1]![1]) / 2;
  const earTopY = L.superauraleL ? L.superauraleL[1] : eyeY + 30;
  // widest points: head above the ears (eurion), cheekbones in front of the ears (zygion), jaw (gonion)
  const head = idx.head.length ? idx.head : idx.body;
  const earFrontZ = L.subauraleL ? L.subauraleL[2] + 12 : eyes[0]![2] - 60;
  const widest = (name: string, verts: Uint32Array, ok: (p: V3) => boolean) => {
    let l: V3 | null = null, r: V3 | null = null;
    for (const v of verts) {
      const p = at(v);
      if (!ok(p)) continue;
      if (p[0] > 0 && (!l || p[0] > l[0])) l = p;
      if (p[0] < 0 && (!r || p[0] < r[0])) r = p;
    }
    if (l && r) {
      L[`${name}L`] = l;
      L[`${name}R`] = r;
    }
  };
  widest('eurion', head, (p) => p[1] > earTopY + 8);
  widest('zygion', head, (p) => p[1] < eyeY && p[1] > L.subnasale![1] && p[2] > earFrontZ);
  widest('gonion', idx.jaw.length ? idx.jaw : head, (p) => p[1] < L.cheilionL![1] && p[1] > L.menton![1]);

  const d = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const w = (name: string) => (L[`${name}L`] && L[`${name}R`] ? L[`${name}L`]![0] - L[`${name}R`]![0] : 0);
  const mean = (f: (s: 'L' | 'R') => number) => (f('L') + f('R')) / 2;
  const height = top[1] - soles;
  const headHeight = top[1] - L.menton![1];
  const m: Measures = {
    height,
    headHeight,
    headsTall: height / headHeight,
    headWidth: w('eurion'),
    headLength: L.glabella![2] - L.opisthocranion![2],
    faceHeight: L.nasion![1] - L.menton![1],
    faceWidth: w('zygion'),
    jawWidth: w('gonion'),
    midFace: L.glabella![1] - L.subnasale![1],
    lowerFace: L.subnasale![1] - L.menton![1],
    ipd: d(eyes[0]!, eyes[1]!),
    intercanthal: w('endocanthion'),
    biocular: w('exocanthion'),
    eyeWidth: mean((s) => d(L[`exocanthion${s}`]!, L[`endocanthion${s}`]!)),
    eyeOpening: mean((s) => L[`palpebraleSuperius${s}`]![1] - L[`palpebraleInferius${s}`]![1]),
    canthalTilt: mean((s) => (Math.atan2(L[`exocanthion${s}`]![1] - L[`endocanthion${s}`]![1], Math.abs(L[`exocanthion${s}`]![0] - L[`endocanthion${s}`]![0])) * 180) / Math.PI),
    noseWidth: w('alare'),
    noseHeight: L.nasion![1] - L.subnasale![1],
    noseProtrusion: L.pronasale![2] - L.subnasale![2],
    mouthWidth: w('cheilion'),
    upperLipHeight: L.subnasale![1] - L.stomion[1],
    upperLip: L.labraleSuperius![1] - L.stomion[1],
    lowerLip: L.stomion[1] - L.labraleInferius![1],
    chinHeight: L.labiomental![1] - L.menton![1],
    chinProjection: L.pogonion![2] - L.subnasale![2],
    earLength: L.superauraleL && L.subauraleL ? mean((s) => L[`superaurale${s}`]![1] - L[`subaurale${s}`]![1]) : 0,
    earTop: L.superauraleL ? mean((s) => L[`superaurale${s}`]![1]) - eyeY : 0,
    lipGap: a[1] - b[1],
  };
  return { landmarks: L, measures: m };
}

/** Labels for the measures (Traditional Chinese), for panels and agent output. */
export const MEASURE_LABELS: Record<keyof Measures, string> = {
  height: '身高',
  headHeight: '頭高（頭頂到下巴）',
  headsTall: '頭身比',
  headWidth: '頭寬',
  headLength: '頭長（前後）',
  faceHeight: '臉高（鼻根到下巴）',
  faceWidth: '臉寬（顴骨間）',
  jawWidth: '下顎寬',
  midFace: '中庭（眉間到鼻底）',
  lowerFace: '下庭（鼻底到下巴）',
  ipd: '瞳距',
  intercanthal: '內眼角距離',
  biocular: '外眼角距離',
  eyeWidth: '眼裂寬',
  eyeOpening: '睜眼高度',
  canthalTilt: '眼尾上揚角度（度）',
  noseWidth: '鼻翼寬',
  noseHeight: '鼻長',
  noseProtrusion: '鼻尖突出',
  mouthWidth: '嘴寬',
  upperLipHeight: '人中＋上唇高',
  upperLip: '上唇厚',
  lowerLip: '下唇厚',
  chinHeight: '下巴高',
  chinProjection: '下巴前突（相對鼻底）',
  earLength: '耳長',
  earTop: '耳頂高於眼睛',
  lipGap: '上下唇間隙',
};
