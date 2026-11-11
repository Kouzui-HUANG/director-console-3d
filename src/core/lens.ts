/** Physical lens math: focal length, sensor size, field of view, aspect ratios, output sizes. */
import { RAD2DEG, DEG2RAD } from './math.ts';
import type { Sensor } from './schema.ts';

export const SENSOR_SIZES: Record<Sensor, { w: number; h: number; label: string }> = {
  fullFrame: { w: 36, h: 24, label: '全片幅 36×24mm' },
  super35: { w: 24.89, h: 18.66, label: 'Super 35' },
  apsc: { w: 23.5, h: 15.6, label: 'APS-C' },
  mft: { w: 17.3, h: 13, label: 'M4/3' },
  oneInch: { w: 13.2, h: 8.8, label: '1 吋（空拍機）' },
  phone: { w: 9.8, h: 7.35, label: '手機' },
};

export const FOCAL_PRESETS = [14, 18, 24, 35, 50, 85, 135, 200] as const;

const FULL_FRAME_DIAGONAL = Math.hypot(36, 24);

/**
 * Sensor area actually used for a frame aspect (width / height).
 * The sensor's long side maps to the frame's long side (portrait = camera rotated),
 * then the other side is cropped to the frame aspect.
 */
export function effectiveSensor(sensor: Sensor, frameAspect: number): { w: number; h: number } {
  const s = SENSOR_SIZES[sensor] ?? SENSOR_SIZES.super35;
  const long = Math.max(s.w, s.h);
  const short = Math.min(s.w, s.h);
  const sensorRatio = long / short;
  const frameRatio = frameAspect >= 1 ? frameAspect : 1 / frameAspect;
  let effLong: number;
  let effShort: number;
  if (frameRatio >= sensorRatio) {
    effLong = long;
    effShort = long / frameRatio;
  } else {
    effShort = short;
    effLong = short * frameRatio;
  }
  return frameAspect >= 1 ? { w: effLong, h: effShort } : { w: effShort, h: effLong };
}

export function fovFromFocal(focalMm: number, sensorMm: number): number {
  return 2 * Math.atan(sensorMm / (2 * focalMm)) * RAD2DEG;
}

export function focalFromFov(fovDeg: number, sensorMm: number): number {
  return sensorMm / (2 * Math.tan((fovDeg * DEG2RAD) / 2));
}

export interface LensFov {
  hfov: number;
  vfov: number;
  dfov: number;
  sensorW: number;
  sensorH: number;
}

export function lensFov(focalMm: number, sensor: Sensor, frameAspect: number): LensFov {
  const e = effectiveSensor(sensor, frameAspect);
  return {
    hfov: fovFromFocal(focalMm, e.w),
    vfov: fovFromFocal(focalMm, e.h),
    dfov: fovFromFocal(focalMm, Math.hypot(e.w, e.h)),
    sensorW: e.w,
    sensorH: e.h,
  };
}

/** 35mm-equivalent focal length (by sensor diagonal). */
export function equivalentFocal(focalMm: number, sensor: Sensor): number {
  const s = SENSOR_SIZES[sensor] ?? SENSOR_SIZES.super35;
  return (focalMm * FULL_FRAME_DIAGONAL) / Math.hypot(s.w, s.h);
}

/** Native focal length that matches a 35mm-equivalent value on a sensor. */
export function focalForEquivalent(equivMm: number, sensor: Sensor): number {
  const s = SENSOR_SIZES[sensor] ?? SENSOR_SIZES.super35;
  return (equivMm * Math.hypot(s.w, s.h)) / FULL_FRAME_DIAGONAL;
}

export const ASPECT_PRESETS = [
  { key: '16:9', ratio: 16 / 9, label: '16:9 寬螢幕' },
  { key: '9:16', ratio: 9 / 16, label: '9:16 直式短影音' },
  { key: '1:1', ratio: 1, label: '1:1 方形' },
  { key: '4:5', ratio: 4 / 5, label: '4:5 社群直式' },
  { key: '4:3', ratio: 4 / 3, label: '4:3 傳統' },
  { key: '1.85:1', ratio: 1.85, label: '1.85:1 電影遮幅' },
  { key: '2.39:1', ratio: 2.39, label: '2.39:1 寬銀幕' },
  { key: '2:1', ratio: 2, label: '2:1（360° 全景）' },
] as const;

export const RESOLUTION_TIERS = [
  { key: '720p', base: 720, label: '720p' },
  { key: '1080p', base: 1080, label: '1080p' },
  { key: '1440p', base: 1440, label: '1440p' },
  { key: '4k', base: 2160, label: '4K' },
] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number]['key'];

export function parseAspect(key: string): number | null {
  const preset = ASPECT_PRESETS.find((p) => p.key === key);
  if (preset) return preset.ratio;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/.exec(key);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 0 && b > 0) return a / b;
  }
  const v = Number(key);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function evenize(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2);
}

/**
 * Output size for an aspect ratio and tier (base 720/1080/1440/2160):
 * wide (≥16:9) → width fixed (1920 for 1080p); 1..16:9 → height = base; portrait → width = base.
 */
export function resolutionFor(aspect: number, tierBase: number): [number, number] {
  const k = tierBase / 1080;
  if (aspect >= 16 / 9 - 1e-6) {
    const w = evenize(1920 * k);
    return [w, evenize(w / aspect)];
  }
  if (aspect >= 1) {
    const h = evenize(1080 * k);
    return [evenize(h * aspect), h];
  }
  const w = evenize(1080 * k);
  return [w, evenize(w / aspect)];
}

/** Which tier (if any) a resolution corresponds to for its aspect. */
export function detectTier(resolution: [number, number]): ResolutionTier | null {
  const aspect = resolution[0] / resolution[1];
  for (const tier of RESOLUTION_TIERS) {
    const r = resolutionFor(aspect, tier.base);
    if (r[0] === resolution[0] && r[1] === resolution[1]) return tier.key;
  }
  return null;
}

/**
 * Circle-of-confusion diameter on the sensor (mm) for an object at distance d (m)
 * with focus distance s (m), focal length f (mm) and f-number N.
 */
export function circleOfConfusionMm(f: number, N: number, s: number, d: number): number {
  const sMm = s * 1000;
  const dMm = Math.max(d * 1000, 1);
  if (sMm <= f) return 0;
  return ((f * f) / (N * (sMm - f))) * (Math.abs(dMm - sMm) / dMm);
}

/** Default lens for a rig (drones use a 1" sensor at ~24mm equivalent). */
export function rigDefaults(rig: string): { sensor: Sensor; focalLength: number } {
  switch (rig) {
    case 'drone':
      return { sensor: 'oneInch', focalLength: Math.round(focalForEquivalent(24, 'oneInch') * 10) / 10 };
    case 'handheld':
      return { sensor: 'super35', focalLength: 28 };
    default:
      return { sensor: 'super35', focalLength: 35 };
  }
}
