/**
 * 3D 導演台 companion server (optional).
 *  - serves the app on http://127.0.0.1:5178 (Vite middleware in --dev, dist/ otherwise)
 *  - stores projects as projects/<id>.json and watches them (external edits → live reload)
 *  - bridges agent requests (HTTP /api/rpc, MCP) to the open browser tab over WebSocket
 *  - runs pure core commands on files when no tab is open
 * Security: binds 127.0.0.1 only, checks Host + Origin, requires a token (.director3d/token).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { readdir, readFile, rename, stat, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { assetTypeInfo } from '../src/core/assetTypes.ts';
import { describeCommands } from '../src/core/commands/registry.ts';
import { CommandError } from '../src/core/commands/types.ts';
import { runCommands, type CommandCall } from '../src/core/commands/execute.ts';
import { checkScene, describeSceneWithChecks, issueDiff } from '../src/core/checks.ts';
import { cameraView, resolvedScene } from '../src/core/describe.ts';
import { programCameraAt } from '../src/core/evaluate.ts';
import { projectJson, serializeProject } from '../src/core/project.ts';
import { ProjectSchema, PROJECT_ID_PATTERN, type Project } from '../src/core/schema.ts';
import { templateProject, TEMPLATES } from '../src/core/templates.ts';
import { groundHeightAt } from '../src/core/terrain.ts';
import { validateProject } from '../src/core/validate.ts';
import { newPortrait, PORTRAIT_ID_PATTERN, portraitJsonSchema, serializePortrait, validatePortrait, FRAMINGS, type FramingType, type Portrait } from '../src/portrait/core/schema.ts';
import { PRESET_BY_ID } from '../src/portrait/core/params/presets.ts';
import { buildSpec, checkReport, commandList, issueDiff as portraitIssueDiff, measureReport, paramList, portraitView, presetList } from '../src/portrait/core/agent.ts';
import { runPortraitCommands, type PortraitCommandCall } from '../src/portrait/core/commands.ts';
import { parseAssets } from '../src/portrait/core/mh/assets.ts';
import { HumanBuilder } from '../src/portrait/core/mh/human.ts';

const VERSION = '0.1.0';
const ROOT = path.resolve(import.meta.dirname, '..');
/** Where projects/, exports/ and .director3d/ live (default: the repo root). */
const DATA = path.resolve(process.env.DIRECTOR_DATA ?? ROOT);
const PORT = Number(process.env.DIRECTOR_PORT ?? 5178);
const HOST = '127.0.0.1';
const DEV = process.argv.includes('--dev');
const PROJECTS = path.join(DATA, 'projects');
const THUMBS = path.join(PROJECTS, '.thumbs');
const TRASH = path.join(PROJECTS, '.trash');
const EXPORTS = path.join(DATA, 'exports');
const PORTRAITS = path.join(DATA, 'portraits');
const PORTRAIT_THUMBS = path.join(PORTRAITS, '.thumbs');
const PORTRAIT_TRASH = path.join(PORTRAITS, '.trash');
const EXPORT_DIRS = new Set(['portraits']);
const STATE = path.join(DATA, '.director3d');
const SCHEMA_DIR = path.join(ROOT, 'schema');
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

for (const d of [PROJECTS, THUMBS, TRASH, EXPORTS, STATE, SCHEMA_DIR, PORTRAITS, PORTRAIT_THUMBS, PORTRAIT_TRASH]) mkdirSync(d, { recursive: true });

function log(...a: unknown[]) {
  console.error('[director3d]', ...a);
}

// ---- token & state files ---------------------------------------------------------------

/**
 * Replace a file by writing a sibling temp file and renaming it over the target. Atomic, and it
 * never edits an existing file in place — on macOS a file created under another app's identity
 * in a protected folder (e.g. ~/Documents) may refuse in-place writes but still allows replacing.
 */
function writeFileAtomicSync(file: string, data: string | Buffer, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, file);
}

async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const TOKEN_FILE = path.join(STATE, 'token');
let TOKEN: string;
if (existsSync(TOKEN_FILE)) TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
else {
  TOKEN = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}
try {
  chmodSync(TOKEN_FILE, 0o600);
} catch {
  /* windows */
}

function tokenOk(t: string | undefined | null): boolean {
  if (!t) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// JSON Schema for editors / agents editing project files directly.
writeFileAtomicSync(
  path.join(SCHEMA_DIR, 'project.schema.json'),
  JSON.stringify({ $id: 'director3d.project.schema.json', title: '3D 導演台 project', ...(z.toJSONSchema(ProjectSchema, { io: 'input', target: 'draft-07', unrepresentable: 'any' }) as object) }, null, 2),
);

writeFileAtomicSync(path.join(SCHEMA_DIR, 'portrait.schema.json'), JSON.stringify(portraitJsonSchema(), null, 2));

// ---- helpers ------------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  code: string;
  hint?: string;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readBody(req: http.IncomingMessage, limit = 30 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'TOO_LARGE', 'request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'BAD_CONTENT_TYPE', 'use content-type: application/json');
  const text = await readBody(req);
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'invalid JSON body');
  }
}

function checkId(id: string): string {
  if (!PROJECT_ID_PATTERN.test(id)) throw new HttpError(400, 'BAD_ID', `invalid project id "${id}"`);
  return id;
}

const projectFile = (id: string) => path.join(PROJECTS, `${checkId(id)}.json`);
const hash = (s: string) => createHash('sha1').update(s).digest('hex');
const lastWritten = new Map<string, string>();

async function writeProjectFile(p: Project): Promise<void> {
  const text = serializeProject(p, { schemaRef: '../schema/project.schema.json' }) + '\n';
  const file = projectFile(p.id);
  const tmp = `${file}.${process.pid}.tmp`;
  lastWritten.set(p.id, hash(text));
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

async function loadProjectFile(id: string): Promise<Project> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(projectFile(id), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'NOT_FOUND', `no project "${id}"`, 'Call list_projects for ids.');
    throw new HttpError(422, 'BAD_FILE', `projects/${id}.json is not valid JSON: ${(e as Error).message}`);
  }
  const r = validateProject(raw);
  if (!r.ok || !r.project) throw new HttpError(422, 'INVALID_PROJECT', `projects/${id}.json: ${r.errors.map((x) => `${x.path}: ${x.message}`).join('; ')}`);
  return r.project;
}

async function listProjects() {
  const files = (await readdir(PROJECTS)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(PROJECTS, f), 'utf8'));
      const id = f.slice(0, -5);
      let thumbnail: string | null = null;
      const tf = path.join(THUMBS, `${id}.jpg`);
      if (existsSync(tf)) thumbnail = `data:image/jpeg;base64,${(await readFile(tf)).toString('base64')}`;
      const st = await stat(path.join(PROJECTS, f));
      out.push({
        id,
        name: String(raw.name ?? id),
        updatedAt: String(raw.updatedAt ?? st.mtime.toISOString()),
        revision: Number(raw.revision ?? 0),
        objects: Array.isArray(raw.objects) ? raw.objects.length : 0,
        duration: Number(raw.settings?.duration ?? 10),
        thumbnail,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---- portraits (portrait studio) ---------------------------------------------------------------

function checkPortraitId(id: string): string {
  if (!PORTRAIT_ID_PATTERN.test(id)) throw new HttpError(400, 'BAD_ID', `invalid portrait id "${id}"`, 'Portrait ids look like "pt_k3v9x2ab".');
  return id;
}

const portraitFile = (id: string) => path.join(PORTRAITS, `${checkPortraitId(id)}.json`);

async function writePortraitFile(p: Portrait): Promise<void> {
  const text = serializePortrait(p, { schemaRef: '../schema/portrait.schema.json' }) + '\n';
  const file = portraitFile(p.id);
  lastWritten.set(p.id, hash(text));
  await writeFileAtomic(file, text);
}

async function listPortraits() {
  const files = (await readdir(PORTRAITS)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const id = f.slice(0, -5);
      if (!PORTRAIT_ID_PATTERN.test(id)) continue;
      const raw = JSON.parse(await readFile(path.join(PORTRAITS, f), 'utf8'));
      const tf = path.join(PORTRAIT_THUMBS, `${id}.jpg`);
      const st = await stat(path.join(PORTRAITS, f));
      out.push({
        id,
        name: String(raw.name ?? id),
        preset: typeof raw.preset === 'string' ? raw.preset : null,
        framing: String(raw.framing?.type ?? 'bust'),
        params: raw.params && typeof raw.params === 'object' ? Object.keys(raw.params).length : 0,
        updatedAt: String(raw.updatedAt ?? st.mtime.toISOString()),
        revision: Number(raw.revision ?? 0),
        thumbnail: existsSync(tf) ? `data:image/jpeg;base64,${(await readFile(tf)).toString('base64')}` : null,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---- browser tabs (bridge) ---------------------------------------------------------------------

interface Tab {
  ws: WebSocket;
  /** director (index.html) or portrait (portrait.html); agent RPC goes to director tabs only. */
  kind: 'director' | 'portrait';
  projectId: string | null;
  projectName: string | null;
  focused: boolean;
  visible: boolean;
  seen: number;
}
const tabs = new Set<Tab>();
let lastProjectId: string | null = null;
let lastPortraitId: string | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

interface Job {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  frame: number;
  total: number;
  result?: unknown;
  error?: string;
  started: number;
}
const jobs = new Map<string, Job>();

function pickTab(projectId?: string, kind: Tab['kind'] = 'director'): Tab | null {
  const live = [...tabs].filter((t) => t.ws.readyState === WebSocket.OPEN && t.kind === kind);
  if (!live.length) return null;
  const ranked = live.sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId) || Number(b.focused) - Number(a.focused) || Number(b.visible) - Number(a.visible) || b.seen - a.seen);
  return ranked[0] ?? null;
}

function rpcToTab(tab: Tab, method: string, params: unknown, timeoutMs: number, jobId?: string): Promise<unknown> {
  const id = randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new HttpError(504, 'TIMEOUT', `the browser tab did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    tab.ws.send(JSON.stringify({ type: 'rpc', id, method, params, jobId }));
  });
}

function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const t of tabs) if (t.ws.readyState === WebSocket.OPEN) t.ws.send(data);
}

// ---- headless operations (no tab open) -----------------------------------------------------

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : undefined);

async function headless(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = String(params.projectId ?? lastProjectId ?? '');
  if (method === 'listCommands') return describeCommands();
  if (method === 'assetTypes') return assetTypeInfo();
  if (method === 'templates') return TEMPLATES.map((t) => ({ id: t.id, label: t.label, description: t.description }));
  if (method === 'projects.list') return (await listProjects()).map(({ thumbnail: _t, ...m }) => m);
  if (method === 'projects.create') {
    const p = templateProject(String(params.template ?? 'blank'), typeof params.name === 'string' ? params.name : undefined);
    await writeProjectFile(p);
    lastProjectId = p.id;
    return { id: p.id, name: p.name };
  }
  if (method === 'projects.open') {
    const pid = checkId(String(params.id ?? params.projectId ?? ''));
    await loadProjectFile(pid);
    lastProjectId = pid;
    return { ok: true, current: { id: pid } };
  }
  if (!id) throw new HttpError(409, 'NO_PROJECT', 'no project is open', 'Pass projectId, call list_projects, or open the app in Chrome.');
  const p = await loadProjectFile(id);
  const t = typeof params.time === 'number' ? params.time : 0;
  switch (method) {
    case 'get':
      return projectJson(p, { ids: strings(params.ids), fields: strings(params.fields) });
    case 'evaluate':
      return resolvedScene(p, t, { ids: strings(params.ids) });
    case 'groundHeight': {
      if (Array.isArray(params.points)) return (params.points as [number, number][]).map(([x, z]) => ({ x, z, y: groundHeightAt(p, Number(x), Number(z)) }));
      return groundHeightAt(p, Number(params.x ?? 0), Number(params.z ?? 0));
    }
    case 'describe':
      return describeSceneWithChecks(p, t, { camera: typeof params.camera === 'string' ? params.camera : undefined });
    case 'check':
      return checkScene(p, { codes: strings(params.codes), step: typeof params.step === 'number' ? params.step : undefined });
    case 'view': {
      const cam = typeof params.camera === 'string' && params.camera !== 'program' ? params.camera : programCameraAt(p, t);
      if (!cam) throw new HttpError(400, 'NO_CAMERA', 'no camera in the scene');
      return cameraView(p, cam, t);
    }
    case 'run': {
      const calls = (Array.isArray(params.commands) ? params.commands : [params]) as CommandCall[];
      const r = runCommands(p, calls, { time: t, selection: [] });
      if (!r.ok) return { ok: false, error: r.error, errors: r.errors, warnings: r.warnings };
      if (!params.dryRun && r.mutated) await writeProjectFile({ ...r.project, revision: p.revision + 1, updatedAt: new Date().toISOString() });
      const diff = r.mutated && params.check !== false ? issueDiff(p, r.project) : null;
      const checks = diff && (diff.new.length || diff.resolved) ? { new: diff.new, resolved: diff.resolved } : undefined;
      return { ok: true, results: r.results, warnings: r.warnings, ...(checks ? { checks } : {}), dryRun: !!params.dryRun, headless: true };
    }
    default:
      throw new HttpError(409, 'NO_RENDERER', `"${method}" needs the app open in a browser tab`, `Open http://127.0.0.1:${PORT}/ in Chrome (the MCP server does this automatically).`);
  }
}

const RPC_TIMEOUT: Record<string, number> = { exportVideo: 30 * 60_000, storyboard: 120_000, cameraSheet: 120_000, snapshot: 60_000, planView: 60_000 };

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const tab = pickTab(typeof params.projectId === 'string' ? params.projectId : undefined);
  if (!tab) return headless(method, params);
  if (typeof params.projectId === 'string' && tab.projectId !== params.projectId) {
    await rpcToTab(tab, 'projects.open', [params.projectId], 30_000);
  }
  const { projectId: _p, ...rest } = params;
  const positional = ['seek', 'select', 'undo', 'redo', 'help', 'describeCommand', 'projects.open', 'projects.remove', 'log'];
  const args = Array.isArray(rest.args) ? rest.args : positional.includes(method) ? Object.values(rest) : method === 'run' ? [rest.commands ?? rest, { dryRun: !!rest.dryRun, check: rest.check }] : [rest];
  return rpcToTab(tab, method, args, RPC_TIMEOUT[method] ?? 30_000);
}

// ---- portrait agent requests (tab first, headless on the files otherwise) ---------------------

let portraitBuilder: Promise<HumanBuilder> | null = null;

/** The MakeHuman engine for headless measuring / checking (loaded on first use, ~40 MB). */
function portraitEngine(): Promise<HumanBuilder> {
  if (!portraitBuilder) {
    portraitBuilder = (async () => {
      const dir = path.join(ROOT, 'public', 'portrait', 'mh');
      if (!existsSync(path.join(dir, 'weights.bin'))) throw new HttpError(503, 'NO_ASSETS', 'the converted MakeHuman data is missing (public/portrait/mh/)', 'Run: node scripts/portrait-mh-convert.ts vendor/makehuman/makehuman/data public/portrait/mh');
      const buf = async (f: string) => {
        const b = await readFile(path.join(dir, f));
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      };
      const meta = JSON.parse(await readFile(path.join(dir, 'mh.json'), 'utf8'));
      return new HumanBuilder(parseAssets(meta, await buf('base.bin'), await buf('targets.bin'), await buf('weights.bin')));
    })();
    portraitBuilder.catch(() => (portraitBuilder = null));
  }
  return portraitBuilder;
}

async function loadPortraitFile(id: string): Promise<Portrait> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(portraitFile(id), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'NOT_FOUND', `no portrait "${id}"`, 'portrait_list shows the portraits.');
    throw new HttpError(422, 'BAD_FILE', `portraits/${id}.json is not valid JSON: ${(e as Error).message}`);
  }
  const r = validatePortrait(raw);
  if (!r.ok || !r.portrait) throw new HttpError(422, 'INVALID_PORTRAIT', `portraits/${id}.json: ${r.errors.map((x) => `${x.path}: ${x.message}`).join('; ')}`);
  return r.portrait;
}

const PORTRAIT_HEADLESS_HELP = `portrait requests without a portrait tab (headless, on portraits/*.json):
  help, listParams {group?, keys?}, listPresets {recipes?}, listCommands {name?}, list, create {preset?, name?, framing?},
  open {portraitId}, get {resolved?}, run {commands, dryRun?}, measure, check, save
Rendering (render, exportPng) needs the portrait studio open in a browser tab: ${'http://127.0.0.1'}:${PORT}/portrait`;

async function portraitHeadless(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'help') return PORTRAIT_HEADLESS_HELP;
  if (method === 'listParams') return paramList({ group: typeof params.group === 'string' ? params.group : undefined, keys: strings(params.keys) });
  if (method === 'listPresets') return presetList({ recipes: !!params.recipes });
  if (method === 'listCommands') return commandList(typeof params.name === 'string' ? params.name : undefined);
  if (method === 'list') return (await listPortraits()).map(({ thumbnail: _t, ...m }) => m);
  if (method === 'create') {
    const preset = params.preset === null ? null : typeof params.preset === 'string' ? params.preset : 'female-eastAsian';
    if (preset && !PRESET_BY_ID.has(preset)) throw new HttpError(400, 'UNKNOWN_PRESET', `no preset "${preset}"`, `Presets: ${[...PRESET_BY_ID.keys()].join(', ')}`);
    const framing = typeof params.framing === 'string' ? (params.framing as FramingType) : undefined;
    if (framing && !FRAMINGS.includes(framing)) throw new HttpError(400, 'INVALID_ARGS', `no framing "${framing}"`, `Framings: ${FRAMINGS.join(', ')}`);
    const p = newPortrait({ name: typeof params.name === 'string' ? params.name : undefined, preset, params: { ...(preset ? PRESET_BY_ID.get(preset)!.params : {}) }, framing: framing ? { type: framing } : undefined });
    await writePortraitFile(p);
    lastPortraitId = p.id;
    return { id: p.id, name: p.name, headless: true };
  }
  if (method === 'open') {
    const pid = checkPortraitId(String(params.portraitId ?? ''));
    const p = await loadPortraitFile(pid);
    lastPortraitId = pid;
    return { id: p.id, name: p.name, headless: true };
  }
  const id = String(params.portraitId ?? lastPortraitId ?? '');
  if (!id) throw new HttpError(409, 'NO_PORTRAIT', 'no portrait is open', 'Pass portraitId, call portrait_list / portrait_new, or open the portrait studio.');
  const p = await loadPortraitFile(id);
  lastPortraitId = id;
  switch (method) {
    case 'get':
      return portraitView(p, { resolved: !!params.resolved });
    case 'measure':
      return measureReport(await portraitEngine(), p);
    case 'check':
      return checkReport(await portraitEngine(), p);
    case 'save':
      return { id: p.id, revision: p.revision, headless: true };
    case 'run': {
      const calls = (Array.isArray(params.commands) ? params.commands : [params.commands]) as PortraitCommandCall[];
      const r = runPortraitCommands(p, calls);
      if (!r.ok) return { ok: false, error: r.error, errors: r.errors, warnings: r.warnings };
      if (params.dryRun || !r.mutated) return { ok: true, results: r.results, warnings: r.warnings, dryRun: !!params.dryRun, changed: false, headless: true };
      const next: Portrait = { ...r.portrait, revision: p.revision + 1, updatedAt: new Date().toISOString() };
      await writePortraitFile(next);
      broadcast({ type: 'portrait-changed', id });
      const engine = await portraitEngine();
      const diff = portraitIssueDiff(checkReport(engine, p), checkReport(engine, next));
      const m = engine.build(buildSpec(next.params).spec).measures;
      const measures = { heightCm: Math.round(m.height) / 10, headsTall: Math.round(m.headsTall * 100) / 100, faceWidth: Math.round(m.faceWidth), ipd: Math.round(m.ipd * 10) / 10, eyeOpening: Math.round(m.eyeOpening * 10) / 10 };
      return { ok: true, results: r.results, warnings: r.warnings, ...(diff.new.length || diff.resolved ? { checks: diff } : {}), measures, revision: next.revision, headless: true };
    }
    default:
      throw new HttpError(409, 'NO_RENDERER', `"${method}" needs the portrait studio open in a browser tab`, `Open http://127.0.0.1:${PORT}/portrait in Chrome (the portrait3d MCP server does this automatically).`);
  }
}

const PORTRAIT_RPC_TIMEOUT: Record<string, number> = { render: 120_000, exportPng: 120_000, sweep: 300_000, presetSheet: 300_000, addReference: 120_000, compare: 120_000, fit: 300_000, fitSelfTest: 900_000, calibrateContour: 900_000, calibrateConsensus: 900_000, calibrateBrows: 900_000 };

async function portraitRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const pid = typeof params.portraitId === 'string' ? params.portraitId : undefined;
  const tab = pickTab(pid, 'portrait');
  if (!tab) return portraitHeadless(method, params);
  if (method === 'open') return rpcToTab(tab, 'open', [{ portraitId: pid }], 30_000);
  if (pid && tab.projectId !== pid && !['help', 'list', 'create', 'listParams', 'listPresets', 'listCommands'].includes(method)) {
    await rpcToTab(tab, 'open', [{ portraitId: pid }], 30_000);
  }
  const { portraitId: _p, ...rest } = params;
  return rpcToTab(tab, method, [rest], PORTRAIT_RPC_TIMEOUT[method] ?? 60_000);
}

// ---- file watching (agents editing projects/*.json) ------------------------------------------------

const debounce = new Map<string, NodeJS.Timeout>();
watch(PROJECTS, (_event, filename) => {
  if (!filename || !filename.endsWith('.json') || filename.includes('.tmp')) return;
  const id = filename.slice(0, -5);
  if (!PROJECT_ID_PATTERN.test(id)) return;
  clearTimeout(debounce.get(id));
  debounce.set(
    id,
    setTimeout(async () => {
      try {
        const text = await readFile(path.join(PROJECTS, filename), 'utf8');
        if (lastWritten.get(id) === hash(text)) return;
        lastWritten.set(id, hash(text));
        log(`external change: projects/${filename}`);
        broadcast({ type: 'project-changed', id });
      } catch {
        /* deleted */
      }
    }, 150),
  );
});

const portraitDebounce = new Map<string, NodeJS.Timeout>();
watch(PORTRAITS, (_event, filename) => {
  if (!filename || !filename.endsWith('.json') || filename.includes('.tmp')) return;
  const id = filename.slice(0, -5);
  if (!PORTRAIT_ID_PATTERN.test(id)) return;
  clearTimeout(portraitDebounce.get(id));
  portraitDebounce.set(
    id,
    setTimeout(async () => {
      try {
        const text = await readFile(path.join(PORTRAITS, filename), 'utf8');
        if (lastWritten.get(id) === hash(text)) return;
        lastWritten.set(id, hash(text));
        log(`external change: portraits/${filename}`);
        broadcast({ type: 'portrait-changed', id });
      } catch {
        /* deleted */
      }
    }, 150),
  );
});

// ---- HTTP -------------------------------------------------------------------------------

let vite: { middlewares: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void; transformIndexHtml: (url: string, html: string) => Promise<string> } | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function injectToken(html: string): string {
  return html.replace('<head>', `<head>\n    <meta name="director3d-token" content="${TOKEN}" />`);
}

/** Extra HTML entry points besides the director (index.html). */
const PAGES: Record<string, string> = { '/portrait': 'portrait.html', '/portrait.html': 'portrait.html' };

async function serveApp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const page = PAGES[url.pathname];
  if (DEV && vite) {
    const isHtml = !!page || url.pathname === '/' || url.pathname === '/index.html' || (!path.extname(url.pathname) && !url.pathname.startsWith('/@') && !url.pathname.startsWith('/src') && !url.pathname.startsWith('/node_modules'));
    if (isHtml) {
      const html = await vite.transformIndexHtml(url.pathname, await readFile(path.join(ROOT, page ?? 'index.html'), 'utf8'));
      res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store' });
      res.end(injectToken(html));
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end('not found');
    });
    return;
  }
  const dist = path.join(ROOT, 'dist');
  let file = page ? path.join(dist, page) : path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || (await stat(file)).isDirectory()) file = path.join(dist, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('尚未建置網頁：請先執行 npm run build（或用 npm run dev 開發模式）。');
    return;
  }
  const ext = path.extname(file);
  if (ext === '.html') {
    res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store' });
    res.end(injectToken(await readFile(file, 'utf8')));
    return;
  }
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const token = (req.headers['x-director-token'] as string | undefined) ?? url.searchParams.get('token');
  if (!tokenOk(token)) throw new HttpError(401, 'UNAUTHORIZED', 'missing or wrong x-director-token', `Read the token from ${TOKEN_FILE}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method ?? 'GET';

  if (parts[1] === 'health') {
    const open = [...tabs].filter((t) => t.ws.readyState === WebSocket.OPEN);
    return send(res, 200, {
      ok: true,
      version: VERSION,
      root: ROOT,
      projectsDir: PROJECTS,
      portraitsDir: PORTRAITS,
      exportsDir: EXPORTS,
      tabs: open.filter((t) => t.kind === 'director').length,
      portraitTabs: open.filter((t) => t.kind === 'portrait').length,
      currentProject: pickTab()?.projectId ?? lastProjectId,
      currentPortrait: pickTab(undefined, 'portrait')?.projectId ?? lastPortraitId,
    });
  }
  if (parts[1] === 'guide') return send(res, 200, { text: await readFile(path.join(ROOT, 'AGENTS.md'), 'utf8') });
  if (parts[1] === 'commands') return send(res, 200, describeCommands());
  if (parts[1] === 'asset-types') return send(res, 200, assetTypeInfo());

  if (parts[1] === 'projects') {
    const id = parts[2];
    if (!id && m === 'GET') return send(res, 200, await listProjects());
    if (!id && m === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await headless('projects.create', body));
    }
    if (id && parts[3] === 'validate' && m === 'GET') {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(projectFile(id), 'utf8'));
      } catch (e) {
        return send(res, 200, { ok: false, errors: [{ path: '(file)', message: (e as Error).message }], warnings: [] });
      }
      const r = validateProject(raw);
      return send(res, 200, { ok: r.ok, errors: r.errors, warnings: r.warnings });
    }
    if (id && m === 'GET') return send(res, 200, JSON.parse(await readFile(projectFile(id), 'utf8').catch(() => {
      throw new HttpError(404, 'NOT_FOUND', `no project "${id}"`);
    })));
    if (id && m === 'PUT') {
      const body = await readJson(req);
      const r = validateProject(body.project);
      if (!r.ok || !r.project) throw new HttpError(422, 'INVALID_PROJECT', r.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
      if (r.project.id !== id) throw new HttpError(400, 'ID_MISMATCH', 'project.id does not match the URL');
      await writeProjectFile(r.project);
      if (typeof body.thumbnail === 'string' && body.thumbnail.startsWith('data:image/jpeg;base64,')) {
        await writeFileAtomic(path.join(THUMBS, `${id}.jpg`), Buffer.from(body.thumbnail.split(',')[1]!, 'base64'));
      }
      lastProjectId = id;
      return send(res, 200, { ok: true, revision: r.project.revision });
    }
    if (id && m === 'DELETE') {
      const file = projectFile(id);
      if (existsSync(file)) await rename(file, path.join(TRASH, `${id}-${Date.now()}.json`));
      const thumb = path.join(THUMBS, `${id}.jpg`);
      if (existsSync(thumb)) unlinkSync(thumb);
      return send(res, 200, { ok: true, movedTo: 'projects/.trash/' });
    }
  }

  if (parts[1] === 'portraits') {
    const id = parts[2];
    if (!id && m === 'GET') return send(res, 200, await listPortraits());
    if (!id && m === 'POST') {
      const body = await readJson(req);
      const preset = typeof body.preset === 'string' ? body.preset : null;
      if (preset && !PRESET_BY_ID.has(preset)) throw new HttpError(400, 'UNKNOWN_PRESET', `no preset "${preset}"`, `Presets: ${[...PRESET_BY_ID.keys()].join(', ')}`);
      const draft = newPortrait({ name: typeof body.name === 'string' ? body.name : undefined, preset, params: { ...(preset ? PRESET_BY_ID.get(preset)!.params : {}) } });
      const r = validatePortrait(draft);
      if (!r.ok || !r.portrait) throw new HttpError(422, 'INVALID_PORTRAIT', r.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
      await writePortraitFile(r.portrait);
      return send(res, 200, { ok: true, id: r.portrait.id, portrait: r.portrait });
    }
    if (id && parts[3] === 'refs') {
      // reference photos: portraits/refs/<id>/<refId>.<ext>
      checkPortraitId(id);
      const dir = path.join(PORTRAITS, 'refs', id);
      const file = parts[4];
      if (!file && m === 'POST') {
        const type = String(req.headers['content-type'] ?? '');
        const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('jpeg') || type.includes('jpg') ? 'jpg' : '';
        if (!ext) throw new HttpError(415, 'BAD_CONTENT_TYPE', 'send the image as image/jpeg, image/png or image/webp');
        const refId = `ref${randomBytes(5).toString('hex')}`;
        await mkdir(dir, { recursive: true });
        const target = path.join(dir, `${refId}.${ext}`);
        let size = 0;
        const limit = 25 * 1024 * 1024;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > limit) throw new HttpError(413, 'TOO_LARGE', 'images must be at most 25 MB');
          chunks.push(c as Buffer);
        }
        await writeFileAtomic(target, Buffer.concat(chunks));
        return send(res, 200, { ok: true, refId, file: `refs/${id}/${refId}.${ext}`, bytes: size });
      }
      if (file) {
        if (!/^ref[a-z0-9]{1,16}\.(jpg|png|webp)$/.test(file)) throw new HttpError(400, 'BAD_FILE', `invalid reference file "${file}"`);
        const target = path.join(dir, file);
        if (m === 'GET') {
          if (!existsSync(target)) throw new HttpError(404, 'NOT_FOUND', `no reference photo ${file}`);
          const data = await readFile(target);
          res.writeHead(200, { 'content-type': file.endsWith('png') ? 'image/png' : file.endsWith('webp') ? 'image/webp' : 'image/jpeg', 'cache-control': 'no-store' });
          return res.end(data);
        }
        if (m === 'DELETE') {
          if (existsSync(target)) await rename(target, path.join(PORTRAIT_TRASH, `${id}-${file}`));
          return send(res, 200, { ok: true, movedTo: 'portraits/.trash/' });
        }
      }
    }
    if (id && parts[3] === 'validate' && m === 'GET') {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(portraitFile(id), 'utf8'));
      } catch (e) {
        return send(res, 200, { ok: false, errors: [{ path: '(file)', message: (e as Error).message }], warnings: [] });
      }
      const r = validatePortrait(raw);
      return send(res, 200, { ok: r.ok, errors: r.errors, warnings: r.warnings });
    }
    if (id && m === 'GET') {
      const text = await readFile(portraitFile(id), 'utf8').catch(() => {
        throw new HttpError(404, 'NOT_FOUND', `no portrait "${id}"`, 'GET /api/portraits lists them.');
      });
      try {
        return send(res, 200, JSON.parse(text));
      } catch (e) {
        throw new HttpError(422, 'BAD_FILE', `portraits/${id}.json is not valid JSON: ${(e as Error).message}`);
      }
    }
    if (id && m === 'PUT') {
      const body = await readJson(req);
      const r = validatePortrait(body.portrait);
      if (!r.ok || !r.portrait) throw new HttpError(422, 'INVALID_PORTRAIT', r.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
      if (r.portrait.id !== checkPortraitId(id)) throw new HttpError(400, 'ID_MISMATCH', 'portrait.id does not match the URL');
      await writePortraitFile(r.portrait);
      if (typeof body.thumbnail === 'string' && body.thumbnail.startsWith('data:image/jpeg;base64,')) {
        await writeFileAtomic(path.join(PORTRAIT_THUMBS, `${id}.jpg`), Buffer.from(body.thumbnail.split(',')[1]!, 'base64'));
      }
      return send(res, 200, { ok: true, revision: r.portrait.revision, warnings: r.warnings });
    }
    if (id && m === 'DELETE') {
      const file = portraitFile(id);
      if (existsSync(file)) await rename(file, path.join(PORTRAIT_TRASH, `${id}-${Date.now()}.json`));
      const thumb = path.join(PORTRAIT_THUMBS, `${id}.jpg`);
      if (existsSync(thumb)) unlinkSync(thumb);
      const refs = path.join(PORTRAITS, 'refs', id);
      if (existsSync(refs)) await rename(refs, path.join(PORTRAIT_TRASH, `${id}-refs-${Date.now()}`));
      if (lastPortraitId === id) lastPortraitId = null;
      broadcast({ type: 'portrait-deleted', id });
      return send(res, 200, { ok: true, movedTo: 'portraits/.trash/' });
    }
  }

  if (parts[1] === 'exports') {
    if (m === 'GET') {
      const files = (await readdir(EXPORTS)).filter((f) => !f.startsWith('.'));
      const out = await Promise.all(files.map(async (f) => ({ name: f, path: path.join(EXPORTS, f), bytes: (await stat(path.join(EXPORTS, f))).size })));
      return send(res, 200, out);
    }
    if (m === 'POST') {
      const raw = (url.searchParams.get('name') ?? 'export.mp4').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
      const ext = path.extname(raw) || '.mp4';
      const base = path.basename(raw, ext);
      // Optional sub-folder from a fixed list (the portrait studio saves under exports/portraits/).
      const sub = url.searchParams.get('dir');
      if (sub && !EXPORT_DIRS.has(sub)) throw new HttpError(400, 'BAD_DIR', `unknown export folder "${sub}"`, `Use one of: ${[...EXPORT_DIRS].join(', ')}`);
      const dir = sub ? path.join(EXPORTS, sub) : EXPORTS;
      await mkdir(dir, { recursive: true });
      let file = path.join(dir, `${base}${ext}`);
      // sub-folders (portrait review sheets) may be replaced in place with overwrite=1
      const overwrite = !!sub && url.searchParams.get('overwrite') === '1';
      if (!overwrite) for (let i = 2; existsSync(file); i++) file = path.join(dir, `${base}_${i}${ext}`);
      await pipeline(req, createWriteStream(file));
      log(`saved export ${file}`);
      return send(res, 200, { ok: true, path: file, name: path.basename(file), bytes: (await stat(file)).size });
    }
  }

  if (parts[1] === 'portrait-rpc' && m === 'POST') {
    const body = await readJson(req);
    const method = String(body.method ?? '');
    if (!method) throw new HttpError(400, 'NO_METHOD', 'body must be {"method": "...", "params": {...}}', 'Try {"method": "help"}.');
    const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
    return send(res, 200, { ok: true, result: await portraitRpc(method, params) });
  }

  if (parts[1] === 'rpc' && m === 'POST') {
    const body = await readJson(req);
    const method = String(body.method ?? '');
    if (!method) throw new HttpError(400, 'NO_METHOD', 'body must be {"method": "...", "params": {...}}');
    const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
    const result = await rpc(method, params);
    return send(res, 200, { ok: true, result });
  }

  if (parts[1] === 'jobs') {
    if (m === 'POST') {
      const body = await readJson(req);
      const tab = pickTab(typeof body.projectId === 'string' ? body.projectId : undefined);
      if (!tab) throw new HttpError(409, 'NO_RENDERER', 'exporting video needs the app open in a browser tab', `Open http://127.0.0.1:${PORT}/ in Chrome.`);
      const job: Job = { id: randomBytes(6).toString('hex'), status: 'running', progress: 0, frame: 0, total: 0, started: Date.now() };
      jobs.set(job.id, job);
      const params = (body.params ?? {}) as Record<string, unknown>;
      rpcToTab(tab, 'exportVideo', { ...params, save: true, download: false }, RPC_TIMEOUT.exportVideo!, job.id)
        .then((r) => {
          job.status = 'done';
          job.progress = 1;
          job.result = r;
        })
        .catch((e: Error) => {
          job.status = 'error';
          job.error = e.message;
        });
      return send(res, 200, { ok: true, jobId: job.id });
    }
    const job = jobs.get(parts[2] ?? '');
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'no such job');
    return send(res, 200, { ok: true, ...job, elapsedSec: Math.round((Date.now() - job.started) / 100) / 10 });
  }

  throw new HttpError(404, 'NOT_FOUND', `no route ${m} ${url.pathname}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? '';
    if (!HOSTS.has(host)) throw new HttpError(403, 'BAD_HOST', `host "${host}" not allowed`);
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) throw new HttpError(403, 'BAD_ORIGIN', `origin "${origin}" not allowed`);
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveApp(req, res);
  } catch (e) {
    const err = e instanceof HttpError ? e : e instanceof CommandError ? new HttpError(400, e.code, e.message, e.hint) : new HttpError(500, 'INTERNAL', e instanceof Error ? e.message : String(e));
    if (!res.headersSent) send(res, err.status, { ok: false, error: { code: err.code, message: err.message, hint: err.hint } });
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== '/bridge') return; // Vite HMR handles its own upgrades in --dev
  const origin = req.headers.origin;
  if (!HOSTS.has(req.headers.host ?? '') || (origin && !ORIGINS.has(origin)) || !tokenOk(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const tab: Tab = { ws, kind: 'director', projectId: null, projectName: null, focused: false, visible: true, seen: Date.now() };
    tabs.add(tab);
    log(`tab connected (${tabs.size})`);
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      tab.seen = Date.now();
      if (msg.type === 'hello') {
        tab.kind = msg.kind === 'portrait' ? 'portrait' : 'director';
        tab.projectId = typeof msg.projectId === 'string' ? msg.projectId : null;
        tab.projectName = typeof msg.projectName === 'string' ? msg.projectName : null;
        tab.focused = !!msg.focused;
        tab.visible = msg.visible !== false;
        if (tab.projectId && tab.kind === 'portrait') lastPortraitId = tab.projectId;
        else if (tab.projectId) lastProjectId = tab.projectId;
      } else if (msg.type === 'rpc-result') {
        const p = pending.get(String(msg.id));
        if (!p) return;
        pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.error) {
          const e = msg.error as { message?: string; code?: string; hint?: string };
          p.reject(e.code ? new HttpError(400, e.code, String(e.message ?? ''), e.hint) : new HttpError(500, 'TAB_ERROR', String(e.message ?? msg.error)));
        } else p.resolve(msg.result);
      } else if (msg.type === 'job-progress') {
        const job = jobs.get(String(msg.jobId));
        if (job) {
          job.progress = Number(msg.fraction ?? 0);
          job.frame = Number(msg.frame ?? 0);
          job.total = Number(msg.total ?? 0);
        }
      }
    });
    ws.on('close', () => {
      tabs.delete(tab);
      log(`tab disconnected (${tabs.size})`);
    });
  });
});
setInterval(() => broadcast({ type: 'ping' }), 25_000).unref();

async function start() {
  if (DEV) {
    const { createServer } = await import('vite');
    vite = (await createServer({ root: ROOT, server: { middlewareMode: true, ws: { server } } as never, appType: 'custom' })) as unknown as typeof vite;
  }
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${PORT} is already in use — is the director server already running? (open http://127.0.0.1:${PORT}/)`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(PORT, HOST, () => {
    const info = { port: PORT, url: `http://127.0.0.1:${PORT}/`, pid: process.pid, startedAt: new Date().toISOString(), dev: DEV };
    writeFileAtomicSync(path.join(STATE, 'server.json'), JSON.stringify(info, null, 2), 0o600);
    log(`3D 導演台 ${DEV ? '(dev) ' : ''}running at ${info.url}`);
    log(`projects: ${PROJECTS}`);
  });
  const cleanup = () => {
    try {
      const s = JSON.parse(readFileSync(path.join(STATE, 'server.json'), 'utf8'));
      if (s.pid === process.pid) unlinkSync(path.join(STATE, 'server.json'));
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

void mkdir(EXPORTS, { recursive: true }).then(start);
