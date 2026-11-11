/**
 * Animatable properties. A property is addressed by a path string:
 *   "position" | "rotation" | "scale" | "visible" | "color"
 *   "camera.focalLength" | "camera.fisheye.fov" | "camera.shake.amount"
 *   "params.<key>" for type parameters marked animatable (e.g. "params.pose", "params.open")
 */
import { getAssetType } from './assetTypes.ts';
import { normalizeColor } from './colors.ts';
import type { EnumField, NumberField } from './fields.ts';
import { isVec3 } from './math.ts';
import type { SceneObject } from './schema.ts';

export type PropKind = 'vec3' | 'number' | 'bool' | 'enum' | 'color';

export interface PropDef {
  path: string;
  kind: PropKind;
  /** continuous = interpolated, step = holds until the next key. */
  interp: 'continuous' | 'step';
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  options?: readonly string[];
}

const BASE: PropDef[] = [
  { path: 'position', kind: 'vec3', interp: 'continuous', label: '位置', unit: 'm' },
  { path: 'rotation', kind: 'vec3', interp: 'continuous', label: '旋轉', unit: '°' },
  { path: 'scale', kind: 'vec3', interp: 'continuous', label: '縮放' },
  { path: 'visible', kind: 'bool', interp: 'step', label: '顯示' },
  { path: 'color', kind: 'color', interp: 'continuous', label: '顏色' },
];

const CAMERA: PropDef[] = [
  { path: 'camera.focalLength', kind: 'number', interp: 'continuous', label: '焦距', unit: 'mm', min: 2, max: 1200 },
  { path: 'camera.fisheye.fov', kind: 'number', interp: 'continuous', label: '魚眼視角', unit: '°', min: 60, max: 360 },
  { path: 'camera.shake.amount', kind: 'number', interp: 'continuous', label: '晃動強度', min: 0, max: 2 },
];

/** All animatable properties for an object. */
export function propDefsFor(obj: Pick<SceneObject, 'type'>): PropDef[] {
  const defs = [...BASE];
  if (obj.type === 'camera') {
    defs.splice(defs.findIndex((d) => d.path === 'scale'), 1);
    defs.push(...CAMERA);
  }
  const asset = getAssetType(obj.type);
  if (asset) {
    for (const f of asset.fields) {
      if (f.kind === 'number' && (f as NumberField).animatable) {
        defs.push({ path: `params.${f.key}`, kind: 'number', interp: 'continuous', label: f.label, unit: f.unit, min: f.min, max: f.max });
      } else if (f.kind === 'enum' && (f as EnumField).animatable) {
        defs.push({ path: `params.${f.key}`, kind: 'enum', interp: 'step', label: f.label, options: f.options.map((o) => o[0]) });
      } else if (f.kind === 'bool' && f.animatable) {
        defs.push({ path: `params.${f.key}`, kind: 'bool', interp: 'step', label: f.label });
      }
    }
  }
  return defs;
}

export function propDef(obj: Pick<SceneObject, 'type'>, path: string): PropDef | undefined {
  return propDefsFor(obj).find((d) => d.path === path);
}

/** Read a (static) value at a dotted path. */
export function getAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Write a value at a dotted path, creating intermediate objects. */
export function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Coerce a raw value into the canonical form for a property; throws a readable Error. */
export function coercePropValue(def: PropDef, raw: unknown): unknown {
  switch (def.kind) {
    case 'vec3': {
      const v = toVec3(raw);
      if (!v) throw new Error(`${def.path} expects [x, y, z] numbers`);
      return v;
    }
    case 'number': {
      const v = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${def.path} expects a number`);
      if (def.min !== undefined && v < def.min) throw new Error(`${def.path} must be >= ${def.min}`);
      if (def.max !== undefined && v > def.max) throw new Error(`${def.path} must be <= ${def.max}`);
      return v;
    }
    case 'bool':
      if (typeof raw !== 'boolean') throw new Error(`${def.path} expects true or false`);
      return raw;
    case 'enum':
      if (typeof raw !== 'string' || !def.options?.includes(raw)) {
        throw new Error(`${def.path} must be one of: ${def.options?.join(', ')}`);
      }
      return raw;
    case 'color': {
      const c = normalizeColor(raw);
      if (!c) throw new Error(`${def.path} expects a color like "#ff8800" or "red"`);
      return c;
    }
  }
}

/** Accept [x,y,z], {x,y,z} or [x,z] (ground point, y = 0). */
export function toVec3(raw: unknown): [number, number, number] | null {
  if (isVec3(raw)) return [raw[0], raw[1], raw[2]];
  if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [raw[0] as number, 0, raw[1] as number];
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const x = o.x ?? 0;
    const y = o.y ?? 0;
    const z = o.z ?? 0;
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && ('x' in o || 'z' in o || 'y' in o)) {
      return [x, y, z];
    }
  }
  return null;
}
