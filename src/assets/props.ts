import * as THREE from 'three';
import type { Params } from '../core/fields.ts';
import { mulberry32 } from '../core/noise.ts';
import { MeshBuilder } from './geometry.ts';

const num = (p: Params, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);

export function buildBox(p: Params, color: string) {
  const b = new MeshBuilder(color);
  b.boxOn(num(p, 'width', 1), num(p, 'height', 1), num(p, 'depth', 1), 0, 0, 0);
  return b.build();
}

export function buildSphere(p: Params, color: string) {
  const r = num(p, 'radius', 0.5);
  const b = new MeshBuilder(color);
  b.sphere(r, Math.max(0, Math.min(3, Math.round(num(p, 'detail', 1)))), { at: [0, r, 0] });
  return b.build();
}

export function buildCylinder(p: Params, color: string) {
  const r = num(p, 'radius', 0.5);
  const h = num(p, 'height', 1);
  const b = new MeshBuilder(color);
  b.cylinder(r, r, h, Math.round(num(p, 'sides', 10)), { at: [0, h / 2, 0] });
  return b.build();
}

export function buildCone(p: Params, color: string) {
  const r = num(p, 'radius', 0.5);
  const h = num(p, 'height', 1);
  const b = new MeshBuilder(color);
  b.cone(r, h, Math.round(num(p, 'sides', 10)), { at: [0, h / 2, 0] });
  return b.build();
}

export function buildPlane(p: Params, color: string) {
  const w = num(p, 'width', 2);
  const h = num(p, 'height', 2);
  const b = new MeshBuilder(color);
  if (p.orientation === 'wall') b.boxOn(w, h, 0.02, 0, 0, 0);
  else b.boxOn(w, 0.02, h, 0, 0, 0);
  return b.build();
}

export function buildTable(p: Params, color: string) {
  const w = num(p, 'width', 1.4);
  const d = num(p, 'depth', 0.8);
  const h = num(p, 'height', 0.75);
  const b = new MeshBuilder(color);
  if (p.shape === 'round') {
    b.cylinder(w / 2, w / 2, 0.04, 16, { at: [0, h - 0.02, 0] });
    b.cylinder(0.05, 0.05, h - 0.04, 6, { at: [0, (h - 0.04) / 2, 0], tint: 0.8 });
    b.cylinder(w * 0.22, w * 0.25, 0.04, 10, { at: [0, 0.02, 0], tint: 0.8 });
  } else {
    b.boxOn(w, 0.04, d, 0, h - 0.04, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxOn(0.05, h - 0.04, 0.05, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06), { tint: 0.8 });
  }
  return b.build();
}

export function buildChair(p: Params, color: string) {
  const sh = num(p, 'seatHeight', 0.45);
  const b = new MeshBuilder(color);
  b.boxOn(0.44, 0.05, 0.44, 0, sh - 0.05, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxOn(0.04, sh - 0.05, 0.04, sx * 0.19, 0, sz * 0.19, { tint: 0.8 });
  b.boxOn(0.44, 0.48, 0.04, 0, sh, -0.2, { tint: 0.95 });
  return b.build();
}

export function buildSofa(p: Params, color: string) {
  const w = num(p, 'width', 2.1);
  const b = new MeshBuilder(color);
  b.boxOn(w, 0.25, 0.9, 0, 0.08, 0, { tint: 0.85 });
  b.boxOn(w - 0.4, 0.14, 0.62, 0, 0.33, 0.1, { tint: 1.1 });
  b.boxOn(w, 0.5, 0.22, 0, 0.33, -0.34);
  for (const s of [1, -1]) b.boxOn(0.2, 0.32, 0.9, s * (w / 2 - 0.1), 0.33, 0, { tint: 0.95 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxOn(0.06, 0.08, 0.06, sx * (w / 2 - 0.08), 0, sz * 0.38, { color: '#3a3c40' });
  return b.build();
}

export function buildBed(p: Params, color: string) {
  const w = num(p, 'width', 1.6);
  const L = num(p, 'length', 2.05);
  const wood = '#8a6a4a';
  const b = new MeshBuilder(color);
  b.boxOn(w, 0.3, L, 0, 0, 0, { color: wood });
  b.boxOn(w - 0.06, 0.22, L - 0.1, 0, 0.3, 0.02);
  b.boxOn(w - 0.08, 0.06, L * 0.62, 0, 0.52, L * 0.18, { tint: 0.85 });
  for (const s of [-1, 1]) b.boxOn(w * 0.4, 0.1, 0.35, (s * w) / 4.4, 0.52, -L / 2 + 0.3, { tint: 1.12 });
  b.boxOn(w, 1.0, 0.08, 0, 0, -L / 2 - 0.04, { color: wood });
  return b.build();
}

export function buildDesk(p: Params, color: string) {
  const w = num(p, 'width', 1.4);
  const d = num(p, 'depth', 0.7);
  const b = new MeshBuilder(color);
  b.boxOn(w, 0.04, d, 0, 0.71, 0);
  for (const s of [-1, 1]) b.boxOn(0.04, 0.71, d - 0.04, s * (w / 2 - 0.02), 0, 0, { tint: 0.85 });
  b.boxOn(w - 0.08, 0.35, 0.02, 0, 0.36, -d / 2 + 0.03, { tint: 0.9 });
  if (p.monitor !== false) {
    b.boxOn(0.18, 0.02, 0.14, 0, 0.75, -d / 2 + 0.16, { color: '#2b2d31' });
    b.boxOn(0.04, 0.18, 0.04, 0, 0.75, -d / 2 + 0.14, { color: '#2b2d31' });
    b.boxOn(0.58, 0.34, 0.03, 0, 0.9, -d / 2 + 0.14, { color: '#26282c' });
    b.boxOn(0.42, 0.015, 0.14, 0, 0.75, -d / 2 + 0.42, { color: '#3a3c40' });
  }
  return b.build();
}

export function buildDoorFrame(p: Params, color: string) {
  const w = num(p, 'width', 0.9);
  const h = num(p, 'height', 2.1);
  const b = new MeshBuilder(color);
  for (const s of [-1, 1]) b.boxOn(0.06, h + 0.06, 0.12, s * (w / 2 + 0.03), 0, 0, { tint: 0.82 });
  b.boxOn(w + 0.12, 0.06, 0.12, 0, h, 0, { tint: 0.82 });
  return b.build();
}

/** Door leaf with its hinge at the local origin, extending toward +X. */
export function buildDoorLeaf(p: Params, color: string) {
  const w = num(p, 'width', 0.9) - 0.02;
  const h = num(p, 'height', 2.1) - 0.01;
  const b = new MeshBuilder(color);
  b.boxOn(w, h, 0.045, w / 2, 0, 0);
  b.boxOn(0.03, 0.03, 0.12, w - 0.09, 1.0, 0, { tint: 0.45 });
  b.boxOn(w * 0.7, h * 0.32, 0.055, w / 2, h * 0.58, 0, { tint: 0.92 });
  return b.build();
}

export function buildCar(p: Params, color: string) {
  const b = new MeshBuilder(color);
  const glass = '#2b3036';
  const tire = '#1d1f22';
  const wheel = (x: number, z: number, r: number, wdt: number) => {
    b.cylinder(r, r, wdt, 10, { at: [x, r, z], rot: [0, 0, 90], color: tire });
    b.cylinder(r * 0.55, r * 0.55, wdt + 0.02, 8, { at: [x, r, z], rot: [0, 0, 90], color: '#8b8f96' });
  };
  const lights = (W: number, L: number, y: number) => {
    for (const s of [-1, 1]) {
      b.boxOn(0.3, 0.12, 0.04, s * (W / 2 - 0.25), y, L / 2, { tint: 1.7 });
      b.boxOn(0.3, 0.12, 0.04, s * (W / 2 - 0.25), y, -L / 2, { color: '#b8302c' });
    }
  };
  switch (p.style) {
    case 'suv': {
      const W = 1.9, L = 4.7;
      b.boxOn(W, 0.75, L, 0, 0.35, 0);
      b.boxOn(W * 0.9, 0.62, L * 0.62, 0, 1.1, -0.2, { color: glass });
      b.boxOn(W * 0.92, 0.06, L * 0.62, 0, 1.69, -0.2);
      lights(W, L, 0.85);
      for (const x of [-1, 1]) for (const z of [-1, 1]) wheel(x * (W / 2 - 0.15), z * (L / 2 - 0.85), 0.38, 0.26);
      break;
    }
    case 'van': {
      const W = 2.0, L = 5.0;
      b.boxOn(W, 1.7, L, 0, 0.35, 0);
      b.boxOn(W * 0.92, 0.6, 0.06, 0, 1.25, L / 2 + 0.01, { color: glass });
      for (const s of [-1, 1]) b.boxOn(0.06, 0.5, L * 0.55, s * (W / 2 + 0.01), 1.35, 0.4, { color: glass });
      lights(W, L, 0.7);
      for (const x of [-1, 1]) for (const z of [-1, 1]) wheel(x * (W / 2 - 0.15), z * (L / 2 - 0.9), 0.36, 0.26);
      break;
    }
    case 'truck': {
      const W = 2.4, L = 7.0;
      b.boxOn(W, 2.0, 2.0, 0, 0.5, L / 2 - 1.0);
      b.boxOn(W * 0.92, 0.7, 0.06, 0, 1.6, L / 2 + 0.01, { color: glass });
      b.boxOn(W, 2.5, L - 2.2, 0, 0.5, -1.1, { color: '#d8d8d4' });
      b.boxOn(W * 0.6, 0.25, L, 0, 0.3, 0, { color: '#3a3c40' });
      lights(W, L, 0.8);
      for (const x of [-1, 1]) for (const z of [L / 2 - 1.0, -L / 2 + 1.2, -L / 2 + 2.3]) wheel(x * (W / 2 - 0.2), z, 0.48, 0.32);
      break;
    }
    default: {
      const W = 1.8, L = 4.5;
      b.boxOn(W, 0.62, L, 0, 0.32, 0);
      b.boxOn(W * 0.84, 0.48, L * 0.5, 0, 0.94, -0.25, { color: glass });
      b.boxOn(W * 0.86, 0.05, L * 0.44, 0, 1.4, -0.3);
      lights(W, L, 0.68);
      for (const x of [-1, 1]) for (const z of [-1, 1]) wheel(x * (W / 2 - 0.12), z * (L / 2 - 0.8), 0.32, 0.22);
    }
  }
  return b.build();
}

export function buildTree(p: Params, color: string) {
  const h = num(p, 'height', 6);
  const trunk = typeof p.trunkColor === 'string' ? (p.trunkColor as string) : '#6b4f3a';
  const rand = mulberry32(num(p, 'seed', 1) * 131 + 5);
  const b = new MeshBuilder(color);
  if (p.style === 'pine') {
    b.cylinder(0.05 * h * 0.5, 0.06 * h * 0.5, h * 0.3, 6, { at: [0, h * 0.15, 0], color: trunk });
    const tiers = 3;
    for (let i = 0; i < tiers; i++) {
      const r = h * (0.22 - i * 0.05);
      const ch = h * 0.38;
      b.cone(r, ch, 7, { at: [0, h * 0.25 + i * h * 0.2 + ch / 2, 0], rot: [0, rand() * 60, 0], tint: 0.9 + i * 0.07 });
    }
  } else {
    b.cylinder(0.04 * h * 0.6, 0.06 * h * 0.6, h * 0.5, 6, { at: [0, h * 0.25, 0], color: trunk });
    const r = h * 0.28;
    b.sphere(r, 1, { at: [0, h * 0.64, 0], scale: [1, 0.9, 1] });
    for (let i = 0; i < 2; i++) {
      const a = rand() * Math.PI * 2;
      b.sphere(r * (0.55 + rand() * 0.2), 0, { at: [Math.cos(a) * r * 0.6, h * (0.58 + rand() * 0.15), Math.sin(a) * r * 0.6], tint: 0.85 + rand() * 0.25 });
    }
  }
  return b.build();
}

export function buildBush(p: Params, color: string) {
  const s = num(p, 'size', 1.2);
  const rand = mulberry32(num(p, 'seed', 2) * 97 + 1);
  const b = new MeshBuilder(color);
  b.sphere(s * 0.45, 0, { at: [0, s * 0.38, 0], scale: [1, 0.8, 1] });
  for (let i = 0; i < 2; i++) {
    const a = rand() * Math.PI * 2;
    b.sphere(s * 0.3, 0, { at: [Math.cos(a) * s * 0.3, s * 0.3, Math.sin(a) * s * 0.3], tint: 0.88 + rand() * 0.2 });
  }
  return b.build();
}

export function buildStreetLight(p: Params, color: string) {
  const h = num(p, 'height', 5);
  const b = new MeshBuilder(color);
  b.cylinder(0.14, 0.18, 0.4, 8, { at: [0, 0.2, 0] });
  b.cylinder(0.06, 0.08, h, 8, { at: [0, h / 2, 0] });
  if (p.arm !== false) {
    b.boxOn(1.2, 0.08, 0.08, 0.6, h - 0.1, 0);
    b.boxOn(0.45, 0.14, 0.25, 1.15, h - 0.24, 0, { tint: 0.9 });
    b.boxOn(0.36, 0.03, 0.18, 1.15, h - 0.27, 0, { color: '#fff2c4' });
  } else {
    b.sphere(0.22, 1, { at: [0, h + 0.1, 0], color: '#fff2c4' });
  }
  return b.build();
}

export function buildBench(p: Params, color: string) {
  const w = num(p, 'width', 1.8);
  const metal = '#3a3c40';
  const b = new MeshBuilder(color);
  for (let i = 0; i < 3; i++) b.boxOn(w, 0.04, 0.12, 0, 0.44, -0.12 + i * 0.14);
  for (let i = 0; i < 2; i++) b.box(w, 0.1, 0.03, { at: [0, 0.6 + i * 0.16, -0.24], rot: [-12, 0, 0] });
  for (const s of [-1, 1]) {
    b.boxOn(0.05, 0.44, 0.45, s * (w / 2 - 0.1), 0, 0, { color: metal });
    b.box(0.05, 0.45, 0.05, { at: [s * (w / 2 - 0.1), 0.65, -0.25], rot: [-12, 0, 0], color: metal });
  }
  return b.build();
}

void THREE;
