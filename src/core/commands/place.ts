/**
 * Relative placement: put an object on another (a cup on a table), next to it (stand in front of
 * the counter, 0.3 m away), or seat a character on a chair / sofa / bench / bed / car.
 * Uses the objects' real footprints, so agents don't have to do the geometry.
 */
import { z } from 'zod';
import { isCharacterType } from '../assetTypes.ts';
import { evaluateCamera } from '../evaluate.ts';
import { cameraForward, lookAngles, objectForward, roundTo, roundVec, rotateY, unwrapDeg, type Vec3 } from '../math.ts';
import type { SceneObject } from '../schema.ts';
import { extentAlong, footprintOf } from '../solids.ts';
import { groundHeightAt } from '../terrain.ts';
import { currentValue, setProp, timeArg } from './helpers.ts';
import { CommandError, defineCommand, IdIn, TimeIn, type CommandContext } from './types.ts';

export const PLACE_SIDES = ['front', 'back', 'left', 'right', 'north', 'south', 'east', 'west'] as const;
const SEATS = new Set(['chair', 'sofa', 'bench', 'bed', 'car']);

export const PlaceIn = z.object({
  on: IdIn.optional().describe('put it on top of this object (a cup on a table, a person on a stage box)'),
  relativeTo: IdIn.optional().describe('put it next to this object'),
  side: z
    .enum(PLACE_SIDES)
    .optional()
    .describe("with relativeTo: front / back / left / right of the target's own facing, or north / south / east / west (default front)"),
  distance: z.number().min(0).max(100).optional().describe('with relativeTo: gap between the two footprints in meters (default 0.3)'),
  sitOn: IdIn.optional().describe('seat a character on a chair / sofa / bench / bed / car: same spot and facing, pose "sit"'),
  offset: z.tuple([z.number(), z.number()]).optional().describe('extra world shift [dx, dz] in meters (e.g. pick a seat on a sofa)'),
  face: z
    .union([z.enum(['target', 'away', 'same', 'keep']), z.number()])
    .optional()
    .describe('facing after placing: "target" (characters default for relativeTo), "away", "same" as the target, "keep", or a yaw in degrees'),
});
export type PlaceArgs = z.infer<typeof PlaceIn>;

const WORLD_DIRS: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

function forwardOf(o: SceneObject, ctx: CommandContext, t: number): [number, number] {
  if (o.type === 'camera') {
    const e = evaluateCamera(ctx.draft, o, t);
    const f = cameraForward(e.rotation[1], 0);
    return [f[0], f[2]];
  }
  const yaw = (currentValue(o, 'rotation', t) as Vec3)[1];
  const f = objectForward(yaw);
  return [f[0], f[2]];
}

function sideDir(target: SceneObject, side: string, ctx: CommandContext, t: number): [number, number] {
  if (WORLD_DIRS[side]) return WORLD_DIRS[side]!;
  const [fx, fz] = forwardOf(target, ctx, t);
  // Positive yaw turns left, so the target's left is its forward turned +90°.
  const turn = side === 'back' ? 180 : side === 'left' ? 90 : side === 'right' ? -90 : 0;
  const d = rotateY([fx, 0, fz], turn);
  return [d[0], d[2]];
}

/** Ground height under a point (terrain if there are hills, else 0). */
function groundAt(ctx: CommandContext, x: number, z: number): number {
  return ctx.draft.objects.some((o) => o.type === 'hills' && o.visible) ? groundHeightAt(ctx.draft, x, z) : 0;
}

/** Place `obj` relative to another object. Shared by object.place and object.add {place}. */
export function placeObject(ctx: CommandContext, obj: SceneObject, a: PlaceArgs, opts: { t?: number; key?: boolean } = {}) {
  const modes = [a.on, a.relativeTo, a.sitOn].filter((v) => v !== undefined);
  if (modes.length !== 1) {
    throw new CommandError('INVALID_ARGS', 'give exactly one of "on", "relativeTo" or "sitOn"', 'Example: {"cmd":"object.place","args":{"id":"hero","relativeTo":"counter","side":"front"}}');
  }
  const targetId = (a.on ?? a.relativeTo ?? a.sitOn)!;
  if (targetId === obj.id) throw new CommandError('INVALID_ARGS', `"${obj.id}" cannot be placed relative to itself`);
  const target = ctx.obj(targetId);
  const T = timeArg(ctx, opts.t);
  const tf = footprintOf(target, T);
  if (!tf || target.type === 'camera') throw new CommandError('INVALID_ARGS', `cannot place relative to ${target.type} "${target.id}"`, 'Use a character, prop or building as the target.');
  const pos = [...(currentValue(obj, 'position', T) as Vec3)] as Vec3;
  const rot = [...(currentValue(obj, 'rotation', T) as Vec3)] as Vec3;
  const [ox, oz] = a.offset ?? [0, 0];
  const isChar = isCharacterType(obj.type);
  const isCam = obj.type === 'camera';
  const targetYaw = (currentValue(target, 'rotation', T) as Vec3)[1];
  let yaw = rot[1];
  let next: Vec3;

  if (a.sitOn) {
    if (!isChar) throw new CommandError('INVALID_ARGS', `sitOn needs a character; "${obj.id}" is a ${obj.type}`);
    if (!SEATS.has(target.type)) ctx.warn(`"${target.id}" is a ${target.type}, not a seat; seating there anyway`);
    const tp = currentValue(target, 'position', T) as Vec3;
    next = [tp[0] + ox, tp[1], tp[2] + oz];
    yaw = typeof a.face === 'number' ? a.face : targetYaw;
    setProp(ctx, obj, 'params.pose', 'sit', { t: T, forceKey: opts.key });
  } else if (a.on) {
    next = [tf.cx + ox, tf.top, tf.cz + oz];
    if (a.face === 'same') yaw = targetYaw;
    else if (typeof a.face === 'number') yaw = a.face;
  } else {
    const dir = sideDir(target, a.side ?? 'front', ctx, T);
    const face = a.face ?? (isChar || isCam ? 'target' : 'keep');
    if (face === 'target') yaw = (Math.atan2(-dir[0], -dir[1]) * 180) / Math.PI;
    else if (face === 'away') yaw = (Math.atan2(dir[0], dir[1]) * 180) / Math.PI;
    else if (face === 'same') yaw = targetYaw;
    else if (typeof face === 'number') yaw = face;
    const extT = extentAlong(tf.hx, tf.hz, tf.yaw, dir);
    // The placed object's half size toward the target, and its footprint center offset, at its new yaw.
    let extO = 0;
    let center: [number, number] = [0, 0];
    if (isChar) extO = 0.25 * Math.max(obj.scale[0], obj.scale[2]);
    else if (!isCam) {
      const of = footprintOf(obj, T);
      if (of) {
        const local = rotateY([of.cx - pos[0], 0, of.cz - pos[2]], -rot[1]);
        const c = rotateY(local, yaw);
        center = [c[0], c[2]];
        extO = extentAlong(of.hx, of.hz, yaw, dir);
      }
    }
    const gap = a.distance ?? 0.3;
    const x = tf.cx + dir[0] * (extT + gap + extO) - center[0] + ox;
    const z = tf.cz + dir[1] * (extT + gap + extO) - center[1] + oz;
    // Stay at the target's level, following the terrain between the two spots.
    const y = isCam ? pos[1] : tf.base + groundAt(ctx, x, z) - groundAt(ctx, tf.cx, tf.cz);
    next = [x, y, z];
  }

  next = roundVec(next, 4);
  setProp(ctx, obj, 'position', next, { t: T, forceKey: opts.key });
  let nextRot = rot;
  if (isCam && a.relativeTo && (a.face ?? 'target') === 'target') {
    const aim: Vec3 = [tf.cx, tf.base + Math.min(1.5, (tf.top - tf.base) * 0.85), tf.cz];
    const ang = lookAngles(next, aim);
    nextRot = [roundTo(ang.tilt, 3), roundTo(unwrapDeg(rot[1], ang.pan), 3), rot[2]];
    if (obj.camera?.lookAt) ctx.warn(`${obj.id} has lookAt, which overrides its pan/tilt`);
  } else if (!isCam && Math.abs(yaw - rot[1]) > 1e-6) {
    nextRot = [rot[0], roundTo(unwrapDeg(rot[1], yaw), 3), rot[2]];
  }
  if (nextRot !== rot) setProp(ctx, obj, 'rotation', nextRot, { t: T, forceKey: opts.key });
  return { id: obj.id, position: next, rotation: nextRot };
}

export const objectPlace = defineCommand({
  name: 'object.place',
  summary:
    'Place an object relative to another using real footprints: on top of it ("on"), next to it ("relativeTo" + side + distance gap), or seat a character ("sitOn"). Characters face the target by default.',
  label: '相對擺放',
  args: PlaceIn.extend({
    id: IdIn,
    t: TimeIn.optional().describe('time for animated properties (default: playhead)'),
    key: z.boolean().optional().describe('force keyframes'),
  }),
  examples: [
    { id: 'cup', on: 'table1' },
    { id: 'hero', relativeTo: 'counter', side: 'front', distance: 0.3 },
    { id: 'heroine', relativeTo: 'hero', side: 'front', distance: 0.8 },
    { id: 'mom', sitOn: 'sofa', offset: [-0.5, 0] },
  ],
  apply(ctx, a) {
    const { id, t, key, ...place } = a;
    return placeObject(ctx, ctx.obj(id), place, { t, key });
  },
});

export const placeCommands = [objectPlace];
