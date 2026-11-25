/**
 * The portrait document: one JSON file per portrait (`portraits/<id>.json`, or IndexedDB in
 * browser mode). Only parameters that differ from their defaults are stored, so files stay
 * short and easy to diff. Versioned with migrations; validation messages are written for both
 * people and agents.
 */
import { z } from 'zod';
import { PARAM_BY_KEY, PARAMS } from './params/registry.ts';
import { suggestKeys } from './params/resolve.ts';

export const PORTRAIT_FORMAT = 'director3d.portrait';
export const PORTRAIT_VERSION = 1;
export const PORTRAIT_ID_PATTERN = /^pt_[a-z0-9]{6,16}$/;

export const FRAMINGS = ['head', 'bust', 'half', 'full'] as const;
export type FramingType = (typeof FRAMINGS)[number];
export const FRAMING_LABELS: Record<FramingType, string> = { head: '頭像', bust: '胸像', half: '半身像', full: '全身像' };

export const FramingSchema = z.object({
  type: z.enum(FRAMINGS).default('bust').describe('head | bust | half | full'),
  /** Cut shape (phase 6: flat or classical rounded). */
  cut: z.enum(['flat', 'rounded']).default('flat'),
  /** Pedestal (phase 6). */
  pedestal: z.enum(['none', 'round', 'square', 'socle']).default('none'),
  /** Real statue height for export, mm (null = life size). */
  heightMm: z.number().positive().max(5000).nullable().default(null),
});
export type Framing = z.output<typeof FramingSchema>;

export const ReferenceSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  note: z.string().default(''),
  /** 35 mm-equivalent focal length from the photo's EXIF (null = unknown). */
  focal35: z.number().positive().max(2000).nullable().default(null),
});

export const PortraitSchema = z.object({
  $schema: z.string().optional(),
  format: z.literal(PORTRAIT_FORMAT),
  version: z.number().int().min(1),
  id: z.string().regex(PORTRAIT_ID_PATTERN, 'id must look like "pt_k3v9x2ab"'),
  name: z.string().min(1).max(120),
  /** Preset the portrait started from (informational). */
  preset: z.string().nullable().default(null),
  /** Semantic parameters that differ from their defaults (see core/params/registry.ts). */
  params: z.record(z.string(), z.number().nullable()).default({}),
  framing: FramingSchema.default({ type: 'bust', cut: 'flat', pedestal: 'none', heightMm: null }),
  references: z.array(ReferenceSchema).default([]),
  notes: z.string().default(''),
  revision: z.number().int().min(0).default(0),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Portrait = z.output<typeof PortraitSchema>;

/** Parameter keys renamed in later versions: old → new (applied when loading). */
const RENAMED_PARAMS: Record<string, string> = {};

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface PortraitValidation {
  ok: boolean;
  portrait?: Portrait;
  errors: ValidationIssue[];
  warnings: string[];
}

/** Validate (and migrate) a raw portrait document. Unknown parameters are dropped with a warning. */
export function validatePortrait(raw: unknown): PortraitValidation {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: [{ path: '(root)', message: 'a portrait must be a JSON object' }], warnings };
  const input = { ...(raw as Record<string, unknown>) };
  if (typeof input.version === 'number' && input.version > PORTRAIT_VERSION) {
    return { ok: false, errors: [{ path: 'version', message: `version ${input.version} is newer than this app supports (${PORTRAIT_VERSION})` }], warnings };
  }
  if (input.params && typeof input.params === 'object' && !Array.isArray(input.params)) {
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.params as Record<string, unknown>)) params[RENAMED_PARAMS[k] ?? k] = v;
    input.params = params;
  }
  const parsed = PortraitSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message })),
      warnings,
    };
  }
  const p = parsed.data;
  p.version = PORTRAIT_VERSION;
  const params: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(p.params)) {
    const def = PARAM_BY_KEY.get(key);
    if (!def) {
      warnings.push(`params.${key}: 沒有這個參數，已忽略（相近：${suggestKeys(key).join('、')}）`);
      continue;
    }
    if (value === null) {
      if (def.def !== null) warnings.push(`params.${key}: null 只用在可自動的參數，已改回預設`);
      continue; // null = automatic = not stored
    }
    if (value < def.limit[0] || value > def.limit[1]) {
      const v = Math.min(def.limit[1], Math.max(def.limit[0], value));
      warnings.push(`params.${key}: ${value} 超出可用範圍 ${def.limit[0]}～${def.limit[1]}，已限制為 ${v}`);
      params[key] = v;
      continue;
    }
    if (value === def.def) continue;
    params[key] = value;
  }
  p.params = params;
  return { ok: true, portrait: p, errors: [], warnings };
}

const ORDER = new Map(PARAMS.map((d, i) => [d.key, i]));

/** Parameters in registry order (stable files, readable diffs). */
export function sortParams(params: Record<string, number | null>): Record<string, number | null> {
  return Object.fromEntries(Object.entries(params).sort(([a], [b]) => (ORDER.get(a) ?? 1e9) - (ORDER.get(b) ?? 1e9) || a.localeCompare(b)));
}

export function serializePortrait(p: Portrait, opts: { schemaRef?: string } = {}): string {
  const out = {
    ...(opts.schemaRef ? { $schema: opts.schemaRef } : {}),
    format: PORTRAIT_FORMAT,
    version: PORTRAIT_VERSION,
    id: p.id,
    name: p.name,
    preset: p.preset,
    params: sortParams(p.params),
    framing: p.framing,
    references: p.references,
    notes: p.notes,
    revision: p.revision,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  return JSON.stringify(out, null, 2);
}

export function randomPortraitId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `pt_${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10)}`;
}

export function newPortrait(o: { name?: string; preset?: string | null; params?: Record<string, number | null>; framing?: Partial<Framing> } = {}): Portrait {
  const now = new Date().toISOString();
  return {
    format: PORTRAIT_FORMAT,
    version: PORTRAIT_VERSION,
    id: randomPortraitId(),
    name: o.name?.trim() || '未命名人像',
    preset: o.preset ?? null,
    params: { ...(o.params ?? {}) },
    framing: { type: 'bust', cut: 'flat', pedestal: 'none', heightMm: null, ...(o.framing ?? {}) },
    references: [],
    notes: '',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function clonePortrait(p: Portrait, name?: string): Portrait {
  const now = new Date().toISOString();
  return { ...structuredClone(p), id: randomPortraitId(), name: name ?? `${p.name}（副本）`, revision: 0, createdAt: now, updatedAt: now };
}

/** JSON Schema of the document (written to schema/portrait.schema.json by the server). */
export function portraitJsonSchema(): unknown {
  return { $id: 'director3d.portrait.schema.json', title: '人像工作室 portrait', ...(z.toJSONSchema(PortraitSchema, { io: 'input', target: 'draft-07', unrepresentable: 'any' }) as object) };
}
