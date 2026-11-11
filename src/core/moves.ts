/**
 * Camera move presets (dolly, truck, crane, pan, tilt, orbit, zoom, dolly-zoom, drone moves).
 * A preset expands into ordinary keyframes that can be edited afterwards.
 */
import { anchorWorld, findObject, resolveAimPoint, sampleProp } from './evaluate.ts';
import { add, cameraForward, clamp, distance, lookAngles, mul, normalize, rotateY, roundTo, roundVec, sub, unwrapDeg, type Vec3 } from './math.ts';
import type { Ease, Project, SceneObject } from './schema.ts';

export const MOVE_PRESETS = {
  dollyIn: { label: '推軌（前進）', unit: 'm', amount: 2 },
  dollyOut: { label: '拉軌（後退）', unit: 'm', amount: 2 },
  truckLeft: { label: '橫移（向左）', unit: 'm', amount: 2 },
  truckRight: { label: '橫移（向右）', unit: 'm', amount: 2 },
  pedestalUp: { label: '升高', unit: 'm', amount: 1 },
  pedestalDown: { label: '降低', unit: 'm', amount: 1 },
  craneUp: { label: '搖臂上升', unit: 'm', amount: 3 },
  craneDown: { label: '搖臂下降', unit: 'm', amount: 3 },
  panLeft: { label: '左搖', unit: '°', amount: 30 },
  panRight: { label: '右搖', unit: '°', amount: 30 },
  tiltUp: { label: '上仰', unit: '°', amount: 15 },
  tiltDown: { label: '下俯', unit: '°', amount: 15 },
  rollLeft: { label: '左傾', unit: '°', amount: 10 },
  rollRight: { label: '右傾', unit: '°', amount: 10 },
  orbitLeft: { label: '向左環繞', unit: '°', amount: 90 },
  orbitRight: { label: '向右環繞', unit: '°', amount: 90 },
  zoomIn: { label: '變焦拉近', unit: '倍', amount: 2 },
  zoomOut: { label: '變焦拉遠', unit: '倍', amount: 2 },
  dollyZoomIn: { label: '滑動變焦（前推）', unit: '比例', amount: 0.5 },
  dollyZoomOut: { label: '滑動變焦（後拉）', unit: '比例', amount: 0.6 },
  droneRise: { label: '空拍拉升揭露', unit: 'm', amount: 20 },
  droneFlyover: { label: '空拍飛越', unit: 'm', amount: 40 },
  droneOrbit: { label: '空拍環繞', unit: '°', amount: 180 },
  topDownRise: { label: '俯視上升', unit: 'm', amount: 15 },
} as const;
export type MovePreset = keyof typeof MOVE_PRESETS;
export const MOVE_IDS = Object.keys(MOVE_PRESETS) as MovePreset[];

export interface PlannedKey {
  path: string;
  t: number;
  v: unknown;
  ease?: Ease;
}

export interface MovePlan {
  keys: PlannedKey[];
  paths: string[];
  smoothPosition: boolean;
  notes: string[];
}

export class MoveError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

export function planMove(
  project: Project,
  cam: SceneObject,
  preset: MovePreset,
  opts: { start: number; duration: number; amount?: number; target?: string; ease?: Ease },
): MovePlan {
  const camera = cam.camera;
  if (!camera) throw new MoveError(`"${cam.id}" is not a camera`);
  const info = MOVE_PRESETS[preset];
  const amount = opts.amount ?? info.amount;
  const start = opts.start;
  const end = Math.min(30, start + opts.duration);
  const ease: Ease = opts.ease ?? 'inOut';
  const notes: string[] = [];

  const P0 = sampleProp(cam, 'position', start) as Vec3;
  const R0 = sampleProp(cam, 'rotation', start) as Vec3;
  const f0 = sampleProp(cam, 'camera.focalLength', start) as number;
  const aim = camera.lookAt ? resolveAimPoint(project, camera.lookAt, start) : null;
  const movesPosition = !['panLeft', 'panRight', 'tiltUp', 'tiltDown', 'rollLeft', 'rollRight', 'zoomIn', 'zoomOut'].includes(preset);
  if (camera.follow && movesPosition) {
    throw new MoveError(`camera "${cam.id}" follows "${camera.follow.target}", so its position is driven by the follow`, 'Clear it first: object.update {camera:{follow:null}}');
  }

  let pan = R0[1];
  let tilt = R0[0];
  if (aim) ({ pan, tilt } = lookAngles(P0, aim));
  const forward = cameraForward(pan, tilt);
  let flat = normalize([forward[0], 0, forward[2]]);
  if (flat[0] === 0 && flat[2] === 0) flat = rotateY([0, 0, -1], pan);
  const right = rotateY([1, 0, 0], pan);

  let pivot: Vec3;
  if (aim) pivot = aim;
  else if (opts.target) {
    const t = findObject(project, opts.target);
    if (!t) throw new MoveError(`no object "${opts.target}"`);
    pivot = anchorWorld(t, 'auto', start);
  } else pivot = add(P0, mul(forward, 6));
  const pivotDist = Math.max(0.5, distance(P0, pivot));

  const keys: PlannedKey[] = [];
  const twoKey = (path: string, a: unknown, b: unknown) => {
    keys.push({ path, t: start, v: a, ease }, { path, t: end, v: b });
  };
  const posKeys = (P1: Vec3) => twoKey('position', roundVec(P0, 3), roundVec(P1, 3));
  const aimRotation = (P: Vec3): Vec3 => {
    const a = lookAngles(P, pivot);
    return [roundTo(a.tilt, 3), roundTo(unwrapDeg(R0[1], a.pan), 3), R0[2]];
  };
  const requireFree = () => {
    if (aim) throw new MoveError(`camera "${cam.id}" uses lookAt, so pan/tilt are automatic`, 'Use orbit/truck/dolly, or clear lookAt: object.update {camera:{lookAt:null}}');
  };

  switch (preset) {
    case 'dollyIn': {
      const d = aim ? Math.min(amount, pivotDist - 0.3) : amount;
      if (d < amount) notes.push('dolly distance shortened so the camera stops before the subject');
      posKeys(add(P0, mul(forward, d)));
      break;
    }
    case 'dollyOut':
      posKeys(add(P0, mul(forward, -amount)));
      break;
    case 'truckLeft':
    case 'truckRight':
      posKeys(add(P0, mul(right, preset === 'truckLeft' ? -amount : amount)));
      break;
    case 'pedestalUp':
    case 'pedestalDown':
      posKeys(add(P0, [0, preset === 'pedestalUp' ? amount : -amount, 0]));
      break;
    case 'craneUp':
    case 'craneDown':
    case 'droneRise': {
      const P1 = add(P0, [0, preset === 'craneDown' ? -amount : amount, 0]);
      if (P1[1] < 0.1) P1[1] = 0.1;
      posKeys(P1);
      if (!aim) twoKey('rotation', [...R0], aimRotation(P1));
      break;
    }
    case 'panLeft':
    case 'panRight':
      requireFree();
      twoKey('rotation', [...R0], [R0[0], roundTo(R0[1] + (preset === 'panLeft' ? amount : -amount), 3), R0[2]]);
      break;
    case 'tiltUp':
    case 'tiltDown':
      requireFree();
      twoKey('rotation', [...R0], [clamp(R0[0] + (preset === 'tiltUp' ? amount : -amount), -90, 90), R0[1], R0[2]]);
      break;
    case 'rollLeft':
    case 'rollRight':
      twoKey('rotation', [...R0], [R0[0], R0[1], R0[2] + (preset === 'rollLeft' ? amount : -amount)]);
      break;
    case 'orbitLeft':
    case 'orbitRight':
    case 'droneOrbit': {
      const angle = preset === 'orbitLeft' ? -amount : amount;
      const steps = Math.max(2, Math.ceil(Math.abs(angle) / 30));
      const rel = sub(P0, pivot);
      let prevPan = R0[1];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const t = start + (end - start) * u;
        const P = add(pivot, rotateY(rel, angle * u));
        keys.push({ path: 'position', t, v: roundVec(P, 3), ease: 'linear' });
        if (!aim) {
          const a = lookAngles(P, pivot);
          prevPan = unwrapDeg(prevPan, a.pan);
          keys.push({ path: 'rotation', t, v: [roundTo(a.tilt, 3), roundTo(prevPan, 3), R0[2]], ease: 'linear' });
        }
      }
      return { keys, paths: aim ? ['position'] : ['position', 'rotation'], smoothPosition: true, notes };
    }
    case 'zoomIn':
    case 'zoomOut': {
      const f1 = clamp(preset === 'zoomIn' ? f0 * amount : f0 / amount, 4, 1200);
      twoKey('camera.focalLength', roundTo(f0, 2), roundTo(f1, 2));
      break;
    }
    case 'dollyZoomIn':
    case 'dollyZoomOut': {
      const k = preset === 'dollyZoomIn' ? clamp(1 - amount, 0.1, 0.95) : 1 + Math.max(0.05, amount);
      const d1 = pivotDist * k;
      const P1 = add(P0, mul(forward, pivotDist - d1));
      posKeys(P1);
      twoKey('camera.focalLength', roundTo(f0, 2), roundTo(clamp(f0 * k, 4, 1200), 2));
      if (!aim) notes.push('tip: set camera.lookAt to the subject for a cleaner dolly zoom');
      break;
    }
    case 'droneFlyover':
      posKeys(add(P0, mul(flat, amount)));
      break;
    case 'topDownRise': {
      requireFree();
      const P1 = add(P0, [0, amount, 0]);
      posKeys(P1);
      twoKey('rotation', [-89.9, R0[1], R0[2]], [-89.9, R0[1], R0[2]]);
      break;
    }
  }
  const paths = [...new Set(keys.map((k) => k.path))];
  return { keys, paths, smoothPosition: false, notes };
}
