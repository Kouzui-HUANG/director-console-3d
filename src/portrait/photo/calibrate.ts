/**
 * Builds and validates the correspondence between MediaPipe face landmarks and the sculpture's
 * surface (browser only, a development tool). The model is rendered from a known camera, MediaPipe
 * finds its landmarks, and a ray through each landmark finds the surface point it sits on (a
 * triangle of the level-2 subdivided mesh plus barycentric weights). Topology is fixed, so the same
 * surface points work for every shape. Landmarks of the face outline (silhouette-dependent) and the
 * irises (on the eyeball) are left out.
 */
import type { PortraitStudio } from '../app.ts';
import { buildSpec } from '../core/agent.ts';
import { browCenterY, browEnds, browHalf, browPoint, GUIDE_K, guideCurves } from '../core/mh/brows.ts';
import type { V3 } from '../core/mh/measure.ts';
import { earTest, jawPlaneTest } from './fit.ts';
import type { ParamValues } from '../core/params/resolve.ts';
import type { ViewName } from '../render/viewer.ts';
import { detectFace } from './mediapipe.ts';
import { BROW_POINTS, FACE_OVAL, FACE_OVAL_ORDER, LEFT_BROW, LEFT_EYE, LIPS, LOWER_OVAL, RIGHT_BROW, RIGHT_EYE } from './regions.ts';

export interface Correspondence {
  /** MediaPipe landmark index. */
  k: number;
  /** Level-2 surface vertex indices and barycentric weights (one vertex for "nearest"). */
  tri: number[];
  bary: number[];
  kind: 'surface' | 'nearest';
}

const LEVEL = 2;
const OVAL = new Set(FACE_OVAL);


async function renderAndDetect(studio: PortraitStudio, params: ParamValues, view: ViewName, width: number, height: number) {
  const viewer = studio.viewer!;
  const prev = { light: studio.ui.getState().light, quality: studio.ui.getState().quality };
  studio.ui.setState({ light: 'flat', quality: 'standard' });
  // brows darkened like hair: MediaPipe should see the face as on a photo
  viewer.setBrowTint(1);
  try {
    await studio.preview(params, { framing: 'full' });
    studio.frame('head');
    const { canvas, camera } = viewer.capture(view, width, height);
    const det = await detectFace(canvas);
    return { canvas, camera, det, mesh: studio.last! };
  } finally {
    viewer.setBrowTint(0);
    studio.ui.setState(prev);
  }
}

export async function calibrateLandmarks(studio: PortraitStudio, o: { params?: ParamValues; view?: ViewName; width?: number; height?: number } = {}) {
  const viewer = studio.viewer;
  const builder = studio.builder;
  if (!viewer || !builder) throw new Error('studio not ready');
  const w = o.width ?? 1200, h = o.height ?? 1500;
  try {
    const { camera, det, mesh } = await renderAndDetect(studio, o.params ?? {}, o.view ?? 'front', w, h);
    if (!det) throw new Error('MediaPipe found no face in the calibration render');
    const nBody = builder.surfaceVertexCount(LEVEL);
    const P = mesh.positions;
    const corr: Correspondence[] = [];
    const skipped: number[] = [];
    for (let k = 0; k < 468; k++) {
      if (OVAL.has(k)) continue;
      const x = det.points[k * 3]!, y = det.points[k * 3 + 1]!;
      const hit = viewer.pick(camera, (2 * x) / w - 1, 1 - (2 * y) / h);
      if (hit && hit.tri.every((i) => i < nBody)) {
        corr.push({ k, tri: hit.tri, bary: hit.bary.map((b) => Math.round(b * 1e5) / 1e5), kind: 'surface' });
        continue;
      }
      // the ray went into the eye opening (eyeball) or missed: take the body vertex nearest to the ray
      const ray = hit?.ray ?? viewer.pick(camera, 0, 0)?.ray;
      if (!ray) {
        skipped.push(k);
        continue;
      }
      const [ox, oy, oz] = ray.origin, [dx, dy, dz] = ray.dir;
      const tHit = hit ? (hit.point[0] - ox) * dx + (hit.point[1] - oy) * dy + (hit.point[2] - oz) * dz : Infinity;
      let best = -1, bd = 3; // mm
      for (let i = 0; i < nBody; i++) {
        const px = P[i * 3]! - ox, py = P[i * 3 + 1]! - oy, pz = P[i * 3 + 2]! - oz;
        const t = px * dx + py * dy + pz * dz;
        if (t > tHit + 4 || t < tHit - 15) continue;
        const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
        const dist = Math.hypot(ex, ey, ez);
        if (dist < bd) {
          bd = dist;
          best = i;
        }
      }
      if (best >= 0) corr.push({ k, tri: [best], bary: [1], kind: 'nearest' });
      else skipped.push(k);
    }
    return { level: LEVEL, view: o.view ?? 'front', size: [w, h], landmarks: corr.length, corr, skipped };
  } finally {
    await studio.preview(null);
    studio.frame();
  }
}

const REGIONS: Record<string, Set<number>> = {
  eyes: new Set([...LEFT_EYE, ...RIGHT_EYE]),
  brows: new Set([...LEFT_BROW, ...RIGHT_BROW]),
  lips: new Set(LIPS),
};
const regionOf = (k: number) => Object.entries(REGIONS).find(([, s]) => s.has(k))?.[0] ?? 'other';

/** Reprojection error of the correspondences on other shapes / views, in % of the pupil distance. */
export async function validateLandmarks(studio: PortraitStudio, corr: Correspondence[], cases: { params: ParamValues; view: ViewName; label?: string }[], o: { width?: number; height?: number } = {}) {
  const viewer = studio.viewer!;
  const w = o.width ?? 900, h = o.height ?? 1125;
  const results = [];
  try {
    for (const c of cases) {
      const { camera, det, mesh } = await renderAndDetect(studio, c.params, c.view, w, h);
      if (!det) {
        results.push({ label: c.label ?? c.view, found: false });
        continue;
      }
      const P = mesh.positions;
      const iod = Math.hypot(det.points[468 * 3]! - det.points[473 * 3]!, det.points[468 * 3 + 1]! - det.points[473 * 3 + 1]!);
      const errs: Record<string, number[]> = {};
      const all: number[] = [];
      for (const cr of corr) {
        let x = 0, y = 0, z = 0;
        cr.tri.forEach((v, i) => {
          x += P[v * 3]! * cr.bary[i]!;
          y += P[v * 3 + 1]! * cr.bary[i]!;
          z += P[v * 3 + 2]! * cr.bary[i]!;
        });
        const ndc = viewer.projectMm([x, y, z], camera);
        const px = ((ndc[0] + 1) / 2) * w, py = ((1 - ndc[1]) / 2) * h;
        const e = (Math.hypot(px - det.points[cr.k * 3]!, py - det.points[cr.k * 3 + 1]!) / iod) * 100;
        all.push(e);
        (errs[regionOf(cr.k)] ??= []).push(e);
      }
      const stat = (a: number[]) => {
        const s = [...a].sort((p, q) => p - q);
        return { median: Math.round(s[Math.floor(s.length / 2)]! * 100) / 100, p90: Math.round(s[Math.floor(s.length * 0.9)]! * 100) / 100 };
      };
      results.push({ label: c.label ?? c.view, found: true, iodPx: Math.round(iod), all: stat(all), ...Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, stat(v)])) });
    }
    return results;
  } finally {
    await studio.preview(null);
    studio.frame();
  }
}

/**
 * Consensus correspondence: start from a single calibration, then for every landmark pick the
 * surface vertex (within `radius` mm of the first guess) whose projection best matches MediaPipe
 * across many renders (several faces × views). Also returns a reliability weight per landmark
 * (1 / (median error² + floor²), errors in % of the pupil distance), for weighted fitting.
 */
export async function calibrateConsensus(studio: PortraitStudio, o: { cases: { params: ParamValues; view: ViewName }[]; radius?: number; width?: number; height?: number }) {
  const viewer = studio.viewer!;
  const builder = studio.builder!;
  const w = o.width ?? 900, h = o.height ?? 1125;
  const first = await calibrateLandmarks(studio, {});
  const nBody = builder.surfaceVertexCount(LEVEL);
  try {
    // candidates around the first guess, on the neutral calibration shape
    await studio.preview({}, { framing: 'full' });
    const P0 = studio.last!.positions;
    const radius = o.radius ?? 7;
    const cands = first.corr.map((c) => {
      let x = 0, y = 0, z = 0;
      c.tri.forEach((v, i) => {
        x += P0[v * 3]! * c.bary[i]!;
        y += P0[v * 3 + 1]! * c.bary[i]!;
        z += P0[v * 3 + 2]! * c.bary[i]!;
      });
      const list: number[] = [];
      for (let v = 0; v < nBody; v++) {
        const dx = P0[v * 3]! - x, dy = P0[v * 3 + 1]! - y, dz = P0[v * 3 + 2]! - z;
        if (dx * dx + dy * dy + dz * dz <= radius * radius) list.push(v);
      }
      return list;
    });
    const errs = cands.map((l) => l.map(() => [] as number[]));
    let used = 0;
    for (const c of o.cases) {
      const { camera, det, mesh } = await renderAndDetect(studio, c.params, c.view, w, h);
      if (!det) continue;
      used++;
      const P = mesh.positions;
      const iod = Math.hypot(det.points[468 * 3]! - det.points[473 * 3]!, det.points[468 * 3 + 1]! - det.points[473 * 3 + 1]!);
      first.corr.forEach((cr, li) => {
        const tx = det.points[cr.k * 3]!, ty = det.points[cr.k * 3 + 1]!;
        cands[li]!.forEach((v, ci) => {
          const ndc = viewer.projectMm([P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!], camera);
          const px = ((ndc[0] + 1) / 2) * w, py = ((1 - ndc[1]) / 2) * h;
          errs[li]![ci]!.push((Math.hypot(px - tx, py - ty) / iod) * 100);
        });
      });
    }
    const median = (a: number[]) => {
      const s = [...a].sort((p, q) => p - q);
      return s[Math.floor(s.length / 2)] ?? Infinity;
    };
    const floor = 0.5;
    const corr: (Correspondence & { error: number; weight: number })[] = first.corr.map((cr, li) => {
      // robust score: mean of squared errors with the worst 15 % dropped
      let best = -1, bestScore = Infinity, bestMedian = Infinity;
      cands[li]!.forEach((v, ci) => {
        const e = [...errs[li]![ci]!].sort((p, q) => p - q);
        const keep = e.slice(0, Math.max(1, Math.ceil(e.length * 0.85)));
        const score = keep.reduce((s, x) => s + x * x, 0) / keep.length;
        if (score < bestScore) {
          bestScore = score;
          best = v;
          bestMedian = median(e);
        }
      });
      return { k: cr.k, tri: [best], bary: [1], kind: cr.kind, error: Math.round(bestMedian * 100) / 100, weight: Math.round((1 / (bestMedian * bestMedian + floor * floor)) * 1000) / 1000 };
    });
    return { level: LEVEL, cases: used, radius, landmarks: corr.length, corr };
  } finally {
    await studio.preview(null);
    studio.frame();
  }
}

/**
 * Face-outline calibration: render faces from many angles; for every lower face-oval landmark
 * MediaPipe finds, take the mesh's silhouette point there (the outermost grazing vertex in a thin
 * window along the outline normal through the landmark). Each observation keeps the vertex, the
 * camera direction (azimuth, elevation around the head, degrees) and MediaPipe's offset from the
 * silhouette (% of pupil distance, + = outside), so fitting can use the observations made from
 * directions like the photo's. Result rows: [k, flat [vertex, az, el, offset]…] (photo/contourMap.ts).
 */
export async function calibrateContour(studio: PortraitStudio, o: { faces: ParamValues[]; yaws?: number[]; pitches?: number[]; width?: number; height?: number }) {
  const viewer = studio.viewer!;
  const builder = studio.builder!;
  const w = o.width ?? 900, h = o.height ?? 1125;
  const yaws = o.yaws ?? [-40, -30, -20, -10, 0, 10, 20, 30, 40];
  const pitches = o.pitches ?? [-6, 6];
  const nBody = builder.surfaceVertexCount(LEVEL);
  // MediaPipe's oval passes in front of the ears: an ear rim is never the cheek's silhouette
  const onEar = earTest(builder, LEVEL);
  const items = LOWER_OVAL.map((k) => ({ k, verts: new Map<number, number>(), offsets: [] as number[], obs: [] as number[] }));
  const n = FACE_OVAL_ORDER.length;
  let renders = 0, found = 0;
  const prev = { light: studio.ui.getState().light, quality: studio.ui.getState().quality };
  studio.ui.setState({ light: 'flat', quality: 'standard' });
  try {
    for (const params of o.faces) {
      await studio.preview(params, { framing: 'full' });
      studio.frame('head');
      const mesh = studio.last!;
      const P = mesh.positions, N = mesh.normals;
      // the face outline belongs to the head: skip the neck below the jaw line (menton–gonions plane)
      const belowJaw = jawPlaneTest(mesh.landmarks);
      for (const el of pitches) {
        for (const az of yaws) {
          viewer.setOrbit(az, el);
          const { canvas, camera } = viewer.capture(null, w, h);
          renders++;
          const det = await detectFace(canvas);
          if (!det) continue;
          found++;
          const D = det.points;
          const C = [camera.position.x * 1000, camera.position.y * 1000, camera.position.z * 1000];
          // grazing body vertices (normal nearly perpendicular to the view ray), projected
          const gx: number[] = [], gy: number[] = [], gv: number[] = [];
          for (let v = 0; v < nBody; v++) {
            if (belowJaw(P, v)) continue;
            const dx = P[v * 3]! - C[0]!, dy = P[v * 3 + 1]! - C[1]!, dz = P[v * 3 + 2]! - C[2]!;
            const f = (N[v * 3]! * dx + N[v * 3 + 1]! * dy + N[v * 3 + 2]! * dz) / Math.hypot(dx, dy, dz);
            if (Math.abs(f) > 0.15 || onEar(v)) continue;
            const ndc = viewer.projectMm([P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!], camera);
            gv.push(v);
            gx.push(((ndc[0] + 1) / 2) * w);
            gy.push(((1 - ndc[1]) / 2) * h);
          }
          const iod = Math.hypot(D[468 * 3]! - D[473 * 3]!, D[468 * 3 + 1]! - D[473 * 3 + 1]!);
          let cx = 0, cy = 0;
          for (let k = 0; k < 468; k++) {
            cx += D[k * 3]! / 468;
            cy += D[k * 3 + 1]! / 468;
          }
          for (const it of items) {
            const i = FACE_OVAL_ORDER.indexOf(it.k);
            const a = FACE_OVAL_ORDER[(i + n - 1) % n]!, b = FACE_OVAL_ORDER[(i + 1) % n]!;
            const tx0 = D[b * 3]! - D[a * 3]!, ty0 = D[b * 3 + 1]! - D[a * 3 + 1]!;
            const l = Math.hypot(tx0, ty0) || 1;
            let nx = ty0 / l, ny = -tx0 / l;
            const ux = D[it.k * 3]!, uy = D[it.k * 3 + 1]!;
            if (nx * (ux - cx) + ny * (uy - cy) < 0) {
              nx = -nx;
              ny = -ny;
            }
            let best = -Infinity, bv = -1;
            for (let g = 0; g < gv.length; g++) {
              const ex = gx[g]! - ux, ey = gy[g]! - uy;
              if (Math.abs(-ny * ex + nx * ey) > 0.03 * iod) continue; // tangential window
              const along = nx * ex + ny * ey;
              if (Math.abs(along) > 0.08 * iod) continue;
              if (along > best) {
                best = along;
                bv = gv[g]!;
              }
            }
            if (bv < 0) continue;
            it.verts.set(bv, (it.verts.get(bv) ?? 0) + 1);
            it.offsets.push((-best / iod) * 100);
            it.obs.push(bv, az, el, Math.round((-best / iod) * 1000) / 10);
          }
        }
      }
    }
  } finally {
    studio.ui.setState(prev);
    await studio.preview(null);
    studio.frame();
  }
  const median = (a: number[]) => {
    const s = [...a].sort((p, q) => p - q);
    return s.length ? s[Math.floor(s.length / 2)]! : 0;
  };
  const map = items.map((it) => [it.k, it.obs] as [number, number[]]);
  return { level: LEVEL, renders, found, map, stats: items.map((it) => ({ k: it.k, seen: it.offsets.length, vertices: it.verts.size, bias: Math.round(median(it.offsets) * 100) / 100 })) };
}

/**
 * Where MediaPipe puts its eyebrow points on a sculpted brow darkened like hair (photo-like
 * renders): for each point, the chart position that best explains the detection, as the median
 * fraction along the brow (u) and offset outward from its edge (mm) over faces and views
 * (→ photo/regions.ts BROW_POINTS).
 */
export async function calibrateBrows(studio: PortraitStudio, o: { faces: ParamValues[]; yaws?: number[]; pitches?: number[]; width?: number; height?: number }) {
  const viewer = studio.viewer!;
  const builder = studio.builder!;
  const w = o.width ?? 900, h = o.height ?? 1125;
  const yaws = o.yaws ?? [-20, 0, 20];
  const pitches = o.pitches ?? [0];
  const guide = builder.browGuide();
  const stencils = guide.stencils.flatMap((side) => side.flatMap((row) => row));
  const seen = new Map<number, { x: number[]; L: number[]; y: number[]; half: number[]; px: number[] }>(BROW_POINTS.map((b) => [b.k, { x: [], L: [], y: [], half: [], px: [] }]));
  let renders = 0, found = 0;
  const prev = { light: studio.ui.getState().light, quality: studio.ui.getState().quality };
  studio.ui.setState({ light: 'flat', quality: 'standard' });
  viewer.setBrowTint(1);
  try {
    for (const params of o.faces) {
      await studio.preview(params, { framing: 'full' });
      studio.frame('head');
      const { spec } = buildSpec(params);
      const shape = spec.brows!;
      const X = builder.stencilPoints(spec, stencils);
      const rows = [0, 1].map((side) => [0, 1].map((row) => Array.from({ length: GUIDE_K }, (_, k): V3 => {
        const j = (side * 2 + row) * GUIDE_K + k;
        return [X[j * 3]!, X[j * 3 + 1]!, X[j * 3 + 2]!];
      })));
      const curves = guideCurves(rows);
      const ends = curves.map((c) => browEnds(c, guide, shape));
      for (const el of pitches) {
        for (const az of yaws) {
          viewer.setOrbit(az, el);
          const { canvas, camera } = viewer.capture(null, w, h);
          renders++;
          const det = await detectFace(canvas);
          if (!det) continue;
          found++;
          const px = (p: V3): [number, number] => {
            const n = viewer.projectMm(p, camera);
            return [((n[0] + 1) / 2) * w, ((1 - n[1]) / 2) * h];
          };
          for (const b of BROW_POINTS) {
            const tx = det.points[b.k * 3]!, ty = det.points[b.k * 3 + 1]!;
            // nearest point of either brow's chart (u along it, y mm above the guide)
            let best = Infinity, bu = 0, by = 0, bs = 0;
            const search = (side: number, u0: number, u1: number, du: number, y0: number, y1: number, dy: number) => {
              for (let u = u0; u <= u1 + 1e-9; u += du) {
                for (let y = y0; y <= y1 + 1e-9; y += dy) {
                  const [qx, qy] = px(browPoint(curves[side]!, ends[side]!, u, y));
                  const d = (qx - tx) ** 2 + (qy - ty) ** 2;
                  if (d < best) [best, bu, by, bs] = [d, u, y, side];
                }
              }
            };
            for (const side of [0, 1]) search(side, -0.4, 1.4, 0.04, -14, 18, 1);
            const side = bs;
            search(side, bu - 0.04, bu + 0.04, 0.005, by - 1, by + 1, 0.1);
            const e = ends[side]!;
            const L = e[1] - e[0];
            const r = seen.get(b.k)!;
            r.x.push(bu * L);
            r.L.push(L);
            r.y.push(by - browCenterY(shape, side, bu));
            r.half.push(browHalf(shape, e, bu));
            r.px.push(Math.sqrt(best));
          }
        }
      }
    }
  } finally {
    viewer.setBrowTint(0);
    studio.ui.setState(prev);
    await studio.preview(null);
    studio.frame();
  }
  // MediaPipe follows a brow's length and thickness only loosely (regressions on them were
  // unstable), so each point is a fixed fraction along the brow and a fixed offset from its edge
  const median = (a: number[]) => {
    const s = [...a].sort((p, q) => p - q);
    return s.length ? s[Math.floor(s.length / 2)]! : 0;
  };
  const spread = (a: number[]) => {
    const m = median(a);
    return median(a.map((x) => Math.abs(x - m)));
  };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    renders,
    found,
    points: BROW_POINTS.map((b) => {
      const r = seen.get(b.k)!;
      const u = r.x.map((x, i) => x / r.L[i]!);
      const out = r.y.map((y, i) => b.edge * y - r.half[i]!);
      return { k: b.k, side: b.side, edge: b.edge, u: r3(median(u)), uSpread: r3(spread(u)), out: r3(median(out)), outSpread: r3(spread(out)), residualPx: r3(median(r.px)), n: u.length };
    }),
  };
}
