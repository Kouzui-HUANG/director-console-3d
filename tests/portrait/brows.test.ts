/**
 * Sculpted eyebrows (core/mh/brows.ts): the relief on the skin, its parameters, and the brow
 * landmarks of photo fitting. Needs the converted MakeHuman data; skipped without it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../../src/portrait/core/agent.ts';
import { parseAssets } from '../../src/portrait/core/mh/assets.ts';
import { HumanBuilder, type HumanMesh } from '../../src/portrait/core/mh/human.ts';
import { PRESET_BY_ID } from '../../src/portrait/core/params/presets.ts';
import { resolveParams, type ParamValues } from '../../src/portrait/core/params/resolve.ts';
import { LandmarkModel } from '../../src/portrait/photo/fit.ts';
import { BROW_POINTS } from '../../src/portrait/photo/regions.ts';

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'portrait', 'mh');
const HAVE = existsSync(path.join(DIR, 'weights.bin'));

describe('brow shape parameters', () => {
  const shape = (p: ParamValues) => resolveParams(p).brows;
  it('starts from the average for the sex and moves the way the labels say', () => {
    const f = shape({ 'base.sex': 0 }), m = shape({ 'base.sex': 1 });
    expect(m.thick[0]).toBeGreaterThan(f.thick[0]);
    expect(m.rise).toBeLessThan(f.rise);
    expect(m.lift[0]).toBeLessThan(f.lift[0]);
    const base = shape({});
    expect(shape({ 'face.brow.thickness': 1 }).thick[1]).toBeGreaterThan(base.thick[1]);
    expect(shape({ 'face.brow.arch': 1 }).rise).toBeGreaterThan(base.rise);
    expect(shape({ 'face.brow.arch': -2 }).rise).toBe(0);
    expect(shape({ 'face.brow.gap': 1 }).headShift).toBeGreaterThan(0);
    expect(shape({ 'face.brow.length': 1 }).tailShift).toBeGreaterThan(0);
    expect(shape({ 'face.brow.density': 1 }).height).toBeGreaterThan(base.height);
    expect(shape({ 'face.brow.head': 1 }).headTaper).toBe(0);
    const asym = shape({ 'asym.brow.height': 1 });
    expect(asym.lift[0]).toBeGreaterThan(asym.lift[1]);
    expect(shape({ 'face.brow.relief': 0 }).relief).toBe(0);
  });
});

describe.skipIf(!HAVE)('sculpted brows', () => {
  const buf = (f: string) => {
    const b = readFileSync(path.join(DIR, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const hb = HAVE ? new HumanBuilder(parseAssets(JSON.parse(readFileSync(path.join(DIR, 'mh.json'), 'utf8')), buf('base.bin'), buf('targets.bin'), buf('weights.bin'))) : (null as unknown as HumanBuilder);
  const female = { ...PRESET_BY_ID.get('female-eastAsian')!.params };
  /** Displacement of every vertex between two builds with the same topology (mm). */
  const moved = (a: HumanMesh, b: HumanMesh) => Float64Array.from({ length: a.positions.length / 3 }, (_, i) => Math.hypot(b.positions[i * 3]! - a.positions[i * 3]!, b.positions[i * 3 + 1]! - a.positions[i * 3 + 1]!, b.positions[i * 3 + 2]! - a.positions[i * 3 + 2]!));

  it('places the guide above the eyes', () => {
    const g = hb.browGuide();
    const m = hb.build({ ...buildSpec({}, { level: 0 }).spec, eyes: false });
    const pupil = m.landmarks.pupilL!;
    const pts = hb.stencilPoints(buildSpec({}).spec, g.stencils[0]![0]!);
    let mx = 0;
    for (let k = 0; k < pts.length / 3; k++) {
      expect(pts[k * 3 + 1]! - pupil[1]).toBeGreaterThan(8);
      expect(pts[k * 3 + 1]! - pupil[1]).toBeLessThan(26);
      // side 0 is the figure's left (+x); the guide starts at the midline so the inner end can move in
      expect(pts[k * 3]!).toBeGreaterThan(-3);
      mx += pts[k * 3]! / (pts.length / 3);
    }
    expect(mx).toBeGreaterThan(20);
    expect(g.headFrac).toBeLessThan(g.tailFrac);
  });

  it('sculpts a symmetric relief above the eyes, and none at relief 0', () => {
    const a = hb.build(buildSpec({ ...female, 'face.brow.relief': 0 }, { level: 2 }).spec);
    const b = hb.build(buildSpec(female, { level: 2 }).spec);
    expect(a.brow).toBeUndefined();
    const d = moved(a, b);
    let n = 0, max = 0, left = 0, right = 0;
    const eyeY = b.landmarks.pupilL![1];
    d.forEach((x, i) => {
      if (x < 0.02) return;
      n++;
      max = Math.max(max, x);
      if (b.positions[i * 3]! > 0) left += x;
      else right += x;
      const y = b.positions[i * 3 + 1]! - eyeY;
      expect(y).toBeGreaterThan(4);
      expect(y).toBeLessThan(34);
    });
    expect(n).toBeGreaterThan(300);
    expect(max).toBeGreaterThan(0.8);
    expect(max).toBeLessThan(1.6);
    expect(left / right).toBeCloseTo(1, 2);
    // the strand chart covers the brows: position along them 0…1, coverage up to 1
    let covered = 0;
    for (let i = 0; i < b.brow!.length / 4; i++) if (b.brow![i * 4 + 3]! > 0.5) covered++;
    expect(covered).toBeGreaterThan(150);
    expect(b.browStrands).toBeCloseTo(0.6);
  });

  it('rides on the skin: follows a brow raise and survives the bust cut', () => {
    const lo = hb.build(buildSpec(female, { level: 1 }).spec);
    const hi = hb.build(buildSpec({ ...female, 'expr.browRaise': 1 }, { level: 1 }).spec);
    const flat = hb.build(buildSpec({ ...female, 'face.brow.relief': 0 }, { level: 1 }).spec);
    const flatHi = hb.build(buildSpec({ ...female, 'face.brow.relief': 0, 'expr.browRaise': 1 }, { level: 1 }).spec);
    // height-weighted centre of the relief, before and after raising the brows
    const centre = (m: HumanMesh, base: HumanMesh) => {
      const d = moved(base, m);
      let y = 0, w = 0;
      d.forEach((x, i) => {
        if (x < 0.05) return;
        y += m.positions[i * 3 + 1]! * x;
        w += x;
      });
      return y / w;
    };
    expect(centre(hi, flatHi) - centre(lo, flat)).toBeGreaterThan(1);
    const bust = hb.build(buildSpec(female, { level: 1, framing: 'bust' }).spec);
    let covered = 0;
    for (let i = 0; i < bust.brow!.length / 4; i++) if (bust.brow![i * 4 + 3]! > 0.5) covered++;
    expect(covered).toBeGreaterThan(30);
  });

  it('moves the photo-fitting brow landmarks with the brow shape', () => {
    const model = new LandmarkModel(hb);
    const k = BROW_POINTS.find((b) => b.side === 'left' && b.edge === 1 && b.m.alongPerLength > 0.4 && b.m.alongPerLength < 0.6)!.k;
    const i = model.ks.indexOf(k);
    expect(i).toBeGreaterThanOrEqual(0);
    const y = (p: ParamValues) => model.points(buildSpec(p).spec)[i * 3 + 1]!;
    expect(y({ ...female, 'face.brow.arch': 1 }) - y(female)).toBeGreaterThan(1.5);
    expect(y({ ...female, 'face.brow.arch': -1 }) - y(female)).toBeLessThan(-1.5);
    // a brow without relief still has a shape for fitting
    expect(Number.isFinite(y({ ...female, 'face.brow.relief': 0 }))).toBe(true);
  });
});
