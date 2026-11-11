/**
 * MCP smoke test: launches server/mcp.ts over stdio like Claude Code does and calls a few tools.
 * Usage: node scripts/mcp-smoke.ts [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const out = process.argv[2] ?? path.join(ROOT, '.director3d', 'smoke');
mkdirSync(out, { recursive: true });

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'server', 'mcp.ts')], cwd: ROOT, stderr: 'inherit' }));

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
  const images = r.content.filter((c) => c.type === 'image');
  console.log(`\n## ${name}${r.isError ? ' (ERROR)' : ''}\n${texts.join('\n').slice(0, 600)}`);
  images.forEach((img, i) => {
    const file = path.join(out, `${name}_${i}.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`);
    writeFileSync(file, Buffer.from(img.data ?? '', 'base64'));
    console.log(`(image saved: ${file})`);
  });
  return r;
}

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
await call('get_guide', { topic: 'Conventions' });
await call('list_commands');
await call('list_projects');
await call('describe_scene', { time: 2 });
await call('run_commands', { commands: [{ cmd: 'object.add', args: { type: 'box', id: 'smokeBox', position: [2, 0, 2] } }], dryRun: true });
await call('run_commands', { commands: [{ cmd: 'object.add', args: { type: 'man' } }] });
await call('view_camera', { time: 2 });
await call('snapshot', { time: 2, width: 512 });
await client.close();
