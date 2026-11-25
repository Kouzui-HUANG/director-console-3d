/**
 * Catmull–Clark subdivision for quad meshes with fixed topology. The topology (edges, rings,
 * new quads) is built once per level; applying it to new positions is a single linear pass, so
 * every slider change re-subdivides cheaply.
 * Output vertex order: [vertex points (nIn)] [face points (nFaces)] [edge points (nEdges)].
 */

export interface SubdivLevel {
  nIn: number;
  nFaces: number;
  nEdges: number;
  nOut: number;
  quads: Uint32Array;
  /** per edge: a, b, face0, face1 (−1 on a boundary) */
  edges: Int32Array;
  /** per face: 4 edge ids (edge c joins corner c and corner c+1) */
  faceEdges: Int32Array;
  /** CSR rings: incident faces and edges per vertex */
  vfOff: Int32Array;
  vf: Int32Array;
  veOff: Int32Array;
  ve: Int32Array;
  boundary: Uint8Array;
  outQuads: Uint32Array;
}

export function buildLevel(quads: Uint32Array, nIn: number): SubdivLevel {
  const nFaces = quads.length / 4;
  const edgeId = new Map<number, number>();
  const edgeList: number[] = [];
  const faceEdges = new Int32Array(nFaces * 4);
  for (let f = 0; f < nFaces; f++) {
    for (let c = 0; c < 4; c++) {
      const a = quads[f * 4 + c]!, b = quads[f * 4 + ((c + 1) & 3)]!;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = lo * nIn + hi;
      let e = edgeId.get(key);
      if (e === undefined) {
        e = edgeList.length / 4;
        edgeId.set(key, e);
        edgeList.push(lo, hi, f, -1);
      } else edgeList[e * 4 + 3] = f;
      faceEdges[f * 4 + c] = e;
    }
  }
  const edges = Int32Array.from(edgeList);
  const nEdges = edges.length / 4;
  const vfCount = new Int32Array(nIn + 1);
  const veCount = new Int32Array(nIn + 1);
  for (let i = 0; i < quads.length; i++) vfCount[quads[i]! + 1]!++;
  for (let e = 0; e < nEdges; e++) {
    veCount[edges[e * 4]! + 1]!++;
    veCount[edges[e * 4 + 1]! + 1]!++;
  }
  for (let v = 0; v < nIn; v++) {
    vfCount[v + 1]! += vfCount[v]!;
    veCount[v + 1]! += veCount[v]!;
  }
  const vfOff = vfCount.slice();
  const veOff = veCount.slice();
  const vf = new Int32Array(quads.length);
  const ve = new Int32Array(nEdges * 2);
  const vfFill = vfOff.slice(0, nIn);
  const veFill = veOff.slice(0, nIn);
  for (let f = 0; f < nFaces; f++) for (let c = 0; c < 4; c++) vf[vfFill[quads[f * 4 + c]!]!++] = f;
  const boundary = new Uint8Array(nIn);
  for (let e = 0; e < nEdges; e++) {
    const a = edges[e * 4]!, b = edges[e * 4 + 1]!;
    ve[veFill[a]!++] = e;
    ve[veFill[b]!++] = e;
    if (edges[e * 4 + 3]! < 0) {
      boundary[a] = 1;
      boundary[b] = 1;
    }
  }
  const outQuads = new Uint32Array(nFaces * 16);
  for (let f = 0; f < nFaces; f++) {
    const F = nIn + f;
    const E = (c: number) => nIn + nFaces + faceEdges[f * 4 + c]!;
    for (let c = 0; c < 4; c++) {
      const o = (f * 4 + c) * 4;
      outQuads[o] = quads[f * 4 + c]!;
      outQuads[o + 1] = E(c);
      outQuads[o + 2] = F;
      outQuads[o + 3] = E((c + 3) & 3);
    }
  }
  return { nIn, nFaces, nEdges, nOut: nIn + nFaces + nEdges, quads, edges, faceEdges, vfOff, vf, veOff, ve, boundary, outQuads };
}

export function applyLevel(L: SubdivLevel, P: Float32Array): Float32Array {
  const { nIn, nFaces, nEdges, quads, edges } = L;
  const out = new Float32Array(L.nOut * 3);
  const fo = nIn * 3;
  const eo = (nIn + nFaces) * 3;
  // face points
  for (let f = 0; f < nFaces; f++) {
    const a = quads[f * 4]! * 3, b = quads[f * 4 + 1]! * 3, c = quads[f * 4 + 2]! * 3, d = quads[f * 4 + 3]! * 3;
    for (let k = 0; k < 3; k++) out[fo + f * 3 + k] = (P[a + k]! + P[b + k]! + P[c + k]! + P[d + k]!) * 0.25;
  }
  // edge points
  for (let e = 0; e < nEdges; e++) {
    const a = edges[e * 4]! * 3, b = edges[e * 4 + 1]! * 3, f0 = edges[e * 4 + 2]!, f1 = edges[e * 4 + 3]!;
    for (let k = 0; k < 3; k++) {
      out[eo + e * 3 + k] = f1 < 0 ? (P[a + k]! + P[b + k]!) * 0.5 : (P[a + k]! + P[b + k]! + out[fo + f0 * 3 + k]! + out[fo + f1 * 3 + k]!) * 0.25;
    }
  }
  // vertex points
  for (let v = 0; v < nIn; v++) {
    const p = v * 3;
    if (L.boundary[v]) {
      // boundary rule: (left + 6·P + right) / 8 along the boundary edges
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let i = L.veOff[v]!; i < L.veOff[v + 1]!; i++) {
        const e = L.ve[i]!;
        if (edges[e * 4 + 3]! >= 0) continue;
        const o = (edges[e * 4]! === v ? edges[e * 4 + 1]! : edges[e * 4]!) * 3;
        sx += P[o]!;
        sy += P[o + 1]!;
        sz += P[o + 2]!;
        n++;
      }
      if (n === 2) {
        out[p] = (sx + 6 * P[p]!) / 8;
        out[p + 1] = (sy + 6 * P[p + 1]!) / 8;
        out[p + 2] = (sz + 6 * P[p + 2]!) / 8;
      } else {
        out[p] = P[p]!;
        out[p + 1] = P[p + 1]!;
        out[p + 2] = P[p + 2]!;
      }
      continue;
    }
    const nf = L.vfOff[v + 1]! - L.vfOff[v]!;
    let qx = 0, qy = 0, qz = 0;
    for (let i = L.vfOff[v]!; i < L.vfOff[v + 1]!; i++) {
      const f = L.vf[i]!;
      qx += out[fo + f * 3]!;
      qy += out[fo + f * 3 + 1]!;
      qz += out[fo + f * 3 + 2]!;
    }
    let rx = 0, ry = 0, rz = 0;
    const ne = L.veOff[v + 1]! - L.veOff[v]!;
    for (let i = L.veOff[v]!; i < L.veOff[v + 1]!; i++) {
      const e = L.ve[i]!;
      const a = edges[e * 4]! * 3, b = edges[e * 4 + 1]! * 3;
      rx += (P[a]! + P[b]!) * 0.5;
      ry += (P[a + 1]! + P[b + 1]!) * 0.5;
      rz += (P[a + 2]! + P[b + 2]!) * 0.5;
    }
    const n = ne;
    out[p] = (qx / nf + (2 * rx) / ne + (n - 3) * P[p]!) / n;
    out[p + 1] = (qy / nf + (2 * ry) / ne + (n - 3) * P[p + 1]!) / n;
    out[p + 2] = (qz / nf + (2 * rz) / ne + (n - 3) * P[p + 2]!) / n;
  }
  return out;
}

/** Area-weighted vertex normals of a quad mesh. */
export function quadNormals(P: Float32Array, quads: Uint32Array, nVerts: number): Float32Array {
  const N = new Float32Array(nVerts * 3);
  for (let f = 0; f < quads.length; f += 4) {
    const a = quads[f]! * 3, b = quads[f + 1]! * 3, c = quads[f + 2]! * 3, d = quads[f + 3]! * 3;
    const ux = P[c]! - P[a]!, uy = P[c + 1]! - P[a + 1]!, uz = P[c + 2]! - P[a + 2]!;
    const vx = P[d]! - P[b]!, vy = P[d + 1]! - P[b + 1]!, vz = P[d + 2]! - P[b + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c, d]) {
      N[o] = N[o]! + nx;
      N[o + 1] = N[o + 1]! + ny;
      N[o + 2] = N[o + 2]! + nz;
    }
  }
  for (let i = 0; i < nVerts; i++) {
    const o = i * 3;
    const l = Math.hypot(N[o]!, N[o + 1]!, N[o + 2]!) || 1;
    N[o] = N[o]! / l;
    N[o + 1] = N[o + 1]! / l;
    N[o + 2] = N[o + 2]! / l;
  }
  return N;
}

/**
 * Stencil of one output vertex of a level: its weights over the level's input vertices (the
 * same rules as applyLevel, so Σ w·P_in reproduces the output position).
 */
export function levelStencil(L: SubdivLevel, o: number): Map<number, number> {
  const { nIn, nFaces, quads, edges } = L;
  const w = new Map<number, number>();
  const add = (v: number, x: number) => w.set(v, (w.get(v) ?? 0) + x);
  const face = (f: number, x: number) => {
    for (let c = 0; c < 4; c++) add(quads[f * 4 + c]!, x * 0.25);
  };
  if (o >= nIn + nFaces) {
    const e = o - nIn - nFaces;
    const a = edges[e * 4]!, b = edges[e * 4 + 1]!, f0 = edges[e * 4 + 2]!, f1 = edges[e * 4 + 3]!;
    if (f1 < 0) {
      add(a, 0.5);
      add(b, 0.5);
    } else {
      add(a, 0.25);
      add(b, 0.25);
      face(f0, 0.25);
      face(f1, 0.25);
    }
    return w;
  }
  if (o >= nIn) {
    face(o - nIn, 1);
    return w;
  }
  const v = o;
  if (L.boundary[v]) {
    const nb: number[] = [];
    for (let i = L.veOff[v]!; i < L.veOff[v + 1]!; i++) {
      const e = L.ve[i]!;
      if (edges[e * 4 + 3]! >= 0) continue;
      nb.push(edges[e * 4]! === v ? edges[e * 4 + 1]! : edges[e * 4]!);
    }
    if (nb.length === 2) {
      add(v, 6 / 8);
      add(nb[0]!, 1 / 8);
      add(nb[1]!, 1 / 8);
    } else add(v, 1);
    return w;
  }
  const nf = L.vfOff[v + 1]! - L.vfOff[v]!;
  const ne = L.veOff[v + 1]! - L.veOff[v]!;
  const n = ne;
  for (let i = L.vfOff[v]!; i < L.vfOff[v + 1]!; i++) face(L.vf[i]!, 1 / (nf * n));
  for (let i = L.veOff[v]!; i < L.veOff[v + 1]!; i++) {
    const e = L.ve[i]!;
    add(edges[e * 4]!, 1 / (ne * n));
    add(edges[e * 4 + 1]!, 1 / (ne * n));
  }
  add(v, (n - 3) / n);
  return w;
}

/** Stencil of a vertex `depth` levels down, over the vertices of levels[0]'s input. */
export function deepStencil(levels: SubdivLevel[], o: number, depth: number): Map<number, number> {
  let cur = new Map<number, number>([[o, 1]]);
  for (let d = depth - 1; d >= 0; d--) {
    const next = new Map<number, number>();
    for (const [v, x] of cur) for (const [u, y] of levelStencil(levels[d]!, v)) next.set(u, (next.get(u) ?? 0) + x * y);
    cur = next;
  }
  return cur;
}
