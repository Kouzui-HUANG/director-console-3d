import { z } from 'zod';
import { defaultParams, getAssetType, isCharacterType } from '../assetTypes.ts';
import { DISTINCT_COLORS } from '../colors.ts';
import { nextCameraId, nextId, isValidId } from '../ids.ts';
import { rigDefaults } from '../lens.ts';
import { add, roundVec } from '../math.ts';
import { propDefsFor } from '../properties.ts';
import { CameraSchema, type CameraSettings, type SceneObject } from '../schema.ts';
import {
  checkRefExists,
  clearReferences,
  colorArg,
  deepMerge,
  deletePath,
  flattenPaths,
  isPlainObject,
  normalizeParams,
  requireType,
  setProp,
  vec3Arg,
} from './helpers.ts';
import { placeObject, PlaceIn } from './place.ts';
import { ColorIn, CommandError, defineCommand, IdIn, TimeIn, Vec3In, type CommandContext } from './types.ts';

const ScaleIn = z.union([Vec3In, z.number().positive()]).describe('[x, y, z] scale or a single uniform number');

function scaleArg(raw: unknown): [number, number, number] {
  if (typeof raw === 'number') return [raw, raw, raw];
  return vec3Arg(raw, 'scale');
}

function validateCamera(ctx: CommandContext, selfId: string, raw: Record<string, unknown>): CameraSettings {
  const r = CameraSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new CommandError('INVALID_CAMERA', `camera.${issue.path.join('.')}: ${issue.message}`, 'See get_guide("camera") for the camera block fields.');
  }
  const cam = r.data;
  checkRefExists(ctx.draft, cam.lookAt?.target, 'camera.lookAt.target', selfId);
  checkRefExists(ctx.draft, cam.follow?.target, 'camera.follow.target', selfId);
  return cam;
}

/** Fill sensible rig defaults (drone lens, handheld shake) for fields the caller didn't give. */
function withRigDefaults(input: Record<string, unknown>): Record<string, unknown> {
  const rig = typeof input.rig === 'string' ? input.rig : 'tripod';
  const out = { ...input };
  const d = rigDefaults(rig);
  if (out.sensor === undefined) out.sensor = d.sensor;
  if (out.focalLength === undefined) out.focalLength = d.focalLength;
  if (out.shake === undefined) {
    if (rig === 'handheld') out.shake = { preset: 'handheld', amount: 0.5 };
    if (rig === 'drone') out.shake = { preset: 'drone', amount: 0.5 };
  }
  return out;
}

export const objectAdd = defineCommand({
  name: 'object.add',
  summary: 'Add an object (character, building, prop, camera...). Returns { id }.',
  label: '新增物件',
  args: z.object({
    type: z.string().describe('object type, e.g. "male", "female", "room", "building", "camera" (see assetTypes)'),
    id: z.string().optional().describe('stable id (letters/digits/_/-, starts with a letter); auto-generated if omitted'),
    name: z.string().max(120).optional().describe('display name (any language)'),
    color: ColorIn.optional(),
    position: Vec3In.optional(),
    rotation: Vec3In.optional().describe('Euler degrees [x, y, z], order YXZ; y = yaw (positive turns left)'),
    scale: ScaleIn.optional(),
    params: z.record(z.string(), z.unknown()).optional().describe('type parameters (see assetTypes)'),
    camera: z.record(z.string(), z.unknown()).optional().describe('camera block for type "camera" (lens, focalLength, sensor, lookAt, follow, shake, rig)'),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    note: z.string().max(2000).optional(),
    place: PlaceIn.optional().describe('place relative to another object instead of giving position: {on} | {relativeTo, side, distance} | {sitOn} (see object.place)'),
  }),
  examples: [
    { type: 'male', id: 'hero', name: '主角', position: [0, 0, 0], rotation: [0, 180, 0], params: { pose: 'stand' } },
    { type: 'box', id: 'cup', params: { width: 0.08, height: 0.1, depth: 0.08 }, place: { on: 'table1' } },
    { type: 'camera', id: 'camA', position: [0, 1.6, 6], camera: { focalLength: 35, lookAt: { target: 'hero', aim: 'head' } } },
    { type: 'room', id: 'livingRoom', params: { width: 6, depth: 5, height: 2.8 } },
  ],
  apply(ctx, a) {
    const def = requireType(a.type);
    const ids = ctx.draft.objects.map((o) => o.id);
    let id: string;
    let defaultName: string;
    if (a.id !== undefined) {
      if (!isValidId(a.id)) throw new CommandError('INVALID_ID', `invalid id "${a.id}"`, 'ids start with a letter and use only letters, digits, "_" or "-"');
      if (ids.includes(a.id)) throw new CommandError('DUPLICATE_ID', `id "${a.id}" already exists`, 'Pick another id or use object.update');
      id = a.id;
      defaultName = def.type === 'camera' ? `${a.id}` : `${def.label}`;
    } else if (def.type === 'camera') {
      const c = nextCameraId(ids);
      id = c.id;
      defaultName = `${c.letter} 機`;
    } else {
      id = nextId(def.type, ids);
      defaultName = `${def.label} ${id.split('_').pop()}`;
    }
    let color = def.defaultColor;
    if (isCharacterType(def.type) && def.type !== 'passerby') {
      // Give each character a distinguishable color: the type default if free, else the first unused palette color.
      const used = new Set(ctx.draft.objects.filter((o) => isCharacterType(o.type)).map((o) => o.color.toLowerCase()));
      color = !used.has(def.defaultColor) ? def.defaultColor : (DISTINCT_COLORS.find((c) => !used.has(c)) ?? DISTINCT_COLORS[used.size % DISTINCT_COLORS.length]!);
    }
    if (a.color !== undefined) color = colorArg(a.color);
    const isCamera = def.type === 'camera';
    const obj: SceneObject = {
      id,
      type: def.type,
      name: a.name ?? defaultName,
      color,
      position: a.position !== undefined ? vec3Arg(a.position, 'position') : isCamera ? [0, 1.6, 8] : [0, 0, 0],
      rotation: a.rotation !== undefined ? vec3Arg(a.rotation, 'rotation') : [0, 0, 0],
      scale: a.scale !== undefined ? scaleArg(a.scale) : [1, 1, 1],
      visible: a.visible ?? true,
      locked: a.locked ?? false,
      params: normalizeParams(def.type, { ...defaultParams(def.type), ...(a.params ?? {}) }),
      tracks: {},
    };
    if (a.note) obj.note = a.note;
    if (isCamera) {
      ctx.draft.objects.push(obj); // so self-reference checks see it
      obj.camera = validateCamera(ctx, id, withRigDefaults(a.camera ?? {}));
    } else {
      if (a.camera) ctx.warn(`"camera" block ignored for type ${def.type}`);
      ctx.draft.objects.push(obj);
    }
    if (a.place) {
      if (a.position !== undefined) ctx.warn('both position and place given; place wins');
      const placed = placeObject(ctx, ctx.obj(id), a.place);
      return { id, position: placed.position, rotation: placed.rotation };
    }
    return { id };
  },
});

export const objectUpdate = defineCommand({
  name: 'object.update',
  summary:
    'Change an object. Animated properties (with keyframes) get a keyframe at t (default: playhead); others change their static value. key:true forces a keyframe.',
  label: '修改物件',
  args: z.object({
    id: IdIn,
    name: z.string().max(120).optional(),
    color: ColorIn.optional(),
    position: Vec3In.optional(),
    rotation: Vec3In.optional(),
    scale: ScaleIn.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    note: z.string().max(2000).optional(),
    params: z.record(z.string(), z.unknown()).optional().describe('partial params, merged'),
    camera: z.record(z.string(), z.unknown()).optional().describe('partial camera block, deep-merged; set lookAt/follow to null to clear'),
    t: TimeIn.optional().describe('time for keyframes (default: current playhead)'),
    key: z.boolean().optional().describe('force keyframes even for properties that are not animated yet (auto-key)'),
  }),
  examples: [
    { id: 'hero', position: [2, 0, -1] },
    { id: 'hero', params: { pose: 'sit' } },
    { id: 'camA', camera: { focalLength: 85, lookAt: { target: 'hero', aim: 'head' } } },
    { id: 'hero', position: [4, 0, 0], t: 3, key: true },
  ],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    const keyed: string[] = [];
    const statics: string[] = [];
    const opt = { t: a.t, forceKey: a.key };
    const record = (path: string, how: 'keyed' | 'static') => (how === 'keyed' ? keyed : statics).push(path);

    if (a.name !== undefined) obj.name = a.name;
    if (a.locked !== undefined) obj.locked = a.locked;
    if (a.note !== undefined) obj.note = a.note;
    if (a.position !== undefined) record('position', setProp(ctx, obj, 'position', vec3Arg(a.position, 'position'), opt));
    if (a.rotation !== undefined) record('rotation', setProp(ctx, obj, 'rotation', vec3Arg(a.rotation, 'rotation'), opt));
    if (a.scale !== undefined) {
      if (obj.type === 'camera') ctx.warn('cameras cannot be scaled');
      else record('scale', setProp(ctx, obj, 'scale', scaleArg(a.scale), opt));
    }
    if (a.visible !== undefined) record('visible', setProp(ctx, obj, 'visible', a.visible, opt));
    if (a.color !== undefined) record('color', setProp(ctx, obj, 'color', colorArg(a.color), opt));

    if (a.params) {
      const animatable = new Set(propDefsFor(obj).map((d) => d.path));
      const staticPatch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.params)) {
        const path = `params.${k}`;
        if (animatable.has(path) && ((obj.tracks[path]?.keys.length ?? 0) > 0 || a.key)) {
          record(path, setProp(ctx, obj, path, v, opt));
        } else {
          staticPatch[k] = v;
          statics.push(path);
        }
      }
      if (Object.keys(staticPatch).length) obj.params = normalizeParams(obj.type, { ...obj.params, ...staticPatch });
    }

    if (a.camera) {
      if (obj.type !== 'camera') throw new CommandError('NOT_A_CAMERA', `"${obj.id}" is not a camera`);
      const patch = structuredClone(a.camera) as Record<string, unknown>;
      const animatable = new Set(propDefsFor(obj).map((d) => d.path));
      for (const [p, v] of flattenPaths(patch)) {
        const path = `camera.${p}`;
        if (animatable.has(path) && ((obj.tracks[path]?.keys.length ?? 0) > 0 || a.key)) {
          record(path, setProp(ctx, obj, path, v, opt));
          deletePath(patch, p);
        } else {
          statics.push(path);
        }
      }
      // lookAt/follow given as partial objects merge onto existing (or defaults); null clears.
      const current = (obj.camera ?? {}) as Record<string, unknown>;
      const merged = deepMerge(current, patch);
      for (const k of ['lookAt', 'follow'] as const) {
        if (isPlainObject(patch[k]) && !isPlainObject(current[k])) merged[k] = patch[k];
      }
      obj.camera = validateCamera(ctx, obj.id, merged);
      if (obj.camera.follow && obj.camera.follow.target === obj.id) throw new CommandError('INVALID_REFERENCE', 'a camera cannot follow itself');
    }
    return { id: obj.id, keyed, static: statics };
  },
});

export const objectRemove = defineCommand({
  name: 'object.remove',
  summary: 'Delete one or more objects (references from cameras and cuts are cleared).',
  label: '刪除物件',
  args: z.object({ id: IdIn.optional(), ids: z.array(IdIn).optional() }),
  examples: [{ id: 'box_1' }, { ids: ['tree_1', 'tree_2'] }],
  apply(ctx, a) {
    const ids = [...(a.ids ?? []), ...(a.id ? [a.id] : [])];
    if (ids.length === 0) throw new CommandError('INVALID_ARGS', 'give "id" or "ids"');
    for (const id of ids) {
      ctx.obj(id);
      ctx.draft.objects = ctx.draft.objects.filter((o) => o.id !== id);
      for (const w of clearReferences(ctx.draft, id)) ctx.warn(w);
    }
    ctx.setSelection(ctx.selection.filter((s) => !ids.includes(s)));
    return { removed: ids };
  },
});

export const objectDuplicate = defineCommand({
  name: 'object.duplicate',
  summary: 'Copy an object (with its animation), offset by a vector. Returns { id }.',
  label: '複製物件',
  args: z.object({
    id: IdIn,
    newId: z.string().optional(),
    offset: Vec3In.optional().describe('default [1, 0, 0]'),
    name: z.string().optional(),
  }),
  examples: [{ id: 'chair_1', offset: [0.8, 0, 0] }],
  apply(ctx, a) {
    const src = ctx.obj(a.id);
    const ids = ctx.draft.objects.map((o) => o.id);
    let id = a.newId;
    if (id !== undefined) {
      if (!isValidId(id)) throw new CommandError('INVALID_ID', `invalid id "${id}"`);
      if (ids.includes(id)) throw new CommandError('DUPLICATE_ID', `id "${id}" already exists`);
    } else id = src.type === 'camera' ? nextCameraId(ids).id : nextId(src.type, ids);
    const offset = a.offset !== undefined ? vec3Arg(a.offset, 'offset') : ([1, 0, 0] as [number, number, number]);
    const copy = structuredClone(JSON.parse(JSON.stringify(src))) as SceneObject;
    copy.id = id;
    copy.name = a.name ?? `${src.name} 副本`;
    copy.position = roundVec(add(copy.position, offset));
    const posTrack = copy.tracks.position;
    if (posTrack) for (const k of posTrack.keys) k.v = roundVec(add(k.v as [number, number, number], offset));
    ctx.draft.objects.push(copy);
    return { id };
  },
});

export const objectCommands = [objectAdd, objectUpdate, objectRemove, objectDuplicate];
export { getAssetType };
