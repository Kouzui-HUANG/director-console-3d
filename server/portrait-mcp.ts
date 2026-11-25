/**
 * MCP server (stdio) for 人像工作室 (the portrait studio). A thin proxy like director3d: it
 * starts the companion server if needed, opens the portrait studio in Chrome when a tool needs
 * rendering, and forwards tool calls to /api/portrait-rpc (an open portrait tab answers them;
 * without one, the server works on portraits/*.json directly).
 * Configure in Claude Code via .mcp.json (included), or Claude Desktop:
 *   { "mcpServers": { "portrait3d": { "command": "node", "args": ["<repo>/server/portrait-mcp.ts"] } } }
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ADDS_FILE, api, EDITS_DOCUMENT, ensureServer as ensureServerWith, ensureTab as ensureTabOf, fail, guideText, imageOf, makeLog, READ_ONLY, SWITCHES_DOCUMENT, text } from './mcp-common.ts';

const log = makeLog('portrait3d-mcp');

async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, needsTab = false): Promise<T> {
  if (needsTab) await ensureTabOf('portrait', log);
  else await ensureServerWith(log);
  const r = await api<{ result: T }>('/api/portrait-rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
  return r.result;
}

const server = new McpServer({ name: 'portrait3d', version: '0.1.0' });

const CommandSchema = z.object({ cmd: z.string(), args: z.record(z.string(), z.unknown()).optional() });
const PortraitId = z.string().optional().describe('portrait id (pt_…); default: the open / last used portrait');
const VIEWS = ['front', 'threeQuarterLeft', 'left', 'back', 'right', 'threeQuarterRight', 'top', 'below'] as const;

server.registerTool(
  'portrait_guide',
  {
    description: 'Read the portrait studio agent guide (conventions, parameters, commands, traits, workflow from a text description or a photo, recipes). Call this first. Optional topic filters sections (e.g. "Conventions", "Workflow", "Recipes").',
    inputSchema: { topic: z.string().optional() },
    annotations: { title: 'Read the portrait guide', ...READ_ONLY },
  },
  async ({ topic }) => {
    try {
      return text(guideText('PORTRAIT_AGENTS.md', topic));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_list_params',
  {
    description:
      'Semantic parameters (159, in 14 groups). Without arguments: every group with "key label (low↔high) range unit". With group (base, head, brow, eyes, nose, mouth, cheek, chin, ears, neck, body, expr, pose, asym) or keys: full specs (realistic range, exaggeration limit, default, unit).',
    inputSchema: { group: z.string().optional(), keys: z.array(z.string()).optional() },
    annotations: { title: 'List portrait parameters', ...READ_ONLY },
  },
  async ({ group, keys }) => {
    try {
      return text(await rpc('listParams', { group, keys }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_list_presets',
  {
    description: 'Built-in presets (male/female × East Asian/European, neutral), the trait vocabulary (Chinese descriptions like 丹鳳眼, 高鼻樑, 鵝蛋臉 grouped by face part; recipes: true shows their parameters) and the framings.',
    inputSchema: { recipes: z.boolean().optional() },
    annotations: { title: 'List presets and traits', ...READ_ONLY },
  },
  async ({ recipes }) => {
    try {
      return text(await rpc('listPresets', { recipes }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_list_commands',
  {
    description: 'Portrait commands for portrait_run. Without name: one line each. With name: the JSON Schema of its args and examples.',
    inputSchema: { name: z.string().optional() },
    annotations: { title: 'List portrait commands', ...READ_ONLY },
  },
  async ({ name }) => {
    try {
      return text(await rpc('listCommands', { name }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_list',
  {
    description: 'Portraits in the library (portraits/*.json): id, name, preset, framing, number of changed parameters, last update.',
    inputSchema: {},
    annotations: { title: 'List portraits', ...READ_ONLY },
  },
  async () => {
    try {
      return text(await rpc('list'));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_new',
  {
    description: 'Create a portrait from a preset (default female-eastAsian; null = neutral) and make it the current one. framing: head | bust (default) | half | full.',
    inputSchema: { preset: z.string().nullable().optional(), name: z.string().optional(), framing: z.enum(['head', 'bust', 'half', 'full']).optional() },
    annotations: { title: 'New portrait', ...ADDS_FILE },
  },
  async ({ preset, name, framing }) => {
    try {
      return text(await rpc('create', { preset, name, framing }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_open',
  {
    description: 'Make a portrait the current one (and show it in the open portrait studio tab).',
    inputSchema: { portraitId: z.string() },
    annotations: { title: 'Open a portrait', ...SWITCHES_DOCUMENT },
  },
  async ({ portraitId }) => {
    try {
      return text(await rpc('open', { portraitId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_get',
  {
    description: 'The portrait document: name, framing and the parameters that differ from their defaults (with labels). resolved: true lists every parameter value instead.',
    inputSchema: { portraitId: PortraitId, resolved: z.boolean().optional() },
    annotations: { title: 'Get a portrait', ...READ_ONLY },
  },
  async ({ portraitId, resolved }) => {
    try {
      return text(await rpc('get', { portraitId, resolved }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_run',
  {
    description:
      'Run an atomic batch of portrait commands, e.g. [{"cmd":"portrait.applyTraits","args":{"traits":["鵝蛋臉","丹鳳眼"]}},{"cmd":"portrait.set","args":{"params":{"face.nose.bridgeHeight":0.4,"body.heightCm":165}}}]. All succeed or none apply (one undo step). On failure "errors" lists every problem with a hint. On success: warnings (clamped or exaggerated values), "checks.new" (problems this batch introduced, e.g. eyelids crossing) and key measures. dryRun checks without applying. Works without a browser tab (edits the portrait file).',
    inputSchema: { commands: z.array(CommandSchema).min(1), dryRun: z.boolean().optional(), portraitId: PortraitId },
    annotations: { title: 'Run portrait commands', ...EDITS_DOCUMENT },
  },
  async ({ commands, dryRun, portraitId }) => {
    try {
      const r = await rpc<{ ok?: boolean; error?: unknown; errors?: unknown[] }>('run', { commands, dryRun, portraitId });
      if (r && r.ok === false) {
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
  'portrait_measure',
  {
    description:
      'Measurements of the portrait (mm: height, head and face sizes, eyes, nose, mouth, lips, chin, ears; heads-tall), face ratios, z-scores against an average person of the same sex, ethnicity, age and height, and a Chinese description of the notable differences (e.g. "眼距偏寬（+1.2）"). Compare the description with what you were asked for. Works without a browser tab.',
    inputSchema: { portraitId: PortraitId },
    annotations: { title: 'Measure the portrait', ...READ_ONLY },
  },
  async ({ portraitId }) => {
    try {
      return text(await rpc('measure', { portraitId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_check',
  {
    description:
      'Plausibility checks: parameter problems (unknown, clamped, exaggerated), extreme heads-tall, height reached by scaling, strong head scaling, eyelids crossing or eyes closed, eyes too round, eye spacing, nose tip behind the lips, lips crossing, mouth as wide as the jaw, face thirds, ear position. Each has a hint naming the parameters to change. Works without a browser tab.',
    inputSchema: { portraitId: PortraitId },
    annotations: { title: 'Check the portrait', ...READ_ONLY },
  },
  async ({ portraitId }) => {
    try {
      return text(await rpc('check', { portraitId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_render',
  {
    description:
      'Render the portrait (white sculpture) — by default front, left 3/4 and left profile side by side. frame: all (the whole framed figure, default), head, face. light: studio | soft | side (shows form) | flat (for comparing with photos) | rembrandt. material: plaster | clay | matcap. focal in mm (85 default). landmarks: true marks face landmarks. Opens the portrait studio in Chrome if needed.',
    inputSchema: {
      portraitId: PortraitId,
      views: z.array(z.enum(VIEWS)).optional(),
      frame: z.enum(['all', 'head', 'face']).optional(),
      width: z.number().int().min(160).max(1600).optional().describe('per view, px'),
      height: z.number().int().min(160).max(1600).optional(),
      light: z.enum(['studio', 'soft', 'side', 'flat', 'rembrandt']).optional(),
      material: z.enum(['plaster', 'clay', 'matcap']).optional(),
      focal: z.number().min(18).max(300).optional(),
      landmarks: z.boolean().optional(),
    },
    annotations: { title: 'Render the portrait', ...READ_ONLY },
  },
  async ({ portraitId, ...o }) => {
    try {
      const r = await rpc<{ image: string; info: unknown }>('render', { portraitId, ...o }, true);
      return imageOf(r.image, r.info);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_export',
  {
    description: 'Export the portrait as PNG (needs the studio tab; opened automatically). Default: the 三視圖 deliverable — 正面／半側／側面 (front, left 3/4, left profile), head and shoulders, 1920 × 1080 (scale 2 → 3840 × 2160) — saved to exports/portraits/<name>_三視圖.png; always finish a portrait with it. With views (or layout "sheet"): the framed figure from those views with a caption, saved to exports/portraits/<name>.png. GLB / OBJ meshes come in a later phase.',
    inputSchema: {
      portraitId: PortraitId,
      format: z.enum(['png', 'glb', 'obj']).default('png'),
      layout: z.enum(['turnaround', 'sheet']).optional().describe('turnaround (default without views) = 正面／半側／側面 sheet; sheet = the given views with the current framing'),
      scale: z.number().min(0.5).max(2).optional().describe('turnaround size: 1 = 1920 × 1080 (default), 2 = 3840 × 2160'),
      views: z.array(z.enum(VIEWS)).optional(),
      name: z.string().optional(),
    },
    annotations: { title: 'Export the portrait', ...ADDS_FILE },
  },
  async ({ portraitId, format, layout, scale, views, name }) => {
    try {
      if (format !== 'png') return fail(new Error(`${format.toUpperCase()} export is not available yet (phase 7); use format "png"`));
      return text(await rpc('exportPng', { portraitId, layout, scale, views, name }, true));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_validate',
  {
    description: 'Validate portraits/<id>.json after editing the file directly; returns errors and warnings (unknown parameters are dropped with a "did you mean" hint).',
    inputSchema: { portraitId: z.string() },
    annotations: { title: 'Validate a portrait file', ...READ_ONLY },
  },
  async ({ portraitId }) => {
    try {
      await ensureServerWith(log);
      return text(await api(`/api/portraits/${encodeURIComponent(portraitId)}/validate`));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---- reference photos ------------------------------------------------------------------------------

const MAX_PHOTO = 20 * 1024 * 1024;

/** A local photo as a data URL (JPEG / PNG / WebP; HEIC is converted with macOS `sips`). */
async function photoDataUrl(file: string): Promise<string> {
  const p = path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
  if (!existsSync(p)) throw new Error(`no such file: ${p}`);
  if (statSync(p).size > MAX_PHOTO) throw new Error('the photo is larger than 20 MB');
  let buf = readFileSync(p);
  const head = buf.subarray(0, 16);
  const isHeic = head.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(head.subarray(8, 12).toString('latin1'));
  if (isHeic) {
    if (process.platform !== 'darwin') throw new Error('HEIC photos must be converted to JPEG first');
    const out = path.join(os.tmpdir(), `portrait-ref-${process.pid}-${Date.now()}.jpg`);
    try {
      await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', p, '--out', out]);
      buf = readFileSync(out);
    } finally {
      rmSync(out, { force: true });
    }
  }
  const type = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf.subarray(0, 4).toString('latin1') === '\x89PNG' ? 'image/png' : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
  if (!type) throw new Error('unsupported image: use JPEG, PNG, WebP or HEIC');
  return `data:${type};base64,${buf.toString('base64')}`;
}

server.registerTool(
  'portrait_add_reference',
  {
    description:
      'Add a reference photo (local file: JPEG, PNG, WebP, or HEIC on macOS) to the portrait. The studio tab analyses it locally with MediaPipe (478 landmarks, expression) — the photo is stored with the portrait in portraits/refs/ and never sent anywhere else. Returns the reference id, whether a face was found, the estimated camera (head turn, focal length) and the current landmark / outline error. Use 1–3 sharp photos: front and 3/4 views, neutral or slight expression. One undoable step.',
    inputSchema: { portraitId: PortraitId, path: z.string().describe('path of the photo on this computer'), note: z.string().max(500).optional().describe('e.g. "正面，自然光"') },
    annotations: { title: 'Add a reference photo', ...EDITS_DOCUMENT },
  },
  async ({ portraitId, path: file, note }) => {
    try {
      const dataUrl = await photoDataUrl(file);
      return text(await rpc('addReference', { portraitId, dataUrl, note: note ?? path.basename(file).replace(/\.[^.]+$/, '') }, true));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_references',
  {
    description: 'Reference photos of the portrait: id, note, analysis status (ready | noface | error), photo size, EXIF focal length, and for the current parameters the camera (head yaw/pitch, 35 mm focal length, distance) and the median landmark / face-outline error (% of the pupil distance). Remove one with portrait_run [{"cmd":"portrait.removeReference","args":{"id":"ref…"}}].',
    inputSchema: { portraitId: PortraitId },
    annotations: { title: 'List reference photos', ...READ_ONLY },
  },
  async ({ portraitId }) => {
    try {
      return text(await rpc('references', { portraitId }, true));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_compare',
  {
    description:
      'Compare a reference photo with the portrait seen through the photo\'s estimated camera. Image (mode all): photo | portrait | 50% overlay | landmarks (green photo, red portrait; outline blue photo, orange portrait). Report: landmark and outline error (% of pupil distance), per-region errors, the camera, and measured differences "photo vs portrait" in % (eye width / opening, inner eye corners, nose width / length, mouth width, lips, philtrum, face and jaw width, lower face; + = larger in the photo). Use it to judge likeness and decide which parameters to change; re-compare after changes. frame "head" shows the crown, ears and head outline (the face crop cuts them off).',
    inputSchema: {
      portraitId: PortraitId,
      refId: z.string().optional().describe('default: the first analysed photo'),
      mode: z.enum(['all', 'side', 'overlay', 'landmarks']).optional(),
      opacity: z.number().min(0).max(1).optional().describe('portrait opacity in the overlay (0.5)'),
      size: z.number().int().min(320).max(1400).optional().describe('panel height in px (720)'),
      frame: z.enum(['face', 'head']).optional().describe('face (default) = cropped to the face; head = the whole head with crown, ears and head outline'),
    },
    annotations: { title: 'Compare photo and portrait', ...READ_ONLY },
  },
  async ({ portraitId, ...o }) => {
    try {
      const r = await rpc<{ image: string; report: unknown }>('compare', { portraitId, ...o }, true);
      return imageOf(r.image, r.report);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'portrait_fit',
  {
    description:
      'Fit the face to the reference photos (all analysed ones, or refIds): estimates each photo\'s camera and adjusts the face parameters (head shape, brows, eyes, nose, mouth, cheeks, chin/jaw — or groups / keys) so the sculpture\'s face landmarks match (outline: true also fits the face widths to the jaw / cheek outline). Regularized toward the current values: parameters the photos cannot show (e.g. nose depth from a front photo) barely move; each changed parameter has a confidence 0…1. expression: estimate (default: fit the photo\'s expression, keep the first photo\'s) | neutral (fit it, then remove it) | keep (do not touch expr.*). One undoable step; dryRun returns the suggestion only. Running it again starts from the new values (it keeps moving toward the photos).',
    inputSchema: {
      portraitId: PortraitId,
      refIds: z.array(z.string()).optional(),
      groups: z.array(z.enum(['head', 'brow', 'eyes', 'nose', 'mouth', 'cheek', 'chin'])).optional(),
      keys: z.array(z.string()).optional().describe('fit only these parameters'),
      expression: z.enum(['estimate', 'neutral', 'keep']).optional(),
      lambda: z.number().min(0.5).max(100).optional().describe('prior strength (8): higher = smaller changes'),
      outline: z.boolean().optional().describe('experimental: then also fit head / jaw / chin width and cheek fullness to the lower face outline (best with a known focal length)'),
      dryRun: z.boolean().optional(),
    },
    annotations: { title: 'Fit the face to the photos', ...EDITS_DOCUMENT },
  },
  async ({ portraitId, ...o }) => {
    try {
      return text(await rpc('fit', { portraitId, ...o }, true));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
log('ready');
