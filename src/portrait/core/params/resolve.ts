/**
 * Semantic parameters → engine inputs (MakeHuman modifier values, absolute targets, pose, gaze),
 * with validation messages written for people and agents.
 */
import type { BrowShape } from '../mh/brows.ts';
import { yearsToAge } from '../mh/modifiers.ts';
import { PARAMS, PARAM_BY_KEY, expandSides, type BrowKey, type ParamDef, type PoseKey } from './registry.ts';

export type ParamValues = Record<string, number | null>;

export interface ParamIssue {
  key: string;
  level: 'error' | 'warning' | 'note';
  code: 'UNKNOWN_PARAM' | 'NOT_A_NUMBER' | 'OUT_OF_LIMIT' | 'EXAGGERATED';
  message: string;
  hint?: string;
}

export interface ResolvedParams {
  /** MakeHuman modifier values (ids from modifiers.ts) and `expr/<unit>` weights. */
  values: Record<string, number>;
  heightCm: number | null;
  headsTall: number | null;
  pose: Record<PoseKey, number>;
  gaze: { yaw: number; pitch: number };
  /** Eyebrow shape in mm (relief 0 = not sculpted; the shape still guides photo fitting). */
  brows: BrowShape;
  /** Skull width above the brows (−2…+2, see HumanSpec.cranium). */
  cranium: number;
  issues: ParamIssue[];
}

/** Closest known keys (edit distance on the last segments), for "did you mean" hints. */
export function suggestKeys(key: string, n = 3): string[] {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  const k = key.toLowerCase();
  const tokens = k.split(/[^a-z0-9]+/).filter(Boolean);
  return PARAMS.map((p) => {
    const pk = p.key.toLowerCase();
    // more matching words first, then edit distance
    const hits = tokens.filter((t) => pk.includes(t)).length;
    return { key: p.key, s: -hits * 100 + (pk.includes(k) || k.includes(pk) ? 0 : dist(k, pk)) };
  })
    .sort((a, b) => a.s - b.s)
    .slice(0, n)
    .map((x) => x.key);
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export function resolveParams(params: ParamValues): ResolvedParams {
  const issues: ParamIssue[] = [];
  const given = new Map<string, number | null>();
  for (const [key, raw] of Object.entries(params)) {
    const def = PARAM_BY_KEY.get(key);
    if (!def) {
      issues.push({ key, level: 'error', code: 'UNKNOWN_PARAM', message: `沒有這個參數：${key}`, hint: `相近的參數：${suggestKeys(key).join('、')}` });
      continue;
    }
    if (raw === null && def.def === null) {
      given.set(key, null);
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      issues.push({ key, level: 'error', code: 'NOT_A_NUMBER', message: `${key}（${def.label}）必須是數字`, hint: def.def === null ? '或用 null 表示自動' : undefined });
      continue;
    }
    let v = raw;
    if (v < def.limit[0] || v > def.limit[1]) {
      v = Math.min(def.limit[1], Math.max(def.limit[0], v));
      issues.push({ key, level: 'warning', code: 'OUT_OF_LIMIT', message: `${key}（${def.label}）= ${fmt(raw)} 超出可用範圍 ${def.limit[0]}～${def.limit[1]}，已限制為 ${fmt(v)}` });
    } else if (v < def.range[0] || v > def.range[1]) {
      issues.push({ key, level: 'note', code: 'EXAGGERATED', message: `${key}（${def.label}）= ${fmt(v)} 超出寫實範圍 ${def.range[0]}～${def.range[1]}（誇張）` });
    }
    given.set(key, v);
  }

  const values: Record<string, number> = {};
  const add = (id: string, v: number) => {
    values[id] = (values[id] ?? 0) + v;
  };
  const pose: Record<PoseKey, number> = { headYaw: 0, headPitch: 0, headRoll: 0, armAngle: 0, elbow: 0, shoulderWidth: 0, shoulderLift: 0 };
  const gaze = { yaw: 0, pitch: 0 };
  let heightCm: number | null = null;
  let headsTall: number | null = null;
  let cranium = 0;
  const ethnic: Record<string, number> = {};
  const browIn: Record<BrowKey, number> = { relief: 1, density: 0, thickness: 0, length: 0, arch: 0, peak: 0, gap: 0, head: 0, texture: 0.6, asym: 0 };

  const valueOf = (d: ParamDef) => (given.has(d.key) ? given.get(d.key)! : d.def);
  for (const d of PARAMS) {
    const v = valueOf(d);
    if (v === null) continue;
    if (d.mh) {
      if (!v) continue;
      for (const [pattern, f] of Object.entries(d.mh)) {
        const factor = typeof f === 'number' ? f : v < 0 ? f[0] : f[1];
        if (!factor) continue;
        for (const id of expandSides(pattern)) add(id, v * factor);
      }
    } else if (d.expr) {
      if (!v) continue;
      for (const [unit, w] of Object.entries(d.expr)) add(`expr/${unit}`, v * w);
    } else if (d.special === 'age') values['macro/Age'] = yearsToAge(v);
    else if (d.special === 'ethnic') ethnic[d.macro!] = v;
    else if (d.special === 'heightCm') heightCm = v;
    else if (d.special === 'headsTall') headsTall = v;
    else if (d.special === 'gazeYaw') gaze.yaw = v;
    else if (d.special === 'gazePitch') gaze.pitch = v;
    else if (d.special === 'cranium') cranium = v;
    else if (d.macro) values[`macro/${d.macro}`] = d.centred ? 0.5 + 0.5 * v : v;
    else if (d.pose) pose[d.pose] = v;
    else if (d.brow) browIn[d.brow] = v;
  }
  // ethnicity: normalized mix; nothing chosen = an even mix
  const sum = (ethnic.Asian ?? 0) + (ethnic.Caucasian ?? 0) + (ethnic.African ?? 0);
  for (const k of ['Asian', 'Caucasian', 'African']) values[`macro/${k}`] = sum > 0 ? (ethnic[k] ?? 0) / sum : 1 / 3;
  const sex = (valueOf(PARAM_BY_KEY.get('base.sex')!) as number | null) ?? 0.5;
  const age = (valueOf(PARAM_BY_KEY.get('base.age')!) as number | null) ?? 25;
  return { values, heightCm, headsTall, pose, gaze, brows: browShape(browIn, sex, age), cranium, issues };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Eyebrow parameters → brow shape in mm, around the average for the sex and age (0 = average):
 * men's brows thicker, straighter and lower; women's thinner, more arched and a little higher;
 * sparser after middle age.
 */
export function browShape(b: Record<BrowKey, number>, sex: number, age: number): BrowShape {
  const m = clamp(sex, 0, 1);
  const lerp = (female: number, male: number) => female + (male - female) * m;
  const thick = Math.max(0.3, 1 + 0.35 * b.thickness);
  const older = clamp((age - 45) / 35, 0, 1);
  const soft = Math.max(0.3, 1 - 0.3 * b.density);
  const lift = lerp(0.8, -0.8);
  return {
    relief: Math.max(0, b.relief),
    height: Math.max(0.1, 1.25 * (1 + 0.5 * b.density) * (1 - 0.25 * older)),
    headShift: 4.5 * b.gap,
    tailShift: 6 * b.length,
    rise: Math.max(0, lerp(4.2, 2.4) + 2.6 * b.arch),
    peak: 0.62 + 0.12 * b.peak,
    thick: [lerp(7, 9) * thick, lerp(5.5, 7) * thick, lerp(1.8, 2.4) * (0.6 + 0.4 * thick)],
    headTaper: clamp(0.5 - 0.5 * b.head, 0, 1),
    soft: [0.7 * soft, 2.2 * soft],
    texture: clamp(b.texture, 0, 1),
    lift: [lift + 1.5 * b.asym, lift - 1.5 * b.asym],
  };
}

/** Only the parameters that differ from their defaults (what a parameter file stores). */
export function changedParams(params: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(params)) {
    const d = PARAM_BY_KEY.get(k);
    if (!d || v === d.def) continue;
    out[k] = v;
  }
  return out;
}
