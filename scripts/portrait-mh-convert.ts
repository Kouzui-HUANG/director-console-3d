/**
 * Converts MakeHuman CC0 data (base mesh hm08, morph targets, modifier definitions) into compact
 * binaries for the portrait engine.
 *
 *   node scripts/portrait-mh-convert.ts <makehuman data dir> <output dir>
 *   node scripts/portrait-mh-convert.ts vendor/makehuman/makehuman/data public/portrait/mh
 *
 * Output:
 *   mh.json      metadata: vertex/face counts, groups, target index, modifiers, source and license
 *   base.bin     Float32 positions (decimeters, MakeHuman units) · Uint32 quads · Uint16 face groups
 *   targets.bin  Uint16 vertex indices for all targets, then Int16 quantized deltas (xyz)
 * Only vertices of the body, the eye helpers and the joint helpers are kept (others are
 * clothing/hair/teeth fitting helpers we do not use); indices are remapped to that subset.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node scripts/portrait-mh-convert.ts <makehuman data dir> <output dir>');
  process.exit(1);
}
const MIN_DELTA = 1e-4; // decimeters (0.01 mm): smaller target offsets are dropped

// ---- base mesh -------------------------------------------------------------------------------
const obj = readFileSync(path.join(src, '3dobjs', 'base.obj'), 'utf8');
const pos: number[] = [];
const quads: number[] = [];
const faceGroup: number[] = [];
const groups: string[] = [];
let group = -1;
for (const line of obj.split('\n')) {
  if (line.startsWith('v ')) {
    const p = line.trim().split(/\s+/);
    pos.push(Number(p[1]), Number(p[2]), Number(p[3]));
  } else if (line.startsWith('g ')) {
    const name = line.slice(2).trim();
    group = groups.indexOf(name);
    if (group < 0) group = groups.push(name) - 1;
  } else if (line.startsWith('f ')) {
    const idx = line.slice(2).trim().split(/\s+/).map((t) => parseInt(t.split('/')[0]!, 10) - 1);
    if (idx.length !== 4) throw new Error(`non-quad face: ${line}`);
    quads.push(...idx);
    faceGroup.push(group);
  }
}
const vertexCount = pos.length / 3;
const keepGroup = (name: string) => name === 'body' || name === 'helper-l-eye' || name === 'helper-r-eye' || name.startsWith('joint-');
const keep = new Int32Array(vertexCount).fill(-1);
const keptFaces: number[] = [];
for (let f = 0; f < faceGroup.length; f++) {
  if (!keepGroup(groups[faceGroup[f]!]!)) continue;
  keptFaces.push(f);
  for (let c = 0; c < 4; c++) keep[quads[f * 4 + c]!] = 0;
}
let kept = 0;
const original: number[] = [];
for (let v = 0; v < vertexCount; v++) {
  if (keep[v] === 0) {
    keep[v] = kept++;
    original.push(v);
  }
}
const outPos = new Float32Array(kept * 3);
for (let i = 0; i < kept; i++) for (let a = 0; a < 3; a++) outPos[i * 3 + a] = pos[original[i]! * 3 + a]!;
const outQuads = new Uint32Array(keptFaces.length * 4);
const outGroups = new Uint16Array(keptFaces.length);
const usedGroups: string[] = [];
keptFaces.forEach((f, i) => {
  for (let c = 0; c < 4; c++) outQuads[i * 4 + c] = keep[quads[f * 4 + c]!]!;
  const name = groups[faceGroup[f]!]!;
  let gi = usedGroups.indexOf(name);
  if (gi < 0) gi = usedGroups.push(name) - 1;
  outGroups[i] = gi;
});

// ---- targets -------------------------------------------------------------------------------
function walk(dir: string, rel = ''): string[] {
  const res: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) {
      if (name === 'images' || name === 'genitals') continue;
      res.push(...walk(full, r));
    } else if (name.endsWith('.target')) res.push(r);
  }
  return res;
}
const targetFiles = walk(path.join(src, 'targets'));
interface TargetEntry {
  name: string;
  offset: number;
  count: number;
  scale: number;
}
const index: TargetEntry[] = [];
const allIdx: number[] = [];
const allDelta: number[] = [];
let droppedSmall = 0;
let droppedHelper = 0;
for (const file of targetFiles) {
  const text = readFileSync(path.join(src, 'targets', file), 'utf8');
  const rows: [number, number, number, number][] = [];
  let maxAbs = 0;
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const v = Number(p[0]);
    const k = keep[v] ?? -1;
    if (k < 0) {
      droppedHelper++;
      continue;
    }
    const dx = Number(p[1]), dy = Number(p[2]), dz = Number(p[3]);
    if (Math.abs(dx) < MIN_DELTA && Math.abs(dy) < MIN_DELTA && Math.abs(dz) < MIN_DELTA) {
      droppedSmall++;
      continue;
    }
    rows.push([k, dx, dy, dz]);
    maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy), Math.abs(dz));
  }
  const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
  index.push({ name: file.replace(/\.target$/, ''), offset: allIdx.length, count: rows.length, scale });
  for (const [k, dx, dy, dz] of rows) {
    allIdx.push(k);
    allDelta.push(Math.round(dx / scale), Math.round(dy / scale), Math.round(dz / scale));
  }
}
if (kept > 65535) throw new Error('too many vertices for Uint16 indices');

// ---- skeleton and skin weights ----------------------------------------------------------------
interface MhSkel {
  bones: Record<string, { head: string; tail: string; parent: string | null }>;
  joints: Record<string, number[]>;
}
const skelJson = JSON.parse(readFileSync(path.join(src, 'rigs', 'default.mhskel'), 'utf8')) as MhSkel;
const weightsJson = JSON.parse(readFileSync(path.join(src, 'rigs', 'default_weights.mhw'), 'utf8')) as { weights: Record<string, [number, number][]> };
const jointNames = Object.keys(skelJson.joints);
let missingJointVerts = 0;
const joints = jointNames.map((j) =>
  skelJson.joints[j]!.map((v) => {
    const k = keep[v] ?? -1;
    if (k < 0) missingJointVerts++;
    return k;
  }).filter((k) => k >= 0),
);
// parents before children
const boneNames: string[] = [];
const visit = (name: string) => {
  if (boneNames.includes(name)) return;
  const parent = skelJson.bones[name]!.parent;
  if (parent) visit(parent);
  boneNames.push(name);
};
for (const name of Object.keys(skelJson.bones)) visit(name);
const bones = boneNames.map((name) => {
  const b = skelJson.bones[name]!;
  return { name, parent: b.parent ? boneNames.indexOf(b.parent) : -1, head: jointNames.indexOf(b.head), tail: jointNames.indexOf(b.tail) };
});
// per kept vertex: top 4 influences, normalized
const influences: [number, number][][] = Array.from({ length: kept }, () => []);
for (const [bone, list] of Object.entries(weightsJson.weights)) {
  const bi = boneNames.indexOf(bone);
  if (bi < 0) continue;
  for (const [v, w] of list) {
    const k = keep[v] ?? -1;
    if (k >= 0 && w > 0) influences[k]!.push([bi, w]);
  }
}
const wBones = new Uint8Array(kept * 4);
const wWeights = new Float32Array(kept * 4);
let unweighted = 0;
influences.forEach((list, v) => {
  list.sort((a, b) => b[1] - a[1]);
  const top = list.slice(0, 4);
  const sum = top.reduce((a, [, w]) => a + w, 0);
  if (!sum) unweighted++;
  top.forEach(([bi, w], i) => {
    wBones[v * 4 + i] = bi;
    wWeights[v * 4 + i] = sum ? w / sum : 0;
  });
});

// ---- write ----------------------------------------------------------------------------------
mkdirSync(out, { recursive: true });
const baseBuf = Buffer.concat([Buffer.from(outPos.buffer), Buffer.from(outQuads.buffer), Buffer.from(outGroups.buffer)]);
writeFileSync(path.join(out, 'base.bin'), baseBuf);
const idxArr = new Uint16Array(allIdx);
const dArr = new Int16Array(allDelta);
writeFileSync(path.join(out, 'targets.bin'), Buffer.concat([Buffer.from(idxArr.buffer), Buffer.from(dArr.buffer)]));
writeFileSync(path.join(out, 'weights.bin'), Buffer.concat([Buffer.from(wWeights.buffer), Buffer.from(wBones.buffer)]));
const readJson = (f: string) => JSON.parse(readFileSync(path.join(src, 'modifiers', f), 'utf8'));
let commit = 'unknown';
try {
  const head = path.join(src, '..', '..', '.git', 'HEAD');
  if (existsSync(head)) commit = readFileSync(head, 'utf8').trim();
} catch {
  /* not a git checkout */
}
const meta = {
  format: 'director3d.mh-assets',
  version: 1,
  source: { repository: 'https://github.com/makehumancommunity/makehuman', commit, basemesh: 'hm08', units: 'decimeter', license: 'CC0-1.0 (LICENSE.ASSETS.md)' },
  vertexCount: kept,
  faceCount: keptFaces.length,
  groups: usedGroups,
  originalVertexIndex: original,
  layout: { positions: [0, kept * 12], quads: [kept * 12, keptFaces.length * 16], faceGroups: [kept * 12 + keptFaces.length * 16, keptFaces.length * 2] },
  targetEntries: allIdx.length,
  targets: index,
  modifiers: { modeling: readJson('modeling_modifiers.json'), measurement: readJson('measurement_modifiers.json'), descriptions: readJson('modeling_modifiers_desc.json') },
  skeleton: { name: 'MakeHuman default skeleton (CC0)', bones, joints: joints.map((verts, i) => ({ name: jointNames[i], verts })), weights: 'weights.bin: Float32 weights[n*4] then Uint8 bones[n*4]' },
  checksum: createHash('sha1').update(baseBuf).digest('hex'),
};
writeFileSync(path.join(out, 'mh.json'), JSON.stringify(meta));
writeFileSync(path.join(out, 'LICENSE.ASSETS.md'), readFileSync(path.join(src, '..', '..', 'LICENSE.ASSETS.md'), 'utf8'));

const mb = (n: number) => (n / 1e6).toFixed(1) + ' MB';
console.log(`vertices ${vertexCount} → kept ${kept}; faces ${faceGroup.length} → kept ${keptFaces.length}; groups ${usedGroups.length}`);
console.log(`targets ${index.length}, entries ${allIdx.length} (dropped: ${droppedSmall} tiny, ${droppedHelper} helper-only)`);
console.log(`skeleton: ${bones.length} bones, ${joints.length} joints (${missingJointVerts} joint verts outside the kept set), unweighted vertices: ${unweighted}`);
console.log(`base.bin ${mb(baseBuf.length)}, targets.bin ${mb(idxArr.byteLength + dArr.byteLength)}, mh.json ${mb(JSON.stringify(meta).length)}`);
