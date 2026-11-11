import * as THREE from 'three';
import type { Params } from '../core/fields.ts';
import { hillsHeight } from '../core/terrain.ts';
import { MeshBuilder } from './geometry.ts';

const num = (p: Params, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);

export function buildGround(p: Params, color: string): THREE.BufferGeometry {
  const s = num(p, 'size', 200);
  const b = new MeshBuilder(color);
  const g = new THREE.PlaneGeometry(s, s, 1, 1);
  g.rotateX(-Math.PI / 2);
  b.add(g);
  return b.build();
}

export function buildHills(p: Params, color: string): THREE.BufferGeometry {
  const s = num(p, 'size', 300);
  const seg = Math.max(8, Math.min(160, Math.round(num(p, 'segments', 56))));
  const maxH = Math.max(0.01, num(p, 'height', 25));
  const g = new THREE.PlaneGeometry(s, s, seg, seg);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, hillsHeight(p, pos.getX(i), pos.getZ(i)));
  const flat = g.toNonIndexed();
  g.dispose();
  flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  const base = new THREE.Color(color);
  const lightTop = base.clone().lerp(new THREE.Color(1, 1, 0.92), 0.25);
  const fp = flat.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(fp.count * 3);
  const c = new THREE.Color();
  for (let tri = 0; tri < fp.count; tri += 3) {
    const y = (fp.getY(tri) + fp.getY(tri + 1) + fp.getY(tri + 2)) / 3;
    const k = Math.min(1, y / maxH);
    c.copy(base).multiplyScalar(0.92 + ((tri * 7919) % 13) / 130).lerp(lightTop, k * 0.8);
    for (let v = 0; v < 3; v++) {
      colors[(tri + v) * 3] = c.r;
      colors[(tri + v) * 3 + 1] = c.g;
      colors[(tri + v) * 3 + 2] = c.b;
    }
  }
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  flat.computeBoundingBox();
  flat.computeBoundingSphere();
  return flat;
}

export function buildWater(p: Params, color: string): THREE.BufferGeometry {
  const b = new MeshBuilder(color);
  const g = new THREE.PlaneGeometry(num(p, 'width', 80), num(p, 'depth', 80), 1, 1);
  g.rotateX(-Math.PI / 2);
  b.add(g, { at: [0, 0.03, 0] });
  return b.build();
}

export function buildRoad(p: Params, color: string): THREE.BufferGeometry {
  const L = num(p, 'length', 60);
  const W = num(p, 'width', 7);
  const b = new MeshBuilder(color);
  b.boxOn(W, 0.02, L, 0, 0, 0);
  if (p.centerLine !== false) {
    const dash = 3;
    const gap = 3;
    for (let z = -L / 2 + dash / 2; z < L / 2; z += dash + gap) b.boxOn(0.15, 0.025, Math.min(dash, L / 2 - z + dash / 2), 0, 0, z, { color: '#e8e4d6' });
    b.boxOn(0.12, 0.025, L, W / 2 - 0.3, 0, 0, { color: '#e8e4d6' });
    b.boxOn(0.12, 0.025, L, -W / 2 + 0.3, 0, 0, { color: '#e8e4d6' });
  }
  if (p.sidewalks !== false) {
    for (const s of [1, -1]) {
      b.boxOn(2.5, 0.15, L, s * (W / 2 + 1.25), 0, 0, { color: '#a8a8a2' });
      b.boxOn(0.2, 0.17, L, s * (W / 2 + 0.1), 0, 0, { color: '#bdbdb6' });
    }
  }
  return b.build();
}
