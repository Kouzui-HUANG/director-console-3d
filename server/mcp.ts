/**
 * MCP server (stdio) for 3D 導演台. A thin proxy: it starts the companion server if needed,
 * opens the app in Chrome when a tool needs rendering, and forwards tool calls.
 * Configure in Claude Code via .mcp.json (included), or Claude Desktop:
 *   { "mcpServers": { "director3d": { "command": "node", "args": ["<repo>/server/mcp.ts"] } } }
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(path.resolve(process.env.DIRECTOR_DATA ?? ROOT), '.director3d');
const PORT = Number(process.env.DIRECTOR_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;

function log(...a: unknown[]) {
  console.error('[director3d-mcp]', ...a);
}

function token(): string {
  const f = path.join(STATE, 'token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

async function api<T = unknown>(p: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-director-token': token(), ...(init.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { code: string; message: string; hint?: string } } & Record<string, unknown>;
  if (!res.ok || data.ok === false) {
    const e = data.error;
    throw new Error(e ? `${e.code}: ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}` : `HTTP ${res.status}`);
  }
  return data as T;
}

async function healthy(): Promise<{ tabs: number; currentProject: string | null } | null> {
  try {
    return await api<{ tabs: number; currentProject: string | null }>('/api/health');
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureServer(): Promise<void> {
  if (await healthy()) return;
  log('starting companion server…');
  const dev = !existsSync(path.join(ROOT, 'dist', 'index.html'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.ts'), ...(dev ? ['--dev'] : [])], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await healthy()) return;
  }
  throw new Error(`could not start the companion server on ${BASE} (run "npm run dev" in ${ROOT} and try again)`);
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args =
    process.platform === 'darwin'
      ? existsSync('/Applications/Google Chrome.app')
        ? ['-a', 'Google Chrome', url]
        : [url]
      : process.platform === 'win32'
        ? ['/c', 'start', '', url]
        : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function ensureTab(): Promise<void> {
  await ensureServer();
  const h = await healthy();
  if (h && h.tabs > 0) return;
  log('opening the app in the browser…');
  openBrowser(`${BASE}/${h?.currentProject ? `?project=${encodeURIComponent(h.currentProject)}` : ''}`);
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const s = await healthy();
    if (s && s.tabs > 0) {
      await sleep(800);
      return;
    }
  }
  throw new Error(`no browser tab connected; open ${BASE}/ in Chrome and retry`);
}

async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, needsTab = false): Promise<T> {
  if (needsTab) await ensureTab();
  else await ensureServer();
  const r = await api<{ result: T }>('/api/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
  return r.result;
}

// Compact JSON: indentation costs agents tokens and adds nothing for a model.
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const imageOf = (dataUrl: string, info: unknown) => {
  const [head, b64] = dataUrl.split(',');
  const mimeType = /data:(.*?);/.exec(head ?? '')?.[1] ?? 'image/jpeg';
  return { content: [{ type: 'image' as const, data: b64 ?? '', mimeType }, { type: 'text' as const, text: JSON.stringify(info) }] };
};
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

const server = new McpServer({ name: 'director3d', version: '0.1.0' });

const CommandSchema = z.object({ cmd: z.string(), args: z.record(z.string(), z.unknown()).optional() });

// Tool annotations let MCP clients (e.g. Claude Code) auto-approve read-only tools.
// Everything here is local (127.0.0.1), so openWorldHint is false. snapshot / storyboard may open
// the app in Chrome but never change the project, so they count as read-only.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const EDITS_SCENE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const ADDS_FILE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const SWITCHES_PROJECT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

interface AssetTypeInfo {
  type: string;
  category: string;
  en: string;
  description: string;
  params: { key: string }[];
}

server.registerTool(
  'get_guide',
  {
    description: 'Read the 3D 導演台 agent guide (conventions, coordinate system, commands, recipes). Call this first. Optional topic filters sections (e.g. "camera", "commands", "recipes").',
    inputSchema: { topic: z.string().optional() },
    annotations: { title: 'Read the agent guide', ...READ_ONLY },
  },
  async ({ topic }) => {
    try {
      const guide = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
      if (!topic) return text(guide);
      const parts = guide.split(/\n(?=## )/).filter((p) => p.toLowerCase().includes(topic.toLowerCase()));
      return text(parts.length ? parts.join('\n') : guide);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'list_commands',
  {
    description: 'List all scene commands. Without "name": names + one-line summaries. With "name": the full JSON Schema and examples for that command.',
    inputSchema: { name: z.string().optional() },
    annotations: { title: 'List scene commands', ...READ_ONLY },
  },
  async ({ name }) => {
    try {
      await ensureServer();
      const list = await api<Array<{ name: string; summary: string; args: unknown; examples: unknown[] }>>('/api/commands');
      if (name) {
        const c = list.find((x) => x.name === name);
        return c ? text(c) : fail(new Error(`no command "${name}"; known: ${list.map((x) => x.name).join(', ')}`));
      }
      return text(list.map((c) => `${c.name} — ${c.summary}`).join('\n'));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'list_asset_types',
  {
    description:
      'Object types for object.add. Without "type": every type with a one-line description and its param names, grouped by category. With "type" (one, or comma-separated like "male,chair"): full param specs (ranges, units, defaults, options, which are animatable).',
    inputSchema: {
      type: z.string().optional(),
      category: z.enum(['character', 'terrain', 'architecture', 'prop', 'camera', 'helper']).optional(),
    },
    annotations: { title: 'List object types', ...READ_ONLY },
  },
  async ({ type, category }) => {
    try {
      await ensureServer();
      const list = await api<AssetTypeInfo[]>('/api/asset-types');
      if (type) {
        const names = type.split(',').map((n) => n.trim()).filter(Boolean);
        const unknown = names.filter((n) => !list.some((d) => d.type === n));
        if (unknown.length) return fail(new Error(`unknown type ${unknown.map((n) => `"${n}"`).join(', ')}; known: ${list.map((d) => d.type).join(', ')}`));
        return text(list.filter((d) => names.includes(d.type)));
      }
      const rows = list.filter((d) => !category || d.category === category);
      const groups = new Map<string, string[]>();
      for (const d of rows) {
        const line = `${d.type} — ${d.description}${d.params.length ? ` (params: ${d.params.map((f) => f.key).join(', ')})` : ''}`;
        groups.set(d.category, [...(groups.get(d.category) ?? []), line]);
      }
      return text([...groups].map(([cat, lines]) => `## ${cat}\n${lines.join('\n')}`).join('\n\n'));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'get_project',
  {
    description:
      'Get the project JSON (objects, keyframes, cameras, cuts). For big scenes pass "ids" (only those objects) and/or "fields" (only those sections) to save tokens; describe_scene is often enough.',
    inputSchema: {
      ids: z.array(z.string()).optional().describe('only these objects'),
      fields: z.array(z.enum(['settings', 'objects', 'cuts', 'markers', 'notes'])).optional().describe('only these sections (id, name, revision are always included)'),
      projectId: z.string().optional(),
    },
    annotations: { title: 'Get project JSON', ...READ_ONLY },
  },
  async ({ ids, fields, projectId }) => {
    try {
      return text(await rpc('get', { ids, fields, projectId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'run_commands',
  {
    description:
      'Run an atomic batch of scene commands, e.g. [{"cmd":"object.add","args":{"type":"male","id":"hero"}}]. All succeed or none apply (one undo step). "$0" refers to the id returned by command 0. On failure "errors" lists every problem in the batch (each with index and hint), so fix them all before retrying. On success "checks.new" lists scene problems this batch introduced (overlaps, floating objects, crossed 180° line, jump cuts…) and "checks.resolved" how many it fixed. dryRun checks without applying. Works without a browser tab (edits the project file).',
    inputSchema: { commands: z.array(CommandSchema).min(1), dryRun: z.boolean().optional(), check: z.boolean().optional().describe('false skips the scene-check diff'), projectId: z.string().optional() },
    annotations: { title: 'Run scene commands', ...EDITS_SCENE },
  },
  async ({ commands, dryRun, check, projectId }) => {
    try {
      const r = await rpc<{ ok?: boolean; error?: unknown; errors?: unknown[] }>('run', { commands, dryRun, check, projectId });
      if (r && r.ok === false) {
        // errors[0] is the same as error; send it once.
        const { error: _first, ...rest } = r;
        return { ...text(r.errors?.length ? rest : r), isError: true };
      }
      return text(r);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'check_scene',
  {
    description:
      'Automatic checks over the whole timeline, like an AD reviewing the scene: characters walking through furniture or each other (OVERLAP), floating or sunken objects (FLOATING, BELOW_GROUND), cameras inside walls or underground (CAMERA_INSIDE, CAMERA_UNDERGROUND), shots showing nobody or hiding their subject (EMPTY_SHOT, SUBJECT_HIDDEN), cuts crossing the 180° line or jump-cutting (CROSSED_LINE, JUMP_CUT), flash frames and timing slips (SHORT_SHOT, SAME_CAMERA_CUT, CUT_AFTER_END, KEYS_AFTER_END). Each issue has ids, time range and a hint with a fix. Works without a browser tab.',
    inputSchema: {
      codes: z.array(z.string()).optional().describe('only these checks, e.g. ["CROSSED_LINE","JUMP_CUT"]'),
      projectId: z.string().optional(),
    },
    annotations: { title: 'Check the scene', ...READ_ONLY },
  },
  async ({ codes, projectId }) => {
    try {
      return text(await rpc('check', { codes, projectId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'describe_scene',
  {
    description: 'Text summary of the scene at a time: objects with positions/facing, cameras with lens, and what each camera sees (shot size, placement, coverage).',
    inputSchema: { time: z.number().min(0).max(30).optional(), camera: z.string().optional(), projectId: z.string().optional() },
    annotations: { title: 'Describe the scene', ...READ_ONLY },
  },
  async ({ time, camera, projectId }) => {
    try {
      return text(await rpc('describe', { time, camera, projectId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'view_camera',
  {
    description: 'Structured framing analysis for one camera (default: program camera): per-object frame boxes (0..1), coverage, shot size, and occlusion (when the app is open).',
    inputSchema: { camera: z.string().optional(), time: z.number().min(0).max(30).optional(), projectId: z.string().optional() },
    annotations: { title: 'Analyze camera framing', ...READ_ONLY },
  },
  async ({ camera, time, projectId }) => {
    try {
      return text(await rpc('view', { camera, time, projectId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'evaluate_scene',
  {
    description:
      'Exact resolved state at a time, with animation, follow and lookAt applied: position, rotation, scale, params (e.g. pose) per object; position, rotation, lens, focal length, FOV and aim point per camera. Use for precise math; describe_scene is the readable summary.',
    inputSchema: { time: z.number().min(0).max(30).optional(), ids: z.array(z.string()).optional().describe('only these objects / cameras'), projectId: z.string().optional() },
    annotations: { title: 'Evaluate the scene at a time', ...READ_ONLY },
  },
  async ({ time, ids, projectId }) => {
    try {
      return text(await rpc('evaluate', { time, ids, projectId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'ground_height',
  {
    description: 'Terrain height (hills) at ground points [x, z]; 0 on flat ground. Use the returned y as position y to stand objects on slopes.',
    inputSchema: { points: z.array(z.tuple([z.number(), z.number()])).min(1).max(200).describe('[[x, z], ...] in meters'), projectId: z.string().optional() },
    annotations: { title: 'Get terrain height', ...READ_ONLY },
  },
  async ({ points, projectId }) => {
    try {
      return text(await rpc('groundHeight', { points, projectId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'snapshot',
  {
    description:
      'Render what a camera sees as an image (default: program camera at the playhead, 768 px wide). labels:true draws each object\'s id, frame box, shot size and how hidden it is, so you can tell which shape is which. cameras:"all" (or a list of ids) renders every camera at that time side by side in one image (LIVE camera outlined red; width = per-camera width, default 384). Opens the app in Chrome if needed.',
    inputSchema: {
      camera: z.string().optional(),
      cameras: z.union([z.literal('all'), z.array(z.string()).min(1)]).optional().describe('"all" or camera ids → one image with every camera'),
      time: z.number().min(0).max(30).optional(),
      width: z.number().int().min(64).max(3840).optional(),
      labels: z.boolean().optional().describe('draw object ids, boxes, shot sizes'),
      projectId: z.string().optional(),
    },
    annotations: { title: 'Render a camera frame', ...READ_ONLY },
  },
  async ({ camera, cameras, time, width, labels, projectId }) => {
    try {
      if (cameras) {
        const r = await rpc<{ dataUrl: string; width: number; height: number; time: number; cameras: string[]; live: string | null }>('cameraSheet', { cameras, time, labels, thumbWidth: width, projectId }, true);
        return imageOf(r.dataUrl, { width: r.width, height: r.height, time: r.time, cameras: r.cameras, live: r.live });
      }
      const r = await rpc<{ dataUrl: string; width: number; height: number; camera: string | null; time: number }>('snapshot', { camera, time, width, labels, projectId }, true);
      return imageOf(r.dataUrl, { width: r.width, height: r.height, camera: r.camera, time: r.time });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'plan_view',
  {
    description:
      'Top-down floor plan at a time (north up, +X east right): object footprints with ids, characters with facing arrows, cameras with field-of-view wedges and aim lines (LIVE camera red), motion paths with key times, metric grid and scale bar. The quickest way to check blocking, camera placement, eyelines and which side of the 180° line each camera is on. area = [minX, minZ, maxX, maxZ] to zoom (default: fits the action). Opens the app in Chrome if needed.',
    inputSchema: {
      time: z.number().min(0).max(30).optional(),
      area: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('[minX, minZ, maxX, maxZ] meters'),
      width: z.number().int().min(320).max(3000).optional(),
      paths: z.boolean().optional().describe('draw motion paths (default true)'),
      projectId: z.string().optional(),
    },
    annotations: { title: 'Render a floor plan', ...READ_ONLY },
  },
  async ({ time, area, width, paths, projectId }) => {
    try {
      const r = await rpc<{ dataUrl: string; width: number; height: number; time: number; area: number[]; grid: number }>('planView', { time, area, width, paths, projectId }, true);
      return imageOf(r.dataUrl, { width: r.width, height: r.height, time: r.time, area: r.area, gridMeters: r.grid });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'storyboard',
  {
    description: 'Render a storyboard sheet: one frame per shot of the edit (program) or evenly spaced frames, labelled with timecode/camera/markers. labels:true also marks object ids on every frame.',
    inputSchema: {
      camera: z.string().optional(),
      count: z.number().int().min(1).max(48).optional(),
      times: z.array(z.number()).optional(),
      labels: z.boolean().optional(),
      projectId: z.string().optional(),
    },
    annotations: { title: 'Render a storyboard', ...READ_ONLY },
  },
  async ({ camera, count, times, labels, projectId }) => {
    try {
      const r = await rpc<{ dataUrl: string; width: number; height: number; times: number[] }>('storyboard', { camera, count, times, labels, projectId }, true);
      return imageOf(r.dataUrl, { width: r.width, height: r.height, times: r.times });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'export_video',
  {
    description:
      'Render the edit (or one camera) to MP4 (H.264 when available) saved under exports/. Waits up to ~50 s; for longer renders returns a jobId — poll get_export_status.',
    inputSchema: {
      camera: z.string().optional().describe('camera id, or omit for the cut list (program)'),
      start: z.number().min(0).max(30).optional(),
      end: z.number().min(0).max(30).optional(),
      tier: z.enum(['720p', '1080p', '1440p', '4k']).optional(),
      quality: z.enum(['draft', 'standard', 'high']).optional(),
      burnIn: z.object({ timecode: z.boolean().optional(), camera: z.boolean().optional(), lens: z.boolean().optional(), title: z.boolean().optional() }).optional(),
      filename: z.string().optional(),
      projectId: z.string().optional(),
    },
    annotations: { title: 'Export video', ...ADDS_FILE },
  },
  async ({ projectId, ...params }) => {
    try {
      await ensureTab();
      const { jobId } = await api<{ jobId: string }>('/api/jobs', { method: 'POST', body: JSON.stringify({ projectId, params }) });
      for (let i = 0; i < 100; i++) {
        await sleep(500);
        const j = await api<{ status: string; result?: unknown; error?: string; progress: number }>(`/api/jobs/${jobId}`);
        if (j.status === 'done') return text(j.result);
        if (j.status === 'error') return fail(new Error(j.error));
      }
      return text({ jobId, status: 'running', note: 'Still rendering. Call get_export_status with this jobId.' });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'get_export_status',
  { description: 'Progress/result of an export_video job.', inputSchema: { jobId: z.string() }, annotations: { title: 'Check export progress', ...READ_ONLY } },
  async ({ jobId }) => {
    try {
      await ensureServer();
      return text(await api(`/api/jobs/${jobId}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'list_projects',
  { description: 'List saved projects (id, name, updatedAt, object count, duration).', inputSchema: {}, annotations: { title: 'List projects', ...READ_ONLY } },
  async () => {
    try {
      return text(await rpc('projects.list'));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'open_project',
  { description: 'Make a project the current one (in the open tab, or for file-based edits).', inputSchema: { projectId: z.string() }, annotations: { title: 'Open a project', ...SWITCHES_PROJECT } },
  async ({ projectId }) => {
    try {
      return text(await rpc('projects.open', { id: projectId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'new_project',
  {
    description: 'Create a project from a template (blank, street, livingRoom, cityAerial, lenses, hillside) and open it.',
    inputSchema: { name: z.string().optional(), template: z.enum(['blank', 'street', 'livingRoom', 'cityAerial', 'lenses', 'hillside']).optional() },
    annotations: { title: 'Create a project', ...ADDS_FILE },
  },
  async ({ name, template }) => {
    try {
      return text(await rpc('projects.create', { name, template: template ?? 'blank' }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'validate_project',
  { description: 'Validate projects/<id>.json after editing the file directly; returns errors and warnings.', inputSchema: { projectId: z.string() }, annotations: { title: 'Validate a project file', ...READ_ONLY } },
  async ({ projectId }) => {
    try {
      await ensureServer();
      return text(await api(`/api/projects/${encodeURIComponent(projectId)}/validate`));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
log('ready');
