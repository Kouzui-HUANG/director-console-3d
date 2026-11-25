/**
 * window.portrait — the portrait studio's agent API (also reached over the companion server's
 * bridge by HTTP /api/portrait-rpc and the portrait3d MCP server). Every method takes at most one
 * plain object argument, so it can be called remotely. Changes go through portrait commands
 * (atomic, undoable); reports come from core/agent.ts, the same code the headless server uses.
 */
import type { PortraitStudio, Quality, StudioUI } from '../app.ts';
import { checkReport, commandList, issueDiff, measureReport, paramList, portraitView, presetList } from '../core/agent.ts';
import type { PortraitCommandCall } from '../core/commands.ts';
import { PRESET_BY_ID } from '../core/params/presets.ts';
import { PARAM_BY_KEY, PARAMS, type ParamGroup } from '../core/params/registry.ts';
import type { ParamValues } from '../core/params/resolve.ts';
import { FRAMINGS, type FramingType } from '../core/schema.ts';
import { LIGHTS, MATERIALS, TURNAROUND, VIEWS, type LightPreset, type MaterialPreset, type ViewName } from '../render/viewer.ts';
import { uploadPng } from './upload.ts';
import { composeCompare, type CompareMode } from '../photo/compose.ts';

type FrameName = 'head' | 'face' | 'all' | 'bust' | 'body';
const frameOf = (f: FrameName | undefined): 'head' | 'face' | 'all' | undefined => (f === 'bust' || f === 'body' ? 'all' : f);

export interface SheetOptions {
  views?: ViewName[];
  width?: number;
  height?: number;
  columns?: number;
  caption?: string;
  frame?: FrameName;
  /** Save as exports/portraits/<name>.png through the companion server (replaces an older file). */
  save?: string;
  /** Also return the image as a data URL (large). */
  dataUrl?: boolean;
}

export interface RenderOptions {
  views?: ViewName[];
  /** head | face | all (the whole framed figure; default). */
  frame?: FrameName;
  width?: number;
  height?: number;
  light?: LightPreset;
  material?: MaterialPreset;
  focal?: number;
  quality?: Quality;
  /** Mark the face landmarks. */
  landmarks?: boolean;
  /** jpeg (default, smaller) or png. */
  format?: 'jpeg' | 'png';
}

const API_HELP = `window.portrait — 人像工作室 agent API (every method takes one optional object)
  help()                          this text
  listParams({group?, keys?})     parameter groups / full specs
  listPresets({recipes?})         presets, trait vocabulary, framings
  listCommands({name?})           portrait commands (+ JSON schema for one)
  list()                          portraits in the library
  open({portraitId})              open a portrait
  create({preset?, name?, framing?})  new portrait (from a preset) and open it
  get({resolved?})                the open portrait (changed params, or every value)
  run({commands, dryRun?})        atomic command batch → results, warnings, checks.new, key measures
  measure()                       measurements, ratios, z-scores, Chinese description
  check()                         plausibility checks
  render({views?, frame?, width?, height?, light?, material?, focal?, quality?, landmarks?, format?})  → image data URL
  exportPng({layout?, scale?, views?, name?})  三視圖 PNG (正面／半側／側面, 1920×1080) or, with views, a multi-view sheet → exports/portraits/
  save()                          save now
Reference photos (analysed locally by MediaPipe; never uploaded anywhere):
  references()                    photos of the open portrait: status, camera, current errors
  addReference({dataUrl | data+mimeType, note?})  add a photo (one undoable step)
  removeReference({refId})        remove a photo from the portrait
  compare({refId?, mode?: all|side|overlay|landmarks, opacity?, size?, save?})  photo vs. portrait through the photo's camera → image + differences
  fit({refIds?, groups?, keys?, expression?: estimate|neutral|keep, lambda?, outline?, dryRun?})  fit the face to the photos (one undoable step)
Dev helpers: set(), params(), preset(), framing(), undo(), sheet(), review(), sweep(), presetSheet(), benchmark(), fitSelfTest(), calibrateContour()`;

const upload = uploadPng;

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'portrait';

/** A data URL or base64 string as a Blob. */
function toBlob(o: { dataUrl?: string; data?: string; mimeType?: string }): Blob {
  let type = o.mimeType ?? '';
  let b64 = o.data ?? '';
  if (o.dataUrl) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(o.dataUrl);
    if (!m || !m[2]) throw Object.assign(new Error('dataUrl must be a base64 data URL (data:image/jpeg;base64,…)'), { code: 'INVALID_ARGS' });
    type = m[1]!;
    b64 = m[3]!;
  }
  if (!b64) throw Object.assign(new Error('pass dataUrl, or data (base64) with mimeType'), { code: 'INVALID_ARGS' });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function createPortraitApi(studio: PortraitStudio) {
  const viewer = () => {
    if (!studio.viewer) throw new Error('3D view is not ready yet');
    return studio.viewer;
  };
  const builder = () => {
    if (!studio.builder) throw new Error('the MakeHuman data is still loading');
    return studio.builder;
  };
  const idle = async () => {
    while (!studio.ui.getState().ready || studio.ui.getState().busy) await new Promise((r) => setTimeout(r, 50));
  };
  const summary = () => {
    const u = studio.ui.getState();
    return { stats: u.stats, issues: u.issues };
  };
  const portrait = () => studio.doc.getState().portrait;
  const keyMeasures = () => {
    const m = studio.ui.getState().measures;
    return m ? { heightCm: Math.round(m.height) / 10, headsTall: Math.round(m.headsTall * 100) / 100, faceWidth: Math.round(m.faceWidth), ipd: Math.round(m.ipd * 10) / 10, eyeOpening: Math.round(m.eyeOpening * 10) / 10 } : null;
  };
  return {
    help() {
      return API_HELP;
    },
    listParams(o: { group?: string; keys?: string[] } = {}) {
      return paramList(o);
    },
    listPresets(o: { recipes?: boolean } = {}) {
      return presetList(o);
    },
    listCommands(o: { name?: string } = {}) {
      return commandList(o.name);
    },
    async list() {
      return (await studio.refreshLibrary()).map(({ thumbnail: _t, ...m }) => m);
    },
    async open(o: { portraitId: string }) {
      if (!(await studio.openById(o.portraitId))) throw Object.assign(new Error(`no portrait "${o.portraitId}"`), { code: 'NOT_FOUND', hint: 'list() shows the portraits.' });
      await studio.rebuild();
      return { id: portrait().id, name: portrait().name };
    },
    async create(o: { preset?: string | null; name?: string; framing?: FramingType } = {}) {
      if (o.preset && !PRESET_BY_ID.has(o.preset)) throw Object.assign(new Error(`no preset "${o.preset}"`), { code: 'UNKNOWN_PRESET', hint: `Presets: ${[...PRESET_BY_ID.keys()].join(', ')}` });
      if (o.framing && !FRAMINGS.includes(o.framing)) throw Object.assign(new Error(`no framing "${o.framing}"`), { code: 'INVALID_ARGS', hint: `Framings: ${FRAMINGS.join(', ')}` });
      const p = await studio.createNew(o.preset === undefined ? 'female-eastAsian' : o.preset, o.name);
      if (o.framing && o.framing !== p.framing.type) studio.runAs('agent', [{ cmd: 'portrait.update', args: { framing: { type: o.framing } } }]);
      await studio.rebuild();
      return { id: p.id, name: p.name };
    },
    get(o: { resolved?: boolean } = {}) {
      return portraitView(portrait(), o);
    },
    /** Atomic command batch. Returns results, warnings, the checks it introduced or fixed, and key measures. */
    async run(o: { commands: PortraitCommandCall[] | PortraitCommandCall; dryRun?: boolean }) {
      await idle();
      const before = studio.ui.getState().issues;
      const calls = Array.isArray(o.commands) ? o.commands : [o.commands];
      const r = studio.runAs('agent', calls, { dryRun: o.dryRun });
      if (!r.ok) return { ok: false, error: r.error, errors: r.errors, warnings: r.warnings };
      if (o.dryRun || !r.mutated) return { ok: true, results: r.results, warnings: r.warnings, dryRun: !!o.dryRun, changed: false };
      await studio.rebuild();
      await studio.saveNow(); // agents may read the file next
      const diff = issueDiff(before, studio.ui.getState().issues);
      return { ok: true, results: r.results, warnings: r.warnings, ...(diff.new.length || diff.resolved ? { checks: diff } : {}), measures: keyMeasures(), revision: studio.savedRevision() };
    },
    measure() {
      return measureReport(builder(), portrait());
    },
    check() {
      return checkReport(builder(), portrait());
    },
    /** Render views of the open portrait; returns a data URL (JPEG by default) and what was rendered. */
    async render(o: RenderOptions = {}) {
      await idle();
      const views = o.views?.length ? o.views : (['front', 'threeQuarterLeft', 'left'] as ViewName[]);
      for (const v of views) if (!VIEWS[v]) throw Object.assign(new Error(`unknown view "${v}"`), { code: 'INVALID_ARGS', hint: `Views: ${Object.keys(VIEWS).join(', ')}` });
      if (o.light && !LIGHTS[o.light]) throw Object.assign(new Error(`unknown light "${o.light}"`), { code: 'INVALID_ARGS', hint: `Lights: ${Object.keys(LIGHTS).join(', ')}` });
      if (o.material && !MATERIALS[o.material]) throw Object.assign(new Error(`unknown material "${o.material}"`), { code: 'INVALID_ARGS', hint: `Materials: ${Object.keys(MATERIALS).join(', ')}` });
      const u = studio.ui.getState();
      const prev = { light: u.light, material: u.material, focal: u.focal, quality: u.quality, landmarks: u.landmarks };
      studio.ui.setState({ light: o.light ?? u.light, material: o.material ?? u.material, focal: o.focal ?? u.focal, quality: o.quality ?? 'standard', landmarks: !!o.landmarks });
      try {
        await studio.rebuild();
        studio.frame(frameOf(o.frame));
        const w = Math.max(160, Math.min(1600, o.width ?? (views.length > 1 ? 520 : 900)));
        const h = Math.max(160, Math.min(1600, o.height ?? Math.round(w * 1.2)));
        const canvas = viewer().sheet(views, w, h, views.length);
        const image = o.format === 'png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86);
        return { image, info: { portrait: portrait().id, name: portrait().name, views, width: canvas.width, height: canvas.height, framing: portrait().framing.type, stats: studio.ui.getState().stats } };
      } finally {
        studio.ui.setState(prev);
        studio.frame();
      }
    },
    /**
     * PNG saved to exports/portraits/. Default (no views): the 三視圖 sheet — 正面／半側／側面, head
     * and shoulders, 1920 × 1080 (scale 2 → 3840 × 2160) — as <name>_三視圖.png. With views (or
     * layout "sheet"): the framed figure from those views with a caption, as <name>.png.
     */
    async exportPng(o: { views?: ViewName[]; name?: string; width?: number; height?: number; layout?: 'turnaround' | 'sheet'; scale?: number } = {}) {
      await idle();
      const prevQuality = studio.ui.getState().quality;
      studio.ui.setState({ quality: 'standard' });
      if (!o.views?.length && o.layout !== 'sheet') {
        try {
          await studio.rebuild();
          const canvas = studio.turnaroundSheet(Math.max(0.5, Math.min(2, o.scale ?? 1)));
          if (!canvas) throw Object.assign(new Error('the portrait is not built yet'), { code: 'NOT_READY', hint: 'Retry in a moment.' });
          return { path: await upload(canvas, `${safeName(o.name ?? portrait().name)}_三視圖`), width: canvas.width, height: canvas.height, layout: 'turnaround', views: TURNAROUND.map((t) => `${t.label} (${t.view})`) };
        } finally {
          studio.ui.setState({ quality: prevQuality });
        }
      }
      const views = o.views?.length ? o.views : (['front', 'threeQuarterLeft', 'left'] as ViewName[]);
      try {
        await studio.rebuild();
        studio.frame();
        const canvas = viewer().sheet(views, o.width ?? 800, o.height ?? 960, views.length, portrait().name);
        return { path: await upload(canvas, safeName(o.name ?? portrait().name)), width: canvas.width, height: canvas.height };
      } finally {
        studio.ui.setState({ quality: prevQuality });
      }
    },
    async save() {
      await studio.saveNow({ thumbnail: true });
      return { id: portrait().id, revision: portrait().revision };
    },

    // ---- reference photos ------------------------------------------------------------------------

    /** Reference photos of the open portrait: analysis status, the camera and the current errors. */
    async references() {
      await idle();
      await studio.refs.settle();
      studio.refs.alignNow();
      return studio.refs.store.getState().items.map(({ url: _u, ...it }) => it);
    },
    /** Add a photo (data URL, or base64 + mimeType) to the open portrait; MediaPipe analyses it locally. */
    async addReference(o: { dataUrl?: string; data?: string; mimeType?: string; note?: string }) {
      await idle();
      const blob = toBlob(o);
      const it = await studio.refs.add(blob, { note: o.note, source: 'agent' });
      await studio.saveNow();
      const { url: _u, ...rest } = it;
      return { ...rest, ...(it.status === 'noface' ? { hint: 'MediaPipe found no face: use a sharper photo where the whole face is visible (frontal or 3/4, not profile).' } : {}) };
    },
    async removeReference(o: { refId: string }) {
      await idle();
      studio.refs.remove(o.refId, 'agent');
      await studio.saveNow();
      return { removed: o.refId, note: 'The image file is kept, so undo brings the reference back.' };
    },
    /**
     * The portrait seen by a photo's camera next to the photo: side by side, overlay, landmarks
     * (or all), plus measured differences (photo vs. portrait, % of the portrait's value).
     */
    async compare(o: { refId?: string; mode?: CompareMode; opacity?: number; size?: number; frame?: 'face' | 'head'; save?: string } = {}) {
      await idle();
      await studio.refs.settle();
      const refId = o.refId ?? studio.refs.store.getState().items.find((i) => i.status === 'ready')?.id;
      if (!refId) throw Object.assign(new Error('no analysed reference photo'), { code: 'NO_PHOTOS', hint: 'Add a photo first (addReference).' });
      const v = await studio.refs.compare(refId, { size: o.size, frame: o.frame ?? 'face' });
      const canvas = await composeCompare(v, o.mode ?? 'all', o.opacity ?? 0.5);
      return { image: canvas.toDataURL('image/jpeg', 0.88), report: v.report, ...(o.save ? { savedPath: await upload(canvas, o.save) } : {}) };
    },
    /** Fit the face to the reference photos (all, or refIds). One undoable step unless dryRun. */
    async fit(o: { refIds?: string[]; groups?: ParamGroup[]; keys?: string[]; expression?: 'estimate' | 'neutral' | 'keep'; lambda?: number; iterations?: number; outline?: boolean; dryRun?: boolean } = {}) {
      await idle();
      const before = studio.ui.getState().issues;
      const r = await studio.refs.fit({ ...o, source: 'agent' });
      if (!r.applied) return r;
      await studio.rebuild();
      await studio.saveNow();
      const diff = issueDiff(before, studio.ui.getState().issues);
      return { ...r, ...(diff.new.length || diff.resolved ? { checks: diff } : {}), measures: keyMeasures(), revision: studio.savedRevision() };
    },

    // ---- dev helpers ----------------------------------------------------------------------------

    /** Synthetic fit test: random faces rendered as photos, measured by MediaPipe, fitted from the preset (development tool). */
    async fitSelfTest(o: Parameters<typeof import('../photo/selftest.ts').fitSelfTest>[1] = {}) {
      await idle();
      const { fitSelfTest } = await import('../photo/selftest.ts');
      return fitSelfTest(studio, o);
    },
    /** Face-outline candidates from renders at many angles (development tool; result → photo/contourMap.ts). */
    async calibrateContour(o: { faces?: ParamValues[]; seeds?: number[]; yaws?: number[]; pitches?: number[] } = {}) {
      await idle();
      const { calibrateContour } = await import('../photo/calibrate.ts');
      const { randomFace } = await import('../photo/selftest.ts');
      const faces = o.faces ?? [{}, ...['female-eastAsian', 'male-eastAsian', 'female-european', 'male-european'].map((id) => ({ ...PRESET_BY_ID.get(id)!.params })), ...(o.seeds ?? [11, 12, 13]).map((s, i) => randomFace({ ...PRESET_BY_ID.get(i % 2 ? 'male-european' : 'female-eastAsian')!.params }, s, 0.8))];
      return calibrateContour(studio, { faces, yaws: o.yaws, pitches: o.pitches });
    },

    /** Where MediaPipe puts its brow points on darkened sculpted brows (development tool; result → photo/regions.ts BROW_POINTS). */
    async calibrateBrows(o: { faces?: ParamValues[]; seeds?: number[]; yaws?: number[]; pitches?: number[] } = {}) {
      await idle();
      const { calibrateBrows } = await import('../photo/calibrate.ts');
      const { randomFace } = await import('../photo/selftest.ts');
      const faces = o.faces ?? [{}, ...['female-eastAsian', 'male-eastAsian', 'female-european', 'male-european'].map((id) => ({ ...PRESET_BY_ID.get(id)!.params })), ...(o.seeds ?? [21, 22, 23, 24, 25, 26]).map((s, i) => randomFace({ ...PRESET_BY_ID.get(['female-eastAsian', 'male-european', 'female-european', 'male-eastAsian'][i % 4]!)!.params }, s, 0.8))];
      return calibrateBrows(studio, { faces, yaws: o.yaws, pitches: o.pitches });
    },
    /** Build the MediaPipe → surface correspondence from a render of `params` (development tool). */
    async calibrateLandmarks(o: { params?: ParamValues; view?: ViewName; width?: number; height?: number } = {}) {
      await idle();
      const { calibrateLandmarks } = await import('../photo/calibrate.ts');
      return calibrateLandmarks(studio, o);
    },
    /** Consensus correspondence over many renders (development tool). */
    async calibrateConsensus(o: { cases: { params: ParamValues; view: ViewName }[]; radius?: number }) {
      await idle();
      const { calibrateConsensus } = await import('../photo/calibrate.ts');
      return calibrateConsensus(studio, o);
    },
    /** Reprojection error of a correspondence on other shapes and views (development tool). */
    async validateLandmarks(o: { corr: Parameters<typeof import('../photo/calibrate.ts').validateLandmarks>[1]; cases: { params: ParamValues; view: ViewName; label?: string }[] }) {
      await idle();
      const { validateLandmarks } = await import('../photo/calibrate.ts');
      return validateLandmarks(studio, o.corr, o.cases);
    },

    /** The portrait document and the main view settings. */
    state() {
      const u = studio.ui.getState();
      return { portrait: portrait(), quality: u.quality, view: u.view, light: u.light, material: u.material, saving: u.saving, stats: u.stats };
    },
    /** portrait.set shortcut. */
    params(patch: ParamValues) {
      return this.run({ commands: [{ cmd: 'portrait.set', args: { params: patch } }] });
    },
    preset(id: string, groups?: ParamGroup[]) {
      return this.run({ commands: [{ cmd: 'portrait.applyPreset', args: { preset: id, ...(groups ? { groups } : {}) } }] });
    },
    framing(type: FramingType) {
      return this.run({ commands: [{ cmd: 'portrait.update', args: { framing: { type } } }] });
    },
    undo(steps = 1) {
      return this.run({ commands: [{ cmd: 'history.undo', args: { steps } }] });
    },
    /** View settings (quality, pupils, view, light, material, focal, ao, turntable, wireframe, landmarks). */
    async set(patch: Partial<Pick<StudioUI, 'quality' | 'pupils' | 'view' | 'light' | 'material' | 'focal' | 'ao' | 'turntable' | 'wireframe' | 'landmarks'>>) {
      studio.ui.setState(patch);
      if (patch.view) studio.viewer?.setView(patch.view);
      await studio.rebuild();
      return summary();
    },
    measures() {
      const m = studio.last;
      return m ? { measures: m.measures, solve: m.solve } : null;
    },
    checks() {
      return studio.ui.getState().issues;
    },
    frame(what?: FrameName) {
      studio.frame(frameOf(what));
    },
    /** Render several views into one image. */
    async sheet(o: SheetOptions = {}) {
      await idle();
      const views = o.views ?? ['front', 'threeQuarterLeft', 'left'];
      if (o.frame) studio.frame(frameOf(o.frame));
      const canvas = viewer().sheet(views, o.width ?? 520, o.height ?? 640, o.columns ?? views.length, o.caption);
      const out: { width: number; height: number; savedPath?: string; dataUrl?: string } = { width: canvas.width, height: canvas.height };
      if (o.save) out.savedPath = await upload(canvas, o.save);
      if (o.dataUrl || !o.save) out.dataUrl = canvas.toDataURL('image/png');
      return out;
    },
    /** Review sheets: the figure (front, 3/4, profile) and a face close-up (front, 3/4). */
    async review(name: string, o: { quality?: Quality; faceViews?: ViewName[] } = {}) {
      await idle();
      const prev = studio.ui.getState().quality;
      studio.ui.setState({ quality: o.quality ?? 'standard' });
      await studio.rebuild();
      studio.frame();
      const body = viewer().sheet(['front', 'threeQuarterLeft', 'left'], 560, 700, 3, studio.doc.getState().portrait.name);
      const bodyPath = await upload(body, name);
      studio.frame('face');
      const face = viewer().sheet(o.faceViews ?? ['front', 'threeQuarterLeft'], 760, 760);
      const facePath = await upload(face, `${name}-face`);
      studio.ui.setState({ quality: prev });
      studio.frame();
      return { bodyPath, facePath, ...summary() };
    },
    /**
     * Parameter sweep: one row per parameter, columns = values × views, from the current
     * parameters with only that parameter changed (preview only — the document is untouched).
     * Values are −1…+1 positions: local parameters use them directly, others map −1 / 0 / +1 to
     * the low end / default / high end of the realistic range.
     */
    async sweep(o: { keys?: string[]; group?: ParamGroup; values?: number[]; views?: ViewName[]; frame?: FrameName; cell?: [number, number]; quality?: Quality; save: string; rowsPerImage?: number; caption?: string }) {
      await idle();
      const keys = o.keys ?? PARAMS.filter((d) => d.group === o.group).map((d) => d.key);
      const positions = o.values ?? [-1, 0, 1];
      const views = o.views ?? ['front'];
      const [w, h] = o.cell ?? [230, 250];
      const labelW = 150;
      const top = 52;
      const per = o.rowsPerImage ?? 8;
      const base = { ...studio.doc.getState().portrait.params };
      const prevQuality = studio.ui.getState().quality;
      studio.ui.setState({ quality: o.quality ?? 'preview' });
      const valueAt = (key: string, t: number) => {
        const d = PARAM_BY_KEY.get(key)!;
        if (d.range[0] === -1 && d.range[1] === 1) return t;
        const mid = d.def ?? (d.range[0] + d.range[1]) / 2;
        return t < 0 ? mid + t * (mid - d.range[0]) : mid + t * (d.range[1] - mid);
      };
      const saved: string[] = [];
      try {
        for (let start = 0; start < keys.length; start += per) {
          const rows = keys.slice(start, start + per);
          const canvas = document.createElement('canvas');
          canvas.width = labelW + w * positions.length * views.length;
          canvas.height = top + h * rows.length;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#1d1f23';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#d8dbe0';
          ctx.font = '600 15px -apple-system, "PingFang TC", sans-serif';
          ctx.fillText(o.caption ?? o.save, 10, 20);
          positions.forEach((t, i) =>
            views.forEach((v, j) => {
              ctx.font = '13px -apple-system, "PingFang TC", sans-serif';
              ctx.fillText(`${t > 0 ? '+' : ''}${t}${views.length > 1 ? `・${VIEWS[v].label}` : ''}`, labelW + (i * views.length + j) * w + 8, 44);
            }),
          );
          for (const [r, key] of rows.entries()) {
            const d = PARAM_BY_KEY.get(key);
            if (!d) throw new Error(`unknown parameter ${key}`);
            for (const [i, t] of positions.entries()) {
              await studio.preview({ ...base, [key]: valueAt(key, t) });
              studio.frame(frameOf(o.frame ?? 'head'));
              for (const [j, v] of views.entries()) ctx.drawImage(viewer().renderView(v, w, h), labelW + (i * views.length + j) * w, top + r * h);
            }
            ctx.fillStyle = '#d8dbe0';
            ctx.font = '600 14px -apple-system, "PingFang TC", sans-serif';
            ctx.fillText(d.label, 10, top + r * h + 24);
            ctx.fillStyle = '#9aa0a8';
            ctx.font = '11px -apple-system, sans-serif';
            ctx.fillText(key, 10, top + r * h + 42);
            if (d.neg) ctx.fillText(`${d.neg} ↔ ${d.pos}`, 10, top + r * h + 58);
            ctx.strokeStyle = '#33363c';
            ctx.beginPath();
            ctx.moveTo(0, top + r * h + 0.5);
            ctx.lineTo(canvas.width, top + r * h + 0.5);
            ctx.stroke();
          }
          saved.push(await upload(canvas, keys.length > per ? `${o.save}-${Math.floor(start / per) + 1}` : o.save));
        }
      } finally {
        studio.ui.setState({ quality: prevQuality });
        await studio.preview(null);
        studio.frame();
      }
      return saved;
    },
    /** One row per preset: the figure from several views plus a head 3/4 column (preview only). */
    async presetSheet(o: { ids: string[]; save: string; views?: ViewName[]; cell?: [number, number]; quality?: Quality; caption?: string }) {
      await idle();
      const views = o.views ?? ['front', 'threeQuarterLeft', 'left'];
      const [w, h] = o.cell ?? [300, 340];
      const labelW = 120;
      const top = 30;
      const canvas = document.createElement('canvas');
      canvas.width = labelW + w * (views.length + 1);
      canvas.height = top + h * o.ids.length;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#1d1f23';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#d8dbe0';
      ctx.font = '600 15px -apple-system, "PingFang TC", sans-serif';
      ctx.fillText(o.caption ?? o.save, 10, 20);
      const prevQuality = studio.ui.getState().quality;
      studio.ui.setState({ quality: o.quality ?? 'standard' });
      try {
        for (const [r, id] of o.ids.entries()) {
          const preset = PRESET_BY_ID.get(id);
          if (!preset) throw new Error(`unknown preset ${id}`);
          const stats = await studio.preview(preset.params);
          studio.frame();
          views.forEach((v, i) => ctx.drawImage(viewer().renderView(v, w, h), labelW + i * w, top + r * h));
          studio.frame('head');
          ctx.drawImage(viewer().renderView('threeQuarterLeft', w, h), labelW + views.length * w, top + r * h);
          ctx.fillStyle = '#d8dbe0';
          ctx.font = '600 14px -apple-system, "PingFang TC", sans-serif';
          ctx.fillText(preset.label, 10, top + r * h + 24);
          ctx.fillStyle = '#9aa0a8';
          ctx.font = '12px -apple-system, "PingFang TC", sans-serif';
          if (stats) {
            ctx.fillText(`${stats.heightCm} cm`, 10, top + r * h + 44);
            ctx.fillText(`頭身比 ${stats.headsTall}`, 10, top + r * h + 62);
          }
        }
      } finally {
        studio.ui.setState({ quality: prevQuality });
        await studio.preview(null);
        studio.frame();
      }
      return upload(canvas, o.save);
    },
    /** Mesh N times at a quality and report timings. */
    async benchmark(o: { quality?: Quality; runs?: number } = {}) {
      await idle();
      const runs = Math.max(1, Math.min(10, o.runs ?? 3));
      const times: number[] = [];
      studio.ui.setState({ quality: o.quality ?? 'standard' });
      let last = null;
      for (let i = 0; i < runs; i++) {
        last = await studio.preview(null);
        if (last) times.push(last.ms);
      }
      return { runs, ms: times, best: Math.min(...times), last };
    },
  };
}

export type PortraitApi = ReturnType<typeof createPortraitApi>;

declare global {
  interface Window {
    portrait?: PortraitApi;
  }
}
