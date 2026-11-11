/** Integration test: starts the companion server on a temp data dir (no browser tab). */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PORT = 5191 + Math.floor(Math.random() * 50);
const BASE = `http://127.0.0.1:${PORT}`;
let data = '';
let proc: ChildProcess;
let token = '';

async function call(p: string, init: RequestInit & { token?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) };
  if (init.token !== null) headers['x-director-token'] = init.token ?? token;
  const res = await fetch(`${BASE}${p}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  data = mkdtempSync(path.join(tmpdir(), 'director3d-test-'));
  proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '..', 'server', 'index.ts')], { env: { ...process.env, DIRECTOR_PORT: String(PORT), DIRECTOR_DATA: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      token = readFileSync(path.join(data, '.director3d', 'token'), 'utf8').trim();
      const r = await call('/api/health');
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
  }
  throw new Error('server did not start');
}, 15000);

afterAll(() => {
  proc?.kill();
  rmSync(data, { recursive: true, force: true });
});

describe('companion server', () => {
  it('rejects missing token, foreign Host and foreign Origin', async () => {
    expect((await call('/api/health', { token: null })).status).toBe(401);
    expect((await call('/api/health', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    // fetch() cannot override Host (DNS-rebinding case), so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/health', headers: { host: `evil.example:${PORT}`, 'x-director-token': token } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('creates a project and edits it without a browser tab', async () => {
    const created = await call('/api/projects', { method: 'POST', body: JSON.stringify({ template: 'blank', name: 'T' }) });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    const run = await call('/api/rpc', {
      method: 'POST',
      body: JSON.stringify({ method: 'run', params: { projectId: id, commands: [{ cmd: 'object.add', args: { type: 'male', id: 'hero' } }, { cmd: 'camera.frame', args: { camera: 'camA', target: 'hero', shot: 'MS' } }] } }),
    });
    expect(run.body.result.ok).toBe(true);
    expect(run.body.result.headless).toBe(true);
    const file = JSON.parse(readFileSync(path.join(data, 'projects', `${id}.json`), 'utf8'));
    expect(file.$schema).toBe('../schema/project.schema.json');
    expect(file.objects.map((o: { id: string }) => o.id)).toContain('hero');
    const desc = await call('/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'describe', params: { projectId: id } }) });
    expect(desc.body.result).toContain('camA');
    const snap = await call('/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'snapshot', params: { projectId: id } }) });
    expect(snap.status).toBe(409);
    expect(snap.body.error.code).toBe('NO_RENDERER');
  });

  it('serves agent helpers without a tab: asset types, filters, evaluate, ground height, all errors', async () => {
    const rpc = (method: string, params: Record<string, unknown>) => call('/api/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
    const types = await call('/api/asset-types');
    expect(types.body.find((d: { type: string }) => d.type === 'male').params.length).toBeGreaterThan(0);
    expect((await rpc('assetTypes', {})).body.result.length).toBe(types.body.length);

    const id = (await call('/api/projects', { method: 'POST', body: JSON.stringify({ template: 'street' }) })).body.id as string;
    const full = (await rpc('get', { projectId: id })).body.result;
    const first = full.objects[0].id as string;
    const one = (await rpc('get', { projectId: id, ids: [first], fields: ['objects'] })).body.result;
    expect(one.objects.map((o: { id: string }) => o.id)).toEqual([first]);
    expect(one.settings).toBeUndefined();

    const ev = (await rpc('evaluate', { projectId: id, time: 1, ids: [first] })).body.result;
    expect(ev.objects.map((o: { id: string }) => o.id)).toEqual([first]);
    const missing = await rpc('evaluate', { projectId: id, ids: ['ghost'] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect(missing.body.error.hint).toContain(first);

    const gh = (await rpc('groundHeight', { projectId: id, points: [[0, 0], [5, -3]] })).body.result;
    expect(gh).toEqual([{ x: 0, z: 0, y: 0 }, { x: 5, z: -3, y: 0 }]);

    const bad = (await rpc('run', { projectId: id, commands: [{ cmd: 'object.add', args: { type: 'man' } }, { cmd: 'object.updat', args: {} }] })).body.result;
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e: { index: number }) => e.index)).toEqual([0, 1]);
  });

  it('checks scenes without a tab and reports what a batch introduced', async () => {
    const rpc = (method: string, params: Record<string, unknown>) => call('/api/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
    const id = (await call('/api/projects', { method: 'POST', body: JSON.stringify({ template: 'street' }) })).body.id as string;
    const check = (await rpc('check', { projectId: id })).body.result;
    expect(check.issues.map((i: { code: string }) => i.code)).toEqual(['CROSSED_LINE']);
    const run = (await rpc('run', { projectId: id, commands: [{ cmd: 'object.add', args: { type: 'box', id: 'floater', position: [3, 2, 3] } }] })).body.result;
    expect(run.checks.new.map((i: { code: string }) => i.code)).toEqual(['FLOATING']);
    const fix = (await rpc('run', { projectId: id, commands: [{ cmd: 'object.update', args: { id: 'floater', position: [3, 0, 3] } }] })).body.result;
    expect(fix.checks).toEqual({ new: [], resolved: 1 });
    const quiet = (await rpc('run', { projectId: id, check: false, commands: [{ cmd: 'object.update', args: { id: 'floater', position: [3, 2, 3] } }] })).body.result;
    expect(quiet.checks).toBeUndefined();
    const desc = (await rpc('describe', { projectId: id })).body.result as string;
    expect(desc).toMatch(/Checks: \d+ warning/);
  });

  it('validates hand-edited files and blocks path traversal ids', async () => {
    writeFileSync(path.join(data, 'projects', 'broken.json'), JSON.stringify({ id: 'broken', objects: [{ id: 'x', type: 'man' }] }));
    const v = await call('/api/projects/broken/validate');
    expect(v.body.ok).toBe(false);
    expect(JSON.stringify(v.body.errors)).toContain('male');
    const bad = await call('/api/projects/..%2F..%2Fetc');
    expect(bad.status).toBe(400);
  });
});
