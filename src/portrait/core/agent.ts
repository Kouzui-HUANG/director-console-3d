/**
 * Agent-facing reports, shared by the browser tab and the headless server so both give the same
 * answers: build specs, parameter / preset / trait listings, measurement reports (mm, ratios and
 * z-scores against an average person of the same sex, ethnicity, age and height, with Chinese
 * descriptions), checks and a short description of a portrait.
 */
import { checkPortrait, type CheckIssue } from './checks.ts';
import { describePortraitCommands } from './commands.ts';
import { FRAMING_CUTS } from './framing.ts';
import type { HumanBuilder, HumanMesh, HumanSpec } from './mh/human.ts';
import { MEASURE_LABELS, type Measures } from './mh/measure.ts';
import { PRESETS } from './params/presets.ts';
import { GROUPS, PARAM_BY_KEY, PARAMS, type ParamDef, type ParamGroup } from './params/registry.ts';
import { resolveParams, type ParamValues, type ResolvedParams } from './params/resolve.ts';
import { TRAIT_GROUPS, TRAITS } from './params/traits.ts';
import { FRAMING_LABELS, type FramingType, type Portrait } from './schema.ts';

export function buildSpec(params: ParamValues, o: { framing?: FramingType | null; level?: number; pupils?: boolean } = {}): { resolved: ResolvedParams; spec: HumanSpec } {
  const r = resolveParams(params);
  return {
    resolved: r,
    spec: {
      values: r.values,
      heightCm: r.heightCm,
      headsTall: r.headsTall,
      pose: r.pose,
      gaze: r.gaze,
      brows: r.brows,
      cranium: r.cranium,
      level: o.level ?? 0,
      bust: o.framing ? FRAMING_CUTS[o.framing] : null,
      carveEyes: o.pupils !== false,
    },
  };
}

// ---- listings --------------------------------------------------------------------------------

const paramSpec = (d: ParamDef) => ({
  key: d.key,
  group: d.group,
  label: d.label,
  ...(d.neg ? { low: d.neg, high: d.pos } : {}),
  ...(d.unit ? { unit: d.unit } : {}),
  realistic: d.range,
  limit: d.limit,
  default: d.def,
});

/** Without arguments: every group with its parameters (key, label, range). With group / keys: full specs. */
export function paramList(o: { group?: string; keys?: string[] } = {}) {
  if (o.keys?.length) {
    const unknown = o.keys.filter((k) => !PARAM_BY_KEY.has(k));
    if (unknown.length) throw new Error(`unknown parameter ${unknown.join(', ')}`);
    return o.keys.map((k) => paramSpec(PARAM_BY_KEY.get(k)!));
  }
  if (o.group) {
    if (!GROUPS.some((g) => g.id === o.group)) throw new Error(`unknown group "${o.group}"; groups: ${GROUPS.map((g) => g.id).join(', ')}`);
    return PARAMS.filter((d) => d.group === o.group).map(paramSpec);
  }
  return GROUPS.map((g) => ({
    group: g.id,
    label: g.label,
    params: PARAMS.filter((d) => d.group === g.id).map((d) => `${d.key} ${d.label}${d.neg ? `（${d.neg}↔${d.pos}）` : ''} ${d.range[0]}…${d.range[1]}${d.unit ? ` ${d.unit}` : ''}`),
  }));
}

export function presetList(o: { recipes?: boolean } = {}) {
  return {
    presets: PRESETS.map((p) => ({ id: p.id, label: p.label, params: p.params })),
    traits: TRAIT_GROUPS.map((g) => ({
      group: g.id,
      label: g.label,
      traits: TRAITS.filter((t) => t.group === g.id).map((t) => (o.recipes ? { name: t.name, aliases: t.aliases ?? [], params: t.params } : `${t.name}${t.aliases?.length ? `（${t.aliases.join('、')}）` : ''}`)),
    })),
    framings: Object.entries(FRAMING_LABELS).map(([id, label]) => ({ id, label })),
  };
}

export function commandList(name?: string) {
  const all = describePortraitCommands();
  if (!name) return all.map((c) => `${c.name} — ${c.summary}`).join('\n');
  const c = all.find((x) => x.name === name);
  if (!c) throw new Error(`no command "${name}"; known: ${all.map((x) => x.name).join(', ')}`);
  return c;
}

// ---- measurement report ------------------------------------------------------------------------

/** Typical adult standard deviations (mm unless noted) and how to say "more" / "less". */
const NORMS: Partial<Record<keyof Measures, { sd: number; name: string; pos: string; neg: string }>> = {
  headsTall: { sd: 0.35, name: '頭身比', pos: '偏高（頭顯小）', neg: '偏低（頭顯大）' },
  headWidth: { sd: 5.5, name: '頭', pos: '偏寬', neg: '偏窄' },
  headLength: { sd: 6.5, name: '頭（前後）', pos: '偏長', neg: '偏短' },
  faceHeight: { sd: 6.5, name: '臉', pos: '偏長', neg: '偏短' },
  faceWidth: { sd: 5.5, name: '顴骨間', pos: '偏寬', neg: '偏窄' },
  jawWidth: { sd: 6, name: '下顎', pos: '偏寬', neg: '偏窄' },
  midFace: { sd: 4.5, name: '中庭', pos: '偏長', neg: '偏短' },
  lowerFace: { sd: 5, name: '下庭', pos: '偏長', neg: '偏短' },
  ipd: { sd: 3.5, name: '瞳距', pos: '偏寬', neg: '偏窄' },
  intercanthal: { sd: 2.8, name: '眼距', pos: '偏寬', neg: '偏窄' },
  eyeWidth: { sd: 1.8, name: '眼裂', pos: '偏長', neg: '偏短' },
  eyeOpening: { sd: 1.4, name: '眼睛', pos: '偏圓', neg: '偏細' },
  canthalTilt: { sd: 3, name: '眼尾', pos: '上揚', neg: '下垂' },
  noseWidth: { sd: 2.8, name: '鼻翼', pos: '偏寬', neg: '偏窄' },
  noseHeight: { sd: 4, name: '鼻子', pos: '偏長', neg: '偏短' },
  noseProtrusion: { sd: 2.2, name: '鼻子', pos: '較挺', neg: '較扁' },
  mouthWidth: { sd: 4, name: '嘴', pos: '偏寬', neg: '偏窄' },
  upperLipHeight: { sd: 2.5, name: '人中', pos: '偏長', neg: '偏短' },
  upperLip: { sd: 1.6, name: '上唇', pos: '偏厚', neg: '偏薄' },
  lowerLip: { sd: 1.8, name: '下唇', pos: '偏厚', neg: '偏薄' },
  chinHeight: { sd: 4, name: '下巴', pos: '偏長', neg: '偏短' },
  chinProjection: { sd: 3.5, name: '下巴', pos: '前突', neg: '後縮' },
  earLength: { sd: 4, name: '耳朵', pos: '偏長', neg: '偏短' },
};

export interface MeasureReport {
  /** Rounded measurements (mm; canthalTilt in degrees; headsTall a ratio). */
  measures: Record<string, number>;
  labels: Record<string, string>;
  /** Proportions people use to describe faces. */
  ratios: Record<string, number>;
  /** (value − average person of the same sex / ethnicity / age / height) ÷ typical SD. */
  z: Record<string, number>;
  /** Notable differences from that average, strongest first, e.g. "眼距偏寬（+1.2）". */
  description: string[];
  /** One line about the person: sex, ethnicity, age, height, heads-tall, framing. */
  summary: string;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Average person for comparison: the same base parameters and height, nothing else. */
function referenceParams(params: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(params)) if (PARAM_BY_KEY.get(k)?.group === 'base' || k === 'body.heightCm') out[k] = v;
  return out;
}

export function personSummary(p: Pick<Portrait, 'params' | 'framing'>, m?: Measures): string {
  const get = (k: string) => (p.params[k] as number | undefined) ?? (PARAM_BY_KEY.get(k)!.def as number);
  const sex = get('base.sex');
  const eth = [
    ['東亞', get('base.eastAsian')],
    ['歐美', get('base.european')],
    ['非洲', get('base.african')],
  ] as [string, number][];
  const sum = eth.reduce((a, [, v]) => a + v, 0);
  const ethText = sum <= 0 ? '族群平均混合' : eth.filter(([, v]) => v > 0).map(([n, v]) => (v / sum >= 0.99 ? n : `${n} ${Math.round((v / sum) * 100)}%`)).join('＋');
  const sexText = sex >= 0.9 ? '男性' : sex <= 0.1 ? '女性' : `性別 ${round(sex, 2)}（0 女～1 男）`;
  const parts = [sexText, ethText, `${Math.round(get('base.age'))} 歲`];
  if (m) parts.push(`身高 ${round(m.height / 10)} cm`, `頭身比 ${round(m.headsTall, 2)}`);
  parts.push(FRAMING_LABELS[p.framing.type]);
  return parts.join('・');
}

export function measureReport(builder: HumanBuilder, p: Pick<Portrait, 'params' | 'framing'>): MeasureReport {
  const m = builder.build(buildSpec(p.params).spec).measures;
  const ref = builder.build(buildSpec(referenceParams(p.params)).spec).measures;
  const measures: Record<string, number> = {};
  const labels: Record<string, string> = {};
  for (const k of Object.keys(MEASURE_LABELS) as (keyof Measures)[]) {
    measures[k] = round(m[k], k === 'headsTall' ? 2 : 1);
    labels[k] = MEASURE_LABELS[k];
  }
  const z: Record<string, number> = {};
  const notes: [number, string][] = [];
  for (const [k, n] of Object.entries(NORMS) as [keyof Measures, NonNullable<(typeof NORMS)[keyof Measures]>][]) {
    const zz = (m[k] - ref[k]) / n.sd;
    z[k] = round(zz, 2);
    if (Math.abs(zz) >= 0.7) notes.push([Math.abs(zz), `${n.name}${zz > 0 ? n.pos : n.neg}（${zz > 0 ? '+' : ''}${round(zz, 1)}）`]);
  }
  const ratios = {
    faceWidthToHeight: round(m.faceWidth / m.faceHeight, 2),
    midToLowerFace: round(m.midFace / m.lowerFace, 2),
    eyeWidthToIntercanthal: round(m.eyeWidth / m.intercanthal, 2),
    noseWidthToIntercanthal: round(m.noseWidth / m.intercanthal, 2),
    mouthToNoseWidth: round(m.mouthWidth / m.noseWidth, 2),
    jawToFaceWidth: round(m.jawWidth / m.faceWidth, 2),
  };
  return {
    measures,
    labels,
    ratios,
    z,
    description: notes.sort((a, b) => b[0] - a[0]).map(([, t]) => t),
    summary: personSummary(p, m),
  };
}

export function checkReport(builder: HumanBuilder, p: Pick<Portrait, 'params' | 'framing'>): CheckIssue[] {
  const { resolved, spec } = buildSpec(p.params, { framing: p.framing.type });
  const mesh: HumanMesh = builder.build(spec);
  return checkPortrait(mesh, resolved, p.params);
}

/** Issues present after but not before (by code + message), and how many were fixed. */
export function issueDiff(before: CheckIssue[], after: CheckIssue[]): { new: CheckIssue[]; resolved: number } {
  const key = (i: CheckIssue) => `${i.code}|${i.message}`;
  const was = new Set(before.map(key));
  const now = new Set(after.map(key));
  return { new: after.filter((i) => !was.has(key(i))), resolved: before.filter((i) => !now.has(key(i))).length };
}

/** Compact view of a portrait for agents: the changed parameters with labels (or every value). */
export function portraitView(p: Portrait, o: { resolved?: boolean } = {}) {
  const params = o.resolved
    ? Object.fromEntries(PARAMS.map((d) => [d.key, (p.params[d.key] as number | null | undefined) ?? d.def]))
    : p.params;
  return {
    id: p.id,
    name: p.name,
    preset: p.preset,
    framing: p.framing,
    params,
    changed: Object.keys(p.params).map((k) => ({ key: k, label: PARAM_BY_KEY.get(k)?.label ?? k, value: p.params[k] })),
    notes: p.notes,
    revision: p.revision,
    updatedAt: p.updatedAt,
  };
}

export type { ParamGroup };
