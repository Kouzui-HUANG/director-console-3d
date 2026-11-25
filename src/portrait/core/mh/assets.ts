/**
 * MakeHuman (CC0) assets converted by scripts/portrait-mh-convert.ts: base mesh hm08 (decimeters),
 * morph targets (sparse, Int16-quantized), the modifier definitions, the default skeleton and its
 * skin weights. Pure parsing — loading is done by the caller (fetch in the browser, fs in Node).
 */
export interface MhModifierJson {
  target?: string;
  min?: string;
  max?: string;
  macrovar?: string;
  label?: string;
  modifierType?: string;
}

export interface MhGroupJson {
  group: string;
  modifiers: MhModifierJson[];
}

export interface MhTargetEntry {
  name: string;
  offset: number;
  count: number;
  scale: number;
}

export interface MhMeta {
  format: string;
  version: number;
  source: { repository: string; commit: string; basemesh: string; units: string; license: string };
  vertexCount: number;
  faceCount: number;
  groups: string[];
  layout: { positions: [number, number]; quads: [number, number]; faceGroups: [number, number] };
  targetEntries: number;
  targets: MhTargetEntry[];
  modifiers: { modeling: MhGroupJson[]; measurement: MhGroupJson[]; descriptions: unknown };
  skeleton: { name: string; bones: { name: string; parent: number; head: number; tail: number }[]; joints: { name: string; verts: number[] }[]; weights: string };
}

/** MakeHuman default skeleton: bones in parent-first order, joints as vertex lists, 4 weights per vertex. */
export interface MhSkeleton {
  names: string[];
  index: Map<string, number>;
  parent: Int16Array;
  /** Joint indices of each bone's head and tail. */
  head: Uint16Array;
  tail: Uint16Array;
  /** Joint position = mean of these vertices (kept-vertex indices). */
  joints: Uint32Array[];
  /** Per vertex: 4 bone indices and normalized weights. */
  bones: Uint8Array;
  weights: Float32Array;
}

export interface MhAssets {
  meta: MhMeta;
  /** Rest positions, decimeters (xyz per vertex). */
  base: Float32Array;
  quads: Uint32Array;
  faceGroups: Uint16Array;
  /** All targets' vertex indices, then all quantized deltas (xyz). */
  tIndex: Uint16Array;
  tDelta: Int16Array;
  targetByName: Map<string, MhTargetEntry>;
  /** Quads of the body surface only (no helpers). */
  bodyQuads: Uint32Array;
  /** Vertex indices of each eye helper (left, right). */
  eyeVerts: [Uint32Array, Uint32Array];
  skeleton: MhSkeleton | null;
}

function facesOfGroup(quads: Uint32Array, faceGroups: Uint16Array, gi: number): Uint32Array {
  let n = 0;
  for (let f = 0; f < faceGroups.length; f++) if (faceGroups[f] === gi) n++;
  const out = new Uint32Array(n * 4);
  let o = 0;
  for (let f = 0; f < faceGroups.length; f++) {
    if (faceGroups[f] !== gi) continue;
    for (let c = 0; c < 4; c++) out[o++] = quads[f * 4 + c]!;
  }
  return out;
}

function vertsOf(faces: Uint32Array): Uint32Array {
  return Uint32Array.from(new Set(faces));
}

function parseSkeleton(meta: MhMeta, weightsBuf: ArrayBuffer): MhSkeleton {
  const sk = meta.skeleton;
  const n = meta.vertexCount;
  return {
    names: sk.bones.map((b) => b.name),
    index: new Map(sk.bones.map((b, i) => [b.name, i])),
    parent: Int16Array.from(sk.bones, (b) => b.parent),
    head: Uint16Array.from(sk.bones, (b) => b.head),
    tail: Uint16Array.from(sk.bones, (b) => b.tail),
    joints: sk.joints.map((j) => Uint32Array.from(j.verts)),
    weights: new Float32Array(weightsBuf.slice(0, n * 16)),
    bones: new Uint8Array(weightsBuf.slice(n * 16, n * 20)),
  };
}

export function parseAssets(meta: MhMeta, baseBuf: ArrayBuffer, targetsBuf: ArrayBuffer, weightsBuf?: ArrayBuffer): MhAssets {
  const L = meta.layout;
  const base = new Float32Array(baseBuf.slice(L.positions[0], L.positions[0] + L.positions[1]));
  const quads = new Uint32Array(baseBuf.slice(L.quads[0], L.quads[0] + L.quads[1]));
  const faceGroups = new Uint16Array(baseBuf.slice(L.faceGroups[0], L.faceGroups[0] + L.faceGroups[1]));
  const n = meta.targetEntries;
  const tIndex = new Uint16Array(targetsBuf, 0, n);
  const tDelta = new Int16Array(targetsBuf, n * 2, n * 3);
  const targetByName = new Map(meta.targets.map((t) => [t.name, t]));
  const g = (name: string) => meta.groups.indexOf(name);
  return {
    meta,
    base,
    quads,
    faceGroups,
    tIndex,
    tDelta,
    targetByName,
    bodyQuads: facesOfGroup(quads, faceGroups, g('body')),
    eyeVerts: [vertsOf(facesOfGroup(quads, faceGroups, g('helper-l-eye'))), vertsOf(facesOfGroup(quads, faceGroups, g('helper-r-eye')))],
    skeleton: weightsBuf && meta.skeleton ? parseSkeleton(meta, weightsBuf) : null,
  };
}

/** Browser loader (the files are served from public/portrait/mh/). */
export async function fetchAssets(baseUrl = '/portrait/mh/'): Promise<MhAssets> {
  const get = async (f: string) => {
    const r = await fetch(baseUrl + f);
    if (!r.ok) throw new Error(`cannot load ${baseUrl}${f}: HTTP ${r.status} (run: node scripts/portrait-mh-convert.ts vendor/makehuman/makehuman/data public/portrait/mh)`);
    return r;
  };
  const [meta, base, targets, weights] = await Promise.all([
    get('mh.json').then((r) => r.json() as Promise<MhMeta>),
    get('base.bin').then((r) => r.arrayBuffer()),
    get('targets.bin').then((r) => r.arrayBuffer()),
    get('weights.bin').then((r) => r.arrayBuffer()),
  ]);
  return parseAssets(meta, base, targets, weights);
}
