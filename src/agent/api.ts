/**
 * window.director — the programmatic interface for AI agents (and power users).
 * Every method takes/returns plain JSON. Mutations go through the same command bus as the UI.
 * The companion server's WebSocket bridge and MCP tools call these same methods.
 */
import * as THREE from 'three';
import guideText from '../../AGENTS.md?raw';
import type { DirectorApp } from '../app/app.ts';
import { assetTypeInfo } from '../core/assetTypes.ts';
import type { CommandCall } from '../core/commands/execute.ts';
import { describeCommands } from '../core/commands/registry.ts';
import { checkScene, describeSceneWithChecks, issueDiff, type CheckOptions } from '../core/checks.ts';
import { cameraView, resolvedScene, type CameraView } from '../core/describe.ts';
import { cameraObjects, evaluateCamera, programCameraAt } from '../core/evaluate.ts';
import { RESOLUTION_TIERS, resolutionFor } from '../core/lens.ts';
import { roundTo } from '../core/math.ts';
import { projectJson } from '../core/project.ts';
import type { Project } from '../core/schema.ts';
import { groundHeightAt } from '../core/terrain.ts';
import { TEMPLATES } from '../core/templates.ts';
import { exportVideo, safeFilename, downloadBlob, type ExportQuality } from '../export/mp4.ts';
import { CommandError } from '../core/commands/types.ts';
import type { PlanArea } from '../core/plan.ts';
import { drawFrameLabels } from '../export/overlay.ts';
import { renderPlanView } from '../export/planView.ts';
import { renderCameraSheet, renderStoryboard, storyboardTimes } from '../export/storyboard.ts';
import { outputSize } from '../render/offscreen.ts';
import type { ViewMode } from '../render/viewport.ts';
import { serverToken } from '../storage/stores.ts';

export const API_VERSION = '0.1.0';

type RunInput = CommandCall | CommandCall[] | { commands: CommandCall[] };

function normalizeCalls(input: RunInput): CommandCall[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && 'commands' in input && Array.isArray(input.commands)) return input.commands;
  return [input as CommandCall];
}

function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function guideSection(topic?: string): string {
  if (!topic) return guideText;
  const parts = guideText.split(/\n(?=## )/);
  const t = topic.toLowerCase();
  const hit = parts.filter((p) => p.toLowerCase().includes(t));
  return hit.length ? hit.join('\n') : `No guide section matches "${topic}". Sections: ${parts.map((p) => p.split('\n')[0]).join(' | ')}`;
}

export interface ExportVideoArgs {
  camera?: string;
  start?: number;
  end?: number;
  tier?: '720p' | '1080p' | '1440p' | '4k';
  width?: number;
  quality?: ExportQuality;
  burnIn?: { timecode?: boolean; camera?: boolean; lens?: boolean; title?: boolean };
  /** Save into the server's exports/ folder (default true when the server is connected). */
  save?: boolean;
  /** Trigger a browser download (default true when no server). */
  download?: boolean;
  filename?: string;
  onProgress?: (fraction: number, frame: number, total: number) => void;
}

export function createDirectorApi(app: DirectorApp) {
  const project = (): Project => app.store.getState().project;
  const now = (): number => app.store.getState().ui.time;

  function requireShots() {
    if (!app.shots || !app.viewport) throw new Error('3D view is not ready yet');
    return app.shots;
  }

  function occlusion(view: CameraView, t: number): CameraView {
    const vp = app.viewport;
    if (!vp) return view;
    const p = project();
    const camObj = p.objects.find((o) => o.id === view.camera);
    if (!camObj) return view;
    vp.sync.sync(p, t, { shadows: false });
    const cam = evaluateCamera(p, camObj, t);
    const origin = new THREE.Vector3(...cam.position);
    const ray = new THREE.Raycaster();
    ray.layers.set(0);
    const targets = vp.sync.group.children;
    for (const o of view.objects) {
      const root = vp.sync.objectFor(o.id);
      if (!root) continue;
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) continue;
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const pts = [c.clone()];
      for (const sx of [-0.35, 0.35]) for (const sy of [-0.3, 0.35]) for (const sz of [-0.35, 0.35]) pts.push(new THREE.Vector3(c.x + sx * size.x, c.y + sy * size.y, c.z + sz * size.z));
      let blocked = 0;
      for (const pt of pts) {
        const dir = pt.clone().sub(origin);
        const dist = dir.length();
        if (dist < 0.05) continue;
        ray.set(origin, dir.normalize());
        ray.far = dist * 0.97;
        const hit = ray.intersectObjects(targets, true).find((h) => {
          const id = vp.sync.idOf(h.object);
          if (!id || id === o.id) return false;
          let cur: THREE.Object3D | null = h.object;
          while (cur) {
            if (!cur.visible) return false;
            cur = cur.parent;
          }
          return true;
        });
        if (hit) blocked++;
      }
      o.occluded = roundTo(blocked / pts.length, 2);
    }
    vp.forceSync();
    return view;
  }

  /** Frame boxes + occlusion for drawing labels over a rendered frame. */
  function labelView(camera: string, t: number): CameraView | null {
    const v = cameraView(project(), camera, t);
    return v ? occlusion(v, t) : null;
  }

  /** Throw a helpful error for unknown / non-camera ids instead of rendering a black frame. */
  function requireCameras(ids: string[]): void {
    const p = project();
    const cams = cameraObjects(p).map((c) => c.id);
    if (!cams.length) throw new CommandError('NO_CAMERA', 'no camera in the scene', 'Add one: {"cmd":"object.add","args":{"type":"camera","id":"camA"}}');
    const bad = ids.filter((id) => !cams.includes(id));
    if (bad.length) throw new CommandError('NOT_FOUND', `no camera with id ${bad.map((b) => `"${b}"`).join(', ')}`, `Cameras: ${cams.join(', ')}`);
  }

  function encode(canvas: HTMLCanvasElement, format: 'jpeg' | 'png' | undefined, quality = 0.85): string {
    return format === 'png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
  }

  async function uploadExport(blob: Blob, filename: string): Promise<string | undefined> {
    const token = serverToken();
    if (!token) return undefined;
    const res = await fetch(`/api/exports?name=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream', 'x-director-token': token },
      body: blob,
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    const data = (await res.json()) as { path: string };
    return data.path;
  }

  const api = {
    version: API_VERSION,

    /** The agent guide (AGENTS.md), or the sections matching a topic such as "camera" or "commands". */
    help(topic?: string): string {
      return guideSection(topic);
    },

    /** All commands with JSON Schemas and examples. */
    listCommands() {
      return describeCommands();
    },

    describeCommand(name: string) {
      return describeCommands().find((c) => c.name === name) ?? null;
    },

    /** Object types and their parameters. */
    assetTypes() {
      return assetTypeInfo();
    },

    templates() {
      return TEMPLATES.map((t) => ({ id: t.id, label: t.label, description: t.description, commands: t.commands }));
    },

    /**
     * Run one command, an array (atomic batch) or {commands:[...]}. When the batch changes the
     * scene, `checks` lists scene-check issues it introduced (and how many it fixed); check:false skips that.
     */
    run(input: RunInput, opts: { dryRun?: boolean; label?: string; check?: boolean } = {}) {
      const calls = normalizeCalls(input);
      const before = project();
      const r = app.runAs('agent', calls, { dryRun: opts.dryRun, label: opts.label });
      const ui = app.store.getState().ui;
      if (!r.ok) return plain({ ok: false, error: r.error, errors: r.errors, warnings: r.warnings });
      const diff = r.mutated && opts.check !== false ? issueDiff(before, r.project) : null;
      const checks = diff && (diff.new.length || diff.resolved) ? { new: diff.new, resolved: diff.resolved } : undefined;
      return plain({ ok: true, results: r.results, warnings: r.warnings, ...(checks ? { checks } : {}), dryRun: !!opts.dryRun, time: ui.time, selection: ui.selection });
    },

    /** Scene checks over the whole timeline: overlaps, floating objects, cameras inside things, empty / hidden shots, 180° line, jump cuts, timing. */
    check(opts: CheckOptions = {}) {
      return plain(checkScene(project(), opts));
    },

    exec(cmd: string, args: Record<string, unknown> = {}) {
      return api.run({ cmd, args });
    },

    /** The project document (plain JSON); `ids` limits objects, `fields` limits sections (settings, objects, cuts, markers, notes). */
    get(opts: { ids?: string[]; fields?: string[] } = {}): Project {
      return projectJson(project(), { ids: opts?.ids, fields: opts?.fields }) as unknown as Project;
    },

    /** Replace the whole scene with a project JSON (validated, undoable). */
    set(next: Record<string, unknown>) {
      return api.run({ cmd: 'project.replace', args: { project: next } });
    },

    /** Resolved positions/rotations at a time (animation applied): evaluate(2) or evaluate({time, ids}). */
    evaluate(opts: number | { time?: number; ids?: string[] } = {}) {
      const o = typeof opts === 'number' ? { time: opts } : (opts ?? {});
      return plain(resolvedScene(project(), o.time ?? now(), { ids: o.ids }));
    },

    /** Human-readable scene summary including what each camera sees. */
    describe(opts: { time?: number; camera?: string } = {}): string {
      return describeSceneWithChecks(project(), opts.time ?? now(), { camera: opts.camera });
    },

    /** What a camera sees: per-object frame boxes, coverage, shot size, occlusion. */
    view(opts: { camera?: string; time?: number } = {}) {
      const p = project();
      const t = opts.time ?? now();
      const cam = opts.camera && opts.camera !== 'program' ? opts.camera : programCameraAt(p, t);
      if (!cam) throw new Error('no camera in the scene');
      const v = cameraView(p, cam, t);
      if (!v) throw new Error(`no camera "${cam}"`);
      return plain(occlusion(v, t));
    },

    /**
     * Render a frame to an image (data URL). Default: program camera, current time, 768 px wide JPEG.
     * labels: true draws object ids, frame boxes, shot sizes and occlusion on top.
     */
    async snapshot(opts: { camera?: string; time?: number; width?: number; labels?: boolean; format?: 'jpeg' | 'png'; quality?: number } = {}) {
      const shots = requireShots();
      const p = project();
      const t = opts.time ?? now();
      if (opts.camera && opts.camera !== 'program') requireCameras([opts.camera]);
      const [w, h] = outputSize(p, opts.width ?? 768);
      const r = shots.render(p, t, opts.camera ?? 'program', w, h, 'export');
      let canvas = r.canvas;
      try {
        if (opts.labels && r.cameraId) {
          canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(r.canvas, 0, 0);
          const view = labelView(r.cameraId, t);
          if (view) drawFrameLabels(ctx, p, view, { x: 0, y: 0, w, h });
        }
        return { dataUrl: encode(canvas, opts.format, opts.quality), width: w, height: h, camera: r.cameraId, time: t };
      } finally {
        shots.restore();
      }
    },

    /** Every camera (or the given ones) at one time in one image; the LIVE camera is outlined in red. */
    async cameraSheet(opts: { time?: number; cameras?: string[] | 'all'; labels?: boolean; thumbWidth?: number; columns?: number; format?: 'jpeg' | 'png' } = {}) {
      const shots = requireShots();
      const p = project();
      const t = opts.time ?? now();
      const ids = !opts.cameras || opts.cameras === 'all' ? cameraObjects(p).map((c) => c.id) : opts.cameras;
      requireCameras(ids.length ? ids : ['(none)']);
      const canvas = renderCameraSheet(p, shots, { time: t, cameras: ids, columns: opts.columns, thumbWidth: opts.thumbWidth ?? 384, labelView: opts.labels ? labelView : undefined });
      return { dataUrl: encode(canvas, opts.format), width: canvas.width, height: canvas.height, time: t, cameras: ids, live: programCameraAt(p, t) };
    },

    /**
     * Top-down floor plan (north up): footprints with ids, characters with facing arrows, camera
     * field-of-view wedges (LIVE in red), motion paths with key times, grid and scale bar.
     * area = [minX, minZ, maxX, maxZ] (default: fit the content). PNG by default.
     */
    async planView(opts: { time?: number; area?: PlanArea; width?: number; paths?: boolean; format?: 'jpeg' | 'png' } = {}) {
      const p = project();
      const t = opts.time ?? now();
      const { canvas, model } = renderPlanView(p, { time: t, area: opts.area, width: opts.width ?? 1024, paths: opts.paths });
      return { dataUrl: encode(canvas, opts.format ?? 'png'), width: canvas.width, height: canvas.height, time: t, area: model.area, grid: model.grid };
    },

    /** Storyboard sheet: one frame per shot (program) or evenly spaced frames; labels: true marks object ids. */
    async storyboard(opts: { camera?: string; count?: number; times?: number[]; columns?: number; thumbWidth?: number; labels?: boolean; format?: 'jpeg' | 'png' } = {}) {
      const shots = requireShots();
      const p = project();
      const camera = opts.camera ?? 'program';
      if (camera !== 'program') requireCameras([camera]);
      const times = opts.times?.length ? opts.times : storyboardTimes(p, camera, opts.count);
      const canvas = renderStoryboard(p, shots, { camera, times, columns: opts.columns, thumbWidth: opts.thumbWidth ?? 360, labelView: opts.labels ? labelView : undefined });
      return { dataUrl: encode(canvas, opts.format), width: canvas.width, height: canvas.height, times };
    },

    /** Render and encode a video (MP4 H.264 when available). */
    async exportVideo(opts: ExportVideoArgs = {}) {
      const shots = requireShots();
      const p = project();
      const [rw, rh] = p.settings.resolution;
      let size: [number, number] = [rw, rh];
      if (opts.tier) size = resolutionFor(rw / rh, RESOLUTION_TIERS.find((x) => x.key === opts.tier)?.base ?? 1080);
      else if (opts.width) size = outputSize(p, opts.width);
      const start = Math.max(0, opts.start ?? 0);
      const end = Math.min(p.settings.duration, opts.end ?? p.settings.duration);
      const result = await exportVideo(p, shots, {
        source: opts.camera ?? 'program',
        start,
        end,
        width: size[0],
        height: size[1],
        fps: p.settings.fps,
        quality: opts.quality ?? 'standard',
        burnIn: { timecode: false, camera: false, lens: false, title: false, ...(opts.burnIn ?? {}) },
        onProgress: (pr) => opts.onProgress?.(pr.fraction, pr.frame, pr.total),
      });
      const filename = `${safeFilename(opts.filename ?? p.name)}.${result.ext}`;
      const connected = !!serverToken() && app.ui.getState().server.connected;
      let savedPath: string | undefined;
      if (opts.save ?? connected) savedPath = await uploadExport(result.blob, filename);
      if (opts.download ?? !connected) downloadBlob(result.blob, filename);
      return { filename, bytes: result.blob.size, mime: result.mime, codec: result.codec, frames: result.frames, duration: result.duration, width: result.width, height: result.height, seconds: roundTo(result.seconds, 2), savedPath };
    },

    seek(t: number) {
      app.seek(t);
      return { time: now() };
    },
    play() {
      app.play();
    },
    pause() {
      app.pause();
      return { time: now() };
    },
    time(): number {
      return now();
    },
    select(ids: string[]) {
      app.select(ids);
      return { selection: ids };
    },
    selection(): string[] {
      return app.store.getState().ui.selection;
    },
    setView(mode: ViewMode, camera?: string) {
      app.setView(mode, camera);
      return { mode, camera: app.ui.getState().viewCamera };
    },
    undo(steps = 1) {
      return api.run({ cmd: 'history.undo', args: { steps } });
    },
    redo(steps = 1) {
      return api.run({ cmd: 'history.redo', args: { steps } });
    },

    projects: {
      async list() {
        return (await app.refreshProjects()).map(({ thumbnail: _t, ...m }) => m);
      },
      current() {
        const p = project();
        return { id: p.id, name: p.name, objects: p.objects.length, duration: p.settings.duration, storage: app.storage.kind };
      },
      async open(id: string) {
        const ok = await app.openById(id);
        return { ok, current: api.projects.current() };
      },
      async create(opts: { template?: string; name?: string } = {}) {
        const p = await app.createProject(opts.template ?? 'blank', opts.name);
        return { id: p.id, name: p.name };
      },
      async save() {
        await app.saveNow({ thumbnail: true });
        return { ok: true, id: project().id };
      },
      async duplicate() {
        const p = await app.duplicateProject();
        return { id: p.id, name: p.name };
      },
      async remove(id: string) {
        await app.deleteProject(id);
        return { ok: true };
      },
    },

    /** Renderer statistics (draw calls, triangles). */
    stats() {
      const p = project();
      return { ...(app.viewport?.stats() ?? {}), objects: p.objects.length, cameras: cameraObjects(p).length };
    },

    /** Measure average editor-view render time over N frames (includes the program monitor). */
    benchmark(opts: number | { frames?: number } = 60) {
      const frames = Math.max(1, Math.min(600, typeof opts === 'number' ? opts : (opts?.frames ?? 60)));
      const vp = app.viewport;
      if (!vp) throw new Error('3D view is not ready yet');
      vp.forceSync();
      vp.renderNow();
      const times: number[] = [];
      for (let i = 0; i < frames; i++) times.push(vp.renderNow());
      times.sort((a, b) => a - b);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      return { frames, avgMs: roundTo(avg, 2), p95Ms: roundTo(times[Math.floor(times.length * 0.95)] ?? avg, 2), fpsEstimate: Math.round(1000 / Math.max(avg, 0.01)), ...vp.stats() };
    },

    /**
     * Terrain height (hills) under ground points; 0 on flat ground.
     * groundHeight(x, z) → number; groundHeight({x, z}) → number; groundHeight({points: [[x, z], ...]}) → [{x, z, y}].
     */
    groundHeight(x: number | { x?: number; z?: number; points?: [number, number][] }, z?: number) {
      const p = project();
      if (typeof x === 'number') return groundHeightAt(p, x, z ?? 0);
      if (Array.isArray(x?.points)) return x.points.map(([px, pz]) => ({ x: px, z: pz, y: groundHeightAt(p, px, pz) }));
      return groundHeightAt(p, Number(x?.x ?? 0), Number(x?.z ?? 0));
    },

    /** Recent command log (UI, console and agent commands). */
    log(n = 20) {
      return plain(app.store.getState().log.slice(-n));
    },
  };
  return api;
}

export type DirectorApi = ReturnType<typeof createDirectorApi>;

declare global {
  interface Window {
    director?: DirectorApi;
  }
}
