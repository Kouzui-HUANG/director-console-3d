/**
 * Simple collision geometry for scene checks and relative placement (pure math, no DOM).
 * Solid objects become boxes in their own yaw frame (walls are split around door/window
 * openings, trees become trunk + canopy); characters become upright cylinders.
 * Pitch and roll are ignored: everything is treated as standing upright.
 */
import { getAssetType, isCharacterType } from './assetTypes.ts';
import { evaluateObject, type EvalObject } from './evaluate.ts';
import type { Params } from './fields.ts';
import { rotateY, transformPoint, type Vec3 } from './math.ts';
import type { Project, SceneObject } from './schema.ts';

export interface SolidBox {
  id: string;
  type: string;
  /** World X/Z of the box center. */
  cx: number;
  cz: number;
  /** Yaw of the box frame (degrees). */
  yaw: number;
  /** Half extents along the box frame's X and Z (meters, scale applied). */
  hx: number;
  hz: number;
  /** World vertical range. */
  y0: number;
  y1: number;
  /** Bodies collide with it (characters walking into it). */
  body: boolean;
  /** It blocks the view (occlusion, camera inside it). */
  view: boolean;
}

export interface BodyCylinder {
  id: string;
  type: string;
  x: number;
  z: number;
  r: number;
  y0: number;
  y1: number;
  pose: string;
}

/** Types without collision boxes: terrain, soft or generated sets, helpers, hinged doors. */
const NO_SOLID = new Set(['ground', 'hills', 'water', 'road', 'crowd', 'cityBlock', 'plane', 'door', 'camera', 'target', 'mark']);

interface LocalBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  body: boolean;
  view: boolean;
}

interface Opening {
  offset: number;
  width: number;
  height: number;
  sill: number;
}

const num = (p: Params, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);

/** Pieces of a wall along local X (centered), thickness along Z, split around openings. */
export function wallPieces(len: number, h: number, t: number, openings: Opening[]): LocalBox[] {
  const half = len / 2;
  const ops = openings
    .map((o) => ({ x0: Math.max(-half + 0.02, o.offset - o.width / 2), x1: Math.min(half - 0.02, o.offset + o.width / 2), sill: Math.max(0, o.sill), top: Math.max(0, o.sill) + o.height }))
    .filter((o) => o.x1 > o.x0)
    .sort((a, b) => a.x0 - b.x0);
  const out: LocalBox[] = [];
  const piece = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 > 0.01 && y1 - y0 > 0.01) out.push({ x0, x1, y0, y1, z0: -t / 2, z1: t / 2, body: true, view: true });
  };
  let cursor = -half;
  for (const o of ops) {
    piece(cursor, o.x0, 0, h);
    piece(o.x0, o.x1, 0, Math.min(o.sill, h));
    piece(o.x0, o.x1, Math.min(o.top, h), h);
    cursor = Math.max(cursor, o.x1);
  }
  piece(cursor, half, 0, h);
  return out;
}

function openingList(raw: unknown, wall: string | null, defaultSill: number): Opening[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter((o) => wall === null || (o.wall ?? (defaultSill > 0 ? 'north' : 'south')) === wall)
    .map((o) => ({ offset: Number(o.offset ?? 0), width: Number(o.width ?? 0.9), height: Number(o.height ?? 2.1), sill: Number(o.sill ?? defaultSill) }));
}

/** Local boxes (object space) for one object, with a per-box frame yaw offset. */
function localBoxes(type: string, params: Params): { box: LocalBox; yaw: number; at: [number, number] }[] {
  const def = getAssetType(type);
  if (!def || NO_SOLID.has(type) || isCharacterType(type)) return [];
  const b = def.bounds(params);
  const full: LocalBox = { x0: b.min[0], x1: b.max[0], y0: b.min[1], y1: b.max[1], z0: b.min[2], z1: b.max[2], body: true, view: true };
  const H = b.max[1] - b.min[1];
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  switch (type) {
    case 'wall':
      return wallPieces(num(params, 'length', 4), num(params, 'height', 2.8), num(params, 'thickness', 0.2), openingList(params.openings, null, 0)).map((box) => ({ box, yaw: 0, at: [0, 0] }));
    case 'room': {
      const w = num(params, 'width', 6);
      const d = num(params, 'depth', 5);
      const h = num(params, 'height', 2.8);
      const t = num(params, 'wallThickness', 0.15);
      const sides = [
        { name: 'north', len: w + 2 * t, at: [0, -d / 2 - t / 2] as [number, number], rot: 0 },
        { name: 'south', len: w + 2 * t, at: [0, d / 2 + t / 2] as [number, number], rot: 180 },
        { name: 'east', len: d, at: [w / 2 + t / 2, 0] as [number, number], rot: -90 },
        { name: 'west', len: d, at: [-w / 2 - t / 2, 0] as [number, number], rot: 90 },
      ];
      return sides.flatMap((s) =>
        wallPieces(s.len, h, t, [...openingList(params.doors, s.name, 0).map((o) => ({ ...o, sill: 0 })), ...openingList(params.windows, s.name, 0.9)]).map((box) => ({ box, yaw: s.rot, at: s.at })),
      );
    }
    case 'tree': {
      const r = Math.min(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2;
      return [
        { box: { x0: cx - 0.13, x1: cx + 0.13, y0: b.min[1], y1: b.min[1] + 0.45 * H, z0: cz - 0.13, z1: cz + 0.13, body: true, view: true }, yaw: 0, at: [0, 0] },
        { box: { x0: cx - r * 0.75, x1: cx + r * 0.75, y0: b.min[1] + 0.4 * H, y1: b.max[1], z0: cz - r * 0.75, z1: cz + r * 0.75, body: false, view: true }, yaw: 0, at: [0, 0] },
      ];
    }
    case 'streetLight':
      return [{ box: { x0: cx - 0.08, x1: cx + 0.08, y0: b.min[1], y1: b.max[1], z0: cz - 0.08, z1: cz + 0.08, body: true, view: true }, yaw: 0, at: [0, 0] }];
    case 'stairs':
      // Something to stand on, not to bump into.
      return [{ box: { ...full, body: false }, yaw: 0, at: [0, 0] }];
    default:
      return [{ box: full, yaw: 0, at: [0, 0] }];
  }
}

/** World boxes for an evaluated object. */
export function solidBoxesOf(e: EvalObject): SolidBox[] {
  const [sx, sy, sz] = e.scale;
  const out: SolidBox[] = [];
  // Tilted objects (pitch / roll, e.g. a wheel made from a cylinder): use the world-aligned box
  // around the rotated corners instead of a yaw-frame box.
  const tilted = Math.abs(e.rotation[0]) > 1 || Math.abs(e.rotation[2]) > 1;
  for (const { box, yaw, at } of localBoxes(e.type, e.params)) {
    if (tilted) {
      const pts: Vec3[] = [];
      for (const x of [box.x0, box.x1])
        for (const y of [box.y0, box.y1])
          for (const z of [box.z0, box.z1]) {
            const q = rotateY([x, y, z], yaw);
            pts.push(transformPoint([q[0] + at[0], q[1], q[2] + at[1]], e.position, e.rotation, e.scale));
          }
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      const zs = pts.map((q) => q[2]);
      out.push({
        id: e.id,
        type: e.type,
        cx: (Math.min(...xs) + Math.max(...xs)) / 2,
        cz: (Math.min(...zs) + Math.max(...zs)) / 2,
        yaw: 0,
        hx: (Math.max(...xs) - Math.min(...xs)) / 2,
        hz: (Math.max(...zs) - Math.min(...zs)) / 2,
        y0: Math.min(...ys),
        y1: Math.max(...ys),
        body: box.body,
        view: box.view,
      });
      continue;
    }
    // Box center in the piece frame → object local (piece yaw + offset) → world (object yaw, scale).
    const pc = rotateY([(box.x0 + box.x1) / 2, 0, (box.z0 + box.z1) / 2], yaw);
    const local: Vec3 = [(at[0] + pc[0]) * sx, 0, (at[1] + pc[2]) * sz];
    const w = rotateY(local, e.rotation[1]);
    const quarter = Math.abs(Math.round(yaw / 90)) % 2 === 1;
    out.push({
      id: e.id,
      type: e.type,
      cx: e.position[0] + w[0],
      cz: e.position[2] + w[2],
      yaw: e.rotation[1] + yaw,
      hx: ((box.x1 - box.x0) / 2) * (quarter ? sz : sx),
      hz: ((box.z1 - box.z0) / 2) * (quarter ? sx : sz),
      y0: e.position[1] + box.y0 * sy,
      y1: e.position[1] + box.y1 * sy,
      body: box.body,
      view: box.view,
    });
  }
  return out;
}

/** Upright body cylinder for a character (not its arms), or null for other types. */
export function bodyOf(e: EvalObject): BodyCylinder | null {
  if (!isCharacterType(e.type)) return null;
  const def = getAssetType(e.type)!;
  const b = def.bounds(e.params);
  const halfW = Math.min(b.max[0] - b.min[0], 0.9) / 2;
  const s = Math.max(e.scale[0], e.scale[2]);
  return {
    id: e.id,
    type: e.type,
    x: e.position[0],
    z: e.position[2],
    r: Math.max(0.1, halfW * 0.6 * s),
    y0: e.position[1],
    y1: e.position[1] + b.max[1] * e.scale[1],
    pose: String(e.params.pose ?? 'stand'),
  };
}

/** Point (x, z) in the box frame. */
function toBox(b: SolidBox, x: number, z: number): [number, number] {
  const v = rotateY([x - b.cx, 0, z - b.cz], -b.yaw);
  return [v[0], v[2]];
}

/** Signed distance from a ground point to the box footprint (negative inside). */
export function footprintDistance(b: SolidBox, x: number, z: number): number {
  const [lx, lz] = toBox(b, x, z);
  const dx = Math.abs(lx) - b.hx;
  const dz = Math.abs(lz) - b.hz;
  return dx > 0 || dz > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) : Math.max(dx, dz);
}

/** Do two boxes' footprints overlap (separating-axis test), allowing `margin` meters of gap? */
export function footprintsOverlap(a: SolidBox, b: SolidBox, margin = 0): boolean {
  // Cheap reject first: bounding circles too far apart.
  if (Math.hypot(a.cx - b.cx, a.cz - b.cz) > Math.hypot(a.hx, a.hz) + Math.hypot(b.hx, b.hz) + Math.max(0, margin)) return false;
  const axes = [a.yaw, a.yaw + 90, b.yaw, b.yaw + 90].map((deg) => rotateY([1, 0, 0], deg));
  const corners = (q: SolidBox) =>
    [
      [-q.hx, -q.hz],
      [q.hx, -q.hz],
      [q.hx, q.hz],
      [-q.hx, q.hz],
    ].map(([x, z]) => {
      const w = rotateY([x!, 0, z!], q.yaw);
      return [q.cx + w[0], q.cz + w[2]] as const;
    });
  const ca = corners(a);
  const cb = corners(b);
  for (const ax of axes) {
    const proj = (pts: (readonly [number, number])[]) => pts.map(([x, z]) => x * ax[0] + z * ax[2]);
    const pa = proj(ca);
    const pb = proj(cb);
    if (Math.max(...pa) + margin < Math.min(...pb) || Math.max(...pb) + margin < Math.min(...pa)) return false;
  }
  return true;
}

export function pointInBox(b: SolidBox, p: Vec3, margin = 0): boolean {
  return p[1] > b.y0 - margin && p[1] < b.y1 + margin && footprintDistance(b, p[0], p[2]) < margin;
}

/** Does the segment a→b pass through the box (ignoring the first/last 2% of the segment)? */
export function segmentHitsBox(b: SolidBox, a: Vec3, c: Vec3): boolean {
  const [ax, az] = toBox(b, a[0], a[2]);
  const [bx, bz] = toBox(b, c[0], c[2]);
  let t0 = 0.02;
  let t1 = 0.98;
  const slab = (p: number, q: number, lo: number, hi: number) => {
    const d = q - p;
    if (Math.abs(d) < 1e-9) return p >= lo && p <= hi;
    let u = (lo - p) / d;
    let v = (hi - p) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
    return t0 <= t1;
  };
  return slab(ax, bx, -b.hx, b.hx) && slab(az, bz, -b.hz, b.hz) && slab(a[1], c[1], b.y0, b.y1);
}

/** Every solid box and character body in the scene at time t. */
export function sceneGeometry(project: Project, t: number): { boxes: SolidBox[]; bodies: BodyCylinder[]; evals: Map<string, EvalObject> } {
  const boxes: SolidBox[] = [];
  const bodies: BodyCylinder[] = [];
  const evals = new Map<string, EvalObject>();
  for (const o of project.objects) {
    if (o.type === 'camera') continue;
    const e = evaluateObject(o, t);
    evals.set(o.id, e);
    if (!e.visible) continue;
    const body = bodyOf(e);
    if (body) bodies.push(body);
    else boxes.push(...solidBoxesOf(e));
  }
  return { boxes, bodies, evals };
}

/** Footprint of an object (all its boxes merged into one oriented rectangle in its own yaw frame). */
export function footprintOf(o: SceneObject, t: number): { cx: number; cz: number; yaw: number; hx: number; hz: number; top: number; base: number } | null {
  const def = getAssetType(o.type);
  if (!def) return null;
  const e = evaluateObject(o, t);
  const b = def.bounds(e.params);
  const c = rotateY([((b.min[0] + b.max[0]) / 2) * e.scale[0], 0, ((b.min[2] + b.max[2]) / 2) * e.scale[2]], e.rotation[1]);
  return {
    cx: e.position[0] + c[0],
    cz: e.position[2] + c[2],
    yaw: e.rotation[1],
    hx: ((b.max[0] - b.min[0]) / 2) * e.scale[0],
    hz: ((b.max[2] - b.min[2]) / 2) * e.scale[2],
    top: e.position[1] + b.max[1] * e.scale[1],
    base: e.position[1] + b.min[1] * e.scale[1],
  };
}

/** Half width of an oriented rectangle measured along a world direction (unit X/Z). */
export function extentAlong(hx: number, hz: number, yaw: number, dir: [number, number]): number {
  const ax = rotateY([1, 0, 0], yaw);
  const az = rotateY([0, 0, 1], yaw);
  return Math.abs(dir[0] * ax[0] + dir[1] * ax[2]) * hx + Math.abs(dir[0] * az[0] + dir[1] * az[2]) * hz;
}
