/**
 * Modifiers → target weights, re-implemented from the MakeHuman data conventions (the targets
 * and modifier definitions are CC0; this code is our own):
 *  - local modifiers with a min/max pair use `<group>/<target>-<min>` for negative values and
 *    `<group>/<target>-<max>` for positive values (range −1…1); single targets range 0…1;
 *  - macro variables (gender, age, muscle, weight, height, proportions, ethnicity, breast size
 *    and firmness) blend "corner" targets named after their categories, e.g.
 *    macrodetails/universal-female-young-averagemuscle-maxweight, macrodetails/asian-male-old,
 *    macrodetails/height/male-young-averagemuscle-averageweight-maxheight. Each corner's weight
 *    is the product of its categories' weights.
 */
import type { MhAssets } from './assets.ts';

export type MacroVar = 'Gender' | 'Age' | 'Muscle' | 'Weight' | 'Height' | 'BodyProportions' | 'African' | 'Asian' | 'Caucasian' | 'BreastSize' | 'BreastFirmness';

export const MACRO_DEFAULTS: Record<MacroVar, number> = {
  Gender: 0.5,
  Age: 0.5,
  Muscle: 0.5,
  Weight: 0.5,
  Height: 0.5,
  BodyProportions: 0.5,
  African: 1 / 3,
  Asian: 1 / 3,
  Caucasian: 1 / 3,
  BreastSize: 0.5,
  BreastFirmness: 0.5,
};

export interface ModifierDef {
  /** `macro/Gender`, `nose/nose-trans-down|up`, `head/head-oval` … */
  id: string;
  group: string;
  kind: 'macro' | 'pair' | 'single';
  macro?: MacroVar;
  min?: string;
  max?: string;
  single?: string;
  range: [number, number];
  def: number;
}

export function buildModifiers(assets: MhAssets): ModifierDef[] {
  const have = (t: string) => (assets.targetByName.has(t) ? t : undefined);
  const defs: ModifierDef[] = [];
  const seen = new Set<string>();
  for (const g of [...assets.meta.modifiers.modeling, ...assets.meta.modifiers.measurement]) {
    if (g.group === 'genitals') continue;
    for (const m of g.modifiers) {
      let d: ModifierDef;
      if (m.macrovar) {
        const v = m.macrovar as MacroVar;
        d = { id: `macro/${v}`, group: g.group, kind: 'macro', macro: v, range: [0, 1], def: MACRO_DEFAULTS[v] ?? 0.5 };
      } else if (m.min && m.max) {
        d = { id: `${g.group}/${m.target}-${m.min}|${m.max}`, group: g.group, kind: 'pair', min: have(`${g.group}/${m.target}-${m.min}`), max: have(`${g.group}/${m.target}-${m.max}`), range: [-1, 1], def: 0 };
      } else {
        d = { id: `${g.group}/${m.target}`, group: g.group, kind: 'single', single: have(`${g.group}/${m.target}`), range: [0, 1], def: 0 };
      }
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      defs.push(d);
    }
  }
  // asymmetry targets have no modifier definitions: expose each as a single (0…1)
  for (const t of assets.meta.targets) {
    if (!t.name.startsWith('asym/') || seen.has(t.name)) continue;
    seen.add(t.name);
    defs.push({ id: t.name, group: 'asym', kind: 'single', single: t.name, range: [0, 1], def: 0 });
  }
  return defs;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Three categories around 0.5: low at 0, average at 0.5, high at 1. */
function tri(v: number, lo: string, mid: string, hi: string): [string, number][] {
  return v < 0.5
    ? [
        [lo, 1 - 2 * v],
        [mid, 2 * v],
      ]
    : [
        [mid, 2 - 2 * v],
        [hi, 2 * v - 1],
      ];
}

/** MakeHuman age value: 0 = 1 year, 0.1875 = 11, 0.5 = 25, 1 = 90. */
export function ageCategories(a: number): [string, number][] {
  if (a < 0.1875) {
    const t = a / 0.1875;
    return [
      ['baby', 1 - t],
      ['child', t],
    ];
  }
  if (a < 0.5) {
    const t = (a - 0.1875) / 0.3125;
    return [
      ['child', 1 - t],
      ['young', t],
    ];
  }
  const t = (a - 0.5) / 0.5;
  return [
    ['young', 1 - t],
    ['old', t],
  ];
}

export function ageToYears(a: number): number {
  if (a < 0.1875) return 1 + (a / 0.1875) * 10;
  if (a < 0.5) return 11 + ((a - 0.1875) / 0.3125) * 14;
  return 25 + ((a - 0.5) / 0.5) * 65;
}

export function yearsToAge(y: number): number {
  if (y < 11) return clamp01(((y - 1) / 10) * 0.1875);
  if (y < 25) return 0.1875 + ((y - 11) / 14) * 0.3125;
  return clamp01(0.5 + ((y - 25) / 65) * 0.5);
}

export const EXPRESSION_UNITS = [
  'eye-left-closure', 'eye-right-closure', 'eye-left-slit', 'eye-right-slit', 'eye-left-opened-up', 'eye-right-opened-up',
  'eyebrows-left-down', 'eyebrows-right-down', 'eyebrows-left-up', 'eyebrows-right-up', 'eyebrows-left-inner-up', 'eyebrows-right-inner-up', 'eyebrows-left-extern-up', 'eyebrows-right-extern-up',
  'mouth-compression', 'mouth-corner-puller', 'mouth-depression', 'mouth-depression-retraction', 'mouth-elevation', 'mouth-eversion', 'mouth-open', 'mouth-parling', 'mouth-part-later', 'mouth-protusion', 'mouth-pursing', 'mouth-retraction', 'mouth-upward-retraction',
  'neck-platysma', 'nose-compression', 'nose-depression', 'nose-left-dilatation', 'nose-right-dilatation', 'nose-left-elevation', 'nose-right-elevation',
] as const;

/**
 * Target weights for a set of modifier values. Keys: modifier ids (see ModifierDef.id), plus
 * `expr/<unit>` (0…1) for expression units. Missing keys use defaults.
 */
export function targetWeights(assets: MhAssets, defs: ModifierDef[], values: Record<string, number>): Map<string, number> {
  const w = new Map<string, number>();
  const add = (name: string, v: number) => {
    if (Math.abs(v) < 1e-6 || !assets.targetByName.has(name)) return;
    w.set(name, (w.get(name) ?? 0) + v);
  };
  for (const d of defs) {
    if (d.kind === 'macro') continue;
    const v = values[d.id] ?? 0;
    if (d.kind === 'pair') {
      if (v < 0 && d.min) add(d.min, -v);
      else if (v > 0 && d.max) add(d.max, v);
    } else if (d.single) add(d.single, v);
  }

  const mv = (k: MacroVar) => clamp01(values[`macro/${k}`] ?? MACRO_DEFAULTS[k]);
  const gender = mv('Gender');
  const G: [string, number][] = [
    ['female', 1 - gender],
    ['male', gender],
  ];
  const A = ageCategories(mv('Age'));
  const M = tri(mv('Muscle'), 'minmuscle', 'averagemuscle', 'maxmuscle');
  const W = tri(mv('Weight'), 'minweight', 'averageweight', 'maxweight');
  const h = mv('Height');
  const H: [string, number][] = [
    ['minheight', Math.max(0, 1 - 2 * h)],
    ['maxheight', Math.max(0, 2 * h - 1)],
  ];
  const p = mv('BodyProportions');
  const Pr: [string, number][] = [
    ['uncommonproportions', Math.max(0, 1 - 2 * p)],
    ['idealproportions', Math.max(0, 2 * p - 1)],
  ];
  const raw: [string, number][] = [
    ['african', mv('African')],
    ['asian', mv('Asian')],
    ['caucasian', mv('Caucasian')],
  ];
  const rs = raw.reduce((a, [, v]) => a + v, 0) || 1;
  const R = raw.map(([k, v]) => [k, v / rs] as [string, number]);
  const CUP = tri(mv('BreastSize'), 'mincup', 'averagecup', 'maxcup');
  const FIRM = tri(mv('BreastFirmness'), 'minfirmness', 'averagefirmness', 'maxfirmness');

  for (const [g, wg] of G) {
    if (wg <= 0) continue;
    for (const [a, wa] of A) {
      if (wa <= 0) continue;
      for (const [r, wr] of R) add(`macrodetails/${r}-${g}-${a}`, wr * wg * wa);
      for (const [m, wm] of M) {
        for (const [ww, www] of W) {
          const b = wg * wa * wm * www;
          if (b <= 0) continue;
          add(`macrodetails/universal-${g}-${a}-${m}-${ww}`, b);
          for (const [hh, wh] of H) add(`macrodetails/height/${g}-${a}-${m}-${ww}-${hh}`, b * wh);
          for (const [pp, wp] of Pr) add(`macrodetails/proportions/${g}-${a}-${m}-${ww}-${pp}`, b * wp);
          for (const [c, wc] of CUP) for (const [f, wf] of FIRM) add(`breast/${g}-${a}-${m}-${ww}-${c}-${f}`, b * wc * wf);
        }
      }
    }
  }

  // expression units exist per ethnicity; blend them like the ethnic macro
  for (const unit of EXPRESSION_UNITS) {
    const v = values[`expr/${unit}`] ?? 0;
    if (!v) continue;
    for (const [r, wr] of R) add(`expression/units/${r}/${unit}`, v * wr);
  }
  return w;
}

/**
 * Apply target weights to the rest mesh. Returns positions in decimeters (or only the summed
 * displacements when `deltaOnly`).
 */
export function morph(assets: MhAssets, weights: Map<string, number>, out?: Float32Array, deltaOnly = false): Float32Array {
  const P = out ?? new Float32Array(assets.base.length);
  if (deltaOnly) P.fill(0);
  else P.set(assets.base);
  const { tIndex, tDelta } = assets;
  for (const [name, wt] of weights) {
    const t = assets.targetByName.get(name)!;
    const s = t.scale * wt;
    const end = t.offset + t.count;
    for (let e = t.offset; e < end; e++) {
      const v = tIndex[e]! * 3;
      P[v] = P[v]! + tDelta[e * 3]! * s;
      P[v + 1] = P[v + 1]! + tDelta[e * 3 + 1]! * s;
      P[v + 2] = P[v + 2]! + tDelta[e * 3 + 2]! * s;
    }
  }
  return P;
}
