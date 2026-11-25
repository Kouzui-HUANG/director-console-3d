/** Semantic parameter registry, resolution and plausibility checks. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPortrait } from '../../src/portrait/core/checks.ts';
import { parseAssets, type MhAssets } from '../../src/portrait/core/mh/assets.ts';
import { HumanBuilder } from '../../src/portrait/core/mh/human.ts';
import { EXPRESSION_UNITS } from '../../src/portrait/core/mh/modifiers.ts';
import { PRESETS } from '../../src/portrait/core/params/presets.ts';
import { GROUPS, PARAMS, expandSides } from '../../src/portrait/core/params/registry.ts';
import { resolveParams, suggestKeys, type ParamValues } from '../../src/portrait/core/params/resolve.ts';

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'portrait', 'mh');
const HAVE = existsSync(path.join(DIR, 'mh.json')) && existsSync(path.join(DIR, 'weights.bin'));

function load(): MhAssets {
  const buf = (f: string) => {
    const b = readFileSync(path.join(DIR, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  return parseAssets(JSON.parse(readFileSync(path.join(DIR, 'mh.json'), 'utf8')), buf('base.bin'), buf('targets.bin'), buf('weights.bin'));
}

describe('parameter registry', () => {
  it('has unique keys, known groups, labels and sane ranges', () => {
    const keys = new Set<string>();
    const groups = new Set(GROUPS.map((g) => g.id));
    expect(PARAMS.length).toBeGreaterThan(140);
    for (const d of PARAMS) {
      expect(keys.has(d.key)).toBe(false);
      keys.add(d.key);
      expect(groups.has(d.group)).toBe(true);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.range[0]).toBeLessThan(d.range[1]);
      expect(d.limit[0]).toBeLessThanOrEqual(d.range[0]);
      expect(d.limit[1]).toBeGreaterThanOrEqual(d.range[1]);
      if (d.def !== null) {
        expect(d.def).toBeGreaterThanOrEqual(d.range[0]);
        expect(d.def).toBeLessThanOrEqual(d.range[1]);
      }
      expect(Number(!!d.mh) + Number(!!d.expr) + Number(!!d.macro || !!d.special) + Number(!!d.pose) + Number(!!d.brow)).toBeGreaterThanOrEqual(1);
    }
  });

  it('only uses existing expression units', () => {
    for (const d of PARAMS) for (const u of Object.keys(d.expr ?? {})) expect(EXPRESSION_UNITS).toContain(u);
  });

  it('resolves symmetric pairs, sums contributions and normalizes ethnicity', () => {
    const r = resolveParams({ 'face.eyes.size': 0.5, 'asym.eyes.size': 1 });
    expect(r.values['eyes/l-eye-scale-decr|incr']).toBeCloseTo(1);
    expect(r.values['eyes/r-eye-scale-decr|incr']).toBeCloseTo(0);
    expect(r.values['macro/Asian']).toBeCloseTo(1 / 3);
    const e = resolveParams({ 'base.eastAsian': 0.6, 'base.european': 0.2 });
    expect(e.values['macro/Asian']).toBeCloseTo(0.75);
    expect(e.values['macro/African']).toBeCloseTo(0);
    const w = resolveParams({ 'face.jaw.width': -1 });
    expect(w.values['head/head-invertedtriangular']).toBeCloseTo(0.8);
    expect(w.values['head/head-square']).toBeUndefined();
    expect(resolveParams({}).pose.armAngle).toBe(10); // relaxed arms by default
  });

  it('reports unknown keys with suggestions, clamps and flags exaggeration', () => {
    const r = resolveParams({ 'face.nose.widht': 1, 'face.eyes.size': 3, 'face.eyes.tilt': 1.4, 'body.heightCm': null, 'base.age': 'old' as unknown as number });
    const codes = Object.fromEntries(r.issues.map((i) => [i.key, i.code]));
    expect(codes['face.nose.widht']).toBe('UNKNOWN_PARAM');
    expect(r.issues.find((i) => i.key === 'face.nose.widht')!.hint).toContain('face.nose.width');
    expect(codes['face.eyes.size']).toBe('OUT_OF_LIMIT');
    expect(r.values['eyes/l-eye-scale-decr|incr']).toBeCloseTo(2);
    expect(codes['face.eyes.tilt']).toBe('EXAGGERATED');
    expect(codes['base.age']).toBe('NOT_A_NUMBER');
    expect(codes['body.heightCm']).toBeUndefined();
    expect(r.heightCm).toBeNull();
    expect(suggestKeys('nose width')[0]).toMatch(/nose/);
  });

  it('presets only use known keys', () => {
    for (const p of PRESETS) expect(resolveParams(p.params).issues.filter((i) => i.level !== 'note')).toEqual([]);
  });
});

describe.skipIf(!HAVE)('parameters on the mesh', () => {
  const A = HAVE ? load() : (null as unknown as MhAssets);
  const hb = HAVE ? new HumanBuilder(A) : (null as unknown as HumanBuilder);
  const build = (params: ParamValues, level = 0) => {
    const r = resolveParams(params);
    return { r, m: hb.build({ values: r.values, heightCm: r.heightCm, headsTall: r.headsTall, pose: r.pose, gaze: r.gaze, brows: r.brows, cranium: r.cranium, level }) };
  };

  it('maps every MakeHuman modifier id that exists', () => {
    const ids = new Set(hb.modifiers.map((d) => d.id));
    for (const d of PARAMS) for (const pattern of Object.keys(d.mh ?? {})) for (const id of expandSides(pattern)) expect(ids.has(id), `${d.key} → ${id}`).toBe(true);
  });

  it('every parameter changes the mesh at the ends of its realistic range', () => {
    const base0 = build({ 'base.sex': 0.5 }).m.positions;
    // the brow relief needs the fine mesh (about 1 mm) to show its shape
    const base2 = build({ 'base.sex': 0.5 }, 2).m.positions;
    const quiet: string[] = [];
    for (const d of PARAMS) {
      if (d.special === 'ethnic' && d.key !== 'base.european') continue; // the mix is relative
      if (d.key === 'face.brow.texture') continue; // brow strands are engraved by the renderer (shading only)
      const value = d.def === null ? d.range[1] : Math.abs(d.range[1] - (d.def ?? 0)) >= Math.abs(d.range[0] - (d.def ?? 0)) ? d.range[1] : d.range[0];
      const level = d.brow ? 2 : 0;
      const base = level ? base2 : base0;
      const { m } = build({ 'base.sex': 0.5, [d.key]: value }, level);
      let moved = 0;
      const n = Math.min(base.length, m.positions.length);
      for (let i = 0; i < n; i++) moved = Math.max(moved, Math.abs(m.positions[i]! - base[i]!));
      expect(m.positions.every(Number.isFinite)).toBe(true);
      if (moved < 0.2) quiet.push(`${d.key} (${moved.toFixed(3)} mm)`);
    }
    expect(quiet).toEqual([]);
  });

  it('checks flag crossed eyelids, extreme heads-tall and solver limits', () => {
    const shut = build({ 'face.eyes.opening': -2, 'face.eyes.size': -2 });
    expect(shut.m.measures.eyeOpening).toBeLessThan(4);
    const codes = checkPortrait(shut.m, shut.r, { 'face.eyes.opening': -2, 'face.eyes.size': -2 }).map((i) => i.code);
    expect(codes.some((c) => c === 'EYELIDS_CROSS' || c === 'EYES_CLOSED')).toBe(true);
    const open = build({ 'expr.mouthOpen': 1 });
    expect(open.m.measures.lipGap).toBeGreaterThan(5);
    const chibi = build({ 'body.headsTall': 4.5 });
    expect(checkPortrait(chibi.m, chibi.r, { 'body.headsTall': 4.5 }).map((i) => i.code)).toContain('HEADS_TALL');
    const tiny = build({ 'base.sex': 1, 'body.heightCm': 110 });
    expect(tiny.m.solve.heightMacro).toBe(0);
    expect(checkPortrait(tiny.m, tiny.r, {}).map((i) => i.code)).toContain('HEIGHT_SCALED');
    const plain = build(PRESETS.find((p) => p.id === 'female-european')!.params);
    expect(checkPortrait(plain.m, plain.r, plain.r.values).filter((i) => i.level !== 'note')).toEqual([]);
  });
});
