/**
 * Portrait commands. Every change to a portrait — from the UI, window.portrait, HTTP or MCP — is
 * a JSON command `{cmd, args}`. A list is atomic (all or nothing) and one undo step; when it
 * fails, every command is re-checked so all problems are reported at once. Error format matches
 * the director: {index, cmd, code, message, hint}.
 */
import { enablePatches, produce, produceWithPatches, type Patch } from 'immer';
import { z } from 'zod';
import { CommandError } from '../../core/commands/types.ts';
import { PRESET_BY_ID, PRESETS } from './params/presets.ts';
import { GROUPS, PARAM_BY_KEY, PARAMS, type ParamGroup } from './params/registry.ts';
import { suggestKeys } from './params/resolve.ts';
import { findTrait, suggestTraits, traitValues } from './params/traits.ts';
import { FRAMINGS, type Portrait } from './schema.ts';

enablePatches();

export { CommandError };

export interface PortraitCommandCall {
  cmd: string;
  args?: Record<string, unknown>;
}

export interface PortraitCommandFailure {
  index: number;
  cmd: string;
  code: string;
  message: string;
  hint?: string;
}

interface Ctx {
  draft: Portrait;
  warn(message: string): void;
}

interface Def<S extends z.ZodType = z.ZodType> {
  name: string;
  summary: string;
  label: string;
  args: S;
  examples: unknown[];
  apply(ctx: Ctx, args: z.output<S>): unknown;
}

const define = <S extends z.ZodType>(d: Def<S>): Def => d as unknown as Def;

const GROUP_IDS = new Set<string>(GROUPS.map((g) => g.id));
const ParamValuesIn = z.record(z.string(), z.number().nullable()).describe('{"face.eyes.spacing": 0.8, "body.heightCm": 168}; null clears / makes automatic');
const GroupsIn = z.array(z.string()).optional().describe(`only these parameter groups: ${GROUPS.map((g) => g.id).join(', ')}`);

function checkGroups(groups: string[] | undefined): ParamGroup[] | null {
  if (!groups) return null;
  for (const g of groups) if (!GROUP_IDS.has(g)) throw new CommandError('UNKNOWN_GROUP', `沒有這個參數群組：${g}`, `可用的群組：${[...GROUP_IDS].join(', ')}`);
  return groups as ParamGroup[];
}

function inGroups(key: string, groups: ParamGroup[] | null): boolean {
  return !groups || groups.includes(PARAM_BY_KEY.get(key)!.group);
}

/** Set one parameter on the draft: validated, clamped, defaults removed. */
function setParam(ctx: Ctx, key: string, value: number | null) {
  const d = PARAM_BY_KEY.get(key);
  if (!d) throw new CommandError('UNKNOWN_PARAM', `沒有這個參數：${key}`, `相近的參數：${suggestKeys(key).join('、')}（portrait_list_params 可列出全部）`);
  if (value === null) {
    delete ctx.draft.params[key];
    return;
  }
  if (!Number.isFinite(value)) throw new CommandError('NOT_A_NUMBER', `${key} 必須是數字`);
  let v = value;
  if (v < d.limit[0] || v > d.limit[1]) {
    v = Math.min(d.limit[1], Math.max(d.limit[0], v));
    ctx.warn(`${key}（${d.label}）= ${value} 超出可用範圍 ${d.limit[0]}～${d.limit[1]}，已限制為 ${v}`);
  } else if (v < d.range[0] || v > d.range[1]) {
    ctx.warn(`${key}（${d.label}）= ${v} 超出寫實範圍 ${d.range[0]}～${d.range[1]}（誇張）`);
  }
  v = Math.round(v * 10000) / 10000;
  if (v === d.def) delete ctx.draft.params[key];
  else ctx.draft.params[key] = v;
}

function presetParams(id: string): Record<string, number | null> {
  const p = PRESET_BY_ID.get(id);
  if (!p) throw new CommandError('UNKNOWN_PRESET', `沒有這個預設：${id}`, `可用的預設：${PRESETS.map((x) => `${x.id}（${x.label}）`).join('、')}`);
  return p.params;
}

/** Replace the parameters (all, or only those in some groups) with a new set. */
function replaceParams(ctx: Ctx, next: Record<string, number | null>, groups: ParamGroup[] | null) {
  for (const key of Object.keys(ctx.draft.params)) if (inGroups(key, groups)) delete ctx.draft.params[key];
  for (const [key, v] of Object.entries(next)) {
    if (!PARAM_BY_KEY.has(key)) throw new CommandError('UNKNOWN_PARAM', `沒有這個參數：${key}`, `相近的參數：${suggestKeys(key).join('、')}`);
    if (inGroups(key, groups)) setParam(ctx, key, v);
  }
}

/** Small deterministic PRNG (mulberry32) and a normal sample from it. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()) };
}

const FACE_GROUPS: ParamGroup[] = ['head', 'brow', 'eyes', 'nose', 'mouth', 'cheek', 'chin', 'ears'];

const COMMANDS: Def[] = [
  define({
    name: 'portrait.set',
    summary: 'Set semantic parameters (null clears one / makes an automatic one automatic again). Out-of-limit values are clamped with a warning.',
    label: '調整參數',
    args: z.object({ params: ParamValuesIn }),
    examples: [{ params: { 'face.eyes.spacing': 0.6, 'face.nose.bridgeHeight': 0.4 } }, { params: { 'body.heightCm': 168, 'body.headsTall': 7 } }],
    apply(ctx, a) {
      for (const [k, v] of Object.entries(a.params)) setParam(ctx, k, v);
      return { changed: Object.keys(a.params) };
    },
  }),
  define({
    name: 'portrait.reset',
    summary: 'Reset parameters to defaults: given keys, whole groups, or everything when both are omitted.',
    label: '重設參數',
    args: z.object({ keys: z.array(z.string()).optional(), groups: GroupsIn }),
    examples: [{ keys: ['face.eyes.size'] }, { groups: ['nose', 'mouth'] }, {}],
    apply(ctx, a) {
      const groups = checkGroups(a.groups);
      const keys = a.keys ?? [];
      for (const k of keys) if (!PARAM_BY_KEY.has(k)) throw new CommandError('UNKNOWN_PARAM', `沒有這個參數：${k}`, `相近的參數：${suggestKeys(k).join('、')}`);
      const removed: string[] = [];
      for (const k of Object.keys(ctx.draft.params)) {
        const hit = keys.length || groups ? keys.includes(k) || (groups ? inGroups(k, groups) : false) : true;
        if (hit) {
          delete ctx.draft.params[k];
          removed.push(k);
        }
      }
      return { removed };
    },
  }),
  define({
    name: 'portrait.applyPreset',
    summary: 'Apply a built-in preset (or a parameter set from a file) — everything, or only some groups (e.g. take the face, keep the body).',
    label: '套用預設',
    args: z.object({ preset: z.string().optional().describe('preset id, e.g. "female-eastAsian"'), params: ParamValuesIn.optional(), groups: GroupsIn }),
    examples: [{ preset: 'female-eastAsian' }, { preset: 'male-european', groups: ['body'] }, { params: { 'base.sex': 0, 'face.eyes.size': 0.4 }, groups: ['eyes'] }],
    apply(ctx, a) {
      if (!a.preset === !a.params) throw new CommandError('INVALID_ARGS', 'give either "preset" or "params"', 'Example: {"preset": "female-eastAsian"}');
      const groups = checkGroups(a.groups);
      replaceParams(ctx, a.preset ? presetParams(a.preset) : a.params!, groups);
      if (a.preset && !groups) ctx.draft.preset = a.preset;
      return { preset: a.preset ?? null };
    },
  }),
  define({
    name: 'portrait.applyTraits',
    summary: 'Apply descriptive traits (e.g. "丹鳳眼", "高鼻樑", "鵝蛋臉"). amount scales the recipes (1 = as written). mode "set" (default) sets those parameters; "add" adds to the current values.',
    label: '套用特徵詞',
    args: z.object({ traits: z.array(z.string()).min(1), amount: z.number().min(0).max(1.5).default(1), mode: z.enum(['set', 'add']).default('set') }),
    examples: [{ traits: ['鵝蛋臉', '丹鳳眼', '高鼻樑', '薄唇'] }, { traits: ['圓臉'], amount: 0.5 }],
    apply(ctx, a) {
      const applied: Record<string, number> = {};
      for (const name of a.traits) {
        const t = findTrait(name);
        if (!t) throw new CommandError('UNKNOWN_TRAIT', `沒有這個特徵詞：${name}`, `相近的特徵詞：${suggestTraits(name).join('、') || '（無）'}；portrait_list_presets 可列出全部`);
        for (const [k, v] of Object.entries(traitValues(t, a.amount))) {
          const def = PARAM_BY_KEY.get(k)!.def ?? 0;
          // set: the later trait wins; add: contributions stack on the current value
          applied[k] = a.mode === 'add' ? (applied[k] ?? (ctx.draft.params[k] as number | undefined) ?? def) + (v - def) : v;
        }
      }
      for (const [k, v] of Object.entries(applied)) setParam(ctx, k, v);
      return { params: applied };
    },
  }),
  define({
    name: 'portrait.mix',
    summary: 'Blend several parameter sets by weight (presets or explicit params; missing parameters count as defaults). Optionally only some groups.',
    label: '混合參數',
    args: z.object({
      sources: z.array(z.object({ preset: z.string().optional(), params: ParamValuesIn.optional(), weight: z.number().min(0) })).min(2),
      groups: GroupsIn,
    }),
    examples: [{ sources: [{ preset: 'female-eastAsian', weight: 0.6 }, { preset: 'female-european', weight: 0.4 }], groups: ['head', 'eyes', 'nose', 'mouth'] }],
    apply(ctx, a) {
      const groups = checkGroups(a.groups);
      const total = a.sources.reduce((s, x) => s + x.weight, 0);
      if (total <= 0) throw new CommandError('INVALID_ARGS', 'the weights must not all be 0');
      const sets = a.sources.map((s) => {
        if (!s.preset === !s.params) throw new CommandError('INVALID_ARGS', 'each source needs either "preset" or "params"');
        return { values: s.preset ? presetParams(s.preset) : s.params!, w: s.weight / total };
      });
      const out: Record<string, number | null> = {};
      for (const d of PARAMS) {
        if (!inGroups(d.key, groups)) continue;
        if (d.def === null) {
          // absolute values mix only when every source gives one
          const vs = sets.map((s) => s.values[d.key]);
          if (vs.every((v) => typeof v === 'number')) out[d.key] = sets.reduce((acc, s) => acc + (s.values[d.key] as number) * s.w, 0);
          continue;
        }
        const v = sets.reduce((acc, s) => acc + ((s.values[d.key] as number | undefined) ?? d.def!) * s.w, 0);
        if (Math.abs(v - d.def) > 1e-6) out[d.key] = v;
      }
      replaceParams(ctx, out, groups);
      return { params: out };
    },
  }),
  define({
    name: 'portrait.update',
    summary: 'Change the name, notes or framing (type head|bust|half|full; cut, pedestal and real statue height are used by later phases).',
    label: '更新人像資料',
    args: z.object({
      name: z.string().min(1).max(120).optional(),
      notes: z.string().max(20000).optional(),
      framing: z
        .object({ type: z.enum(FRAMINGS).optional(), cut: z.enum(['flat', 'rounded']).optional(), pedestal: z.enum(['none', 'round', 'square', 'socle']).optional(), heightMm: z.number().positive().max(5000).nullable().optional() })
        .optional(),
    }),
    examples: [{ name: '林小姐・胸像' }, { framing: { type: 'head' } }],
    apply(ctx, a) {
      if (a.name !== undefined) ctx.draft.name = a.name.trim();
      if (a.notes !== undefined) ctx.draft.notes = a.notes;
      if (a.framing) for (const [k, v] of Object.entries(a.framing)) if (v !== undefined) (ctx.draft.framing as Record<string, unknown>)[k] = v;
      return {};
    },
  }),
  define({
    name: 'portrait.addReference',
    summary: 'Record a reference photo already stored with the portrait (the studio and portrait_add_reference store the image and call this).',
    label: '加入參考照片',
    args: z.object({ id: z.string().regex(/^ref[a-z0-9]{1,16}$/).optional(), file: z.string().min(1).max(200), note: z.string().max(500).default(''), focal35: z.number().positive().max(2000).nullable().default(null) }),
    examples: [{ id: 'refk3v9x2', file: 'refs/pt_k3v9x2ab/refk3v9x2.jpg', note: '正面，微笑' }],
    apply(ctx, a) {
      const id = a.id ?? `ref${Date.now().toString(36)}`;
      if (ctx.draft.references.some((r) => r.id === id)) throw new CommandError('DUPLICATE_ID', `參考照片 ${id} 已經存在`);
      ctx.draft.references.push({ id, file: a.file, note: a.note, focal35: a.focal35 });
      return { id };
    },
  }),
  define({
    name: 'portrait.removeReference',
    summary: 'Remove a reference photo from the portrait (the image file is kept, so undo brings it back).',
    label: '移除參考照片',
    args: z.object({ id: z.string() }),
    examples: [{ id: 'refk3v9x2' }],
    apply(ctx, a) {
      const i = ctx.draft.references.findIndex((r) => r.id === a.id);
      if (i < 0) throw new CommandError('NOT_FOUND', `沒有參考照片 ${a.id}`, `現有的：${ctx.draft.references.map((r) => r.id).join('、') || '（無）'}`);
      ctx.draft.references.splice(i, 1);
      return { removed: a.id };
    },
  }),
  define({
    name: 'portrait.updateReference',
    summary: 'Change the note of a reference photo, or its 35 mm-equivalent focal length (null = unknown; helps the fit when the photo has no EXIF).',
    label: '更新參考照片',
    args: z.object({ id: z.string(), note: z.string().max(500).optional(), focal35: z.number().min(8).max(1200).nullable().optional() }),
    examples: [{ id: 'refk3v9x2', note: '3/4 側，自然光' }, { id: 'refk3v9x2', focal35: 26 }],
    apply(ctx, a) {
      const r = ctx.draft.references.find((x) => x.id === a.id);
      if (!r) throw new CommandError('NOT_FOUND', `沒有參考照片 ${a.id}`, `現有的：${ctx.draft.references.map((x) => x.id).join('、') || '（無）'}`);
      if (a.note !== undefined) r.note = a.note;
      if (a.focal35 !== undefined) r.focal35 = a.focal35;
      return {};
    },
  }),
  define({
    name: 'portrait.neutralize',
    summary: 'Remove the expression (all expr.* parameters), keeping the likeness.',
    label: '表情歸零',
    args: z.object({}),
    examples: [{}],
    apply(ctx) {
      const removed = Object.keys(ctx.draft.params).filter((k) => k.startsWith('expr.'));
      for (const k of removed) delete ctx.draft.params[k];
      return { removed };
    },
  }),
  define({
    name: 'portrait.randomize',
    summary: 'Randomize local shape parameters (deterministic per seed) for inspiration or tests. Default: the face groups; amount 0.5 keeps faces plausible.',
    label: '隨機變化',
    args: z.object({ seed: z.number().int().optional(), amount: z.number().min(0).max(1.5).default(0.5), groups: GroupsIn }),
    examples: [{ seed: 7 }, { seed: 3, amount: 0.8, groups: ['nose', 'mouth'] }],
    apply(ctx, a) {
      const groups = checkGroups(a.groups) ?? FACE_GROUPS;
      const seed = a.seed ?? Math.floor(Math.random() * 1e9);
      const r = rng(seed);
      const changed: string[] = [];
      for (const d of PARAMS) {
        if (!groups.includes(d.group) || d.def === null) continue;
        // MakeHuman shape modifiers and the eyebrow shape (not its relief or strands)
        if (!d.mh && !(d.brow && d.range[0] === -1)) continue;
        const span = d.range[0] === 0 ? d.range[1] : (d.range[1] - d.range[0]) / 2;
        // centred parameters: normal around 0; one-sided ones (0…1): mostly small
        const v = d.range[0] < 0 ? r.normal() * 0.35 * a.amount * span : Math.max(0, r.normal() * 0.25 * a.amount * span);
        setParam(ctx, d.key, Math.min(d.range[1], Math.max(d.range[0], v)));
        changed.push(d.key);
      }
      return { seed, changed };
    },
  }),
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

export const PORTRAIT_HISTORY_COMMANDS = [
  { name: 'history.undo', summary: 'Undo the last change (or N with {steps}).', label: '復原' },
  { name: 'history.redo', summary: 'Redo (or N steps with {steps}).', label: '重做' },
] as const;

export function getPortraitCommand(name: string) {
  return BY_NAME.get(name);
}

function suggestCommand(name: string): string {
  const all = [...COMMANDS.map((c) => c.name), ...PORTRAIT_HISTORY_COMMANDS.map((h) => h.name)];
  const tail = name.split('.').pop()!.toLowerCase();
  const hit = all.find((c) => c.toLowerCase().endsWith(tail)) ?? all.find((c) => c.toLowerCase().includes(tail.slice(0, 4)));
  return hit ? `Did you mean "${hit}"? Commands: ${all.join(', ')}` : `Commands: ${all.join(', ')}`;
}

export interface PortraitCommandInfo {
  name: string;
  summary: string;
  label: string;
  args: unknown;
  examples: unknown[];
}

/** JSON-Schema descriptions of every command (for agents / MCP). */
export function describePortraitCommands(): PortraitCommandInfo[] {
  const schema = (s: z.ZodType) => {
    try {
      return z.toJSONSchema(s, { io: 'input', target: 'draft-07', unrepresentable: 'any' });
    } catch {
      return { type: 'object' };
    }
  };
  return [
    ...COMMANDS.map((c) => ({ name: c.name, summary: c.summary, label: c.label, args: schema(c.args), examples: c.examples })),
    ...PORTRAIT_HISTORY_COMMANDS.map((h) => ({ name: h.name, summary: h.summary, label: h.label, args: { type: 'object', properties: { steps: { type: 'integer', minimum: 1 } } }, examples: [{}] })),
  ];
}

export type PortraitRunResult =
  | { ok: true; results: unknown[]; warnings: string[]; portrait: Portrait; patches: Patch[]; inverse: Patch[]; mutated: boolean }
  | { ok: false; error: PortraitCommandFailure; errors: PortraitCommandFailure[]; warnings: string[] };

function exec(draft: Portrait, call: PortraitCommandCall | undefined, index: number, multi: boolean, warnings: string[]): { cmd: string; result: unknown } {
  if (!call || typeof call !== 'object' || typeof call.cmd !== 'string') throw new CommandError('INVALID_CALL', 'each command must look like {"cmd": "portrait.set", "args": {...}}');
  if (call.cmd.startsWith('history.')) throw new CommandError('INVALID_CALL', `${call.cmd} cannot be mixed with other commands in one batch`, 'Send history.undo / history.redo on their own.');
  const def = BY_NAME.get(call.cmd);
  if (!def) throw new CommandError('UNKNOWN_COMMAND', `unknown command "${call.cmd}"`, suggestCommand(call.cmd));
  const parsed = def.args.safeParse(call.args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.path.length ? `${issue.path.map(String).join('.')}: ` : '';
    throw new CommandError('INVALID_ARGS', `${call.cmd}: ${path}${issue.message}`, `Example: ${JSON.stringify({ cmd: def.name, args: def.examples[0] ?? {} })}`);
  }
  const ctx: Ctx = { draft, warn: (m) => warnings.push(multi ? `[${index}] ${m}` : m) };
  return { cmd: call.cmd, result: def.apply(ctx, parsed.data) ?? {} };
}

function failure(e: unknown, index: number, cmd: string): PortraitCommandFailure {
  if (e instanceof CommandError) return { index, cmd, code: e.code, message: e.message, hint: e.hint };
  return { index, cmd, code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

/** Run a batch atomically. */
export function runPortraitCommands(portrait: Portrait, calls: PortraitCommandCall[]): PortraitRunResult {
  const warnings: string[] = [];
  const results: unknown[] = [];
  if (!Array.isArray(calls)) {
    const error = failure(new CommandError('INVALID_CALL', 'expected an array of {"cmd": "...", "args": {...}}'), -1, '');
    return { ok: false, error, errors: [error], warnings };
  }
  let index = -1;
  let cmd = '';
  try {
    const [next, patches, inverse] = produceWithPatches(portrait, (draft) => {
      for (let i = 0; i < calls.length; i++) {
        index = i;
        cmd = String(calls[i]?.cmd ?? '');
        results.push(exec(draft as Portrait, calls[i], i, calls.length > 1, warnings).result);
      }
    });
    return { ok: true, results, warnings, portrait: next, patches, inverse, mutated: patches.length > 0 };
  } catch (e) {
    const error = failure(e, index, cmd);
    const errors = [error];
    if (calls.length > 1) {
      // re-check the rest one by one so every problem shows up
      let state = portrait;
      for (let i = 0; i < calls.length; i++) {
        if (i === index) continue;
        try {
          state = produce(state, (draft) => void exec(draft as Portrait, calls[i], i, true, []));
        } catch (e2) {
          if (i > index) errors.push(failure(e2, i, String(calls[i]?.cmd ?? '')));
        }
      }
    }
    return { ok: false, error, errors, warnings };
  }
}
