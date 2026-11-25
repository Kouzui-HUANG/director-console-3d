/**
 * Shared by the two MCP servers (director3d, portrait3d): talk to the companion server with the
 * local token, start it when needed, open the right page in Chrome when a tool needs rendering,
 * and format tool results.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(path.resolve(process.env.DIRECTOR_DATA ?? ROOT), '.director3d');
export const PORT = Number(process.env.DIRECTOR_PORT ?? 5178);
export const BASE = `http://127.0.0.1:${PORT}`;

export function makeLog(prefix: string) {
  return (...a: unknown[]) => console.error(`[${prefix}]`, ...a);
}

export function token(): string {
  const f = path.join(STATE, 'token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

export async function api<T = unknown>(p: string, init: RequestInit = {}): Promise<T> {
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

export interface Health {
  tabs: number;
  portraitTabs?: number;
  currentProject: string | null;
  currentPortrait?: string | null;
}

export async function healthy(): Promise<Health | null> {
  try {
    return await api<Health>('/api/health');
  } catch {
    return null;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureServer(log: (...a: unknown[]) => void): Promise<void> {
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

export function openBrowser(url: string) {
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

/** Make sure a tab of this kind is connected (opens the page in Chrome if not). */
export async function ensureTab(kind: 'director' | 'portrait', log: (...a: unknown[]) => void): Promise<void> {
  await ensureServer(log);
  const count = (h: Health | null) => (kind === 'portrait' ? (h?.portraitTabs ?? 0) : (h?.tabs ?? 0));
  const h = await healthy();
  if (count(h) > 0) return;
  log(`opening the ${kind === 'portrait' ? 'portrait studio' : 'app'} in the browser…`);
  const url =
    kind === 'portrait'
      ? `${BASE}/portrait${h?.currentPortrait ? `?portrait=${encodeURIComponent(h.currentPortrait)}` : ''}`
      : `${BASE}/${h?.currentProject ? `?project=${encodeURIComponent(h.currentProject)}` : ''}`;
  openBrowser(url);
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    if (count(await healthy()) > 0) {
      await sleep(800);
      return;
    }
  }
  throw new Error(`no ${kind} tab connected; open ${url} in Chrome and retry`);
}

// Compact JSON: indentation costs agents tokens and adds nothing for a model.
export const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });
export const imageOf = (dataUrl: string, info: unknown) => {
  const [head, b64] = dataUrl.split(',');
  const mimeType = /data:(.*?);/.exec(head ?? '')?.[1] ?? 'image/jpeg';
  return { content: [{ type: 'image' as const, data: b64 ?? '', mimeType }, { type: 'text' as const, text: JSON.stringify(info) }] };
};
export const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

/** Guide text, optionally only the "## " sections whose text mentions the topic. */
export function guideText(file: string, topic?: string): string {
  const guide = readFileSync(path.join(ROOT, file), 'utf8');
  if (!topic) return guide;
  const parts = guide.split(/\n(?=## )/).filter((p) => p.toLowerCase().includes(topic.toLowerCase()));
  return parts.length ? parts.join('\n') : guide;
}

// Tool annotations let MCP clients (e.g. Claude Code) auto-approve read-only tools. Everything is
// local (127.0.0.1), so openWorldHint is false. Rendering may open the app in Chrome but never
// changes a document, so it counts as read-only.
export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
export const EDITS_DOCUMENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
export const ADDS_FILE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const SWITCHES_DOCUMENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
