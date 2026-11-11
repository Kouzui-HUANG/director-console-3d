/**
 * Asset factory: object type + params + color → three.js objects.
 * Simple assets share cached geometries; everything uses the one shared material.
 */
import * as THREE from 'three';
import { getAssetType } from '../core/assetTypes.ts';
import type { Params } from '../core/fields.ts';
import { buildBuilding, buildCityBlock, buildHouse, buildPillar, buildRoomPieces, buildStairs, buildWall } from './architecture.ts';
import { buildCharacter, buildCrowd } from './characters.ts';
import { MeshBuilder, sceneMaterial } from './geometry.ts';
import {
  buildBed,
  buildBench,
  buildBox,
  buildBush,
  buildCar,
  buildChair,
  buildCone,
  buildCylinder,
  buildDesk,
  buildDoorFrame,
  buildDoorLeaf,
  buildPlane,
  buildSofa,
  buildSphere,
  buildStreetLight,
  buildTable,
  buildTree,
} from './props.ts';
import { buildGround, buildHills, buildRoad, buildWater } from './terrain.ts';

/** Layer for things only the editor camera sees (helpers, camera bodies, marks). */
export const EDITOR_LAYER = 1;

export interface CutawayPart {
  object: THREE.Object3D;
  normal: THREE.Vector3;
  center: THREE.Vector3;
}

export interface BuiltAsset {
  root: THREE.Group;
  /** Cheap per-frame update for animatable params (e.g. door angle). */
  update?(params: Params): void;
  cutaway?: CutawayPart[];
  dispose(): void;
}

type GeoBuilder = (p: Params, color: string) => THREE.BufferGeometry;

const SIMPLE: Record<string, GeoBuilder> = {
  male: (p, c) => buildCharacter('male', p, c),
  female: (p, c) => buildCharacter('female', p, c),
  child: (p, c) => buildCharacter('child', p, c),
  passerby: (p, c) => buildCharacter('passerby', p, c),
  crowd: buildCrowd,
  ground: buildGround,
  hills: buildHills,
  water: buildWater,
  road: buildRoad,
  wall: buildWall,
  building: buildBuilding,
  house: buildHouse,
  cityBlock: buildCityBlock,
  stairs: buildStairs,
  pillar: buildPillar,
  box: buildBox,
  sphere: buildSphere,
  cylinder: buildCylinder,
  cone: buildCone,
  plane: buildPlane,
  table: buildTable,
  chair: buildChair,
  sofa: buildSofa,
  bed: buildBed,
  desk: buildDesk,
  car: buildCar,
  tree: buildTree,
  bush: buildBush,
  streetLight: buildStreetLight,
  bench: buildBench,
};

// ---------------------------------------------------------------------------
// Geometry cache (shared geometry for identical type+params+color)
// ---------------------------------------------------------------------------

interface CacheEntry {
  geo: THREE.BufferGeometry;
  refs: number;
  lastUsed: number;
}
const cache = new Map<string, CacheEntry>();
const MAX_UNUSED = 96;

function acquire(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let e = cache.get(key);
  if (!e) {
    e = { geo: make(), refs: 0, lastUsed: 0 };
    cache.set(key, e);
  }
  e.refs++;
  e.lastUsed = performance.now();
  return e.geo;
}

function release(key: string): void {
  const e = cache.get(key);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  e.lastUsed = performance.now();
  const unused = [...cache.entries()].filter(([, v]) => v.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (unused.length > MAX_UNUSED) {
    const [k, v] = unused.shift()!;
    v.geo.dispose();
    cache.delete(k);
  }
}

/** Params key without continuously-animated numeric params (those are applied by update()). */
export function staticParamsKey(type: string, params: Params): string {
  const def = getAssetType(type);
  if (!def) return JSON.stringify(params);
  const skip = new Set(def.fields.filter((f) => f.kind === 'number' && f.animatable).map((f) => f.key));
  const out: Params = {};
  for (const k of Object.keys(params).sort()) if (!skip.has(k)) out[k] = params[k];
  return JSON.stringify(out);
}

function setLayer(root: THREE.Object3D, layer: number) {
  root.traverse((o) => o.layers.set(layer));
}

function cameraBody(color: string): THREE.Mesh {
  const b = new MeshBuilder(color);
  b.box(0.16, 0.2, 0.3, { at: [0, 0, 0.08] });
  b.cylinder(0.06, 0.075, 0.14, 10, { at: [0, 0, -0.12], rot: [90, 0, 0], tint: 0.45 });
  b.box(0.06, 0.05, 0.12, { at: [0, 0.125, 0.08], tint: 0.8 });
  b.sphere(0.06, 0, { at: [0, 0.2, 0.0], tint: 0.8 });
  return new THREE.Mesh(b.build(), sceneMaterial());
}

function targetMarker(size: number, color: string): THREE.Mesh {
  const b = new MeshBuilder(color);
  b.add(new THREE.OctahedronGeometry(size / 2, 0));
  b.box(size * 1.6, size * 0.06, size * 0.06, { tint: 0.7 });
  b.box(size * 0.06, size * 1.6, size * 0.06, { tint: 0.7 });
  b.box(size * 0.06, size * 0.06, size * 1.6, { tint: 0.7 });
  return new THREE.Mesh(b.build(), sceneMaterial());
}

function floorMark(size: number, color: string): THREE.Mesh {
  const b = new MeshBuilder(color);
  b.boxOn(size, 0.012, size * 0.14, 0, 0.002, 0);
  b.boxOn(size * 0.14, 0.012, size, 0, 0.002, 0);
  b.boxOn(size * 0.3, 0.014, size * 0.3, 0, 0.002, size * 0.38, { rot: [0, 45, 0], tint: 0.8 });
  return new THREE.Mesh(b.build(), sceneMaterial());
}

export function buildAsset(type: string, params: Params, color: string): BuiltAsset {
  const def = getAssetType(type);
  const root = new THREE.Group();
  root.name = type;

  if (type === 'room') {
    const pieces = buildRoomPieces(params, color);
    const cutaway: CutawayPart[] = [];
    for (const p of pieces) {
      const mesh = new THREE.Mesh(p.geometry, sceneMaterial());
      mesh.name = p.name;
      root.add(mesh);
      if (params.cutaway !== false && p.name !== 'floor') {
        cutaway.push({ object: mesh, normal: new THREE.Vector3(...p.normal), center: new THREE.Vector3(...p.center) });
      }
    }
    return { root, cutaway, dispose: () => pieces.forEach((p) => p.geometry.dispose()) };
  }

  if (type === 'door') {
    const frame = new THREE.Mesh(buildDoorFrame(params, color), sceneMaterial());
    const pivot = new THREE.Group();
    const width = typeof params.width === 'number' ? params.width : 0.9;
    pivot.position.set(-width / 2 + 0.01, 0, 0);
    const leaf = new THREE.Mesh(buildDoorLeaf(params, color), sceneMaterial());
    pivot.add(leaf);
    root.add(frame, pivot);
    return {
      root,
      update(p) {
        pivot.rotation.y = (-(typeof p.open === 'number' ? p.open : 0) * Math.PI) / 180;
      },
      dispose() {
        frame.geometry.dispose();
        leaf.geometry.dispose();
      },
    };
  }

  if (type === 'camera') {
    const body = cameraBody(color);
    root.add(body);
    setLayer(root, EDITOR_LAYER);
    return { root, dispose: () => body.geometry.dispose() };
  }
  if (type === 'target' || type === 'mark') {
    const size = typeof params.size === 'number' ? params.size : type === 'target' ? 0.4 : 0.6;
    const mesh = type === 'target' ? targetMarker(size, color) : floorMark(size, color);
    root.add(mesh);
    setLayer(root, EDITOR_LAYER);
    return { root, dispose: () => mesh.geometry.dispose() };
  }

  const make = SIMPLE[type];
  if (!make) {
    // Unknown type: visible placeholder so the scene still loads.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: '#ff00ff', wireframe: true }));
    mesh.position.y = 0.25;
    root.add(mesh);
    return { root, dispose: () => mesh.geometry.dispose() };
  }
  const key = `${type}|${color}|${staticParamsKey(type, params)}`;
  const geo = acquire(key, () => make(params, color));
  const mesh = new THREE.Mesh(geo, sceneMaterial());
  root.add(mesh);
  if (def?.editorOnly) setLayer(root, EDITOR_LAYER);
  return { root, dispose: () => release(key) };
}
