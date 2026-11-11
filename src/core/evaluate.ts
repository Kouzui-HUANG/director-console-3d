/**
 * Pure time evaluation: evaluate(project, t) → resolved state of every object and camera.
 * Same project + same t → same result (all randomness is seeded).
 */
import { getAssetType, isCharacterType, localAnchor, type AnchorName } from './assetTypes.ts';
import type { Params } from './fields.ts';
import { sampleTrack } from './interpolate.ts';
import { lensFov } from './lens.ts';
import { add, lookAngles, rotateY, transformPoint, type Vec3 } from './math.ts';
import { fbm1 } from './noise.ts';
import { getAtPath, propDef } from './properties.ts';
import {
  defaultCamera,
  type Aim,
  type CameraSettings,
  type FisheyeMapping,
  type Lens,
  type LookAt,
  type Project,
  type Rig,
  type SceneObject,
  type Sensor,
  type ShakePreset,
} from './schema.ts';

export interface EvalObject {
  id: string;
  type: string;
  name: string;
  color: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  params: Params;
  editorOnly: boolean;
}

export interface EvalCamera {
  id: string;
  name: string;
  /** Final world position (after follow + shake). */
  position: Vec3;
  /** Final Euler [tilt, pan, roll] degrees, order YXZ (after lookAt + shake). */
  rotation: Vec3;
  rig: Rig;
  lens: Lens;
  sensor: Sensor;
  focalLength: number;
  /** Frame aspect (width / height) this evaluation was computed for. */
  aspect: number;
  hfov: number;
  vfov: number;
  fisheye: { fov: number; mapping: FisheyeMapping; circular: boolean };
  /** Resolved aim point if lookAt is active. */
  aimPoint: Vec3 | null;
}

export interface EvalScene {
  t: number;
  objects: EvalObject[];
  byId: Map<string, EvalObject>;
  programCamera: string | null;
}

export function findObject(project: Project, id: string): SceneObject | undefined {
  return project.objects.find((o) => o.id === id);
}

/** Value of a property at time t (animated if the track has keys, otherwise static). */
export function sampleProp(obj: SceneObject, path: string, t: number): unknown {
  const track = obj.tracks[path];
  if (track && track.keys.length > 0) {
    const def = propDef(obj, path);
    if (def) {
      const v = sampleTrack(track, t, def);
      if (v !== undefined) return v;
    }
  }
  return getAtPath(obj, path);
}

export function isAnimated(obj: SceneObject, path: string): boolean {
  return (obj.tracks[path]?.keys.length ?? 0) > 0;
}

export function evaluateObject(obj: SceneObject, t: number): EvalObject {
  const asset = getAssetType(obj.type);
  const params: Params = { ...obj.params };
  for (const path of Object.keys(obj.tracks)) {
    if (path.startsWith('params.') && obj.tracks[path]!.keys.length > 0) {
      params[path.slice(7)] = sampleProp(obj, path, t);
    }
  }
  return {
    id: obj.id,
    type: obj.type,
    name: obj.name,
    color: sampleProp(obj, 'color', t) as string,
    position: sampleProp(obj, 'position', t) as Vec3,
    rotation: sampleProp(obj, 'rotation', t) as Vec3,
    scale: obj.type === 'camera' ? [1, 1, 1] : (sampleProp(obj, 'scale', t) as Vec3),
    visible: sampleProp(obj, 'visible', t) as boolean,
    params,
    editorOnly: asset?.editorOnly ?? false,
  };
}

/** Which part of a target an "auto" aim resolves to. */
export function resolveAimName(type: string, aim: Aim): AnchorName {
  if (aim !== 'auto') return aim;
  return isCharacterType(type) ? 'chest' : 'center';
}

/** World position of an object's anchor at time t. */
export function anchorWorld(obj: SceneObject, aim: Aim, t: number): Vec3 {
  const e = evaluateObject(obj, t);
  const local = localAnchor(obj.type, e.params, resolveAimName(obj.type, aim));
  return transformPoint(local, e.position, e.rotation, e.scale);
}

export function resolveAimPoint(project: Project, lookAt: LookAt, t: number): Vec3 | null {
  if (lookAt.target) {
    const target = findObject(project, lookAt.target);
    if (!target) return lookAt.point ? add(lookAt.point, lookAt.offset) : null;
    return add(anchorWorld(target, lookAt.aim, t), lookAt.offset);
  }
  if (lookAt.point) return add(lookAt.point, lookAt.offset);
  return null;
}

interface ShakeProfile {
  rot: Vec3;
  pos: Vec3;
  freq: number;
  bob?: { freq: number; amp: number };
}

export const SHAKE_PROFILES: Record<ShakePreset, ShakeProfile> = {
  none: { rot: [0, 0, 0], pos: [0, 0, 0], freq: 1 },
  handheld: { rot: [0.55, 0.65, 0.4], pos: [0.008, 0.01, 0.008], freq: 0.9 },
  walk: { rot: [0.8, 0.7, 0.7], pos: [0.02, 0.02, 0.015], freq: 1.1, bob: { freq: 1.9, amp: 0.03 } },
  drone: { rot: [0.25, 0.5, 0.35], pos: [0.14, 0.09, 0.14], freq: 0.17 },
  vehicle: { rot: [0.35, 0.25, 0.35], pos: [0.012, 0.025, 0.012], freq: 4.5 },
  earthquake: { rot: [1.6, 1.3, 2.2], pos: [0.06, 0.05, 0.06], freq: 6 },
};

/** Deterministic shake offsets for a camera at time t. */
export function shakeOffsets(preset: ShakePreset, amount: number, seed: number, t: number): { rot: Vec3; pos: Vec3 } {
  const p = SHAKE_PROFILES[preset] ?? SHAKE_PROFILES.none;
  if (preset === 'none' || amount <= 0) return { rot: [0, 0, 0], pos: [0, 0, 0] };
  const x = t * p.freq;
  const rot: Vec3 = [
    p.rot[0] * amount * fbm1(x, seed * 7 + 1),
    p.rot[1] * amount * fbm1(x, seed * 7 + 2),
    p.rot[2] * amount * fbm1(x, seed * 7 + 3),
  ];
  const pos: Vec3 = [
    p.pos[0] * amount * fbm1(x * 0.8, seed * 7 + 4),
    p.pos[1] * amount * fbm1(x * 0.8, seed * 7 + 5),
    p.pos[2] * amount * fbm1(x * 0.8, seed * 7 + 6),
  ];
  if (p.bob) pos[1] += p.bob.amp * amount * (Math.abs(Math.sin(Math.PI * p.bob.freq * t)) - 0.5);
  return { rot, pos };
}

export function cameraSettings(obj: SceneObject): CameraSettings {
  return obj.camera ?? defaultCamera();
}

export function frameAspect(project: Project): number {
  const [w, h] = project.settings.resolution;
  return w / h;
}

export function evaluateCamera(project: Project, obj: SceneObject, t: number, aspect = frameAspect(project)): EvalCamera {
  const cam = cameraSettings(obj);
  const base = evaluateObject(obj, t);
  let position = base.position;
  let rotation: Vec3 = [...base.rotation];
  let aimPoint: Vec3 | null = null;

  if (cam.follow) {
    const target = findObject(project, cam.follow.target);
    if (target && target.id !== obj.id) {
      const te = evaluateObject(target, Math.max(0, t - cam.follow.lag));
      const offset = cam.follow.space === 'local' ? rotateY(cam.follow.offset, te.rotation[1]) : cam.follow.offset;
      position = add(te.position, offset);
    }
  }
  if (cam.lookAt && cam.lookAt.target !== obj.id) {
    aimPoint = resolveAimPoint(project, cam.lookAt, t);
    if (aimPoint) {
      const { pan, tilt } = lookAngles(position, aimPoint);
      rotation = [tilt, pan, rotation[2]];
    }
  }

  const amount = sampleProp(obj, 'camera.shake.amount', t) as number;
  const shake = shakeOffsets(cam.shake.preset, amount ?? 0, cam.shake.seed, t);
  position = add(position, shake.pos);
  rotation = add(rotation, shake.rot);

  const focalLength = (sampleProp(obj, 'camera.focalLength', t) as number) ?? cam.focalLength;
  const fov = lensFov(focalLength, cam.sensor, aspect);

  return {
    id: obj.id,
    name: obj.name,
    position,
    rotation,
    rig: cam.rig,
    lens: cam.lens,
    sensor: cam.sensor,
    focalLength,
    aspect,
    hfov: fov.hfov,
    vfov: fov.vfov,
    fisheye: {
      fov: (sampleProp(obj, 'camera.fisheye.fov', t) as number) ?? cam.fisheye.fov,
      mapping: cam.fisheye.mapping,
      circular: cam.fisheye.circular,
    },
    aimPoint,
  };
}

/** Cameras in document order. */
export function cameraObjects(project: Project): SceneObject[] {
  return project.objects.filter((o) => o.type === 'camera');
}

/** The camera that is "live" at time t according to the cut list (fallback: first camera). */
export function programCameraAt(project: Project, t: number): string | null {
  const cams = new Set(cameraObjects(project).map((c) => c.id));
  if (cams.size === 0) return null;
  let live: string | null = null;
  const cuts = [...project.cuts].sort((a, b) => a.t - b.t);
  for (const c of cuts) {
    if (c.t <= t + 1e-6 && cams.has(c.camera)) live = c.camera;
  }
  if (live) return live;
  const first = cuts.find((c) => cams.has(c.camera));
  return first ? first.camera : (cameraObjects(project)[0]?.id ?? null);
}

export function evaluateScene(project: Project, t: number): EvalScene {
  const objects = project.objects.map((o) => evaluateObject(o, t));
  return {
    t,
    objects,
    byId: new Map(objects.map((o) => [o.id, o])),
    programCamera: programCameraAt(project, t),
  };
}

/** Total frame count for a project. */
export function frameCount(project: Project): number {
  return Math.max(1, Math.round(project.settings.duration * project.settings.fps));
}
