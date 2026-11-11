/**
 * Plain-data parameter descriptions. One description drives three things:
 * the Zod validator, the auto-generated inspector form, and the agent docs.
 */
import { z } from 'zod';
import { ColorSchema } from './schema.ts';

interface FieldBase {
  key: string;
  /** Traditional Chinese UI label. */
  label: string;
  /** Short English name for agents / JSON Schema descriptions. */
  en: string;
  hint?: string;
  advanced?: boolean;
}

export interface NumberField extends FieldBase {
  kind: 'number';
  default: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  int?: boolean;
  /** Can be animated with keyframes (interpolated). */
  animatable?: boolean;
}
export interface EnumField extends FieldBase {
  kind: 'enum';
  default: string;
  options: readonly (readonly [value: string, label: string])[];
  /** Can be animated with keyframes (hold / switch). */
  animatable?: boolean;
}
export interface BoolField extends FieldBase {
  kind: 'bool';
  default: boolean;
  animatable?: boolean;
}
export interface ColorField extends FieldBase {
  kind: 'color';
  default: string;
}
export interface TextField extends FieldBase {
  kind: 'text';
  default: string;
  maxLength?: number;
}
export interface ListField extends FieldBase {
  kind: 'list';
  item: readonly ScalarField[];
  default: Record<string, unknown>[];
  maxItems?: number;
}
export type ScalarField = NumberField | EnumField | BoolField | ColorField | TextField;
export type Field = ScalarField | ListField;

export type Params = Record<string, unknown>;

function describe(f: FieldBase & { unit?: string }): string {
  return `${f.en}${f.unit ? ` (${f.unit})` : ''} — ${f.label}${f.hint ? `. ${f.hint}` : ''}`;
}

function scalarToZod(f: ScalarField): z.ZodType {
  switch (f.kind) {
    case 'number': {
      let s = z.number();
      if (f.int) s = s.int();
      return s.min(f.min).max(f.max).default(f.default).describe(describe(f));
    }
    case 'enum': {
      const values = f.options.map((o) => o[0]) as [string, ...string[]];
      return z.enum(values).default(f.default).describe(describe(f));
    }
    case 'bool':
      return z.boolean().default(f.default).describe(describe(f));
    case 'color':
      return ColorSchema.default(f.default).describe(describe(f));
    case 'text':
      return z
        .string()
        .max(f.maxLength ?? 200)
        .default(f.default)
        .describe(describe(f));
  }
}

export function fieldsToZod(fields: readonly Field[]): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    if (f.kind === 'list') {
      const item = fieldsToZod(f.item);
      const def = f.default;
      shape[f.key] = z
        .array(item)
        .max(f.maxItems ?? 50)
        .default(() => structuredClone(def))
        .describe(describe(f));
    } else {
      shape[f.key] = scalarToZod(f);
    }
  }
  return z.object(shape);
}

export function fieldDefaults(fields: readonly Field[]): Params {
  const out: Params = {};
  for (const f of fields) out[f.key] = structuredClone(f.default);
  return out;
}

/** Default values for one list item. */
export function listItemDefaults(f: ListField): Params {
  return fieldDefaults(f.item);
}

// Small constructors to keep asset definitions compact -------------------------

export const num = (
  key: string,
  label: string,
  en: string,
  def: number,
  min: number,
  max: number,
  opts: Partial<Omit<NumberField, 'kind' | 'key' | 'label' | 'en' | 'default' | 'min' | 'max'>> = {},
): NumberField => ({ kind: 'number', key, label, en, default: def, min, max, step: 0.1, ...opts });

export const int = (
  key: string,
  label: string,
  en: string,
  def: number,
  min: number,
  max: number,
  opts: Partial<Omit<NumberField, 'kind' | 'key' | 'label' | 'en' | 'default' | 'min' | 'max'>> = {},
): NumberField => ({ kind: 'number', key, label, en, default: def, min, max, step: 1, int: true, ...opts });

export const choice = (
  key: string,
  label: string,
  en: string,
  options: readonly (readonly [string, string])[],
  def: string,
  opts: Partial<Omit<EnumField, 'kind' | 'key' | 'label' | 'en' | 'default' | 'options'>> = {},
): EnumField => ({ kind: 'enum', key, label, en, options, default: def, ...opts });

export const bool = (
  key: string,
  label: string,
  en: string,
  def: boolean,
  opts: Partial<Omit<BoolField, 'kind' | 'key' | 'label' | 'en' | 'default'>> = {},
): BoolField => ({ kind: 'bool', key, label, en, default: def, ...opts });

export const color = (key: string, label: string, en: string, def: string): ColorField => ({
  kind: 'color',
  key,
  label,
  en,
  default: def,
});

export const seed = (def = 1): NumberField =>
  int('seed', '亂數種子', 'random seed', def, 0, 99999, { hint: '改變數字可得到不同的隨機排列' });
