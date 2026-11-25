/**
 * portrait3d MCP smoke test: launches server/portrait-mcp.ts over stdio like Claude Code does and
 * makes a portrait from a text description using only MCP tools — new → traits → measure →
 * check → render → export — then runs the photo workflow on a render of itself (add reference →
 * compare → fit dry run). Rendering needs a portrait studio tab; the MCP server opens Chrome if
 * none is connected (pass --no-render to skip the rendering and photo tools).
 * Usage: node scripts/portrait-mcp-smoke.ts [outDir] [--no-render] [--keep]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? path.join(ROOT, '.director3d', 'smoke-portrait');
const render = !args.includes('--no-render');
const keep = args.includes('--keep');
mkdirSync(out, { recursive: true });

const client = new Client({ name: 'portrait-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'server', 'portrait-mcp.ts')], cwd: ROOT, stderr: 'inherit' }));

type Content = { type: string; text?: string; data?: string; mimeType?: string };
let failures = 0;
let shots = 0;
async function call(name: string, a: Record<string, unknown> = {}, expectError = false) {
  const r = (await client.callTool({ name, arguments: a })) as { content: Content[]; isError?: boolean };
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
  const images = r.content.filter((c) => c.type === 'image');
  if (!!r.isError !== expectError) failures++;
  console.log(`\n## ${name}${r.isError ? ' (ERROR)' : ''}${!!r.isError !== expectError ? '  ← UNEXPECTED' : ''}\n${texts.join('\n').slice(0, 700)}`);
  images.forEach((img, i) => {
    const file = path.join(out, `${String(++shots).padStart(2, '0')}_${name}_${i}.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`);
    writeFileSync(file, Buffer.from(img.data ?? '', 'base64'));
    console.log(`(image saved: ${file})`);
  });
  return { r, json: () => JSON.parse(texts[0] ?? 'null') };
}

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const readOnly = tools.tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
console.log('read-only:', readOnly.join(', '));

// The brief: 「28 歲的台灣女生，鵝蛋臉、丹鳳眼、高鼻樑、薄唇，帶一點微笑，身高 165 公分，胸像」
await call('portrait_guide', { topic: 'Conventions' });
await call('portrait_list_params', { group: 'eyes' });
await call('portrait_list_presets');
const created = (await call('portrait_new', { preset: 'female-eastAsian', name: 'MCP 煙霧測試・丹鳳眼', framing: 'bust' })).json() as { id: string };
const id = created.id;
await call('portrait_run', { portraitId: id, commands: [{ cmd: 'portrait.applyTraits', args: { traits: ['鵝蛋臉', '丹鳳眼', '高鼻樑', '薄唇'], amount: 0.9 } }, { cmd: 'portrait.set', args: { params: { 'base.age': 28, 'body.heightCm': 165, 'expr.smile': 0.3 } } }] });
await call('portrait_run', { portraitId: id, commands: [{ cmd: 'portrait.set', args: { params: { 'face.nose.widht': 1 } } }] }, true);
const measured = (await call('portrait_measure', { portraitId: id })).json() as { description: string[]; summary: string; measures: { height: number } };
console.log('description:', measured.description.join('、'), '|', measured.summary);
if (Math.abs(measured.measures.height - 1650) > 3) failures++;
if (!measured.description.some((d) => d.includes('眼尾上揚'))) failures++;
await call('portrait_check', { portraitId: id });
await call('portrait_get', { portraitId: id });
if (render) {
  await call('portrait_render', { portraitId: id, width: 360 });
  await call('portrait_render', { portraitId: id, views: ['front'], frame: 'face', light: 'flat', width: 480 });
  await call('portrait_export', { portraitId: id, format: 'png' });
  await call('portrait_export', { portraitId: id, format: 'glb' }, true);
  // photo workflow on a synthetic "photo": a flat-lit render of the portrait itself, so the
  // comparison must line up (small error) and the fit has little to change
  const shot = await call('portrait_render', { portraitId: id, views: ['front'], frame: 'head', light: 'flat', width: 900, height: 1125 });
  const img = shot.r.content.find((c) => c.type === 'image');
  const photo = path.join(out, 'reference-front.jpg');
  writeFileSync(photo, Buffer.from(img?.data ?? '', 'base64'));
  const added = (await call('portrait_add_reference', { portraitId: id, path: photo, note: '煙霧測試：自己的正面' })).json() as { id: string; status: string; align?: { error: number } };
  if (added.status !== 'ready') failures++;
  await call('portrait_references', { portraitId: id });
  const report = (await call('portrait_compare', { portraitId: id, refId: added.id })).json() as { error: number; measures: unknown[] };
  if (!(report.error < 4) || !report.measures.length) failures++;
  await call('portrait_fit', { portraitId: id, dryRun: true, expression: 'keep' });
  await call('portrait_add_reference', { portraitId: id, path: path.join(out, 'missing.jpg') }, true);
}
await client.close();

if (!keep) {
  // remove the test portrait (moves it to portraits/.trash/)
  const token = readFileSync(path.join(ROOT, '.director3d', 'token'), 'utf8').trim();
  await fetch(`http://127.0.0.1:${process.env.DIRECTOR_PORT ?? 5178}/api/portraits/${id}`, { method: 'DELETE', headers: { 'x-director-token': token } });
}
console.log(failures ? `\n${failures} unexpected result(s)` : '\nall good');
process.exit(failures ? 1 : 0);
