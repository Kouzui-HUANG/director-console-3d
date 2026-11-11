/**
 * Cinematography helpers: shot sizes, camera angles and sides → camera placement.
 * Distances come from the real lens field of view, so a "medium shot" really
 * frames waist-up for the chosen focal length and sensor.
 */
import { characterAnchors, isCharacterType, getAssetType } from './assetTypes.ts';
import type { EvalObject } from './evaluate.ts';
import { focalFromFov, lensFov } from './lens.ts';
import { add, clamp, DEG2RAD, faceYaw, mul, normalize, rotateY, sub, type Vec3 } from './math.ts';
import type { Sensor } from './schema.ts';

export const SHOT_SIZES = {
  ECU: { label: '大特寫', en: 'extreme close-up', frame: 0.1, top: 0.0 },
  CU: { label: '特寫', en: 'close-up', frame: 0.22, top: 0.02 },
  MCU: { label: '近景', en: 'medium close-up', frame: 0.36, top: 0.04 },
  MS: { label: '中景', en: 'medium shot (waist up)', frame: 0.52, top: 0.05 },
  MLS: { label: '中遠景', en: 'medium long shot (knees up)', frame: 0.78, top: 0.06 },
  FS: { label: '全景', en: 'full shot (whole body)', frame: 1.3, top: 0.12 },
  LS: { label: '遠景', en: 'long / wide shot', frame: 2.6, top: 0.7 },
  ELS: { label: '大遠景', en: 'extreme long shot', frame: 8, top: 3.5 },
} as const;
export type ShotSize = keyof typeof SHOT_SIZES;
export const SHOT_SIZE_IDS = Object.keys(SHOT_SIZES) as ShotSize[];

export const ANGLES = {
  eye: { label: '平視', en: 'eye level', elevation: 0, roll: 0 },
  high: { label: '俯角', en: 'high angle', elevation: 28, roll: 0 },
  low: { label: '仰角', en: 'low angle', elevation: -22, roll: 0 },
  overhead: { label: '鳥瞰', en: "overhead / bird's eye", elevation: 88, roll: 0 },
  worm: { label: '蟲視', en: "worm's eye", elevation: -55, roll: 0 },
  dutch: { label: '荷蘭角', en: 'dutch tilt', elevation: 0, roll: 15 },
} as const;
export type ShotAngle = keyof typeof ANGLES;
export const ANGLE_IDS = Object.keys(ANGLES) as ShotAngle[];

/** Camera direction around the subject, relative to the subject's facing. "left" = subject's left-hand side. */
export const SIDES = {
  front: { label: '正面', yaw: 0 },
  frontLeft: { label: '左前 3/4', yaw: 40 },
  left: { label: '左側', yaw: 90 },
  backLeft: { label: '左後', yaw: 140 },
  back: { label: '背面', yaw: 180 },
  backRight: { label: '右後', yaw: -140 },
  right: { label: '右側', yaw: -90 },
  frontRight: { label: '右前 3/4', yaw: -40 },
} as const;
export type ShotSide = keyof typeof SIDES;
export const SIDE_IDS = Object.keys(SIDES) as ShotSide[];

export interface FramingSubject {
  position: Vec3;
  yaw: number;
  /** Visual height of the subject in meters (characters: body height). */
  height: number;
  /** Eye height in world space (meters). */
  eyeY: number;
  baseY: number;
}

export function subjectFromEval(e: EvalObject): FramingSubject {
  const asset = getAssetType(e.type);
  const scaleY = e.scale[1];
  if (isCharacterType(e.type)) {
    const h = (typeof e.params.height === 'number' ? e.params.height : 1.7) * scaleY;
    const pose = String(e.params.pose ?? 'stand');
    const anchors = characterAnchors(pose, h);
    const visualH = pose === 'sit' ? h * 0.72 : pose === 'crouch' ? h * 0.62 : pose === 'lie' ? h * 0.25 : h;
    return { position: e.position, yaw: e.rotation[1], height: visualH, eyeY: e.position[1] + anchors.head[1], baseY: e.position[1] };
  }
  const b = asset ? asset.bounds(e.params) : { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
  const h = Math.max(0.1, (b.max[1] - b.min[1]) * scaleY);
  return { position: e.position, yaw: e.rotation[1], height: h, eyeY: e.position[1] + h * 0.85, baseY: e.position[1] + b.min[1] * scaleY };
}

export interface FramingRequest {
  subject: FramingSubject;
  shot: ShotSize;
  angle: ShotAngle;
  side: ShotSide;
  focalLength: number;
  sensor: Sensor;
  aspect: number;
  /** Over-the-shoulder: the foreground character whose shoulder we shoot over. */
  over?: FramingSubject;
  /** Which shoulder of `over` to use. */
  shoulder?: 'left' | 'right';
  /** Keep this camera position and solve the focal length instead. */
  keepPosition?: Vec3;
}

export interface FramingResult {
  position: Vec3;
  /** World point the camera aims at (frame center). */
  aim: Vec3;
  focalLength: number;
  roll: number;
  distance: number;
  notes: string[];
}

/** Frame height (meters at the subject) and frame-center height for a shot size. */
export function shotFrame(shot: ShotSize, subject: FramingSubject): { frameH: number; centerY: number } {
  const s = SHOT_SIZES[shot];
  const H = subject.height;
  const frameH = s.frame * H;
  let centerY: number;
  if (shot === 'ECU') centerY = subject.eyeY - 0.02 * H;
  else if (shot === 'LS' || shot === 'ELS') centerY = subject.baseY + Math.min(frameH * 0.35, H * 0.5 + s.top);
  else centerY = subject.baseY + H + s.top * H - frameH / 2;
  return { frameH, centerY };
}

export function computeFraming(req: FramingRequest): FramingResult {
  const notes: string[] = [];
  const { subject } = req;
  const { frameH, centerY } = shotFrame(req.shot, subject);
  const aim: Vec3 = [subject.position[0], centerY, subject.position[2]];
  const angle = ANGLES[req.angle];
  const fov = lensFov(req.focalLength, req.sensor, req.aspect);

  // Over-the-shoulder: camera fixed behind the foreground subject; solve focal length.
  if (req.over) {
    const dir = normalize([subject.position[0] - req.over.position[0], 0, subject.position[2] - req.over.position[2]]);
    const right: Vec3 = [-dir[2], 0, dir[0]];
    const sideSign = req.shoulder === 'left' ? -1 : 1;
    const pos: Vec3 = add(
      add([req.over.position[0], req.over.eyeY + 0.08, req.over.position[2]], mul(dir, -0.55)),
      mul(right, 0.32 * sideSign),
    );
    const d = Math.hypot(aim[0] - pos[0], aim[1] - pos[1], aim[2] - pos[2]);
    const f = clamp(focalFromFov(2 * Math.atan(frameH / 2 / d) / DEG2RAD, fov.sensorH), 8, 600);
    return { position: pos, aim, focalLength: f, roll: angle.roll, distance: d, notes };
  }

  if (req.keepPosition) {
    const pos = req.keepPosition;
    const d = Math.hypot(aim[0] - pos[0], aim[1] - pos[1], aim[2] - pos[2]);
    const fRaw = focalFromFov(2 * Math.atan(frameH / 2 / d) / DEG2RAD, fov.sensorH);
    const f = clamp(fRaw, 8, 600);
    if (f !== fRaw) notes.push(`focal length clamped to ${f.toFixed(0)}mm; move the camera to get exactly this shot size`);
    return { position: pos, aim, focalLength: f, roll: angle.roll, distance: d, notes };
  }

  const d = frameH / 2 / Math.tan((fov.vfov * DEG2RAD) / 2);
  const azimuth = subject.yaw + SIDES[req.side].yaw;
  const flatDir = rotateY([0, 0, 1], azimuth);
  let position: Vec3;
  if (req.angle === 'eye' || req.angle === 'dutch') {
    // Camera at the subject's eye height for people (natural eye-level framing).
    const camY = req.shot === 'LS' || req.shot === 'ELS' ? Math.max(centerY, subject.baseY + 1.5) : subject.eyeY;
    const dy = camY - centerY;
    const horiz = Math.sqrt(Math.max(d * d - dy * dy, d * d * 0.25));
    position = [aim[0] + flatDir[0] * horiz, camY, aim[2] + flatDir[2] * horiz];
  } else {
    const el = angle.elevation * DEG2RAD;
    const dir: Vec3 = [flatDir[0] * Math.cos(el), Math.sin(el), flatDir[2] * Math.cos(el)];
    position = add(aim, mul(dir, d));
    if (position[1] < 0.15) {
      position[1] = 0.15;
      notes.push('camera height clamped to just above the ground');
    }
  }
  return { position, aim, focalLength: req.focalLength, roll: angle.roll, distance: d, notes };
}

/** Rough shot-size classification from how much of the frame height a subject fills. */
export function classifyShot(subjectHeightFraction: number): ShotSize {
  // subjectHeightFraction = subject visible height / frame height (can exceed 1 when cropped)
  const ratio = 1 / Math.max(subjectHeightFraction, 1e-3); // ≈ frame / subject
  let best: ShotSize = 'FS';
  let bestErr = Infinity;
  for (const id of SHOT_SIZE_IDS) {
    const err = Math.abs(Math.log(SHOT_SIZES[id].frame / ratio));
    if (err < bestErr) {
      bestErr = err;
      best = id;
    }
  }
  return best;
}

/** Yaw for a subject to face another point (front = +Z). */
export function yawToward(from: Vec3, to: Vec3): number {
  return faceYaw(from, to);
}

export function directionBetween(a: Vec3, b: Vec3): Vec3 {
  return normalize(sub(b, a));
}
