import { z } from 'zod';
import { isCharacterType } from '../assetTypes.ts';
import { anchorWorld, evaluateCamera, evaluateObject, findObject, frameAspect, resolveAimName } from '../evaluate.ts';
import { ANGLE_IDS, computeFraming, SHOT_SIZE_IDS, SHOT_SIZES, SIDE_IDS, subjectFromEval } from '../framing.ts';
import { snapTime } from '../interpolate.ts';
import { distance, faceYaw, lookAngles, roundTo, roundVec, sub, unwrapDeg, type Vec3 } from '../math.ts';
import { MOVE_IDS, MoveError, planMove } from '../moves.ts';
import { propDef, toVec3 } from '../properties.ts';
import { currentValue, fpsOf, removeKeysInside, requireCamera, setProp, timeArg, upsertKey } from './helpers.ts';
import { CommandError, defineCommand, EaseIn, IdIn, TimeIn, Vec3In, type CommandContext } from './types.ts';
import type { SceneObject } from '../schema.ts';

function destination(raw: unknown, from: Vec3): Vec3 {
  const v = toVec3(raw);
  if (!v) throw new CommandError('INVALID_ARGS', 'point must be [x, z], [x, y, z] or {x, z}');
  const twoD = (Array.isArray(raw) && raw.length === 2) || (raw && typeof raw === 'object' && !Array.isArray(raw) && !('y' in raw));
  return twoD ? [v[0], from[1], v[2]] : v;
}

function gaitKeys(ctx: CommandContext, obj: SceneObject, gait: string, start: number, end: number) {
  if (gait === 'none' || !propDef(obj, 'params.pose')) return;
  const before = String(currentValue(obj, 'params.pose', start));
  const after = before === 'walk' || before === 'run' ? 'stand' : before;
  removeKeysInside(ctx.draft, obj, 'params.pose', start, end);
  upsertKey(ctx.draft, obj, 'params.pose', start, gait);
  upsertKey(ctx.draft, obj, 'params.pose', end, after);
}

function finishTime(ctx: CommandContext, start: number, duration: number): number {
  let end = snapTime(start + duration, fpsOf(ctx.draft));
  if (end > 30) {
    end = 30;
    ctx.warn('motion clipped at the 30 s limit');
  }
  if (end > ctx.draft.settings.duration + 1e-6) {
    ctx.warn(`motion ends at ${end}s, after the project duration (${ctx.draft.settings.duration}s); consider project.update {settings:{duration:${Math.ceil(end)}}}`);
  }
  return end;
}

export const objectMoveTo = defineCommand({
  name: 'object.moveTo',
  summary:
    'Animate an object from where it is at `start` to `to`. Characters turn toward the destination and use a walk/run pose while moving.',
  label: '移動到',
  args: z.object({
    id: IdIn,
    to: Vec3In.describe('destination; [x, z] keeps the current height'),
    start: TimeIn.optional().describe('start time (default: playhead)'),
    duration: z.number().min(0.05).max(30).optional().describe('seconds; default from distance / speed'),
    speed: z.number().min(0.05).max(200).optional().describe('m/s; default 1.4 (walk), 3.5 (run), 5 (objects)'),
    ease: EaseIn.optional(),
    face: z.boolean().optional().describe('turn toward the destination (default true for characters)'),
    gait: z.enum(['walk', 'run', 'none']).optional().describe('pose while moving (characters)'),
  }),
  examples: [
    { id: 'hero', to: [3, -2], start: 1 },
    { id: 'car_1', to: [0, 0, -40], start: 0, duration: 5, ease: 'in' },
  ],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    const start = timeArg(ctx, a.start);
    const from = currentValue(obj, 'position', start) as Vec3;
    const to = destination(a.to, from);
    const dist = distance(from, to);
    const isChar = isCharacterType(obj.type);
    const gait = a.gait ?? (isChar ? ((a.speed ?? 1.4) > 2.5 ? 'run' : 'walk') : 'none');
    const speed = a.speed ?? (gait === 'run' ? 3.5 : isChar ? 1.4 : 5);
    const end = finishTime(ctx, start, a.duration ?? Math.max(dist / speed, 0.2));
    removeKeysInside(ctx.draft, obj, 'position', start, end);
    upsertKey(ctx.draft, obj, 'position', start, roundVec(from, 4), a.ease ?? (isChar ? 'linear' : 'inOut'));
    upsertKey(ctx.draft, obj, 'position', end, roundVec(to, 4));
    if ((a.face ?? isChar) && dist > 0.01 && obj.type !== 'camera') {
      const r0 = currentValue(obj, 'rotation', start) as Vec3;
      const yaw = roundTo(unwrapDeg(r0[1], faceYaw(from, to)), 3);
      if (Math.abs(yaw - r0[1]) > 0.5) {
        const turn = snapTime(Math.min(0.4, (end - start) / 3), fpsOf(ctx.draft));
        removeKeysInside(ctx.draft, obj, 'rotation', start, end);
        upsertKey(ctx.draft, obj, 'rotation', start, [...r0], 'inOut');
        if (turn > 0 && start + turn < end) upsertKey(ctx.draft, obj, 'rotation', start + turn, [r0[0], yaw, r0[2]], 'hold');
        upsertKey(ctx.draft, obj, 'rotation', end, [r0[0], yaw, r0[2]]);
      }
    }
    if (isChar) gaitKeys(ctx, obj, gait, start, end);
    return { id: obj.id, start, end, distance: roundTo(dist, 3) };
  },
});

export const objectFollowPath = defineCommand({
  name: 'object.followPath',
  summary:
    'Animate an object through waypoints at constant speed (smooth curve by default). Characters face along the path and use a walk/run pose.',
  label: '沿路徑移動',
  args: z.object({
    id: IdIn,
    points: z.array(Vec3In).min(1).describe('waypoints; [x, z] keeps the current height'),
    start: TimeIn.optional(),
    speed: z.number().min(0.05).max(200).optional(),
    duration: z.number().min(0.1).max(30).optional().describe('total seconds (overrides speed)'),
    smooth: z.boolean().optional().describe('curved path through the points (default true)'),
    face: z.boolean().optional(),
    gait: z.enum(['walk', 'run', 'none']).optional(),
    includeCurrent: z.boolean().optional().describe('start from the current position (default true)'),
  }),
  examples: [{ id: 'hero', points: [[2, 0], [2, -4], [-1, -6]], start: 0, speed: 1.4 }],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    const fps = fpsOf(ctx.draft);
    const start = timeArg(ctx, a.start);
    const from = currentValue(obj, 'position', start) as Vec3;
    const pts = a.points.map((p) => destination(p, from));
    const path = a.includeCurrent === false ? pts : [from, ...pts];
    if (path.length < 2) throw new CommandError('INVALID_ARGS', 'need at least two points (including the current position)');
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + distance(path[i - 1]!, path[i]!));
    const total = cum[cum.length - 1]!;
    if (total < 1e-3) throw new CommandError('INVALID_ARGS', 'path has zero length');
    const isChar = isCharacterType(obj.type);
    const gait = a.gait ?? (isChar ? ((a.speed ?? 1.4) > 2.5 ? 'run' : 'walk') : 'none');
    const speed = a.speed ?? (gait === 'run' ? 3.5 : isChar ? 1.4 : 5);
    const end = finishTime(ctx, start, a.duration ?? total / speed);
    const span = end - start;
    const times = cum.map((c) => snapTime(start + (span * c) / total, fps));

    removeKeysInside(ctx.draft, obj, 'position', start, end);
    path.forEach((p, i) => upsertKey(ctx.draft, obj, 'position', times[i]!, roundVec(p, 4), 'linear'));
    obj.tracks.position!.path = a.smooth === false ? 'linear' : 'smooth';

    if ((a.face ?? isChar) && obj.type !== 'camera') {
      const r0 = currentValue(obj, 'rotation', start) as Vec3;
      removeKeysInside(ctx.draft, obj, 'rotation', start, end);
      let yaw = r0[1];
      const yaws: number[] = [];
      for (let i = 0; i < path.length - 1; i++) {
        yaw = unwrapDeg(yaw, faceYaw(path[i]!, path[i + 1]!));
        yaws.push(roundTo(yaw, 3));
      }
      const rot = (y: number): Vec3 => [r0[0], y, r0[2]];
      upsertKey(ctx.draft, obj, 'rotation', start, [...r0], 'inOut');
      const firstTurn = snapTime(start + Math.min(0.35, (times[1]! - start) / 3), fps);
      if (firstTurn > start) upsertKey(ctx.draft, obj, 'rotation', firstTurn, rot(yaws[0]!), 'hold');
      for (let i = 1; i < path.length - 1; i++) {
        const h = Math.min(0.25, (times[i]! - times[i - 1]!) / 3, (times[i + 1]! - times[i]!) / 3);
        const t0 = snapTime(times[i]! - h, fps);
        const t1 = snapTime(times[i]! + h, fps);
        if (t0 > firstTurn) upsertKey(ctx.draft, obj, 'rotation', t0, rot(yaws[i - 1]!), 'inOut');
        if (t1 > t0) upsertKey(ctx.draft, obj, 'rotation', t1, rot(yaws[i]!), 'hold');
      }
      upsertKey(ctx.draft, obj, 'rotation', end, rot(yaws[yaws.length - 1]!));
    }
    if (isChar) gaitKeys(ctx, obj, gait, start, end);
    return { id: obj.id, start, end, length: roundTo(total, 3), keys: path.length };
  },
});

export const objectFace = defineCommand({
  name: 'object.face',
  summary:
    'Turn an object to face a target object or point (or set yaw directly). For cameras this aims pan/tilt without a lookAt constraint.',
  label: '面向',
  args: z.object({
    id: IdIn,
    target: IdIn.optional(),
    point: Vec3In.optional(),
    yaw: z.number().optional().describe('degrees; 0 = facing +Z (south), 90 = facing +X (east)'),
    t: TimeIn.optional().describe('if given, sets a keyframe at t'),
  }),
  examples: [{ id: 'hero', target: 'heroine' }, { id: 'hero', yaw: 180, t: 3 }],
  apply(ctx, a) {
    const obj = ctx.obj(a.id);
    const T = a.t ?? ctx.time;
    const pos = currentValue(obj, 'position', T) as Vec3;
    const r = currentValue(obj, 'rotation', T) as Vec3;
    let point: Vec3 | null = null;
    if (a.target) {
      const snap = ctx.snapshot();
      const t = findObject(snap, a.target);
      if (!t) throw new CommandError('NOT_FOUND', `no object "${a.target}"`);
      point = obj.type === 'camera' ? anchorWorld(t, 'auto', T) : evaluateObject(t, T).position;
    } else if (a.point !== undefined) point = destination(a.point, pos);
    let next: Vec3;
    if (obj.type === 'camera') {
      if (!point && a.yaw === undefined) throw new CommandError('INVALID_ARGS', 'give target, point or yaw');
      const ang = point ? lookAngles(pos, point) : { pan: a.yaw!, tilt: r[0] };
      next = [roundTo(ang.tilt, 3), roundTo(unwrapDeg(r[1], ang.pan), 3), r[2]];
      if (obj.camera?.lookAt) ctx.warn('this camera has lookAt, which overrides pan/tilt');
    } else {
      const yaw = a.yaw ?? (point ? faceYaw(pos, point) : undefined);
      if (yaw === undefined) throw new CommandError('INVALID_ARGS', 'give target, point or yaw');
      next = [r[0], roundTo(unwrapDeg(r[1], yaw), 3), r[2]];
    }
    const how = setProp(ctx, obj, 'rotation', next, { t: a.t, forceKey: a.t !== undefined });
    return { id: obj.id, rotation: next, how };
  },
});

export const cameraFrame = defineCommand({
  name: 'camera.frame',
  summary:
    'Place a camera to frame a subject with a standard shot size (ECU, CU, MCU, MS, MLS, FS, LS, ELS), angle and side, using the real lens FOV. Sets lookAt to the subject by default.',
  label: '一鍵構圖',
  args: z.object({
    camera: IdIn,
    target: IdIn,
    shot: z.enum(SHOT_SIZE_IDS as [string, ...string[]]).describe(SHOT_SIZE_IDS.map((s) => `${s}=${SHOT_SIZES[s as keyof typeof SHOT_SIZES].en}`).join(', ')),
    angle: z.enum(ANGLE_IDS as [string, ...string[]]).optional().describe('eye (default), high, low, overhead, worm, dutch'),
    side: z.enum(SIDE_IDS as [string, ...string[]]).optional().describe("front (default), frontLeft, left, backLeft, back, backRight, right, frontRight — relative to the subject's facing; left = subject's left"),
    over: IdIn.optional().describe('over-the-shoulder: foreground character whose shoulder the camera looks over'),
    shoulder: z.enum(['left', 'right']).optional(),
    focalLength: z.number().min(4).max(1200).optional().describe('lens to use (default: current)'),
    keepPosition: z.boolean().optional().describe('keep the camera where it is and solve the focal length instead'),
    lookAt: z.boolean().optional().describe('lock aim to the subject (default true)'),
    t: TimeIn.optional().describe('evaluate the subject at t and keyframe the camera at t'),
  }),
  examples: [
    { camera: 'camA', target: 'hero', shot: 'MS' },
    { camera: 'camB', target: 'heroine', shot: 'MCU', over: 'hero', shoulder: 'right' },
    { camera: 'camC', target: 'hero', shot: 'LS', angle: 'high', side: 'frontLeft', focalLength: 24 },
  ],
  apply(ctx, a) {
    const cam = requireCamera(ctx, a.camera);
    const target = ctx.obj(a.target);
    if (target.id === cam.id) throw new CommandError('INVALID_REFERENCE', 'a camera cannot frame itself');
    const snap = ctx.snapshot();
    const T = a.t ?? ctx.time;
    const camSnap = findObject(snap, cam.id)!;
    const subject = subjectFromEval(evaluateObject(findObject(snap, target.id)!, T));
    const overObj = a.over ? findObject(snap, a.over) : undefined;
    if (a.over && !overObj) throw new CommandError('NOT_FOUND', `no object "${a.over}"`);
    const camEval = evaluateCamera(snap, camSnap, T);
    const res = computeFraming({
      subject,
      shot: a.shot as keyof typeof SHOT_SIZES,
      angle: (a.angle ?? 'eye') as never,
      side: (a.side ?? 'front') as never,
      focalLength: a.focalLength ?? camEval.focalLength,
      sensor: cam.camera!.sensor,
      aspect: frameAspect(snap),
      over: overObj ? subjectFromEval(evaluateObject(overObj, T)) : undefined,
      shoulder: a.shoulder,
      keepPosition: a.keepPosition ? (currentValue(camSnap, 'position', T) as Vec3) : undefined,
    });
    if (cam.camera!.follow) {
      cam.camera!.follow = null;
      ctx.warn('follow cleared because the camera was re-framed');
    }
    const keyOpts = { t: a.t, forceKey: a.t !== undefined };
    const position = roundVec(res.position, 3);
    setProp(ctx, cam, 'position', position, keyOpts);
    setProp(ctx, cam, 'camera.focalLength', roundTo(res.focalLength, 1), keyOpts);
    const ang = lookAngles(res.position, res.aim);
    const rotation: Vec3 = [roundTo(ang.tilt, 3), roundTo(ang.pan, 3), res.roll];
    setProp(ctx, cam, 'rotation', rotation, { t: a.t, forceKey: a.t !== undefined && (res.roll !== 0 || (cam.tracks.rotation?.keys.length ?? 0) > 0) });
    if (a.lookAt ?? true) {
      const feet = anchorWorld(findObject(snap, target.id)!, 'feet', T);
      cam.camera!.lookAt = { target: target.id, point: null, aim: 'feet', offset: roundVec(sub(res.aim, feet), 3) };
    } else if (cam.camera!.lookAt) {
      cam.camera!.lookAt = null;
      ctx.warn('lookAt cleared (lookAt:false)');
    }
    for (const n of res.notes) ctx.warn(n);
    return {
      camera: cam.id,
      position,
      focalLength: roundTo(res.focalLength, 1),
      distance: roundTo(res.distance, 2),
      description: `${SHOT_SIZES[a.shot as keyof typeof SHOT_SIZES].en} of ${target.id}, ${a.angle ?? 'eye'} angle, ${a.side ?? 'front'} side`,
      aim: resolveAimName(target.type, 'auto'),
    };
  },
});

export const cameraMove = defineCommand({
  name: 'camera.move',
  summary: `Apply a camera move preset as keyframes: ${MOVE_IDS.join(', ')}.`,
  label: '套用運鏡',
  args: z.object({
    camera: IdIn,
    preset: z.enum(MOVE_IDS as [string, ...string[]]),
    start: TimeIn.optional().describe('default: playhead'),
    duration: z.number().min(0.1).max(30).optional().describe('seconds (default 4)'),
    amount: z.number().optional().describe('meters, degrees, zoom factor or ratio depending on preset (see presets)'),
    target: IdIn.optional().describe('pivot object for orbits / crane aiming when the camera has no lookAt'),
    ease: EaseIn.optional(),
  }),
  examples: [
    { camera: 'camA', preset: 'dollyIn', start: 0, duration: 5, amount: 2 },
    { camera: 'drone', preset: 'droneOrbit', start: 0, duration: 12, amount: 180, target: 'hero' },
    { camera: 'camA', preset: 'dollyZoomIn', start: 2, duration: 4 },
  ],
  apply(ctx, a) {
    const cam = requireCamera(ctx, a.camera);
    const snap = ctx.snapshot();
    const start = timeArg(ctx, a.start);
    const duration = a.duration ?? 4;
    if (a.target) ctx.obj(a.target);
    let plan;
    try {
      plan = planMove(snap, findObject(snap, cam.id)!, a.preset as never, { start, duration, amount: a.amount, target: a.target, ease: a.ease });
    } catch (e) {
      if (e instanceof MoveError) throw new CommandError('MOVE_NOT_POSSIBLE', e.message, e.hint);
      throw e;
    }
    const fps = fpsOf(ctx.draft);
    const end = Math.min(30, start + duration);
    for (const path of plan.paths) removeKeysInside(ctx.draft, cam, path, start, end);
    for (const k of plan.keys) upsertKey(ctx.draft, cam, k.path, snapTime(k.t, fps), k.v, k.ease);
    if (plan.smoothPosition && cam.tracks.position) cam.tracks.position.path = 'smooth';
    for (const n of plan.notes) ctx.warn(n);
    if (end > ctx.draft.settings.duration + 1e-6) ctx.warn(`move ends after the project duration (${ctx.draft.settings.duration}s)`);
    return { camera: cam.id, preset: a.preset, start, end, keys: plan.keys.length };
  },
});

export const motionCommands = [objectMoveTo, objectFollowPath, objectFace, cameraFrame, cameraMove];
