import { z } from 'zod';
import { sameFrame, sortKeys } from '../interpolate.ts';
import { setAtPath } from '../properties.ts';
import { coerce, currentValue, fpsOf, requireProp, timeArg, upsertKey } from './helpers.ts';
import { CommandError, defineCommand, EaseIn, IdIn, TimeIn } from './types.ts';

const PropIn = z
  .string()
  .describe('property path: position | rotation | scale | visible | color | camera.focalLength | camera.fisheye.fov | camera.shake.amount | params.<animatable param, e.g. pose, open>');

export const keySet = defineCommand({
  name: 'key.set',
  summary: 'Add or replace a keyframe. Omit v to key the current value. Omit t to use the playhead.',
  label: '設定關鍵影格',
  args: z.object({
    id: IdIn,
    prop: PropIn,
    t: TimeIn.optional(),
    v: z.unknown().optional().describe('value (vec3 [x,y,z], number, bool, enum string or color); omit = current value'),
    ease: EaseIn.optional(),
  }),
  examples: [
    { id: 'hero', prop: 'position', t: 0, v: [0, 0, 0] },
    { id: 'hero', prop: 'position', t: 4, v: [3, 0, -2], ease: 'inOut' },
    { id: 'camA', prop: 'camera.focalLength', t: 6, v: 85 },
    { id: 'hero', prop: 'params.pose', t: 4, v: 'sit' },
  ],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    const def = requireProp(obj, a.prop);
    const t = timeArg(ctx, a.t);
    const v = a.v === undefined ? currentValue(obj, a.prop, t) : coerce(def, a.v);
    const stored = upsertKey(ctx.draft, obj, a.prop, t, v, a.ease);
    if (t > ctx.draft.settings.duration) ctx.warn(`key at ${t}s is after the project duration (${ctx.draft.settings.duration}s)`);
    return { id: obj.id, prop: a.prop, t: stored, v };
  },
});

export const keyRemove = defineCommand({
  name: 'key.remove',
  summary: 'Delete the keyframe at time t (same frame). Removing the last key makes the property static at that value.',
  label: '刪除關鍵影格',
  args: z.object({ id: IdIn, prop: PropIn, t: TimeIn }),
  examples: [{ id: 'hero', prop: 'position', t: 4 }],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    requireProp(obj, a.prop);
    const track = obj.tracks[a.prop];
    const fps = fpsOf(ctx.draft);
    const idx = track?.keys.findIndex((k) => sameFrame(k.t, a.t, fps)) ?? -1;
    if (!track || idx < 0) {
      throw new CommandError('NOT_FOUND', `no ${a.prop} keyframe at ${a.t}s on "${a.id}"`, track ? `Keys at: ${track.keys.map((k) => k.t).join(', ')}` : 'This property has no keyframes.');
    }
    const [removed] = track.keys.splice(idx, 1);
    if (track.keys.length === 0) {
      delete obj.tracks[a.prop];
      setAtPath(obj as unknown as Record<string, unknown>, a.prop, removed!.v);
    }
    return { id: obj.id, prop: a.prop, t: removed!.t };
  },
});

export const keyMove = defineCommand({
  name: 'key.move',
  summary: 'Retime a keyframe from t to `to` (replaces a key already at `to`).',
  label: '移動關鍵影格',
  args: z.object({ id: IdIn, prop: PropIn, t: TimeIn, to: TimeIn }),
  examples: [{ id: 'hero', prop: 'position', t: 4, to: 5 }],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    requireProp(obj, a.prop);
    const track = obj.tracks[a.prop];
    const fps = fpsOf(ctx.draft);
    const key = track?.keys.find((k) => sameFrame(k.t, a.t, fps));
    if (!track || !key) throw new CommandError('NOT_FOUND', `no ${a.prop} keyframe at ${a.t}s on "${a.id}"`);
    const to = timeArg(ctx, a.to);
    track.keys = track.keys.filter((k) => k === key || !sameFrame(k.t, to, fps));
    key.t = to;
    sortKeys(track.keys);
    return { id: obj.id, prop: a.prop, t: to };
  },
});

export const keyClear = defineCommand({
  name: 'key.clear',
  summary: 'Remove all keyframes of one property (or all properties). The value at time t (default playhead) becomes static.',
  label: '清除動畫',
  args: z.object({ id: IdIn, prop: PropIn.optional(), t: TimeIn.optional() }),
  examples: [{ id: 'hero', prop: 'position' }, { id: 'camA' }],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    const t = a.t ?? ctx.time;
    const props = a.prop ? [a.prop] : Object.keys(obj.tracks);
    for (const p of props) {
      if (!obj.tracks[p]) continue;
      const v = currentValue(obj, p, t);
      delete obj.tracks[p];
      if (v !== undefined) setAtPath(obj as unknown as Record<string, unknown>, p, v);
    }
    return { id: obj.id, cleared: props };
  },
});

export const keyPath = defineCommand({
  name: 'key.path',
  summary: 'Set how a position track moves between keys: "linear" (straight lines) or "smooth" (curve through the keys).',
  label: '設定路徑模式',
  args: z.object({ id: IdIn, prop: PropIn.optional().describe('default "position"'), path: z.enum(['linear', 'smooth']) }),
  examples: [{ id: 'hero', path: 'smooth' }],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    const prop = a.prop ?? 'position';
    const track = obj.tracks[prop];
    if (!track) throw new CommandError('NOT_FOUND', `"${a.id}" has no ${prop} keyframes`);
    track.path = a.path;
    return { id: obj.id, prop, path: a.path };
  },
});

export const keyCommands = [keySet, keyRemove, keyMove, keyClear, keyPath];
