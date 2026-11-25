/** Integration test: starts the companion server on a temp data dir (no browser tab). */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

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

  it('saves exports into an allowed sub-folder only (portrait studio renders)', async () => {
    const ok = await call('/api/exports?dir=portraits&name=sheet.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'png' });
    expect(ok.status).toBe(200);
    expect(ok.body.path).toBe(path.join(data, 'exports', 'portraits', 'sheet.png'));
    const again = await call('/api/exports?dir=portraits&name=sheet.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'png' });
    expect(again.body.path).toBe(path.join(data, 'exports', 'portraits', 'sheet_2.png')); // never overwrites by default
    const replaced = await call('/api/exports?dir=portraits&overwrite=1&name=sheet.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'png2' });
    expect(replaced.body.path).toBe(path.join(data, 'exports', 'portraits', 'sheet.png'));
    expect(replaced.body.bytes).toBe(4);
    const bad = await call('/api/exports?dir=..%2F..&name=x.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'png' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_DIR');
  });

  it('stores portraits: create from a preset, list, update, validate, live-reload notice, trash', async () => {
    expect(readFileSync(path.resolve(import.meta.dirname, '..', 'schema', 'portrait.schema.json'), 'utf8')).toContain('director3d.portrait');
    const created = await call('/api/portraits', { method: 'POST', body: JSON.stringify({ preset: 'female-eastAsian', name: '測試人像' }) });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect(id).toMatch(/^pt_/);
    expect(created.body.portrait.params['base.eastAsian']).toBe(1);
    const bad = await call('/api/portraits', { method: 'POST', body: JSON.stringify({ preset: 'elf' }) });
    expect(bad.body.error.code).toBe('UNKNOWN_PRESET');

    const list = await call('/api/portraits');
    expect(list.body.map((p: { id: string }) => p.id)).toContain(id);
    const got = await call(`/api/portraits/${id}`);
    expect(got.body.name).toBe('測試人像');

    // a tab registers as a portrait tab and hears about external edits
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge?token=${token}`, { headers: { origin: BASE } });
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    ws.send(JSON.stringify({ type: 'hello', kind: 'portrait', projectId: id }));
    const heard = new Promise<string>((resolve) => ws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      if (msg.type === 'portrait-changed') resolve(msg.id);
    }));
    await new Promise((r) => setTimeout(r, 200));
    const file = path.join(data, 'portraits', `${id}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, params: { ...doc.params, 'face.nose.length': 0.4 } }, null, 2));
    expect(await Promise.race([heard, new Promise((r) => setTimeout(() => r('timeout'), 3000))])).toBe(id);
    // director agent requests are not routed to a portrait tab
    const rpc = await call('/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'projects.list', params: {} }) });
    expect(rpc.status).toBe(200);
    ws.close();

    const put = await call(`/api/portraits/${id}`, { method: 'PUT', body: JSON.stringify({ portrait: { ...doc, params: { 'face.eyes.size': 0.5, 'face.nose.widht': 1 } } }) });
    expect(put.status).toBe(200);
    expect(put.body.warnings.join(' ')).toContain('face.nose.width');
    expect((await call(`/api/portraits/${id}`)).body.params).toEqual({ 'face.eyes.size': 0.5 });
    const mismatch = await call(`/api/portraits/${id}`, { method: 'PUT', body: JSON.stringify({ portrait: { ...doc, id: 'pt_other123' } }) });
    expect(mismatch.body.error.code).toBe('ID_MISMATCH');
    writeFileSync(file, '{ not json');
    const v = await call(`/api/portraits/${id}/validate`);
    expect(v.body.ok).toBe(false);
    expect((await call('/api/portraits/..%2Fsecret')).status).toBe(400);

    const del = await call(`/api/portraits/${id}`, { method: 'DELETE' });
    expect(del.body.movedTo).toBe('portraits/.trash/');
    expect((await call(`/api/portraits/${id}`)).status).toBe(404);
  });

  it('stores reference photos with a portrait and moves them to the trash with it', async () => {
    const id = (await call('/api/portraits', { method: 'POST', body: JSON.stringify({ preset: null, name: '照片測試' }) })).body.id as string;
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const up = await call(`/api/portraits/${id}/refs`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
    expect(up.status).toBe(200);
    expect(up.body.refId).toMatch(/^ref[0-9a-f]{10}$/);
    expect(up.body.file).toBe(`refs/${id}/${up.body.refId}.jpg`);
    const name = `${up.body.refId}.jpg`;
    expect(readFileSync(path.join(data, 'portraits', 'refs', id, name))).toEqual(jpeg);
    const res = await fetch(`${BASE}/api/portraits/${id}/refs/${name}`, { headers: { 'x-director-token': token } });
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(jpeg);
    expect((await fetch(`${BASE}/api/portraits/${id}/refs/${name}`)).status).toBe(401);
    expect((await call(`/api/portraits/${id}/refs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await call(`/api/portraits/${id}/refs/..%2F..%2Fsecret.jpg`)).status).toBe(400);
    // the reference is recorded in the document by a command (headless here)
    const run = await call('/api/portrait-rpc', { method: 'POST', body: JSON.stringify({ method: 'run', params: { portraitId: id, commands: [{ cmd: 'portrait.addReference', args: { id: up.body.refId, file: up.body.file, note: '正面' } }] } }) });
    expect(run.body.result.ok).toBe(true);
    expect((await call(`/api/portraits/${id}`)).body.references).toEqual([{ id: up.body.refId, file: up.body.file, note: '正面', focal35: null }]);
    // deleting the portrait takes its photos to the trash too
    expect((await call(`/api/portraits/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(path.join(data, 'portraits', 'refs', id))).toBe(false);
  });

  it('answers portrait agent requests headless (no portrait tab): create, run, get, measure, check', async () => {
    const rpc = (method: string, params: Record<string, unknown> = {}) => call('/api/portrait-rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
    expect(String((await rpc('help')).body.result)).toContain('measure');
    const params = (await rpc('listParams', { keys: ['face.nose.width'] })).body.result;
    expect(params[0].label).toBe('鼻子寬度');
    expect(JSON.stringify((await rpc('listPresets')).body.result)).toContain('丹鳳眼');
    const created = (await rpc('create', { preset: 'male-european', name: 'Agent 測試', framing: 'head' })).body.result;
    expect(created.id).toMatch(/^pt_/);
    const id = created.id as string;
    const bad = (await rpc('run', { portraitId: id, commands: [{ cmd: 'portrait.set', args: { params: { 'face.nose.widht': 1 } } }, { cmd: 'portrait.applyTraits', args: { traits: ['xx'] } }] })).body.result;
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(2);
    const dry = (await rpc('run', { portraitId: id, dryRun: true, commands: [{ cmd: 'portrait.applyTraits', args: { traits: ['丹鳳眼'] } }] })).body.result;
    expect(dry.ok && dry.dryRun).toBe(true);
    expect((await rpc('get', { portraitId: id })).body.result.params['face.eyes.tilt']).toBeUndefined();
    const assets = existsSync(path.resolve(import.meta.dirname, '..', 'public', 'portrait', 'mh', 'weights.bin'));
    if (assets) {
      const ran = (await rpc('run', { portraitId: id, commands: [{ cmd: 'portrait.applyTraits', args: { traits: ['丹鳳眼', '高鼻樑'] } }] })).body.result;
      expect(ran.ok).toBe(true);
      expect(ran.headless).toBe(true);
      expect(ran.measures.heightCm).toBeCloseTo(178, 0);
      const got = (await rpc('get', { portraitId: id })).body.result;
      expect(got.params['face.eyes.tilt']).toBe(0.7);
      expect(got.framing.type).toBe('head');
      const m = (await rpc('measure', { portraitId: id })).body.result;
      expect(m.z.canthalTilt).toBeGreaterThan(0.5); // tilted eyes measured against the average man
      expect(m.description.join(' ')).toContain('眼尾上揚');
      expect(m.summary).toContain('男性');
      const checks = (await rpc('check', { portraitId: id })).body.result;
      expect(Array.isArray(checks)).toBe(true);
    }
    const render = await rpc('render', { portraitId: id });
    expect(render.status).toBe(409);
    expect(render.body.error.code).toBe('NO_RENDERER');
    const health = (await call('/api/health')).body;
    expect(health.portraitTabs).toBe(0);
    expect(health.currentPortrait).toBe(id);
  }, 30000);
});

