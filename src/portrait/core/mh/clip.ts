/**
 * Cut a closed triangle mesh with planes and close each cut with a flat cap — used to turn the
 * body into a bust (bottom cut, side cuts through the arms). Cut loops are chained by vertex
 * position so seams between earlier caps and the surface still connect.
 */

export interface TriMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Optional values per vertex (`extraSize` each, default 1: e.g. a highlight weight), interpolated along cuts, 0 on caps. */
  extra?: Float32Array;
  extraSize?: number;
  /** After a tracked cut: the input vertex of each output vertex (−1 for new cut and cap vertices). */
  source?: Int32Array;
}

/** Keep the side where n·p ≥ d. */
export interface CutPlane {
  n: [number, number, number];
  d: number;
}

class Grow {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(Math.max(16, cap));
  }
  push(x: number, y: number, z: number) {
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

export function clipWithCap(m: TriMesh, plane: CutPlane, track = false): TriMesh {
  const [nx, ny, nz] = plane.n;
  const P = m.positions;
  const N = m.normals;
  const X = m.extra;
  const xs = m.extraSize ?? 1;
  const nV = P.length / 3;
  const extraX: number[] = [];
  const side = new Float64Array(nV);
  for (let i = 0; i < nV; i++) side[i] = nx * P[i * 3]! + ny * P[i * 3 + 1]! + nz * P[i * 3 + 2]! - plane.d;

  // new vertices (cut points, cap copies) are appended after the original ones
  const extraP = new Grow(4096);
  const extraN = new Grow(4096);
  const vx = (v: number, c: number) => (v < nV ? P[v * 3 + c]! : extraP.a[(v - nV) * 3 + c]!);
  let idx = new Uint32Array(m.indices.length + 1024);
  let ni = 0;
  const emit = (a: number, b: number, c: number) => {
    if (ni + 3 > idx.length) {
      const g = new Uint32Array(idx.length * 2);
      g.set(idx);
      idx = g;
    }
    idx[ni++] = a;
    idx[ni++] = b;
    idx[ni++] = c;
  };
  const cutVert = new Map<number, number>();
  const cross = (a: number, b: number): number => {
    const k = a < b ? a * nV + b : b * nV + a;
    let v = cutVert.get(k);
    if (v !== undefined) return v;
    const t = side[a]! / (side[a]! - side[b]!);
    v = nV + extraP.n / 3;
    extraP.push(P[a * 3]! + (P[b * 3]! - P[a * 3]!) * t, P[a * 3 + 1]! + (P[b * 3 + 1]! - P[a * 3 + 1]!) * t, P[a * 3 + 2]! + (P[b * 3 + 2]! - P[a * 3 + 2]!) * t);
    extraN.push(N[a * 3]! + (N[b * 3]! - N[a * 3]!) * t, N[a * 3 + 1]! + (N[b * 3 + 1]! - N[a * 3 + 1]!) * t, N[a * 3 + 2]! + (N[b * 3 + 2]! - N[a * 3 + 2]!) * t);
    if (X) for (let c = 0; c < xs; c++) extraX.push(X[a * xs + c]! + (X[b * xs + c]! - X[a * xs + c]!) * t);
    cutVert.set(k, v);
    return v;
  };
  const segments: [number, number][] = [];
  const I = m.indices;
  for (let t = 0; t < I.length; t += 3) {
    const t0 = I[t]!, t1 = I[t + 1]!, t2 = I[t + 2]!;
    const i0 = side[t0]! >= 0, i1 = side[t1]! >= 0, i2 = side[t2]! >= 0;
    const nIn = Number(i0) + Number(i1) + Number(i2);
    if (nIn === 3) {
      emit(t0, t1, t2);
      continue;
    }
    if (nIn === 0) continue;
    // rotate so the odd vertex (alone on its side) comes first
    const tri = [t0, t1, t2];
    const ins = [i0, i1, i2];
    let r = 0;
    for (let i = 0; i < 3; i++) if (ins[i] !== ins[(i + 1) % 3] && ins[i] !== ins[(i + 2) % 3]) r = i;
    const a = tri[r]!, b = tri[(r + 1) % 3]!, c = tri[(r + 2) % 3]!;
    const ab = cross(a, b), ac = cross(a, c);
    if (ins[r]) {
      emit(a, ab, ac);
      segments.push([ab, ac]); // walking ab → ac keeps the kept side on the left
    } else {
      emit(ab, b, c);
      emit(ab, c, ac);
      segments.push([ac, ab]);
    }
  }

  // chain segments into loops (by position, so duplicated seam vertices still join)
  const q = (v: number) => `${Math.round(vx(v, 0) * 1e4)},${Math.round(vx(v, 1) * 1e4)},${Math.round(vx(v, 2) * 1e4)}`;
  const next = new Map<string, [number, number]>();
  for (const sgm of segments) next.set(q(sgm[0]), sgm);
  const used = new Set<string>();
  const loops: number[][] = [];
  for (const [s0] of segments) {
    const k0 = q(s0);
    if (used.has(k0)) continue;
    const loop: number[] = [];
    let k = k0;
    for (let guard = 0; guard <= segments.length; guard++) {
      const sgm = next.get(k);
      if (!sgm || used.has(k)) break;
      used.add(k);
      loop.push(sgm[0]);
      k = q(sgm[1]);
      if (k === k0) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }

  // cap each loop: copies of its vertices with the cap normal, ear-clipped in the plane
  const ref: [number, number, number] = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ux = ref[1] * nz - ref[2] * ny, uy = ref[2] * nx - ref[0] * nz, uz = ref[0] * ny - ref[1] * nx;
  const ul = Math.hypot(ux, uy, uz);
  const U: [number, number, number] = [ux / ul, uy / ul, uz / ul];
  const V: [number, number, number] = [ny * U[2] - nz * U[1], nz * U[0] - nx * U[2], nx * U[1] - ny * U[0]];
  for (const loop of loops) {
    const base = nV + extraP.n / 3;
    const pts: [number, number][] = [];
    for (const v of loop) {
      const x = vx(v, 0), y = vx(v, 1), z = vx(v, 2);
      extraP.push(x, y, z);
      extraN.push(-nx, -ny, -nz);
      if (X) for (let c = 0; c < xs; c++) extraX.push(0);
      pts.push([x * U[0] + y * U[1] + z * U[2], x * V[0] + y * V[1] + z * V[2]]);
    }
    for (const [a, b, c] of earClip(pts)) emit(base + a, base + c, base + b);
  }

  // compact: keep only referenced vertices
  const total = nV + extraP.n / 3;
  const remap = new Int32Array(total).fill(-1);
  let count = 0;
  for (let i = 0; i < ni; i++) {
    const v = idx[i]!;
    if (remap[v] === -1) remap[v] = count++;
  }
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const extra = X ? new Float32Array(count * xs) : undefined;
  for (let v = 0; v < total; v++) {
    const o = remap[v]!;
    if (o < 0) continue;
    for (let c = 0; c < 3; c++) {
      positions[o * 3 + c] = vx(v, c);
      normals[o * 3 + c] = v < nV ? N[v * 3 + c]! : extraN.a[(v - nV) * 3 + c]!;
    }
    if (extra) for (let c = 0; c < xs; c++) extra[o * xs + c] = v < nV ? X![v * xs + c]! : extraX[(v - nV) * xs + c]!;
  }
  const indices = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) indices[i] = remap[idx[i]!]!;
  const out: TriMesh = extra ? { positions, normals, indices, extra, extraSize: xs } : { positions, normals, indices };
  if (track) {
    const source = new Int32Array(count).fill(-1);
    for (let v = 0; v < nV; v++) if (remap[v]! >= 0) source[remap[v]!] = v;
    out.source = source;
  }
  return out;
}

/** Ear clipping of a simple polygon (either winding). Returns triangles (counter-clockwise). */
export function earClip(pts: [number, number][]): [number, number, number][] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[(i + 1) % n]!;
    area += x0 * y1 - x1 * y0;
  }
  const order = Array.from({ length: n }, (_, i) => i);
  if (area < 0) order.reverse();
  const tris: [number, number, number][] = [];
  const cross = (a: number, b: number, c: number) => {
    const [ax, ay] = pts[a]!, [bx, by] = pts[b]!, [cx, cy] = pts[c]!;
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  };
  const inTri = (p: number, a: number, b: number, c: number) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (order.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < order.length; i++) {
      const a = order[(i + order.length - 1) % order.length]!, b = order[i]!, c = order[(i + 1) % order.length]!;
      if (cross(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const p of order) {
        if (p === a || p === b || p === c) continue;
        if (inTri(p, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push([a, b, c]);
      order.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate remainder: fan it
      for (let i = 1; i + 1 < order.length; i++) tris.push([order[0]!, order[i]!, order[i + 1]!]);
      return tris;
    }
  }
  if (order.length === 3) tris.push([order[0]!, order[1]!, order[2]!]);
  return tris;
}
