/**
 * Sparse Surface Nets mesher for a compiled distance-field Program.
 *
 *  1. plan: an octree over blocks of B³ cells drops every region that cannot contain surface
 *     (|d(center)| > 1.5·r + band with a culled node list), leaving "active" blocks, each with the
 *     short list of shapes that matter there.
 *  2. meshBlocks (parallel, any subset of blocks): inside a block, sub-blocks of S³ cells are
 *     tested again; corners are evaluated only in active sub-blocks; each cell with a sign change
 *     gets one vertex (average of its edge crossings) with a normal from the trilinear gradient;
 *     each sign-changing edge owned by the block emits a quad between the 4 cells around it.
 *     Cells are identified by a global key, so quads can reference cells of other blocks.
 *  3. assemble: weld chunks by key into an indexed triangle mesh.
 *
 * Everything is plain data and pure functions: it runs in Web Workers and in Node.
 */
import { cullList } from '../sdf/cull.ts';
import { evalList } from '../sdf/evaluate.ts';
import type { Box, Program } from '../sdf/program.ts';

export interface MeshSettings {
  /** Cell size in mm. */
  h: number;
  /** Cells per block side (power of two, default 16). */
  blockCells?: number;
  /** Cells per sub-block side (divides blockCells, default 4). */
  subCells?: number;
  /** Restrict meshing to this box (default: the program's bounds). */
  bounds?: Box;
}

export interface BlockJob {
  bi: number;
  bj: number;
  bk: number;
  list: Int32Array;
}

export interface MeshPlan {
  h: number;
  B: number;
  S: number;
  band: number;
  origin: [number, number, number];
  /** cells per axis */
  nc: [number, number, number];
  blocks: BlockJob[];
  /** distance evaluations spent on planning */
  evals: number;
}

export interface MeshChunk {
  positions: Float32Array;
  normals: Float32Array;
  keys: Float64Array;
  quads: Float64Array;
  vertexCount: number;
  quadCount: number;
  evals: number;
}

export interface MeshData {
  /** mm, xyz per vertex */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** quads dropped because a neighbor cell had no vertex (should be 0) */
  missing: number;
  bounds: Box;
}

/** Safety bound on the field's gradient magnitude (approximate shapes can exceed 1 slightly). */
const LIPSCHITZ = 1.5;

// ---------------------------------------------------------------------------------------------
// 1. plan
// ---------------------------------------------------------------------------------------------

export function planMesh(P: Program, s: MeshSettings): MeshPlan {
  const h = s.h;
  const B = s.blockCells ?? 16;
  const S = s.subCells ?? 4;
  const band = 2 * h;
  const src = s.bounds ?? P.bounds;
  const pad = 2 * h;
  const origin: [number, number, number] = [Math.floor((src[0] - pad) / h) * h, Math.floor((src[1] - pad) / h) * h, Math.floor((src[2] - pad) / h) * h];
  const nb = [0, 1, 2].map((a) => Math.max(1, Math.ceil((src[a + 3]! + pad - origin[a]!) / h / B))) as [number, number, number];
  const nc: [number, number, number] = [nb[0] * B, nb[1] * B, nb[2] * B];
  let size = 1;
  while (size < Math.max(...nb)) size *= 2;
  const depthBufs: Int32Array[] = [];
  const blocks: BlockJob[] = [];
  let evals = 0;
  const bs = B * h;

  const rec = (bi: number, bj: number, bk: number, sz: number, depth: number, list: Int32Array, n: number) => {
    const box: Box = [
      origin[0] + bi * bs,
      origin[1] + bj * bs,
      origin[2] + bk * bs,
      origin[0] + Math.min(bi + sz, nb[0]) * bs,
      origin[1] + Math.min(bj + sz, nb[1]) * bs,
      origin[2] + Math.min(bk + sz, nb[2]) * bs,
    ];
    const buf = (depthBufs[depth] ??= new Int32Array(P.count));
    const m = cullList(P, list, n, box, band, buf);
    if (m === 0) return;
    const cx = (box[0] + box[3]) / 2, cy = (box[1] + box[4]) / 2, cz = (box[2] + box[5]) / 2;
    const r = 0.5 * Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    const d = evalList(P, buf, m, cx, cy, cz);
    evals++;
    // The culled field equals the true field within `band` of the surface, so a zero inside the
    // box would make |d(center)| ≤ L·r (L = Lipschitz bound of the field).
    if (Math.abs(d) > LIPSCHITZ * r) return;
    if (sz === 1) {
      blocks.push({ bi, bj, bk, list: buf.slice(0, m) });
      return;
    }
    const half = sz / 2;
    for (let dz = 0; dz < 2; dz++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const ci = bi + dx * half, cj = bj + dy * half, ck = bk + dz * half;
          if (ci < nb[0] && cj < nb[1] && ck < nb[2]) rec(ci, cj, ck, half, depth + 1, buf, m);
        }
  };
  rec(0, 0, 0, size, 0, P.all, P.count);
  return { h, B, S, band, origin, nc, blocks, evals };
}

// ---------------------------------------------------------------------------------------------
// 2. mesh a set of blocks
// ---------------------------------------------------------------------------------------------

class GrowF32 {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(cap);
  }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
}

class GrowF64 {
  a: Float64Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float64Array(cap);
  }
  push(v: number) {
    if (this.n + 1 > this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

// Cube corners (x, y, z) in bit order: bit0 = x, bit1 = y, bit2 = z.
const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
];

export function meshBlocks(P: Program, plan: Omit<MeshPlan, 'blocks'>, jobs: BlockJob[]): MeshChunk {
  const { h, B, S, band, origin, nc } = plan;
  const N1 = B + 1;
  const V = new Float32Array(N1 * N1 * N1);
  const cellVert = new Int32Array(B * B * B);
  const cellActive = new Uint8Array(B * B * B);
  const nS = B / S;
  const M = 2; // micro-block size in cells (second-level narrowing inside sub-blocks)
  const nM = S / M;
  const subList = new Int32Array(P.count);
  const pos = new GrowF32(1 << 16);
  const nor = new GrowF32(1 << 16);
  const keys = new GrowF64(1 << 15);
  const quads = new GrowF64(1 << 16);
  let evals = 0;
  const ncx = nc[0], ncy = nc[1];
  const cv = new Float64Array(8);
  const sr = LIPSCHITZ * 0.5 * Math.sqrt(3) * S * h;
  const mr = LIPSCHITZ * 0.5 * Math.sqrt(3) * M * h;

  for (const job of jobs) {
    V.fill(NaN);
    cellVert.fill(-1);
    cellActive.fill(0);
    const gi0 = job.bi * B, gj0 = job.bj * B, gk0 = job.bk * B;
    const x0 = origin[0] + gi0 * h, y0 = origin[1] + gj0 * h, z0 = origin[2] + gk0 * h;
    let any = false;

    // -- sub-blocks → micro-blocks: test centers, evaluate corners only where surface can be
    for (let sk = 0; sk < nS; sk++)
      for (let sj = 0; sj < nS; sj++)
        for (let si = 0; si < nS; si++) {
          const box: Box = [x0 + si * S * h, y0 + sj * S * h, z0 + sk * S * h, x0 + (si + 1) * S * h, y0 + (sj + 1) * S * h, z0 + (sk + 1) * S * h];
          const m = cullList(P, job.list, job.list.length, box, band, subList);
          if (m === 0) continue;
          const d = evalList(P, subList, m, (box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
          evals++;
          if (Math.abs(d) > sr) continue;
          for (let mk = 0; mk < nM; mk++)
            for (let mj = 0; mj < nM; mj++)
              for (let mi = 0; mi < nM; mi++) {
                const i0 = si * S + mi * M, j0 = sj * S + mj * M, k0 = sk * S + mk * M;
                const dm = evalList(P, subList, m, x0 + (i0 + M / 2) * h, y0 + (j0 + M / 2) * h, z0 + (k0 + M / 2) * h);
                evals++;
                if (Math.abs(dm) > mr) continue;
                any = true;
                for (let k = k0; k <= k0 + M; k++)
                  for (let j = j0; j <= j0 + M; j++)
                    for (let i = i0; i <= i0 + M; i++) {
                      if (i < i0 + M && j < j0 + M && k < k0 + M) cellActive[i + B * (j + B * k)] = 1;
                      const ci = i + N1 * (j + N1 * k);
                      if (V[ci] === V[ci]) continue; // already evaluated (not NaN)
                      V[ci] = evalList(P, subList, m, x0 + i * h, y0 + j * h, z0 + k * h);
                      evals++;
                    }
              }
        }
    if (!any) continue;

    // -- vertices for active cells with a sign change
    for (let k = 0; k < B; k++)
      for (let j = 0; j < B; j++)
        for (let i = 0; i < B; i++) {
          if (!cellActive[i + B * (j + B * k)]) continue;
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            const v = V[i + (c & 1) + N1 * (j + ((c >> 1) & 1) + N1 * (k + ((c >> 2) & 1)))]!;
            cv[c] = v;
            if (v < 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;
          // average of edge crossings, in cell-local [0,1]³
          let sx = 0, sy = 0, sz = 0, cnt = 0;
          for (let e = 0; e < 12; e++) {
            const [ca, cb] = EDGES[e]!;
            const va = cv[ca]!, vb = cv[cb]!;
            if (va < 0 === vb < 0) continue;
            const t = va / (va - vb);
            const ax = ca & 1, ay = (ca >> 1) & 1, az = (ca >> 2) & 1;
            const bx = cb & 1, by = (cb >> 1) & 1, bz = (cb >> 2) & 1;
            sx += ax + (bx - ax) * t;
            sy += ay + (by - ay) * t;
            sz += az + (bz - az) * t;
            cnt++;
          }
          const fx = sx / cnt, fy = sy / cnt, fz = sz / cnt;
          // trilinear gradient at (fx, fy, fz)
          const gx = (1 - fy) * (1 - fz) * (cv[1]! - cv[0]!) + fy * (1 - fz) * (cv[3]! - cv[2]!) + (1 - fy) * fz * (cv[5]! - cv[4]!) + fy * fz * (cv[7]! - cv[6]!);
          const gy = (1 - fx) * (1 - fz) * (cv[2]! - cv[0]!) + fx * (1 - fz) * (cv[3]! - cv[1]!) + (1 - fx) * fz * (cv[6]! - cv[4]!) + fx * fz * (cv[7]! - cv[5]!);
          const gz = (1 - fx) * (1 - fy) * (cv[4]! - cv[0]!) + fx * (1 - fy) * (cv[5]! - cv[1]!) + (1 - fx) * fy * (cv[6]! - cv[2]!) + fx * fy * (cv[7]! - cv[3]!);
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
          cellVert[i + B * (j + B * k)] = keys.n;
          pos.push3(x0 + (i + fx) * h, y0 + (j + fy) * h, z0 + (k + fz) * h);
          nor.push3(gx / gl, gy / gl, gz / gl);
          keys.push(gi0 + i + ncx * (gj0 + j + ncy * (gk0 + k)));
        }

    // -- quads for sign-changing edges starting at each active cell's min corner
    const key = (a: number, b: number, c: number) => a + ncx * (b + ncy * c);
    for (let k = 0; k < B; k++)
      for (let j = 0; j < B; j++)
        for (let i = 0; i < B; i++) {
          if (!cellActive[i + B * (j + B * k)]) continue;
          const v0 = V[i + N1 * (j + N1 * k)]!;
          const in0 = v0 < 0;
          const gi = gi0 + i, gj = gj0 + j, gk = gk0 + k;
          // +x edge: the 4 cells around it lie in the (y, z) plane
          const vx = V[i + 1 + N1 * (j + N1 * k)]!;
          if (vx === vx && in0 !== vx < 0) {
            const q0 = key(gi, gj - 1, gk - 1), q1 = key(gi, gj, gk - 1), q2 = key(gi, gj, gk), q3 = key(gi, gj - 1, gk);
            if (in0) { quads.push(q0); quads.push(q1); quads.push(q2); quads.push(q3); }
            else { quads.push(q0); quads.push(q3); quads.push(q2); quads.push(q1); }
          }
          // +y edge: cells in the (z, x) plane
          const vy = V[i + N1 * (j + 1 + N1 * k)]!;
          if (vy === vy && in0 !== vy < 0) {
            const q0 = key(gi - 1, gj, gk - 1), q1 = key(gi - 1, gj, gk), q2 = key(gi, gj, gk), q3 = key(gi, gj, gk - 1);
            if (in0) { quads.push(q0); quads.push(q1); quads.push(q2); quads.push(q3); }
            else { quads.push(q0); quads.push(q3); quads.push(q2); quads.push(q1); }
          }
          // +z edge: cells in the (x, y) plane
          const vz = V[i + N1 * (j + N1 * (k + 1))]!;
          if (vz === vz && in0 !== vz < 0) {
            const q0 = key(gi - 1, gj - 1, gk), q1 = key(gi, gj - 1, gk), q2 = key(gi, gj, gk), q3 = key(gi - 1, gj, gk);
            if (in0) { quads.push(q0); quads.push(q1); quads.push(q2); quads.push(q3); }
            else { quads.push(q0); quads.push(q3); quads.push(q2); quads.push(q1); }
          }
        }
  }
  return {
    positions: pos.a.slice(0, pos.n),
    normals: nor.a.slice(0, nor.n),
    keys: keys.a.slice(0, keys.n),
    quads: quads.a.slice(0, quads.n),
    vertexCount: keys.n,
    quadCount: quads.n / 4,
    evals,
  };
}

// ---------------------------------------------------------------------------------------------
// 3. assemble
// ---------------------------------------------------------------------------------------------

/** Open-addressing hash map: integer-valued double keys (≥ 0) → int32. */
class KeyMap {
  private keys: Float64Array;
  private vals: Int32Array;
  private mask: number;
  constructor(n: number) {
    let cap = 16;
    while (cap < n * 2) cap *= 2;
    this.keys = new Float64Array(cap).fill(-1);
    this.vals = new Int32Array(cap);
    this.mask = cap - 1;
  }
  private slot(k: number): number {
    const hi = Math.floor(k / 4294967296);
    const lo = k - hi * 4294967296;
    return (Math.imul(lo | 0, 0x9e3779b1) ^ Math.imul(hi | 0, 0x85ebca77)) & this.mask;
  }
  set(k: number, v: number) {
    let s = this.slot(k);
    while (this.keys[s] !== -1 && this.keys[s] !== k) s = (s + 1) & this.mask;
    this.keys[s] = k;
    this.vals[s] = v;
  }
  get(k: number): number {
    let s = this.slot(k);
    for (;;) {
      const kk = this.keys[s]!;
      if (kk === k) return this.vals[s]!;
      if (kk === -1) return -1;
      s = (s + 1) & this.mask;
    }
  }
}

export function assemble(chunks: MeshChunk[]): MeshData {
  const vertexCount = chunks.reduce((a, c) => a + c.vertexCount, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const map = new KeyMap(vertexCount);
  let base = 0;
  for (const c of chunks) {
    positions.set(c.positions, base * 3);
    normals.set(c.normals, base * 3);
    for (let i = 0; i < c.vertexCount; i++) map.set(c.keys[i]!, base + i);
    base += c.vertexCount;
  }
  const quadCount = chunks.reduce((a, c) => a + c.quadCount, 0);
  const indices = new Uint32Array(quadCount * 6);
  let t = 0;
  let missing = 0;
  const d2 = (a: number, b: number) => {
    const dx = positions[a * 3]! - positions[b * 3]!, dy = positions[a * 3 + 1]! - positions[b * 3 + 1]!, dz = positions[a * 3 + 2]! - positions[b * 3 + 2]!;
    return dx * dx + dy * dy + dz * dz;
  };
  for (const c of chunks) {
    for (let q = 0; q < c.quadCount; q++) {
      const a = map.get(c.quads[q * 4]!), b = map.get(c.quads[q * 4 + 1]!), cc = map.get(c.quads[q * 4 + 2]!), d = map.get(c.quads[q * 4 + 3]!);
      if (a < 0 || b < 0 || cc < 0 || d < 0) {
        missing++;
        continue;
      }
      // split along the shorter diagonal
      if (d2(a, cc) <= d2(b, d)) {
        indices[t++] = a; indices[t++] = b; indices[t++] = cc;
        indices[t++] = a; indices[t++] = cc; indices[t++] = d;
      } else {
        indices[t++] = a; indices[t++] = b; indices[t++] = d;
        indices[t++] = b; indices[t++] = cc; indices[t++] = d;
      }
    }
  }
  const bounds: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a]!;
      if (v < bounds[a]!) bounds[a] = v;
      if (v > bounds[a + 3]!) bounds[a + 3] = v;
    }
  }
  return { positions, normals, indices: t === indices.length ? indices : indices.slice(0, t), vertexCount, triangleCount: t / 3, missing, bounds };
}

/** Single-threaded meshing (Node, tests, fallback). */
export function meshSync(P: Program, s: MeshSettings): MeshData & { evals: number; blocks: number } {
  const plan = planMesh(P, s);
  const { blocks, ...meta } = plan;
  const chunk = meshBlocks(P, meta, blocks);
  return { ...assemble([chunk]), evals: plan.evals + chunk.evals, blocks: blocks.length };
}
