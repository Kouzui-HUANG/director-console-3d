/**
 * Photo fitting math on synthetic observations: the sculpture's own landmarks projected through a
 * known camera stand in for MediaPipe (perfect correspondence), so the camera and the shape must be
 * recovered. Needs the converted MakeHuman data.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../../src/portrait/core/agent.ts';
import { parseAssets } from '../../src/portrait/core/mh/assets.ts';
import { HumanBuilder } from '../../src/portrait/core/mh/human.ts';
import { PRESET_BY_ID } from '../../src/portrait/core/params/presets.ts';
import type { ParamValues } from '../../src/portrait/core/params/resolve.ts';
import { alignPhoto, cameraInfo, cameraRotation, expressionFromBlendshapes, fitCamera, fitPortrait, LandmarkModel, projectPoints, type Camera, type Observation } from '../../src/portrait/photo/fit.ts';
import { IRIS_CENTER } from '../../src/portrait/photo/regions.ts';

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'portrait', 'mh');
const HAVE = existsSync(path.join(DIR, 'weights.bin'));

describe.skipIf(!HAVE)('photo fitting (synthetic)', () => {
  const buf = (f: string) => {
    const b = readFileSync(path.join(DIR, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const hb = HAVE ? new HumanBuilder(parseAssets(JSON.parse(readFileSync(path.join(DIR, 'mh.json'), 'utf8')), buf('base.bin'), buf('targets.bin'), buf('weights.bin'))) : (null as unknown as HumanBuilder);
  const model = HAVE ? new LandmarkModel(hb) : (null as unknown as LandmarkModel);

  /** Project the model's landmarks (and pupils, for the pupil distance) through a camera. */
  function observe(values: ParamValues, cam: Camera, size: [number, number]): Observation {
    const spec = buildSpec(values).spec;
    const X = model.points(spec);
    const uv = projectPoints(cam, X);
    const pts = new Float64Array(478 * 3);
    model.ks.forEach((k, i) => {
      pts[k * 3] = uv[i * 2]!;
      pts[k * 3 + 1] = uv[i * 2 + 1]!;
    });
    const eyes = hb.build({ ...spec, level: 0 }).eyes;
    const pu = projectPoints(cam, [...eyes[0]!.center, ...eyes[1]!.center]);
    pts[IRIS_CENTER.left * 3] = pu[0]!;
    pts[IRIS_CENTER.left * 3 + 1] = pu[1]!;
    pts[IRIS_CENTER.right * 3] = pu[2]!;
    pts[IRIS_CENTER.right * 3 + 1] = pu[3]!;
    const iod = Math.hypot(pu[0]! - pu[2]!, pu[1]! - pu[3]!);
    // the face centre stands in for every unmapped point
    let cx = 0, cy = 0;
    for (let i = 0; i < model.nSurface; i++) {
      cx += uv[i * 2]! / model.nSurface;
      cy += uv[i * 2 + 1]! / model.nSurface;
    }
    const set = new Set([...model.ks, IRIS_CENTER.left, IRIS_CENTER.right]);
    // the lower outline, consistent with how the fit reads it: each point is the outermost of the
    // candidates for this view along the outline normal (from its neighbours), moved by MediaPipe's
    // bias; the neighbours above the ears continue the outline straight on
    const plan = model.plan(cam, X);
    const ends = [[356, 454, 323], [127, 234, 93]] as const;
    const P = (k: number): [number, number] => [pts[k * 3]!, pts[k * 3 + 1]!];
    model.contour.forEach((c, i) => {
      const cand = plan.idx[i]!;
      let mx = cx, my = cy;
      if (cand.length) {
        mx = cand.reduce((s, j) => s + uv[j * 2]!, 0) / cand.length;
        my = cand.reduce((s, j) => s + uv[j * 2 + 1]!, 0) / cand.length;
      }
      pts[c.k * 3] = mx;
      pts[c.k * 3 + 1] = my;
      set.add(c.k);
    });
    for (const [k, a, b] of ends) {
      pts[k * 3] = 2 * pts[a * 3]! - pts[b * 3]!;
      pts[k * 3 + 1] = 2 * pts[a * 3 + 1]! - pts[b * 3 + 1]!;
      set.add(k);
    }
    for (let pass = 0; pass < 12; pass++) {
      const next = model.contour.map((c, i) => {
        const [ax, ay] = P(c.prev), [bx, by] = P(c.next), [ux, uy] = P(c.k);
        const cand = plan.idx[i]!;
        if (!cand.length) return [ux, uy];
        const l = Math.hypot(bx - ax, by - ay) || 1;
        let nx = (by - ay) / l, ny = -(bx - ax) / l;
        if (nx * (ux - cx) + ny * (uy - cy) < 0) {
          nx = -nx;
          ny = -ny;
        }
        // the outermost candidate within a band across the current point, as the fit reads it
        const tu = -ny * ux + nx * uy;
        let best = -Infinity, px = 0, py = 0;
        for (const band of [0.06, 0.12, Infinity]) {
          for (const j of cand) {
            if (Math.abs(-ny * uv[j * 2]! + nx * uv[j * 2 + 1]! - tu) > band * iod) continue;
            const sc = nx * uv[j * 2]! + ny * uv[j * 2 + 1]!;
            if (sc > best) {
              best = sc;
              px = uv[j * 2]!;
              py = uv[j * 2 + 1]!;
            }
          }
          if (best > -Infinity) break;
        }
        return [px + (nx * plan.bias[i]! * iod) / 100, py + (ny * plan.bias[i]! * iod) / 100];
      });
      model.contour.forEach((c, i) => {
        pts[c.k * 3] = next[i]![0]!;
        pts[c.k * 3 + 1] = next[i]![1]!;
      });
    }
    for (let k = 0; k < 468; k++) {
      if (set.has(k)) continue;
      pts[k * 3] = cx;
      pts[k * 3 + 1] = cy;
    }
    return { width: size[0], height: size[1], points: pts };
  }

  const base = { ...PRESET_BY_ID.get('female-eastAsian')!.params };
  const size: [number, number] = [1000, 1250];
  // a camera 600 mm in front of the face, head turned 20° to the subject's left
  const truthCam = (yawDeg: number): Camera => {
    const X = model.points(buildSpec(base).spec);
    let cy = 0, cz = 0;
    for (let i = 0; i < model.nSurface; i++) {
      cy += X[i * 3 + 1]! / model.nSurface;
      cz += X[i * 3 + 2]! / model.nSurface;
    }
    // turning the head by +yaw (to the subject's left) is a camera-space rotation of −yaw about y
    const cam: Camera = { rot: [0, (-yawDeg * Math.PI) / 180, 0], t: [0, 0, 0], f: 1500, cx: size[0] / 2, cy: size[1] / 2 };
    const R = cameraRotation(cam);
    cam.t = [-(R[1]! * cy + R[2]! * cz), -(R[4]! * cy + R[5]! * cz), 600 - (R[7]! * cy + R[8]! * cz)];
    return cam;
  };

  it('recovers the camera from landmarks', () => {
    const cam = truthCam(20);
    const obs = observe(base, cam, size);
    const X = model.points(buildSpec(base).spec);
    const { cam: got } = fitCamera(X, obs, model);
    const info = cameraInfo(got, obs);
    expect(Math.abs(info.yaw - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(info.pitch)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.hypot(...got.t) - Math.hypot(...cam.t))).toBeLessThan(60);
  });

  it('recovers face parameters and the expression from one photo', () => {
    const truth: ParamValues = { ...base, 'face.eyes.spacing': 0.7, 'face.nose.alarWidth': 0.8, 'face.mouth.width': -0.6, 'face.chin.height': 0.6, 'face.eyes.tilt': -0.5, 'expr.smile': 0.5 };
    const obs = observe(truth, truthCam(15), size);
    // perfect correspondences: a light prior lets the data speak
    const r = fitPortrait(model, base, [obs], { iterations: 6, lambda: 1 });
    expect(r.error.after).toBeLessThan(r.error.before / 5);
    expect(r.error.after).toBeLessThan(0.5);
    const got = (k: string) => (r.params[k] as number | undefined) ?? 0;
    for (const k of ['face.eyes.spacing', 'face.nose.alarWidth', 'face.mouth.width', 'face.chin.height', 'face.eyes.tilt']) {
      const err0 = Math.abs((truth[k] as number) - ((base[k] as number | undefined) ?? 0));
      expect(Math.abs((truth[k] as number) - got(k)), k).toBeLessThan(err0 * 0.45);
    }
    expect(Math.abs((r.params['expr.smile'] as number) - 0.5)).toBeLessThan(0.25);
    expect(Math.abs(r.photos[0]!.camera.yaw - 15)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.photos[0]!.camera.distanceMm - 600)).toBeLessThan(50);
    expect(r.photos[0]!.camera.focal35mm).toBe(43);
  }, 60000);

  it('uses the face outline for jaw and face width', () => {
    expect(model.contour.length).toBeGreaterThan(15);
    const truth: ParamValues = { ...base, 'face.jaw.width': 0.8, 'head.width': -0.6, 'face.chin.width': 0.6 };
    const obs = observe(truth, truthCam(10), size);
    // the outline alone pins these parameters down…
    const keys = ['face.jaw.width', 'head.width', 'face.chin.width'];
    const only = fitPortrait(model, base, [obs], { iterations: 6, lambda: 1, keys, contour: true });
    for (const k of keys) expect(Math.abs((only.params[k] as number) - (truth[k] as number)), k).toBeLessThan(0.1);
    // …and with every parameter free (front + 3/4), the fitted silhouette matches the photos far
    // better than a fit without the outline (the 3D widths themselves are not always visible)
    const photos = [obs, observe(truth, truthCam(-30), size)];
    const withOutline = fitPortrait(model, base, photos, { iterations: 6, contour: true, outlineMode: 'all' });
    const without = fitPortrait(model, base, photos, { iterations: 6 });
    const widths = fitPortrait(model, base, photos, { iterations: 6, contour: true });
    const outlineOf = (pv: ParamValues) => photos.reduce((s, ph) => s + alignPhoto(model, pv, ph).outlineError! / photos.length, 0);
    expect(withOutline.outline!.after).toBeLessThan(withOutline.outline!.before / 5);
    expect(outlineOf(withOutline.params)).toBeLessThan(outlineOf(without.params) * 0.6);
    // the default two-pass mode (widths only) also tightens the silhouette
    expect(outlineOf(widths.params)).toBeLessThan(outlineOf(without.params));
    expect(withOutline.error.after).toBeLessThan(withOutline.error.before / 5);
  }, 60000);

  it('guesses expressions from blendshapes', () => {
    const e = expressionFromBlendshapes({ mouthSmileLeft: 0.6, mouthSmileRight: 0.4, jawOpen: 0.25 });
    expect(e['expr.smile']).toBeCloseTo(0.7);
    expect(e['expr.mouthOpen']).toBeCloseTo(0.4);
    expect(e['expr.frown']).toBe(0);
  });
});
