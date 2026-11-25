/**
 * Built-in presets. A preset is just a parameter file (only the values that differ from the
 * defaults). Heights follow adult averages (East Asia ≈ 172 / 160 cm, Europe ≈ 178 / 165 cm).
 * Light refinements on top of MakeHuman's averages: slightly longer eye fissures (its eyes are
 * narrow), and a more adult face for the East Asian male (its young target reads as a teenager).
 */
import type { ParamValues } from './resolve.ts';

export interface Preset {
  id: string;
  label: string;
  params: ParamValues;
}

export const PRESETS: Preset[] = [
  { id: 'neutral', label: '中性基準', params: {} },
  {
    id: 'male-eastAsian',
    label: '男性・東亞',
    params: { 'base.sex': 1, 'base.eastAsian': 1, 'base.age': 28, 'body.heightCm': 172, 'head.age': 0.35, 'face.jaw.angle': 0.3, 'face.nose.bridgeHeight': 0.25, 'face.brow.ridge': 0.2, 'face.eyes.width': 0.3 },
  },
  {
    id: 'female-eastAsian',
    label: '女性・東亞',
    params: { 'base.sex': 0, 'base.eastAsian': 1, 'base.age': 26, 'body.heightCm': 160, 'face.eyes.width': 0.35, 'face.eyes.size': 0.2, 'face.nose.bridgeHeight': 0.15, 'head.shape.oval': 0.3 },
  },
  {
    id: 'male-european',
    label: '男性・歐美',
    params: { 'base.sex': 1, 'base.european': 1, 'base.age': 30, 'body.heightCm': 178, 'face.eyes.width': 0.25 },
  },
  {
    id: 'female-european',
    label: '女性・歐美',
    params: { 'base.sex': 0, 'base.european': 1, 'base.age': 28, 'body.heightCm': 165, 'face.eyes.width': 0.25, 'face.eyes.opening': 0.1, 'face.brow.ridge': -0.2 },
  },
];

export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
