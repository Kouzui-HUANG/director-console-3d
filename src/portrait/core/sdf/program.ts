/**
 * Signed-distance sculpting.
 *  - Shapes: primitive distance functions with their parameters, bounding box and a Lipschitz
 *    safety factor (1 = exact distance; larger = approximate estimate).
 *  - Sculpt: a tree builder — smooth union / subtraction / intersection, nested groups, regions.
 *  - compile(): flattens the tree into typed arrays shared by the evaluator, the culler and the
 *    mesher. A Program is plain data, so it can be posted to Web Workers unchanged.
 * Units are millimeters. Negative distance = inside.
 */
import { type Basis, IDENTITY, type V3, dot, sub } from '../math.ts';

export const PRIM = { sphere: 1, ellipsoid: 2, capsule: 3, roundCone: 4, roundBox: 5, bezier: 6, plane: 7, torus: 8, eyelid: 9 } as const;
export type PrimType = (typeof PRIM)[keyof typeof PRIM];
export const OP = { union: 0, sub: 1, inter: 2 } as const;
export type Op = (typeof OP)[keyof typeof OP];

/** [minX, minY, minZ, maxX, maxY, maxZ] */
export type Box = [number, number, number, number, number, number];

export interface Shape {
  type: PrimType;
  params: number[];
  aabb: Box;
  /** How much the distance estimate may underestimate the true distance (1 = exact). */
  lip: number;
}

const basisParams = (b: Basis): number[] => [...b[0], ...b[1], ...b[2]];

function boxAround(c: V3, ext: V3): Box {
  return [c[0] - ext[0], c[1] - ext[1], c[2] - ext[2], c[0] + ext[0], c[1] + ext[1], c[2] + ext[2]];
}

function boxOfPoints(pts: V3[], pad: number): Box {
  const b: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let i = 0; i < 3; i++) {
      b[i] = Math.min(b[i]!, p[i]! - pad);
      b[i + 3] = Math.max(b[i + 3]!, p[i]! + pad);
    }
  }
  return b;
}

/** World-axis half extents of an oriented box/ellipsoid with local half sizes `r`. */
function orientedExtent(b: Basis, r: V3, round: boolean): V3 {
  const e: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (round) e[i] = Math.hypot(b[0][i]! * r[0], b[1][i]! * r[1], b[2][i]! * r[2]);
    else e[i] = Math.abs(b[0][i]!) * r[0] + Math.abs(b[1][i]!) * r[1] + Math.abs(b[2][i]!) * r[2];
  }
  return e;
}

export function sphere(c: V3, r: number): Shape {
  return { type: PRIM.sphere, params: [...c, r], aabb: boxAround(c, [r, r, r]), lip: 1 };
}

/** Ellipsoid with radii `r` along the local axes of `basis` (approximate distance, very good near the surface). */
export function ellipsoid(c: V3, r: V3, basis: Basis = IDENTITY): Shape {
  const ratio = Math.max(...r) / Math.min(...r);
  return { type: PRIM.ellipsoid, params: [...basisParams(basis), ...c, ...r], aabb: boxAround(c, orientedExtent(basis, r, true)), lip: Math.min(2.5, 1 + 0.3 * (ratio - 1)) };
}

export function capsule(a: V3, b: V3, r: number): Shape {
  return { type: PRIM.capsule, params: [...a, ...b, r], aabb: boxOfPoints([a, b], r), lip: 1 };
}

/** Cone between two spheres (radius ra at a, rb at b), smoothly capped. */
export function roundCone(a: V3, b: V3, ra: number, rb: number): Shape {
  const ba = sub(b, a);
  const l2 = Math.max(dot(ba, ba), 1e-6);
  const l = Math.sqrt(l2);
  // One sphere must not swallow the other.
  if (Math.abs(ra - rb) > l * 0.98) {
    if (ra > rb) rb = ra - l * 0.98;
    else ra = rb - l * 0.98;
  }
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const pad = Math.max(ra, rb);
  return { type: PRIM.roundCone, params: [...a, ...ba, ra, rb, l2, rr, a2, 1 / l2], aabb: boxOfPoints([a, b], pad), lip: 1 };
}

/** Box with half sizes `half` (outer, rounding included) and edge radius `radius`. */
export function roundBox(c: V3, half: V3, radius: number, basis: Basis = IDENTITY): Shape {
  return { type: PRIM.roundBox, params: [...basisParams(basis), ...c, ...half, radius], aabb: boxAround(c, orientedExtent(basis, half, false)), lip: 1 };
}

export interface TubeOptions {
  /** Reference "up" for the cross-section frame (default +Y). */
  up?: V3;
  /** Cross-section scale along the side axis (tangent × up) and along up. 1 = round. */
  ws?: number;
  wu?: number;
}

/**
 * Tube along the quadratic Bézier A–B–C. Radius goes r0 → rm → r1 along the curve (quadratic
 * profile); the cross-section can be elliptical (ws, wu).
 */
export function bezier(A: V3, B: V3, C: V3, r0: number, rm: number, r1: number, opts: TubeOptions = {}): Shape {
  let b: V3 = [A[0] - 2 * B[0] + C[0], A[1] - 2 * B[1] + C[1], A[2] - 2 * B[2] + C[2]];
  if (dot(b, b) < 1e-6) {
    // Straight segment with the control point in the middle: nudge it so the closed form stays valid.
    const dir = sub(C, A);
    const side: V3 = Math.abs(dir[1]) < Math.abs(dir[0]) ? [0, 1, 0] : [1, 0, 0];
    B = [B[0] + side[0] * 1e-2, B[1] + side[1] * 1e-2, B[2] + side[2] * 1e-2];
    b = [A[0] - 2 * B[0] + C[0], A[1] - 2 * B[1] + C[1], A[2] - 2 * B[2] + C[2]];
  }
  const a = sub(B, A);
  const kk = 1 / dot(b, b);
  const kx = kk * dot(a, b);
  const aa = dot(a, a);
  const up = opts.up ?? [0, 1, 0];
  const ws = opts.ws ?? 1;
  const wu = opts.wu ?? 1;
  const rMax = Math.max(r0, rm, r1) * Math.max(ws, wu);
  const ratio = Math.max(ws, wu) / Math.min(ws, wu);
  return {
    type: PRIM.bezier,
    params: [...A, ...B, ...C, ...a, ...b, kk, kx, aa, r0, rm, r1, ...up, ws, wu],
    aabb: boxOfPoints([A, B, C], rMax),
    lip: 1.25 * ratio,
  };
}

/** Bézier tube that passes through `M` at its middle (t = 0.5). */
export function bezierThrough(A: V3, M: V3, C: V3, r0: number, rm: number, r1: number, opts: TubeOptions = {}): Shape {
  const B: V3 = [2 * M[0] - (A[0] + C[0]) / 2, 2 * M[1] - (A[1] + C[1]) / 2, 2 * M[2] - (A[2] + C[2]) / 2];
  return bezier(A, B, C, r0, rm, r1, opts);
}

/** Half-space: solid where n·p < d (n is normalized here). */
export function plane(n: V3, d: number): Shape {
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return { type: PRIM.plane, params: [n[0] / l, n[1] / l, n[2] / l, d / l], aabb: [-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity], lip: 1 };
}

/** Ring around the local z axis of `basis` (major radius R, tube radius r). */
export function torus(c: V3, R: number, r: number, basis: Basis = IDENTITY): Shape {
  const e = R + r;
  return { type: PRIM.torus, params: [...basisParams(basis), ...c, R, r], aabb: boxAround(c, [e, e, e]), lip: 1 };
}

export interface EyelidSpec {
  /** Eyeball center and frame: local x = lateral, y = up, z = gaze direction. */
  center: V3;
  basis: Basis;
  /** Eyeball radius and lid thickness (mm). */
  R: number;
  t: number;
  /** Rounding of the lid margins (mm). */
  edge: number;
  /** Canthus angles around the eyeball center (radians): azimuth medial < 0 < lateral, elevation. */
  aMed: number;
  aLat: number;
  eMed: number;
  eLat: number;
  /** Opening of the upper / lower margin above / below the line between the canthi (radians). */
  hUp: number;
  hLo: number;
  /** Where along the fissure (0 medial … 1 lateral) the upper / lower margin peaks. */
  pUp: number;
  pLo: number;
  /** Upper lid crease: height above the margin (radians, 0 = none), groove depth and width (mm). */
  crease: number;
  creaseDepth: number;
  creaseWidth: number;
  /** The lid shell is kept only in front of local z = −back (mm). */
  back: number;
}

/**
 * Both eyelids of one eye: a skin shell around the eyeball with the palpebral fissure (an almond
 * shaped opening between the margins) cut out, rounded margins and an optional lid crease.
 */
export function eyelid(s: EyelidSpec): Shape {
  const g = (p: number) => Math.log(0.5) / Math.log(Math.min(0.95, Math.max(0.05, p)));
  const e = s.R + s.t + 2;
  return {
    type: PRIM.eyelid,
    params: [...basisParams(s.basis), ...s.center, s.R, s.t, s.edge, s.aMed, s.aLat, s.eMed, s.eLat, s.hUp, s.hLo, g(s.pUp), g(s.pLo), s.crease, s.creaseDepth, s.creaseWidth, s.back],
    aabb: boxAround(s.center, [e, e, e]),
    lip: 1.8,
  };
}

// ---------------------------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------------------------

interface PrimNode {
  kind: 0;
  shape: Shape;
  op: Op;
  k: number;
  region: number;
}
interface GroupNode {
  kind: 1;
  children: SNode[];
  op: Op;
  k: number;
  region: number;
  /** Children are never culled individually (needed when a group uses intersections internally). */
  atomic: boolean;
  name: string;
}
type SNode = PrimNode | GroupNode;

export interface GroupOptions {
  op?: Op;
  k?: number;
  atomic?: boolean;
  region?: string;
}

/** Sculpt builder. Children combine in order into the group's accumulator (empty = +∞). */
export class Sculpt {
  readonly node: GroupNode;
  readonly regions: string[];
  private readonly regionId: number;

  constructor(node?: GroupNode, regions?: string[], regionId = 0) {
    this.regions = regions ?? ['body'];
    this.node = node ?? { kind: 1, children: [], op: OP.union, k: 0, region: 0, atomic: false, name: 'root' };
    this.regionId = regionId;
  }

  /** Region id for a name (regions tag vertices: skin, hair, eyes, pedestal…). */
  region(name: string): number {
    let i = this.regions.indexOf(name);
    if (i < 0) i = this.regions.push(name) - 1;
    return i;
  }

  private push(shape: Shape, op: Op, k: number): this {
    this.node.children.push({ kind: 0, shape, op, k, region: this.regionId });
    return this;
  }

  /** Smooth union (k = blend radius in mm, 0 = hard). */
  add(shape: Shape, k = 0): this {
    return this.push(shape, OP.union, k);
  }

  /** Smooth subtraction (carve the shape out of everything added so far in this group). */
  sub(shape: Shape, k = 0): this {
    return this.push(shape, OP.sub, k);
  }

  /** Smooth intersection (keep only what is inside the shape). */
  inter(shape: Shape, k = 0): this {
    return this.push(shape, OP.inter, k);
  }

  /** Nested group, combined into this one with opts.op (default union) and blend radius opts.k. */
  group(name: string, opts: GroupOptions, build: (g: Sculpt) => void): this {
    const region = opts.region ? this.region(opts.region) : this.regionId;
    const node: GroupNode = { kind: 1, children: [], op: opts.op ?? OP.union, k: opts.k ?? 0, region, atomic: !!opts.atomic, name };
    build(new Sculpt(node, this.regions, region));
    if (node.children.length) this.node.children.push(node);
    return this;
  }
}

// ---------------------------------------------------------------------------------------------
// Compiled program
// ---------------------------------------------------------------------------------------------

export const NODE = { prim: 0, begin: 1, end: 2 } as const;

export interface Program {
  count: number;
  /** NODE.prim / NODE.begin / NODE.end */
  kind: Int8Array;
  type: Int8Array;
  op: Int8Array;
  k: Float64Array;
  lip: Float64Array;
  region: Int16Array;
  pOff: Int32Array;
  params: Float64Array;
  aabb: Float64Array;
  /** begin → its end index, end → its begin index, prim → itself */
  match: Int32Array;
  atomic: Int8Array;
  /** Every node in evaluation order (the uncull list). */
  all: Int32Array;
  /** Bounding box of the solid. */
  bounds: Box;
  regions: string[];
}

const EMPTY_BOX = (): Box => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
const finite = (b: Box) => b.every((v) => Number.isFinite(v));

function unionBox(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
}
function interBox(a: Box, b: Box): Box {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3]), Math.min(a[4], b[4]), Math.min(a[5], b[5])];
}

export function compile(s: Sculpt): Program {
  interface Entry {
    kind: number;
    type: number;
    op: number;
    k: number;
    lip: number;
    region: number;
    params: number[];
    aabb: Box;
    match: number;
    atomic: boolean;
  }
  const entries: Entry[] = [];

  /** Bounding box of the solid a list of children produces (unions grow it, intersections clip it). */
  function solidBox(children: SNode[], boxes: Box[]): Box {
    let box = EMPTY_BOX();
    let maxK = 0;
    children.forEach((c, i) => {
      if (c.op === OP.union) {
        box = unionBox(box, boxes[i]!);
        maxK = Math.max(maxK, c.k);
      }
    });
    children.forEach((c, i) => {
      if (c.op === OP.inter && finite(boxes[i]!)) box = interBox(box, boxes[i]!);
    });
    const pad = maxK / 4;
    return [box[0] - pad, box[1] - pad, box[2] - pad, box[3] + pad, box[4] + pad, box[5] + pad];
  }

  /** Emits a node; returns its bounding box and max Lipschitz factor. */
  function emit(n: SNode): { box: Box; lip: number } {
    if (n.kind === 0) {
      entries.push({ kind: NODE.prim, type: n.shape.type, op: n.op, k: n.k, lip: n.shape.lip, region: n.region, params: n.shape.params, aabb: n.shape.aabb, match: entries.length, atomic: false });
      return { box: n.shape.aabb, lip: n.shape.lip };
    }
    const begin = entries.length;
    entries.push({ kind: NODE.begin, type: 0, op: n.op, k: n.k, lip: 1, region: n.region, params: [], aabb: EMPTY_BOX(), match: -1, atomic: n.atomic });
    const boxes: Box[] = [];
    let lip = 1;
    for (const c of n.children) {
      const r = emit(c);
      boxes.push(r.box);
      lip = Math.max(lip, r.lip);
    }
    const box = solidBox(n.children, boxes);
    const end = entries.length;
    entries.push({ kind: NODE.end, type: 0, op: n.op, k: n.k, lip, region: n.region, params: [], aabb: box, match: begin, atomic: n.atomic });
    const b = entries[begin]!;
    b.match = end;
    b.aabb = box;
    b.lip = lip;
    return { box, lip };
  }

  const rootBoxes: Box[] = [];
  for (const c of s.node.children) rootBoxes.push(emit(c).box);
  const bounds = solidBox(s.node.children, rootBoxes);

  const count = entries.length;
  const P: Program = {
    count,
    kind: new Int8Array(count),
    type: new Int8Array(count),
    op: new Int8Array(count),
    k: new Float64Array(count),
    lip: new Float64Array(count),
    region: new Int16Array(count),
    pOff: new Int32Array(count),
    params: new Float64Array(entries.reduce((a, e) => a + e.params.length, 0)),
    aabb: new Float64Array(count * 6),
    match: new Int32Array(count),
    atomic: new Int8Array(count),
    all: new Int32Array(count),
    bounds,
    regions: [...s.regions],
  };
  let off = 0;
  entries.forEach((e, i) => {
    P.kind[i] = e.kind;
    P.type[i] = e.type;
    P.op[i] = e.op;
    P.k[i] = e.k;
    P.lip[i] = e.lip;
    P.region[i] = e.region;
    P.pOff[i] = off;
    P.params.set(e.params, off);
    off += e.params.length;
    P.aabb.set(e.aabb, i * 6);
    P.match[i] = e.match;
    P.atomic[i] = e.atomic ? 1 : 0;
    P.all[i] = i;
  });
  return P;
}
