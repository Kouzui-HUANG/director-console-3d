/**
 * Synthetic self-test of photo fitting (browser, development). Random faces are rendered as
 * "photos" (flat light, the studio's lens), MediaPipe measures them exactly as it would real
 * photos, and the fit starts from the plain preset. Reports how much closer the parameters and the
 * face proportions get to the truth, and saves a sheet: truth | start | fitted.
 */
import type { PortraitStudio } from '../app.ts';
import { uploadPng } from '../agent/upload.ts';
import { buildSpec } from '../core/agent.ts';
import { runPortraitCommands } from '../core/commands.ts';
import { PRESET_BY_ID } from '../core/params/presets.ts';
import { PARAM_BY_KEY, PARAMS } from '../core/params/registry.ts';
import type { ParamValues } from '../core/params/resolve.ts';
import { newPortrait } from '../core/schema.ts';
import { FIT_GROUPS, fitPortrait, isFitted, NOT_FITTED, type Observation } from './fit.ts';
import { detectFace } from './mediapipe.ts';

const RATIOS = ['faceWidth', 'jawWidth', 'faceHeight', 'midFace', 'lowerFace', 'intercanthal', 'eyeWidth', 'eyeOpening', 'noseWidth', 'noseHeight', 'noseProtrusion', 'mouthWidth', 'upperLip', 'lowerLip', 'chinHeight'] as const;

/** A random face (fit groups only) on top of a preset; deterministic per seed. */
export function randomFace(base: ParamValues, seed: number, amount: number): ParamValues {
  const r = runPortraitCommands(newPortrait({ params: { ...base } }), [{ cmd: 'portrait.randomize', args: { seed, amount, groups: FIT_GROUPS } }]);
  if (!r.ok || !r.portrait) throw new Error('randomize failed');
  const out = { ...r.portrait.params };
  for (const k of NOT_FITTED) {
    if (base[k] === undefined) delete out[k];
    else out[k] = base[k]!;
  }
  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

export async function fitSelfTest(
  studio: PortraitStudio,
  o: { cases?: number; seed?: number; amount?: number; views?: [number, number][]; lambda?: number; iterations?: number; focal?: boolean; contour?: boolean; outlineWeight?: number; outlineMode?: 'widths' | 'all'; save?: string | false; width?: number; height?: number; presets?: string[] } = {},
) {
  const viewer = studio.viewer!;
  const builder = studio.builder!;
  const model = studio.refs.landmarkModel();
  const presets = o.presets ?? ['female-eastAsian', 'male-eastAsian', 'female-european', 'male-european'];
  const views = o.views ?? [[0, 3], [32, 5]];
  const w = o.width ?? 900, h = o.height ?? 1125;
  const cases = o.cases ?? 4;
  const focal = studio.ui.getState().focal;
  const keys = PARAMS.filter((d) => FIT_GROUPS.includes(d.group) && isFitted(d)).map((d) => d.key);
  const val = (pv: ParamValues, k: string) => (pv[k] as number | undefined) ?? (PARAM_BY_KEY.get(k)!.def as number);
  const ratios = (pv: ParamValues) => {
    const m = builder.build({ ...buildSpec(pv).spec, level: 0 }).measures;
    return Object.fromEntries(RATIOS.map((k) => [k, m[k] / m.ipd])) as Record<(typeof RATIOS)[number], number>;
  };
  const cellW = 240, cellH = 300, labelW = 150, top = 34;
  const columns = ['真值（照片）', ...(views.length > 1 ? ['真值 側'] : []), '起點（預設）', '擬合結果', ...(views.length > 1 ? ['擬合 側'] : [])];
  const sheet = document.createElement('canvas');
  sheet.width = labelW + cellW * columns.length;
  sheet.height = top + cellH * cases;
  const g = sheet.getContext('2d')!;
  g.fillStyle = '#1d1f23';
  g.fillRect(0, 0, sheet.width, sheet.height);
  g.fillStyle = '#d8dbe0';
  g.font = '600 14px -apple-system, "PingFang TC", sans-serif';
  columns.forEach((c, i) => g.fillText(c, labelW + i * cellW + 8, 22));
  const prev = { light: studio.ui.getState().light, quality: studio.ui.getState().quality };
  studio.ui.setState({ light: 'flat', quality: 'standard' });
  interface Row {
    case: number;
    preset: string;
    found: number;
    landmarks?: { before: number; after: number };
    outline?: { before: number; after: number } | null;
    paramError?: { before: number; after: number; reduction: number };
    ratioError?: { before: number; after: number };
    ratios?: Record<string, [number, number]>;
    cameras?: unknown[];
    /** Largest parameter changes of the fit, and the truth for each. */
    changed?: [string, number, number, number][];
    ms?: number;
  }
  const rows: Row[] = [];
  try {
    for (let c = 0; c < cases; c++) {
      const presetId = presets[c % presets.length]!;
      const base = { ...PRESET_BY_ID.get(presetId)!.params };
      const truth = randomFace(base, (o.seed ?? 1) * 1000 + c, o.amount ?? 0.7);
      await studio.preview(truth, { framing: 'full' });
      studio.frame('head');
      const photos: Observation[] = [];
      const shots: HTMLCanvasElement[] = [];
      // dark brows, as on a real photo (MediaPipe reads the brow edges from the hair)
      viewer.setBrowTint(1);
      for (const [az, el] of views) {
        viewer.setOrbit(az, el);
        const { canvas } = viewer.capture(null, w, h);
        const det = await detectFace(canvas);
        if (det) photos.push({ ...det, focal35: o.focal === false ? null : focal });
        shots.push(canvas);
      }
      viewer.setBrowTint(0);
      const y = top + c * cellH;
      shots.forEach((s, i) => g.drawImage(s, labelW + i * cellW, y, cellW, cellH));
      if (!photos.length) {
        rows.push({ case: c, preset: presetId, found: 0 });
        continue;
      }
      const t0 = performance.now();
      const fit = fitPortrait(model, base, photos, { lambda: o.lambda, iterations: o.iterations, contour: o.contour, outlineWeight: o.outlineWeight, outlineMode: o.outlineMode, expression: 'keep' });
      const ms = Math.round(performance.now() - t0);
      const e0 = mean(keys.map((k) => Math.abs(val(truth, k) - val(base, k))));
      const e1 = mean(keys.map((k) => Math.abs(val(truth, k) - val(fit.params, k))));
      const rt = ratios(truth), rb = ratios(base), rf = ratios(fit.params);
      const per = RATIOS.map((k) => ({ k, before: Math.abs(rb[k] / rt[k] - 1) * 100, after: Math.abs(rf[k] / rt[k] - 1) * 100 }));
      // renders of the start and the fit, same views
      for (const [col, params, vs] of [
        [shots.length, base, [views[0]!]],
        [shots.length + 1, fit.params, views],
      ] as [number, ParamValues, [number, number][]][]) {
        await studio.preview(params, { framing: 'full' });
        studio.frame('head');
        vs.forEach(([az, el], i) => {
          viewer.setOrbit(az, el);
          g.drawImage(viewer.capture(null, w, h).canvas, labelW + (col + i) * cellW, y, cellW, cellH);
        });
      }
      g.fillStyle = '#d8dbe0';
      g.font = '600 13px -apple-system, "PingFang TC", sans-serif';
      g.fillText(PRESET_BY_ID.get(presetId)!.label, 8, y + 22);
      g.font = '12px -apple-system, "PingFang TC", sans-serif';
      g.fillStyle = '#9aa0a8';
      [`參數誤差 ${r2(e0)}→${r2(e1)}`, `比例誤差 ${r2(mean(per.map((p) => p.before)))}→${r2(mean(per.map((p) => p.after)))}%`, `特徵點 ${fit.error.before}→${fit.error.after}%`, fit.outline ? `輪廓 ${fit.outline.before}→${fit.outline.after}%` : '', `${ms} ms`].forEach((t, i) => g.fillText(t, 8, y + 44 + i * 18));
      rows.push({
        case: c,
        preset: presetId,
        found: photos.length,
        landmarks: fit.error,
        outline: fit.outline,
        paramError: { before: r2(e0), after: r2(e1), reduction: Math.round((1 - e1 / e0) * 100) },
        ratioError: { before: r2(mean(per.map((p) => p.before))), after: r2(mean(per.map((p) => p.after))) },
        ratios: Object.fromEntries(per.map((p) => [p.k, [r2(p.before), r2(p.after)] as [number, number]])),
        cameras: fit.photos.map((p) => p.camera),
        changed: fit.changed.slice(0, 14).map((c) => [c.key, r2(c.from), r2(c.to), r2(val(truth, c.key))] as [string, number, number, number]),
        ms,
      });
    }
  } finally {
    viewer.setBrowTint(0);
    studio.ui.setState(prev);
    await studio.preview(null);
    studio.frame();
  }
  const ok = rows.filter((r): r is Required<Row> => !!r.paramError);
  const summary = {
    cases: rows.length,
    detected: ok.length,
    paramReduction: Math.round(mean(ok.map((r) => r.paramError.reduction))),
    ratioError: { before: r2(mean(ok.map((r) => r.ratioError.before))), after: r2(mean(ok.map((r) => r.ratioError.after))) },
    landmarks: { before: r2(mean(ok.map((r) => r.landmarks.before))), after: r2(mean(ok.map((r) => r.landmarks.after))) },
    outline: ok[0]?.outline ? { before: r2(mean(ok.map((r) => r.outline!.before))), after: r2(mean(ok.map((r) => r.outline!.after))) } : null,
    perRatio: Object.fromEntries(RATIOS.map((k) => [k, [r2(mean(ok.map((r) => r.ratios[k]![0]!))), r2(mean(ok.map((r) => r.ratios[k]![1]!)))]])),
  };
  const savedPath = o.save === false ? null : await uploadPng(sheet, o.save ?? 'p4_fit_selftest').catch(() => null);
  return { summary, rows, savedPath };
}
