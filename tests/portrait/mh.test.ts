/**
 * MakeHuman-based engine. Needs the converted assets in public/portrait/mh/ (run
 * `node scripts/portrait-mh-convert.ts vendor/makehuman/makehuman/data public/portrait/mh`);
 * skipped when they are missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAssets, type MhAssets } from '../../src/portrait/core/mh/assets.ts';
import { clipWithCap, earClip } from '../../src/portrait/core/mh/clip.ts';
import { HumanBuilder } from '../../src/portrait/core/mh/human.ts';
import { ageToYears, buildModifiers, targetWeights, yearsToAge } from '../../src/portrait/core/mh/modifiers.ts';
import { valuesOf } from '../../src/portrait/core/mh/presets.ts';
import { applyLevel, buildLevel, deepStencil } from '../../src/portrait/core/mh/subdivide.ts';

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'portrait', 'mh');
const HAVE = existsSync(path.join(DIR, 'mh.json'));

function load(): MhAssets {
  const buf = (f: string) => {
    const b = readFileSync(path.join(DIR, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  return parseAssets(JSON.parse(readFileSync(path.join(DIR, 'mh.json'), 'utf8')), buf('base.bin'), buf('targets.bin'), buf('weights.bin'));
}

/** Closed surface check that ignores duplicated seam vertices (caps): edges keyed by position. */
function openEdges(positions: Float32Array, indices: Uint32Array): number {
  const key = (i: number) => `${Math.round(positions[i * 3]! * 1000)},${Math.round(positions[i * 3 + 1]! * 1000)},${Math.round(positions[i * 3 + 2]! * 1000)}`;
  const count = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(indices[t + e]!), b = key(indices[t + ((e + 1) % 3)]!);
      if (a === b) continue;
      const k = `${a}>${b}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const k of count.keys()) {
    const [a, b] = k.split('>');
    if (!count.has(`${b}>${a}`)) open++;
  }
  return open;
}

describe('subdivision and clipping (synthetic)', () => {
  it('Catmull–Clark on a cube keeps it closed and shrinks corners toward the center', () => {
    const P = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
    const Q = new Uint32Array([0, 3, 2, 1, 4, 5, 6, 7, 0, 1, 5, 4, 2, 3, 7, 6, 1, 2, 6, 5, 0, 4, 7, 3]);
    const L = buildLevel(Q, 8);
    expect(L.nOut).toBe(8 + 6 + 12);
    const S = applyLevel(L, P);
    expect(Math.abs(S[0]!)).toBeCloseTo(5 / 9, 5); // corner point (n = 3) of a unit cube
    expect(L.outQuads.length).toBe(6 * 16);
  });

  it('stencils reproduce subdivided positions (two levels)', () => {
    const P = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
    const Q = new Uint32Array([0, 3, 2, 1, 4, 5, 6, 7, 0, 1, 5, 4, 2, 3, 7, 6, 1, 2, 6, 5, 0, 4, 7, 3]);
    const L0 = buildLevel(Q, 8);
    const L1 = buildLevel(L0.outQuads, L0.nOut);
    const P2 = applyLevel(L1, applyLevel(L0, P));
    for (let o = 0; o < L1.nOut; o += 7) {
      const st = deepStencil([L0, L1], o, 2);
      let x = 0, y = 0, z = 0, sum = 0;
      for (const [v, w] of st) {
        x += P[v * 3]! * w;
        y += P[v * 3 + 1]! * w;
        z += P[v * 3 + 2]! * w;
        sum += w;
      }
      expect(sum).toBeCloseTo(1, 9);
      expect(x).toBeCloseTo(P2[o * 3]!, 5);
      expect(y).toBeCloseTo(P2[o * 3 + 1]!, 5);
      expect(z).toBeCloseTo(P2[o * 3 + 2]!, 5);
    }
  });

  it('ear clipping triangulates a concave polygon', () => {
    const tris = earClip([
      [0, 0],
      [4, 0],
      [4, 4],
      [2, 1.5],
      [0, 4],
    ]);
    expect(tris).toHaveLength(3);
  });

  it('a plane cut with a cap leaves a closed surface', () => {
    // octahedron
    const positions = new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
    const normals = new Float32Array(positions);
    const indices = new Uint32Array([0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]);
    expect(openEdges(positions, indices)).toBe(0);
    const cut = clipWithCap({ positions, normals, indices }, { n: [0, 1, 0], d: -0.3 });
    expect(openEdges(cut.positions, cut.indices)).toBe(0);
    for (let i = 1; i < cut.positions.length; i += 3) expect(cut.positions[i]!).toBeGreaterThanOrEqual(-0.3 - 1e-6); // float32
  });
});

describe.skipIf(!HAVE)('MakeHuman assets and modifiers', () => {
  const A = HAVE ? load() : (null as unknown as MhAssets);

  it('loads hm08 with all modeling modifiers (genitals excluded)', () => {
    expect(A.meta.source.basemesh).toBe('hm08');
    expect(A.bodyQuads.length / 4).toBe(13378);
    expect(A.eyeVerts[0].length).toBeGreaterThan(50);
    const defs = buildModifiers(A);
    expect(defs.length).toBeGreaterThan(250);
    const pairs = defs.filter((d) => d.kind === 'pair');
    expect(pairs.every((d) => d.min && d.max)).toBe(true);
  });

  it('macro corner weights: ethnic targets of one sex and age sum to 1', () => {
    const defs = buildModifiers(A);
    const w = targetWeights(A, defs, valuesOf({ sex: 1, ethnicity: 'mixed', age: 25, weight: 0.5, muscle: 0.5, mods: {} }));
    const race = [...w].filter(([k]) => /^macrodetails\/(african|asian|caucasian)-male-young$/.test(k));
    expect(race).toHaveLength(3);
    expect(race.reduce((a, [, v]) => a + v, 0)).toBeCloseTo(1, 6);
    expect([...w.keys()].some((k) => k.includes('female'))).toBe(false);
  });

  it('local modifiers pick the min or max target by sign', () => {
    const defs = buildModifiers(A);
    const w1 = targetWeights(A, defs, { 'nose/nose-trans-down|up': 0.6 });
    expect(w1.get('nose/nose-trans-up')).toBeCloseTo(0.6);
    const w2 = targetWeights(A, defs, { 'nose/nose-trans-down|up': -0.4 });
    expect(w2.get('nose/nose-trans-down')).toBeCloseTo(0.4);
    expect(w2.has('nose/nose-trans-up')).toBe(false);
  });

  it('age mapping round-trips', () => {
    for (const y of [1, 5, 11, 18, 25, 40, 90]) expect(ageToYears(yearsToAge(y))).toBeCloseTo(y, 6);
  });
});

describe.skipIf(!HAVE)('portrait mesh', () => {
  const hb = HAVE ? new HumanBuilder(load()) : (null as unknown as HumanBuilder);

  it('builds plausible adults, finite and with eyes in place', () => {
    const m = hb.build({ values: valuesOf({ sex: 1, ethnicity: 'caucasian', age: 30, weight: 0.5, muscle: 0.5, mods: {} }), level: 1 });
    const f = hb.build({ values: valuesOf({ sex: 0, ethnicity: 'asian', age: 30, weight: 0.5, muscle: 0.5, mods: {} }), level: 1 });
    expect(m.height).toBeGreaterThan(1650);
    expect(m.height).toBeLessThan(1900);
    expect(f.height).toBeGreaterThan(1400);
    expect(f.height).toBeLessThan(m.height);
    for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
    const [l, r] = m.eyes;
    expect(l!.center[0]).toBeCloseTo(-r!.center[0], 3); // symmetric
    expect(l!.center[0] - r!.center[0]).toBeGreaterThan(55); // interpupillary distance (mm)
    expect(l!.center[0] - r!.center[0]).toBeLessThan(70);
  });

  it('the body is a closed surface, also after the bust cut', () => {
    const values = valuesOf({ sex: 0, ethnicity: 'caucasian', age: 30, weight: 0.5, muscle: 0.5, mods: {} });
    const body = hb.build({ values, level: 1, eyes: false });
    expect(openEdges(body.positions, body.indices)).toBe(0);
    const bust = hb.build({ values, level: 1, eyes: false, bust: { below: 0.19, half: 0.105 } });
    expect(openEdges(bust.positions, bust.indices)).toBe(0);
    expect(bust.bounds[1]).toBeGreaterThan(body.bounds[1] + 500); // the legs are gone
    // oblique arm cuts with relaxed arms stay closed too
    const relaxed = hb.build({ values, level: 1, eyes: false, pose: { armAngle: 10, elbow: 10 }, bust: { below: 0.19, half: 0.085, sideAngle: 60 } });
    expect(openEdges(relaxed.positions, relaxed.indices)).toBe(0);
  });

  it('a local modifier moves the right region', () => {
    const base = hb.build({ values: {}, level: 0, eyes: false });
    const up = hb.build({ values: { 'nose/nose-trans-down|up': 1 }, level: 0, eyes: false });
    let moved = 0;
    let maxY = -Infinity;
    for (let i = 0; i < base.positions.length; i += 3) {
      if (Math.abs(up.positions[i + 1]! - base.positions[i + 1]!) > 0.5) {
        moved++;
        maxY = Math.max(maxY, base.positions[i + 1]!);
      }
    }
    expect(moved).toBeGreaterThan(20);
    expect(maxY).toBeGreaterThan(base.eyes[0]!.center[1] - 80); // only around the face
  });

  it('cranium width widens only the skull above the brows (face and ears stay put)', () => {
    const values = valuesOf({ sex: 0, ethnicity: 'asian', age: 25, weight: 0.5, muscle: 0.5, mods: {} });
    const base = hb.build({ values, level: 0, eyes: false });
    const wide = hb.build({ values, level: 0, eyes: false, cranium: 1 });
    const narrow = hb.build({ values, level: 0, eyes: false, cranium: -1 });
    const eyeY = base.eyes[0]!.center[1];
    let maxBelow = 0, maxWide = 0;
    for (let i = 0; i < base.positions.length; i += 3) {
      // only x changes, outward on both sides
      expect(wide.positions[i + 1]).toBe(base.positions[i + 1]);
      expect(wide.positions[i + 2]).toBe(base.positions[i + 2]);
      const dx = (wide.positions[i]! - base.positions[i]!) * Math.sign(base.positions[i]!);
      expect(dx).toBeGreaterThanOrEqual(-1e-3);
      if (base.positions[i + 1]! < eyeY + 20) maxBelow = Math.max(maxBelow, Math.abs(dx));
      else maxWide = Math.max(maxWide, dx);
    }
    expect(maxBelow).toBeLessThan(1e-3); // eyes, nose, mouth, cheeks, jaw untouched
    expect(maxWide).toBeGreaterThan(5);
    const [m0, m1, m2] = [base.measures, wide.measures, narrow.measures];
    for (const k of ['ipd', 'faceWidth', 'jawWidth', 'noseWidth', 'mouthWidth', 'faceHeight', 'height', 'headHeight'] as const) expect(m1[k]).toBeCloseTo(m0[k], 3);
    // the ears are masked out
    expect(m1.earLength).toBeCloseTo(m0.earLength, 1);
    expect(m1.earTop).toBeCloseTo(m0.earTop, 1);
    // the skull gets wider / narrower by a plausible amount at +1 / −1: at the upper forehead (pupils
    // + 60…80 mm) about 12 % wider / 7 % narrower, and the head width (widest above the ears) a little
    const halfWidth = (m: typeof base) => {
      let w = 0;
      for (let i = 0; i < m.positions.length; i += 3) if (m.positions[i + 1]! > eyeY + 60 && m.positions[i + 1]! < eyeY + 80) w = Math.max(w, Math.abs(m.positions[i]!));
      return w;
    };
    const [w0, w1, w2] = [halfWidth(base), halfWidth(wide), halfWidth(narrow)];
    expect(w1 / w0).toBeGreaterThan(1.09);
    expect(w1 / w0).toBeLessThan(1.13);
    expect(w2 / w0).toBeLessThan(0.95);
    expect(w2 / w0).toBeGreaterThan(0.91);
    expect(m1.headWidth - m0.headWidth).toBeGreaterThan(3);
    expect(m1.headWidth - m0.headWidth).toBeLessThan(20);
    expect(m2.headWidth).toBeLessThanOrEqual(m0.headWidth + 1e-3);
  });
});

describe.skipIf(!HAVE)('skeleton, solving and posing', () => {
  const A = HAVE ? load() : (null as unknown as MhAssets);
  const hb = HAVE ? new HumanBuilder(A) : (null as unknown as HumanBuilder);
  const male = HAVE ? valuesOf({ sex: 1, ethnicity: 'caucasian', age: 30, weight: 0.5, muscle: 0.5, mods: {} }) : {};
  const female = HAVE ? valuesOf({ sex: 0, ethnicity: 'asian', age: 30, weight: 0.5, muscle: 0.5, mods: {} }) : {};

  it('loads the default skeleton with parents first and normalized weights', () => {
    const sk = A.skeleton!;
    expect(sk.names).toHaveLength(163);
    sk.parent.forEach((p, b) => expect(p).toBeLessThan(b));
    for (const name of ['head', 'neck01', 'clavicle.L', 'upperarm01.R', 'eye.L', 'jaw']) expect(sk.index.has(name)).toBe(true);
    for (let v = 0; v < 200; v++) {
      const w = sk.weights[v * 4]! + sk.weights[v * 4 + 1]! + sk.weights[v * 4 + 2]! + sk.weights[v * 4 + 3]!;
      expect(w).toBeCloseTo(1, 5);
    }
  });

  it('meets absolute height and heads-tall targets', () => {
    for (const values of [male, female]) {
      for (const heightCm of [150, 172, 195]) {
        const m = hb.build({ values, level: 0, eyes: false, heightCm });
        expect(Math.abs(m.measures.height - heightCm * 10)).toBeLessThan(3); // ±3 mm
        expect(m.height).toBeCloseTo(heightCm * 10, 0);
      }
      const r = hb.build({ values, level: 0, eyes: false, heightCm: 165, headsTall: 5 });
      expect(Math.abs(r.measures.height - 1650)).toBeLessThan(3);
      expect(r.measures.headsTall).toBeCloseTo(5, 2);
      const t = hb.build({ values, level: 0, eyes: false, headsTall: 8.5 });
      expect(t.measures.headsTall).toBeCloseTo(8.5, 2);
    }
  });

  it('turns the head and lowers the arms by skinning', () => {
    const rest = hb.build({ values: male, level: 0 });
    const turned = hb.build({ values: male, level: 0, pose: { headYaw: 30 } });
    // the face swings toward the figure's left (+X); the eyes follow
    expect(turned.eyes[0]!.center[0] + turned.eyes[1]!.center[0]).toBeGreaterThan(rest.eyes[0]!.center[0] + rest.eyes[1]!.center[0] + 20);
    // displayed landmarks follow the turn (measurements stay in rest orientation)
    expect(rest.posedLandmarks.pronasale).toEqual(rest.landmarks.pronasale);
    expect(turned.landmarks.pronasale![0]).toBeCloseTo(rest.landmarks.pronasale![0], 3);
    expect(turned.posedLandmarks.pronasale![0]).toBeGreaterThan(rest.landmarks.pronasale![0] + 30);
    const eyeMidX = (turned.eyes[0]!.center[0] + turned.eyes[1]!.center[0]) / 2;
    expect(Math.abs(turned.posedLandmarks.pronasale![0] - eyeMidX)).toBeLessThan(40); // the nose tip stays in front of the turned eyes
    const relaxed = hb.build({ values: male, level: 0, eyes: false, pose: { armAngle: 8, elbow: 10 } });
    expect(relaxed.bounds[3] - relaxed.bounds[0]).toBeLessThan(rest.bounds[3] - rest.bounds[0] - 200); // arms no longer spread
    expect(relaxed.measures.height).toBeCloseTo(rest.measures.height, 0); // posing does not change the height
    const wide = hb.build({ values: male, level: 0, eyes: false, pose: { armAngle: 8, elbow: 10, shoulderWidth: 1 } });
    expect(wide.bounds[3] - wide.bounds[0]).toBeGreaterThan(relaxed.bounds[3] - relaxed.bounds[0] + 30);
  });

  it('surface stencils match the built mesh, also after a shape change and a pose', () => {
    const spec = { values: female, level: 2, eyes: false, pose: { headYaw: 20 } };
    const m = hb.build(spec);
    const picks = [0, 1234, 50000, hb.surfaceVertexCount(2) - 1];
    const stencils = picks.map((v) => hb.surfaceStencil([v], [1], 2));
    const pts = hb.stencilPoints(spec, stencils);
    picks.forEach((v, i) => {
      for (let a = 0; a < 3; a++) expect(Math.abs(pts[i * 3 + a]! - m.positions[v * 3 + a]!)).toBeLessThan(0.01);
    });
  });

  it('measures plausible faces', () => {
    for (const values of [male, female]) {
      const M = hb.build({ values, level: 0, eyes: false }).measures;
      expect(M.headsTall).toBeGreaterThan(6.8);
      expect(M.headsTall).toBeLessThan(8.5);
      expect(M.ipd).toBeGreaterThan(50);
      expect(M.ipd).toBeLessThan(70);
      expect(M.eyeOpening).toBeGreaterThan(5);
      expect(M.eyeOpening).toBeLessThan(14);
      expect(M.eyeWidth).toBeGreaterThan(15);
      expect(M.mouthWidth).toBeGreaterThan(M.noseWidth);
      expect(M.faceWidth).toBeGreaterThan(M.jawWidth);
      expect(M.headWidth).toBeGreaterThan(120);
      expect(M.headLength).toBeGreaterThan(M.headWidth);
      expect(M.noseProtrusion).toBeGreaterThan(5);
      expect(M.earLength).toBeGreaterThan(45);
      expect(M.lipGap).toBeGreaterThan(-1);
    }
    // a female East Asian face is smaller than a male European one
    const m = hb.build({ values: male, level: 0, eyes: false }).measures;
    const f = hb.build({ values: female, level: 0, eyes: false }).measures;
    expect(f.headHeight).toBeLessThan(m.headHeight);
  });
});
