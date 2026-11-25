import { describe, expect, it } from 'vitest';
import { basisEuler, mirrorBasis, type V3 } from '../../src/portrait/core/math.ts';
import { cullList } from '../../src/portrait/core/sdf/cull.ts';
import { evalAll, evalList, smin } from '../../src/portrait/core/sdf/evaluate.ts';
import { OP, Sculpt, bezierThrough, capsule, compile, ellipsoid, eyelid, plane, roundBox, roundCone, sphere, torus, type Box } from '../../src/portrait/core/sdf/program.ts';
import { assemble, meshBlocks, meshSync, planMesh } from '../../src/portrait/core/mesher/surfaceNets.ts';

const single = (fn: (s: Sculpt) => void) => {
  const s = new Sculpt();
  fn(s);
  return compile(s);
};

describe('primitives', () => {
  it('exact distances for sphere, capsule, round cone, round box, plane, torus', () => {
    expect(evalAll(single((s) => s.add(sphere([0, 0, 0], 10))), 20, 0, 0)).toBeCloseTo(10);
    expect(evalAll(single((s) => s.add(capsule([0, 0, 0], [0, 10, 0], 2))), 5, 5, 0)).toBeCloseTo(3);
    const rc = single((s) => s.add(roundCone([0, 0, 0], [0, 20, 0], 5, 2)));
    expect(evalAll(rc, 0, -8, 0)).toBeCloseTo(3);
    expect(evalAll(rc, 0, 25, 0)).toBeCloseTo(3);
    const rb = single((s) => s.add(roundBox([0, 0, 0], [10, 5, 5], 1, basisEuler(0, 90))));
    expect(evalAll(rb, 0, 0, 12)).toBeCloseTo(2); // rotated 90°: local x now along z
    expect(evalAll(single((s) => s.add(sphere([0, 0, 0], 50)).inter(plane([0, 1, 0], 10))), 0, 20, 0)).toBeCloseTo(10);
    expect(evalAll(single((s) => s.add(torus([0, 0, 0], 10, 2))), 10, 0, 5)).toBeCloseTo(3);
  });

  it('ellipsoid is exact on the axes', () => {
    const e = single((s) => s.add(ellipsoid([0, 0, 0], [30, 10, 20])));
    expect(evalAll(e, 40, 0, 0)).toBeCloseTo(10, 4);
    expect(evalAll(e, 0, 15, 0)).toBeCloseTo(5, 4);
    expect(evalAll(e, 0, 0, -20)).toBeCloseTo(0, 4);
  });

  it('bézier tube: distance to a curved centerline', () => {
    const b = single((s) => s.add(bezierThrough([-10, 0, 0], [0, 5, 0], [10, 0, 0], 1, 1, 1)));
    expect(evalAll(b, 0, 5, 3)).toBeCloseTo(2, 4); // above the mid point
    expect(evalAll(b, -14, 0, 0)).toBeCloseTo(3, 4); // beyond the end cap
  });

  it('mirrored basis keeps local axes lateral', () => {
    const left = basisEuler(0, 20);
    const right = mirrorBasis(left, -1);
    expect(right[0][0]).toBeCloseTo(-left[0][0]);
    expect(right[0][2]).toBeCloseTo(left[0][2]);
  });

  it('eyelid opening is open at the front and closed above', () => {
    const lid = single((s) =>
      s.add(
        eyelid({ center: [0, 0, 0], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], R: 12, t: 2, edge: 1, aMed: -1.2, aLat: 1.3, eMed: 0, eLat: 0.05, hUp: 0.4, hLo: 0.4, pUp: 0.45, pLo: 0.55, crease: 0, creaseDepth: 0, creaseWidth: 1, back: 4 }),
      ),
    );
    expect(evalAll(lid, 0, 0, 13)).toBeGreaterThan(0.5); // straight ahead: the fissure (no lid)
    expect(evalAll(lid, 0, 9.2, 9.2)).toBeLessThan(0); // 45° up: inside the upper lid shell
  });
});

describe('smooth ops and culling', () => {
  it('smin is exact min beyond the blend radius', () => {
    expect(smin(1, 5, 2)).toBe(1);
    expect(smin(1, 1.5, 2)).toBeLessThan(1);
  });

  it('culled lists give identical values near the surface', () => {
    const s = new Sculpt();
    s.add(sphere([0, 0, 0], 40));
    for (let i = 0; i < 30; i++) s.add(sphere([Math.cos(i) * 45, Math.sin(i * 1.7) * 30, Math.sin(i) * 45], 6 + (i % 4)), 4);
    s.sub(ellipsoid([20, 10, 30], [8, 6, 10], basisEuler(10, 30)), 3);
    s.group('g', { k: 6 }, (g) => {
      g.add(capsule([-50, -20, 0], [-30, -40, 10], 5));
      g.sub(sphere([-40, -30, 5], 3), 1);
    });
    s.inter(plane([0, 1, 0], 35), 2);
    const P = compile(s);
    const out = new Int32Array(P.count);
    const h = 1;
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const c: V3 = [Math.sin(n * 12.9898) * 60, Math.sin(n * 78.233) * 50, Math.sin(n * 37.719) * 60];
      const box: Box = [c[0] - 4, c[1] - 4, c[2] - 4, c[0] + 4, c[1] + 4, c[2] + 4];
      const m = cullList(P, P.all, P.count, box, 2 * h, out);
      for (let t = 0; t < 8; t++) {
        const x = c[0] - 4 + (t & 1) * 8, y = c[1] - 4 + ((t >> 1) & 1) * 8, z = c[2] - 4 + ((t >> 2) & 1) * 8;
        const full = evalAll(P, x, y, z);
        if (Math.abs(full) > 2 * h) continue;
        checked++;
        expect(evalList(P, out, m, x, y, z)).toBeCloseTo(full, 9);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(OP.union).toBe(0);
  });

  it('keeps an early hard shape that a later wide blend depends on', () => {
    // A k = 0 shape followed by a k = 26 blend: the first shape matters up to ~26 mm away.
    const s = new Sculpt();
    s.add(ellipsoid([0, 44, -4], [74, 84, 99]));
    s.add(ellipsoid([-60, 72, -22], [16, 20, 24]), 26);
    s.add(ellipsoid([0, 50, 36], [61, 56, 60]), 22);
    const P = compile(s);
    const out = new Int32Array(P.count);
    const h = 0.75;
    const box: Box = [-79.5, 60.8, -39, -76.5, 63.8, -36];
    const m = cullList(P, P.all, P.count, box, 2 * h, out);
    for (let t = 0; t < 27; t++) {
      const x = box[0] + (t % 3) * 1.5, y = box[1] + (Math.floor(t / 3) % 3) * 1.5, z = box[2] + Math.floor(t / 9) * 1.5;
      expect(evalList(P, out, m, x, y, z)).toBeCloseTo(evalAll(P, x, y, z), 9);
    }
  });
});

describe('surface nets mesher', () => {
  it('meshes a sphere: closed, outward, on the surface', () => {
    const P = single((s) => s.add(sphere([3, -2, 1], 30)));
    const m = meshSync(P, { h: 1.5 });
    expect(m.missing).toBe(0);
    expect(m.triangleCount).toBeGreaterThan(1000);
    // every vertex near radius 30, normals outward
    for (let i = 0; i < m.vertexCount; i += 7) {
      const x = m.positions[i * 3]! - 3, y = m.positions[i * 3 + 1]! + 2, z = m.positions[i * 3 + 2]! - 1;
      const r = Math.hypot(x, y, z);
      expect(Math.abs(r - 30)).toBeLessThan(0.3);
      expect((x * m.normals[i * 3]! + y * m.normals[i * 3 + 1]! + z * m.normals[i * 3 + 2]!) / r).toBeGreaterThan(0.95);
    }
    // closed manifold: every edge used by exactly two triangles, in opposite directions
    const edges = new Map<string, number>();
    for (let t = 0; t < m.triangleCount; t++) {
      for (let e = 0; e < 3; e++) {
        const a = m.indices[t * 3 + e]!, b = m.indices[t * 3 + ((e + 1) % 3)]!;
        edges.set(`${a},${b}`, (edges.get(`${a},${b}`) ?? 0) + 1);
      }
    }
    for (const [k, n] of edges) {
      const [a, b] = k.split(',');
      expect(n).toBe(1);
      expect(edges.get(`${b},${a}`)).toBe(1);
    }
    // triangle winding agrees with the normals (outward)
    let agree = 0;
    for (let t = 0; t < m.triangleCount; t += 5) {
      const [a, b, c] = [m.indices[t * 3]!, m.indices[t * 3 + 1]!, m.indices[t * 3 + 2]!];
      const p = (i: number): V3 => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u: V3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const v: V3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[0] * m.normals[a * 3]! + n[1] * m.normals[a * 3 + 1]! + n[2] * m.normals[a * 3 + 2]! > 0) agree++;
    }
    expect(agree).toBe(Math.ceil(m.triangleCount / 5));
  });

  it('splitting blocks across workers gives the same mesh', () => {
    const P = single((s) => {
      s.add(ellipsoid([0, 0, 0], [40, 25, 30]));
      s.add(capsule([0, 0, 0], [50, 30, 0], 8), 6);
      s.sub(sphere([0, 0, 30], 10), 2);
    });
    const plan = planMesh(P, { h: 1 });
    const { blocks, ...meta } = plan;
    const whole = assemble([meshBlocks(P, meta, blocks)]);
    const parts = [0, 1, 2].map((w) => meshBlocks(P, meta, blocks.filter((_, i) => i % 3 === w)));
    const split = assemble(parts);
    expect(split.missing).toBe(0);
    expect(split.vertexCount).toBe(whole.vertexCount);
    expect(split.triangleCount).toBe(whole.triangleCount);
  });
});
