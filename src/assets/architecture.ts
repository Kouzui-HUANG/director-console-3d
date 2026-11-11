import * as THREE from 'three';
import type { Params } from '../core/fields.ts';
import { mulberry32 } from '../core/noise.ts';
import { MeshBuilder } from './geometry.ts';

const num = (p: Params, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);

export interface Opening {
  offset: number;
  width: number;
  height: number;
  sill: number;
}

/** Wall along local X, centered, y from 0 to height, with rectangular openings. */
export function addWall(b: MeshBuilder, length: number, height: number, thickness: number, openings: Opening[], tint = 1): void {
  const half = length / 2;
  const ops = openings
    .map((o) => {
      const x0 = Math.max(-half + 0.02, o.offset - o.width / 2);
      const x1 = Math.min(half - 0.02, o.offset + o.width / 2);
      const sill = Math.max(0, Math.min(height - 0.05, o.sill));
      const top = Math.min(height, sill + o.height);
      return { x0, x1, sill, top };
    })
    .filter((o) => o.x1 - o.x0 > 0.05)
    .sort((a, b) => a.x0 - b.x0);
  let cursor = -half;
  for (const o of ops) {
    const x0 = Math.max(cursor, o.x0);
    if (x0 > cursor + 1e-3) b.boxOn(x0 - cursor, height, thickness, (cursor + x0) / 2, 0, 0, { tint });
    const x1 = Math.max(x0, o.x1);
    const w = x1 - x0;
    if (w > 1e-3) {
      if (o.sill > 1e-3) b.boxOn(w, o.sill, thickness, (x0 + x1) / 2, 0, 0, { tint });
      if (height - o.top > 1e-3) b.boxOn(w, height - o.top, thickness, (x0 + x1) / 2, o.top, 0, { tint });
    }
    cursor = Math.max(cursor, x1);
  }
  if (half - cursor > 1e-3) b.boxOn(half - cursor, height, thickness, (cursor + half) / 2, 0, 0, { tint });
}

function openingsOf(list: unknown): Opening[] {
  if (!Array.isArray(list)) return [];
  return list.map((o) => ({
    offset: Number(o?.offset ?? 0),
    width: Number(o?.width ?? 0.9),
    height: Number(o?.height ?? 2.1),
    sill: Number(o?.sill ?? 0),
  }));
}

export function buildWall(p: Params, color: string): THREE.BufferGeometry {
  const b = new MeshBuilder(color);
  addWall(b, num(p, 'length', 4), num(p, 'height', 2.8), num(p, 'thickness', 0.2), openingsOf(p.openings));
  return b.build();
}

export interface RoomPiece {
  name: 'north' | 'south' | 'east' | 'west' | 'floor' | 'ceiling';
  geometry: THREE.BufferGeometry;
  /** Local outward normal (for editor cut-away). */
  normal: [number, number, number];
  center: [number, number, number];
}

export function buildRoomPieces(p: Params, color: string): RoomPiece[] {
  const w = num(p, 'width', 6);
  const d = num(p, 'depth', 5);
  const h = num(p, 'height', 2.8);
  const t = num(p, 'wallThickness', 0.15);
  const doors = Array.isArray(p.doors) ? (p.doors as Record<string, unknown>[]) : [];
  const windows = Array.isArray(p.windows) ? (p.windows as Record<string, unknown>[]) : [];
  const pieces: RoomPiece[] = [];
  const sides = [
    { name: 'north' as const, len: w + 2 * t, at: [0, 0, -d / 2 - t / 2], rot: 0, normal: [0, 0, -1] },
    { name: 'south' as const, len: w + 2 * t, at: [0, 0, d / 2 + t / 2], rot: 180, normal: [0, 0, 1] },
    { name: 'east' as const, len: d, at: [w / 2 + t / 2, 0, 0], rot: -90, normal: [1, 0, 0] },
    { name: 'west' as const, len: d, at: [-w / 2 - t / 2, 0, 0], rot: 90, normal: [-1, 0, 0] },
  ];
  for (const s of sides) {
    const ops: Opening[] = [
      ...doors.filter((o) => (o.wall ?? 'south') === s.name).map((o) => ({ offset: Number(o.offset ?? 0), width: Number(o.width ?? 0.9), height: Number(o.height ?? 2.1), sill: 0 })),
      ...windows.filter((o) => (o.wall ?? 'north') === s.name).map((o) => ({ offset: Number(o.offset ?? 0), width: Number(o.width ?? 1.2), height: Number(o.height ?? 1.2), sill: Number(o.sill ?? 0.9) })),
    ];
    const b = new MeshBuilder(color);
    b.transform = new THREE.Matrix4().compose(
      new THREE.Vector3(...(s.at as [number, number, number])),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (s.rot * Math.PI) / 180),
      new THREE.Vector3(1, 1, 1),
    );
    addWall(b, s.len, h, t, ops, s.name === 'north' || s.name === 'south' ? 1 : 0.94);
    b.transform = null;
    pieces.push({ name: s.name, geometry: b.build(), normal: s.normal as [number, number, number], center: [s.at[0]!, h / 2, s.at[2]!] });
  }
  if (p.floor !== false) {
    const b = new MeshBuilder(color);
    b.box(w + 2 * t, 0.06, d + 2 * t, { at: [0, -0.025, 0], tint: 0.72 });
    pieces.push({ name: 'floor', geometry: b.build(), normal: [0, -1, 0], center: [0, 0, 0] });
  }
  if (p.ceiling) {
    const b = new MeshBuilder(color);
    b.box(w + 2 * t, t, d + 2 * t, { at: [0, h + t / 2, 0], tint: 1.05 });
    pieces.push({ name: 'ceiling', geometry: b.build(), normal: [0, 1, 0], center: [0, h, 0] });
  }
  return pieces;
}

function addWindowsOnFacade(b: MeshBuilder, facadeLen: number, floors: number, fh: number, place: (x: number, y: number) => void) {
  const n = Math.max(1, Math.floor((facadeLen - 0.8) / 3));
  const spacing = facadeLen / n;
  for (let f = 0; f < floors; f++) {
    for (let i = 0; i < n; i++) place(-facadeLen / 2 + spacing * (i + 0.5), f * fh + fh * 0.32);
  }
  void b;
}

export function buildBuilding(p: Params, color: string): THREE.BufferGeometry {
  const w = num(p, 'width', 12);
  const d = num(p, 'depth', 10);
  const floors = Math.max(1, Math.round(num(p, 'floors', 5)));
  const fh = num(p, 'floorHeight', 3.2);
  const H = floors * fh;
  const b = new MeshBuilder(color);
  b.boxOn(w, H, d, 0, 0, 0);
  if (p.windows !== false) {
    const winH = Math.min(1.6, fh * 0.48);
    if (floors <= 40) {
      const ww = 1.3;
      const tz = 0.06;
      addWindowsOnFacade(b, w, floors, fh, (x, y) => {
        b.boxOn(ww, winH, tz, x, y, d / 2 + tz / 2 - 0.01, { tint: 0.42 });
        b.boxOn(ww, winH, tz, x, y, -d / 2 - tz / 2 + 0.01, { tint: 0.42 });
      });
      addWindowsOnFacade(b, d, floors, fh, (x, y) => {
        b.boxOn(tz, winH, ww, w / 2 + tz / 2 - 0.01, y, x, { tint: 0.42 });
        b.boxOn(tz, winH, ww, -w / 2 - tz / 2 + 0.01, y, x, { tint: 0.42 });
      });
    } else {
      for (let f = 0; f < floors; f++) b.boxOn(w + 0.06, winH, d + 0.06, 0, f * fh + fh * 0.32, 0, { tint: 0.5 });
    }
    b.boxOn(1.8, 2.5, 0.08, 0, 0, d / 2 + 0.03, { tint: 0.3 });
  }
  if (p.roof === 'gable') {
    const along = w >= d;
    b.add(new THREE.BoxGeometry(1, 1, 1), { at: [0, H + 0.05, 0], scale: [w + 0.2, 0.1, d + 0.2], tint: 0.7 });
    const rh = Math.min(w, d) * 0.3;
    b.prism(along ? w + 0.4 : d + 0.4, along ? d + 0.4 : w + 0.4, rh, { at: [0, H + 0.1, 0], rot: [0, along ? 0 : 90, 0], tint: 0.62 });
  } else {
    b.boxOn(w + 0.3, 0.4, d + 0.3, 0, H, 0, { tint: 0.82 });
    b.boxOn(w * 0.25, 1.4, d * 0.2, w * 0.18, H + 0.4, -d * 0.15, { tint: 0.9 });
  }
  return b.build();
}

export function buildHouse(p: Params, color: string): THREE.BufferGeometry {
  const w = num(p, 'width', 8);
  const d = num(p, 'depth', 7);
  const wh = num(p, 'wallHeight', 3);
  const rh = num(p, 'roofHeight', 2.4);
  const b = new MeshBuilder(color);
  b.boxOn(w, wh, d, 0, 0, 0);
  b.boxOn(w + 0.3, 0.25, d + 0.3, 0, -0.05, 0, { tint: 0.75 });
  b.prism(w + 0.6, d + 0.7, rh, { at: [0, wh, 0], tint: 0.5 });
  if (p.door !== false) b.boxOn(1.0, 2.1, 0.08, 0, 0.2, d / 2 + 0.03, { tint: 0.38 });
  if (p.windows !== false) {
    for (const x of [-w * 0.3, w * 0.3]) b.boxOn(1.2, 1.1, 0.07, x, 1.0, d / 2 + 0.03, { tint: 0.42 });
    for (const x of [-w * 0.25, w * 0.25]) b.boxOn(1.2, 1.1, 0.07, x, 1.0, -d / 2 - 0.03, { tint: 0.42 });
    for (const s of [1, -1]) b.boxOn(0.07, 1.1, 1.2, (s * w) / 2 + s * 0.03, 1.0, 0, { tint: 0.42 });
  }
  b.boxOn(0.6, rh * 0.8, 0.6, w * 0.25, wh + rh * 0.35, -d * 0.12, { tint: 0.7 });
  return b.build();
}

export function buildCityBlock(p: Params, color: string): THREE.BufferGeometry {
  const nx = Math.max(1, Math.round(num(p, 'blocksX', 4)));
  const nz = Math.max(1, Math.round(num(p, 'blocksZ', 4)));
  const B = num(p, 'blockSize', 36);
  const S = num(p, 'streetWidth', 12);
  const minF = Math.max(1, Math.round(num(p, 'minFloors', 2)));
  const maxF = Math.max(minF, Math.round(num(p, 'maxFloors', 22)));
  const density = num(p, 'density', 0.75);
  const rand = mulberry32(num(p, 'seed', 11) * 1013 + 7);
  const pitch = B + S;
  const TX = nx * pitch;
  const TZ = nz * pitch;
  const b = new MeshBuilder(color);
  if (p.roads !== false) b.boxOn(TX, 0.02, TZ, 0, 0, 0, { color: '#4b4e54' });
  const fh = 3.3;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const cx = -TX / 2 + pitch * (i + 0.5);
      const cz = -TZ / 2 + pitch * (j + 0.5);
      b.boxOn(B, 0.15, B, cx, 0, cz, { color: '#a2a29c' });
      const split = rand();
      const lots: { x: number; z: number; w: number; d: number }[] = [];
      if (split < 0.25) lots.push({ x: cx, z: cz, w: B, d: B });
      else if (split < 0.55) {
        lots.push({ x: cx - B / 4, z: cz, w: B / 2, d: B }, { x: cx + B / 4, z: cz, w: B / 2, d: B });
      } else {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) lots.push({ x: cx + (sx * B) / 4, z: cz + (sz * B) / 4, w: B / 2, d: B / 2 });
      }
      for (const lot of lots) {
        const m = Math.min(3, lot.w * 0.12);
        const w = lot.w - 2 * m;
        const d = lot.d - 2 * m;
        if (rand() > density) {
          b.boxOn(lot.w - 1, 0.05, lot.d - 1, lot.x, 0.15, lot.z, { color: '#6f8f55' });
          const trees = 1 + Math.floor(rand() * 3);
          for (let k = 0; k < trees; k++) {
            const tx = lot.x + (rand() - 0.5) * (lot.w - 4);
            const tz = lot.z + (rand() - 0.5) * (lot.d - 4);
            const th = 4 + rand() * 4;
            b.cylinder(0.2, 0.25, th * 0.4, 5, { at: [tx, 0.15 + th * 0.2, tz], color: '#6b4f3a' });
            b.sphere(th * 0.3, 0, { at: [tx, 0.15 + th * 0.62, tz], color: '#4f8a3c' });
          }
          continue;
        }
        const r = rand();
        const floors = Math.round(minF + (maxF - minF) * r * r * r);
        const H = floors * fh;
        const shade = 0.78 + rand() * 0.38;
        const ww = w * (0.7 + rand() * 0.3);
        const dd = d * (0.7 + rand() * 0.3);
        b.boxOn(ww, H, dd, lot.x, 0.15, lot.z, { tint: shade });
        for (let f = 0; f < floors; f++) b.boxOn(ww + 0.08, fh * 0.42, dd + 0.08, lot.x, 0.15 + f * fh + fh * 0.32, lot.z, { tint: shade * 0.55 });
        if (floors > 6 && rand() < 0.6) b.boxOn(ww * 0.4, 2.5, dd * 0.4, lot.x, 0.15 + H, lot.z, { tint: shade * 0.9 });
      }
    }
  }
  return b.build();
}

export function buildStairs(p: Params, color: string): THREE.BufferGeometry {
  const w = num(p, 'width', 1.2);
  const steps = Math.max(2, Math.round(num(p, 'steps', 12)));
  const rise = num(p, 'rise', 0.17);
  const run = num(p, 'run', 0.28);
  const b = new MeshBuilder(color);
  for (let i = 0; i < steps; i++) b.boxOn(w, rise * (i + 1), run, 0, 0, -(i + 0.5) * run, { tint: i % 2 ? 0.95 : 1 });
  return b.build();
}

export function buildPillar(p: Params, color: string): THREE.BufferGeometry {
  const h = num(p, 'height', 3);
  const r = num(p, 'radius', 0.25);
  const b = new MeshBuilder(color);
  if (p.shape === 'square') b.boxOn(r * 2, h, r * 2, 0, 0, 0);
  else b.cylinder(r, r, h, 12, { at: [0, h / 2, 0] });
  b.boxOn(r * 2.6, Math.min(0.2, h * 0.08), r * 2.6, 0, 0, 0, { tint: 0.9 });
  b.boxOn(r * 2.6, Math.min(0.2, h * 0.08), r * 2.6, 0, h - Math.min(0.2, h * 0.08), 0, { tint: 0.9 });
  return b.build();
}
