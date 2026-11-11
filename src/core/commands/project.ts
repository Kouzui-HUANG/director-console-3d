import { z } from 'zod';
import { sameFrame, snapTime } from '../interpolate.ts';
import { ASPECT_PRESETS, detectTier, evenize, parseAspect, resolutionFor, RESOLUTION_TIERS } from '../lens.ts';
import { EnvironmentSchema, MAX_DURATION } from '../schema.ts';
import { validateProject } from '../validate.ts';
import { colorArg, deepMerge, fpsOf, requireCamera, timeArg } from './helpers.ts';
import { ColorIn, CommandError, defineCommand, IdIn, TimeIn } from './types.ts';

export const projectUpdate = defineCommand({
  name: 'project.update',
  summary: 'Change project name/notes and settings (duration ≤ 30 s, fps, aspect, resolution, environment).',
  label: '修改專案設定',
  args: z.object({
    name: z.string().max(200).optional(),
    notes: z.string().max(20000).optional(),
    settings: z
      .object({
        duration: z.number().min(1).max(MAX_DURATION).optional(),
        fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
        aspect: z.string().optional().describe(`aspect preset (${ASPECT_PRESETS.map((p) => p.key).join(', ')}) or "W:H"`),
        resolutionTier: z.enum(['720p', '1080p', '1440p', '4k']).optional(),
        resolution: z.tuple([z.number().int().min(16).max(8192), z.number().int().min(16).max(8192)]).optional(),
        environment: z.record(z.string(), z.unknown()).optional().describe('partial environment: preset, skyColor, sunAzimuth, sunElevation, fog, fogDensity, shadows'),
      })
      .optional(),
  }),
  examples: [
    { name: '街頭對話', settings: { duration: 12, fps: 24 } },
    { settings: { aspect: '9:16', resolutionTier: '1080p' } },
    { settings: { environment: { preset: 'golden', shadows: true } } },
  ],
  apply(ctx, a) {
    const p = ctx.draft;
    if (a.name !== undefined) p.name = a.name;
    if (a.notes !== undefined) p.notes = a.notes;
    const s = a.settings;
    if (!s) return { settings: p.settings };
    if (s.duration !== undefined) {
      p.settings.duration = s.duration;
      const late = p.objects.some((o) => Object.values(o.tracks).some((tr) => tr.keys.some((k) => k.t > s.duration! + 1e-6)));
      if (late) ctx.warn('some keyframes are after the new duration; they are kept but not reached');
    }
    if (s.fps !== undefined) p.settings.fps = s.fps;
    const currentTier = detectTier(p.settings.resolution);
    const tierBase =
      RESOLUTION_TIERS.find((t) => t.key === (s.resolutionTier ?? currentTier ?? '1080p'))?.base ?? 1080;
    if (s.resolution) {
      p.settings.resolution = [evenize(s.resolution[0]), evenize(s.resolution[1])];
      const ratio = p.settings.resolution[0] / p.settings.resolution[1];
      p.settings.aspect = ASPECT_PRESETS.find((x) => Math.abs(x.ratio - ratio) < 0.01)?.key ?? 'custom';
    } else if (s.aspect !== undefined || s.resolutionTier !== undefined) {
      const key = s.aspect ?? p.settings.aspect;
      const ratio = key === 'custom' ? p.settings.resolution[0] / p.settings.resolution[1] : parseAspect(key);
      if (!ratio) throw new CommandError('INVALID_ARGS', `unknown aspect "${key}"`, `Use one of ${ASPECT_PRESETS.map((x) => x.key).join(', ')} or "W:H"`);
      p.settings.resolution = resolutionFor(ratio, tierBase);
      p.settings.aspect = ASPECT_PRESETS.some((x) => x.key === key) ? key : 'custom';
    }
    if (s.environment) {
      const env = { ...s.environment };
      if (env.skyColor !== undefined && env.skyColor !== null) env.skyColor = colorArg(env.skyColor);
      const r = EnvironmentSchema.safeParse(deepMerge(p.settings.environment as unknown as Record<string, unknown>, env));
      if (!r.success) throw new CommandError('INVALID_ARGS', `environment.${r.error.issues[0]!.path.join('.')}: ${r.error.issues[0]!.message}`);
      p.settings.environment = r.data;
    }
    return { settings: p.settings };
  },
});

export const projectReplace = defineCommand({
  name: 'project.replace',
  summary: 'Replace the whole scene with a full project JSON (validated; keeps the current project id). Undoable.',
  label: '取代整個專案',
  args: z.object({ project: z.record(z.string(), z.unknown()) }),
  examples: [{ project: { name: 'New scene', settings: { duration: 8 }, objects: [] } }],
  apply(ctx, a) {
    const r = validateProject({ ...a.project, id: ctx.draft.id });
    if (!r.ok || !r.project) {
      const e = r.errors[0]!;
      throw new CommandError('INVALID_PROJECT', `${e.path}: ${e.message}`, r.errors.slice(1, 4).map((x) => `${x.path}: ${x.message}`).join('; ') || undefined);
    }
    for (const w of r.warnings) ctx.warn(`${w.path}: ${w.message}`);
    const next = r.project;
    ctx.draft.name = next.name;
    ctx.draft.notes = next.notes;
    ctx.draft.settings = next.settings;
    ctx.draft.objects = next.objects;
    ctx.draft.cuts = next.cuts;
    ctx.draft.markers = next.markers;
    ctx.setSelection([]);
    return { objects: next.objects.length };
  },
});

export const cutSet = defineCommand({
  name: 'cut.set',
  summary: 'From time t, the program output uses this camera (hard cut). Replaces a cut on the same frame.',
  label: '設定剪輯點',
  args: z.object({ t: TimeIn, camera: IdIn }),
  examples: [{ t: 0, camera: 'camA' }, { t: 4.5, camera: 'camB' }],
  apply(ctx, a) {
    requireCamera(ctx, a.camera);
    const t = timeArg(ctx, a.t);
    const fps = fpsOf(ctx.draft);
    const existing = ctx.draft.cuts.find((c) => sameFrame(c.t, t, fps));
    if (existing) existing.camera = a.camera;
    else ctx.draft.cuts.push({ t, camera: a.camera });
    ctx.draft.cuts.sort((x, y) => x.t - y.t);
    if (ctx.draft.cuts[0] && ctx.draft.cuts[0].t > 0) ctx.warn('the first cut is after 0 s; before it the first cut\'s camera is used');
    return { t, camera: a.camera };
  },
});

export const cutRemove = defineCommand({
  name: 'cut.remove',
  summary: 'Remove the cut at time t.',
  label: '刪除剪輯點',
  args: z.object({ t: TimeIn }),
  examples: [{ t: 4.5 }],
  apply(ctx, a) {
    const fps = fpsOf(ctx.draft);
    const before = ctx.draft.cuts.length;
    ctx.draft.cuts = ctx.draft.cuts.filter((c) => !sameFrame(c.t, a.t, fps));
    if (ctx.draft.cuts.length === before) {
      throw new CommandError('NOT_FOUND', `no cut at ${a.t}s`, `Cuts at: ${ctx.draft.cuts.map((c) => c.t).join(', ') || '(none)'}`);
    }
    return { t: a.t };
  },
});

export const cutClear = defineCommand({
  name: 'cut.clear',
  summary: 'Remove all cuts (the first camera is used for the whole program).',
  label: '清除剪輯',
  args: z.object({}),
  examples: [{}],
  apply(ctx) {
    ctx.draft.cuts = [];
    return {};
  },
});

export const markerSet = defineCommand({
  name: 'marker.set',
  summary: 'Add or rename a timeline marker (script beat, dialogue line) at time t.',
  label: '設定標記',
  args: z.object({ t: TimeIn, label: z.string().max(200), color: ColorIn.optional() }),
  examples: [{ t: 3, label: '主角回頭' }],
  apply(ctx, a) {
    const t = snapTime(a.t, fpsOf(ctx.draft));
    const fps = fpsOf(ctx.draft);
    const existing = ctx.draft.markers.find((m) => sameFrame(m.t, t, fps));
    const color = a.color ? colorArg(a.color) : undefined;
    if (existing) {
      existing.label = a.label;
      if (color) existing.color = color;
    } else {
      ctx.draft.markers.push(color ? { t, label: a.label, color } : { t, label: a.label });
      ctx.draft.markers.sort((x, y) => x.t - y.t);
    }
    return { t, label: a.label };
  },
});

export const markerRemove = defineCommand({
  name: 'marker.remove',
  summary: 'Remove a marker by time or label.',
  label: '刪除標記',
  args: z.object({ t: TimeIn.optional(), label: z.string().optional() }),
  examples: [{ t: 3 }, { label: '主角回頭' }],
  apply(ctx, a) {
    const fps = fpsOf(ctx.draft);
    const before = ctx.draft.markers.length;
    ctx.draft.markers = ctx.draft.markers.filter((m) => !((a.t !== undefined && sameFrame(m.t, a.t, fps)) || (a.label !== undefined && m.label === a.label)));
    if (before === ctx.draft.markers.length) throw new CommandError('NOT_FOUND', 'no matching marker');
    return {};
  },
});

export const uiSeek = defineCommand({
  name: 'ui.seek',
  summary: 'Move the playhead to time t (not undoable; affects later commands that default to the playhead).',
  label: '移動時間指針',
  mutates: false,
  args: z.object({ t: TimeIn }),
  examples: [{ t: 2.5 }],
  apply(ctx, a) {
    ctx.setTime(Math.min(a.t, ctx.draft.settings.duration));
    return { t: ctx.time };
  },
});

export const uiSelect = defineCommand({
  name: 'ui.select',
  summary: 'Select objects in the editor (not undoable).',
  label: '選取',
  mutates: false,
  args: z.object({ ids: z.array(IdIn) }),
  examples: [{ ids: ['hero'] }],
  apply(ctx, a) {
    for (const id of a.ids) ctx.obj(id);
    ctx.setSelection(a.ids);
    return { ids: a.ids };
  },
});

export const projectCommands = [projectUpdate, projectReplace, cutSet, cutRemove, cutClear, markerSet, markerRemove, uiSeek, uiSelect];
