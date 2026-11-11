/**
 * Top-down floor plan model (pure math, no DOM): object footprints, characters with facing,
 * cameras with field-of-view wedges and motion paths, in world X/Z meters. North (−Z) is up.
 * The browser draws it (src/export/planView.ts); tests check the model directly.
 */
import { getAssetType, isCharacterType } from './assetTypes.ts';
import { cameraObjects, evaluateCamera, evaluateObject, frameAspect, isAnimated, programCameraAt, sampleProp } from './evaluate.ts';
import { CommandError } from './commands/types.ts';
import { cameraForward, objectForward, roundTo, transformPoint, type Vec3 } from './math.ts';
import type { Project, SceneObject } from './schema.ts';

export type XZ = [number, number];
/** [minX, minZ, maxX, maxZ] in meters. */
export type PlanArea = [number, number, number, number];

export type PlanKind = 'terrain' | 'area' | 'solid' | 'crowd' | 'helper' | 'character';

export interface PlanShape {
  id: string;
  type: string;
  kind: PlanKind;
  color: string;
  /** Footprint polygon in world X/Z. */
  polygon: XZ[];
  center: XZ;
  /** Draw as an ellipse inside the polygon (trees, spheres, cylinders). */
  round: boolean;
  /** Unit facing direction in X/Z for things with a front (characters, chairs, cars…). */
  facing: XZ | null;
  hidden: boolean;
  label: string | null;
}

export interface PlanCamera {
  id: string;
  label: string;
  color: string;
  live: boolean;
  position: XZ;
  /** Unit horizontal view direction; null when looking (almost) straight down. */
  direction: XZ | null;
  /** Horizontal field of view in degrees (360 for panorama). */
  fov: number;
  /** Wedge length in meters. */
  range: number;
  aim: XZ | null;
}

export interface PlanPath {
  id: string;
  camera: boolean;
  color: string;
  points: XZ[];
  keys: { t: number; at: XZ }[];
}

export interface PlanModel {
  t: number;
  area: PlanArea;
  /** Grid spacing in meters. */
  grid: number;
  /** Shapes in draw order (terrain first, characters last). */
  shapes: PlanShape[];
  cameras: PlanCamera[];
  paths: PlanPath[];
}

export interface PlanOptions {
  /** Fixed area instead of fitting the content. */
  area?: PlanArea;
  /** Include motion paths (default true). */
  paths?: boolean;
}

const TERRAIN = new Set(['ground', 'hills', 'water', 'road']);
const AREA = new Set(['room', 'cityBlock']);
const ROUND = new Set(['tree', 'bush', 'sphere', 'cylinder', 'cone']);
const FRONTED = new Set(['chair', 'sofa', 'car', 'bench', 'bed']);
const KIND_ORDER: Record<PlanKind, number> = { terrain: 0, area: 1, solid: 2, crowd: 3, helper: 4, character: 5 };
/** Content larger than this (diagonal, m) does not drive the automatic framing. */
const HUGE = 60;
const GRID_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200];

const xz = (v: Vec3): XZ => [roundTo(v[0], 3), roundTo(v[2], 3)];

function unit(x: number, z: number): XZ | null {
  const l = Math.hypot(x, z);
  return l < 1e-6 ? null : [roundTo(x / l, 4), roundTo(z / l, 4)];
}

function kindOf(type: string): PlanKind {
  if (TERRAIN.has(type)) return 'terrain';
  if (AREA.has(type)) return 'area';
  if (type === 'crowd') return 'crowd';
  if (isCharacterType(type)) return 'character';
  if (getAssetType(type)?.category === 'helper') return 'helper';
  return 'solid';
}

function diag(poly: XZ[]): number {
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
}

function shapeOf(o: SceneObject, t: number): PlanShape | null {
  const def = getAssetType(o.type);
  if (!def || o.type === 'camera') return null;
  const e = evaluateObject(o, t);
  const b = def.bounds(e.params);
  const y = b.min[1];
  const corners: Vec3[] = [
    [b.min[0], y, b.min[2]],
    [b.max[0], y, b.min[2]],
    [b.max[0], y, b.max[2]],
    [b.min[0], y, b.max[2]],
  ];
  const polygon = corners.map((c) => xz(transformPoint(c, e.position, e.rotation, e.scale)));
  const center = xz(transformPoint([(b.min[0] + b.max[0]) / 2, y, (b.min[2] + b.max[2]) / 2], e.position, e.rotation, e.scale));
  const kind = kindOf(o.type);
  const fwd = objectForward(e.rotation[1]);
  const fronted = kind === 'character' || FRONTED.has(o.type);
  return {
    id: o.id,
    type: o.type,
    kind,
    color: o.color,
    polygon,
    center: kind === 'character' ? xz(e.position) : center,
    round: ROUND.has(o.type),
    facing: fronted ? unit(fwd[0], fwd[2]) : null,
    hidden: !e.visible,
    label: kind === 'terrain' ? null : e.visible ? o.id : `${o.id} (hidden)`,
  };
}

function lensLabel(id: string, lens: string, focal: number, fisheyeFov: number): string {
  return lens === 'standard' ? `${id} ${Math.round(focal)}mm` : lens === 'fisheye' ? `${id} fisheye ${Math.round(fisheyeFov)}°` : `${id} 360°`;
}

function pathsOf(project: Project, opts: PlanOptions): PlanPath[] {
  if (opts.paths === false) return [];
  const out: PlanPath[] = [];
  const fps = project.settings.fps;
  const duration = project.settings.duration;
  for (const o of project.objects) {
    const isCam = o.type === 'camera';
    const keyed = isAnimated(o, 'position');
    const follows = isCam && !!o.camera?.follow;
    if (!keyed && !follows) continue;
    const keys = keyed ? o.tracks.position!.keys : [];
    const t0 = keyed ? keys[0]!.t : 0;
    const t1 = keyed && !follows ? keys[keys.length - 1]!.t : duration;
    if (t1 - t0 < 1e-6) continue;
    const steps = Math.max(16, Math.min(300, Math.round(((t1 - t0) * fps) / 2)));
    const at = (t: number): XZ => (isCam ? xz(evaluateCamera(project, o, t).position) : xz(sampleProp(o, 'position', t) as Vec3));
    const points: XZ[] = [];
    let len = 0;
    for (let i = 0; i <= steps; i++) {
      const p = at(t0 + ((t1 - t0) * i) / steps);
      const prev = points[points.length - 1];
      if (prev) len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      points.push(p);
    }
    if (len < 0.05) continue;
    out.push({ id: o.id, camera: isCam, color: o.color, points, keys: follows ? [] : keys.map((k) => ({ t: k.t, at: at(k.t) })) });
  }
  return out;
}

/** Grid spacing so that roughly 6–16 lines cross the longer side. */
export function gridStep(area: PlanArea): number {
  const span = Math.max(area[2] - area[0], area[3] - area[1]);
  return GRID_STEPS.find((s) => span / s <= 16) ?? GRID_STEPS[GRID_STEPS.length - 1]!;
}

/** Fit an area around points with a margin, at least `min` meters, aspect (w/h) clamped to [0.75, 1.78]. */
export function fitArea(points: XZ[], min = 8): PlanArea {
  if (!points.length) return [-10, -10, 10, 10];
  let x0 = Math.min(...points.map((p) => p[0]));
  let x1 = Math.max(...points.map((p) => p[0]));
  let z0 = Math.min(...points.map((p) => p[1]));
  let z1 = Math.max(...points.map((p) => p[1]));
  const margin = Math.max(1.5, 0.12 * Math.max(x1 - x0, z1 - z0));
  x0 -= margin;
  x1 += margin;
  z0 -= margin;
  z1 += margin;
  const grow = (lo: number, hi: number, size: number): [number, number] => {
    const c = (lo + hi) / 2;
    return [c - size / 2, c + size / 2];
  };
  if (x1 - x0 < min) [x0, x1] = grow(x0, x1, min);
  if (z1 - z0 < min) [z0, z1] = grow(z0, z1, min);
  const w = x1 - x0;
  const h = z1 - z0;
  if (w / h > 1.78) [z0, z1] = grow(z0, z1, w / 1.78);
  else if (w / h < 0.75) [x0, x1] = grow(x0, x1, h * 0.75);
  return [roundTo(x0, 2), roundTo(z0, 2), roundTo(x1, 2), roundTo(z1, 2)];
}

export function planModel(project: Project, t: number, opts: PlanOptions = {}): PlanModel {
  const shapes = project.objects
    .map((o) => shapeOf(o, t))
    .filter((s): s is PlanShape => !!s)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || diag(b.polygon) - diag(a.polygon));
  const paths = pathsOf(project, opts);
  const live = programCameraAt(project, t);
  const aspect = frameAspect(project);
  const cams = cameraObjects(project).map((c) => {
    const e = evaluateCamera(project, c, t, aspect);
    const f = cameraForward(e.rotation[1], e.rotation[0]);
    const flat = Math.hypot(f[0], f[2]);
    return { c, e, direction: flat < 0.08 ? null : unit(f[0], f[2]) };
  });

  let area = opts.area;
  if (area) {
    const [ax0, az0, ax1, az1] = area;
    if (![ax0, az0, ax1, az1].every(Number.isFinite) || ax1 - ax0 < 1 || az1 - az0 < 1 || ax1 - ax0 > 3000 || az1 - az0 > 3000) {
      throw new CommandError('INVALID_ARGS', `area must be [minX, minZ, maxX, maxZ] with each side 1..3000 m (got ${JSON.stringify(area)})`, 'Example: [-10, -8, 10, 8]');
    }
  } else {
    // Fit the blocking: characters, cameras, aim points and their paths. Props, buildings and
    // vehicle paths only count when there is no blocking to fit (e.g. an empty or prop-only set).
    const charIds = new Set(shapes.filter((s) => s.kind === 'character').map((s) => s.id));
    const pts: XZ[] = [];
    for (const s of shapes) if (s.kind === 'character') pts.push(s.center);
    for (const { e } of cams) {
      pts.push(xz(e.position));
      if (e.aimPoint) pts.push(xz(e.aimPoint));
    }
    for (const p of paths) if (p.camera || charIds.has(p.id)) pts.push(...p.points);
    if (!charIds.size) {
      for (const s of shapes) if (s.kind !== 'terrain' && diag(s.polygon) < HUGE) pts.push(...s.polygon);
      for (const p of paths) pts.push(...p.points);
    }
    area = fitArea(pts);
  }
  const span = Math.min(area[2] - area[0], area[3] - area[1]);

  const cameras: PlanCamera[] = cams.map(({ c, e, direction }) => {
    const pos = xz(e.position);
    const aim = e.aimPoint ? xz(e.aimPoint) : null;
    const aimDist = aim ? Math.hypot(aim[0] - pos[0], aim[1] - pos[1]) : 0;
    const range = Math.max(1.5, Math.min(aim ? aimDist * 1.15 : span * 0.3, span * 0.6));
    const fov = e.lens === 'standard' ? e.hfov : e.lens === 'fisheye' ? Math.min(360, e.fisheye.fov) : 360;
    return {
      id: c.id,
      label: `${lensLabel(c.id, e.lens, e.focalLength, e.fisheye.fov)}${c.id === live ? ' LIVE' : ''}`,
      color: c.color,
      live: c.id === live,
      position: pos,
      direction,
      fov: roundTo(fov, 2),
      range: roundTo(range, 2),
      aim,
    };
  });
  return { t, area, grid: gridStep(area), shapes, cameras, paths };
}
