/**
 * Low-poly mesh assembly. Every object is merged into ONE non-indexed BufferGeometry with
 * per-vertex colors, drawn with ONE shared Lambert material → one draw call per object.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../core/math.ts';

const DEG = Math.PI / 180;

export interface PartOptions {
  /** Center position of the part. */
  at?: Vec3;
  /** Euler degrees, order YXZ. */
  rot?: Vec3;
  scale?: Vec3;
  /** Full transform (overrides at/rot/scale). */
  matrix?: THREE.Matrix4;
  /** Brightness multiplier of the base color. */
  tint?: number;
  /** Absolute color (hex) instead of a tint of the base color. */
  color?: string;
}

const tmpColor = new THREE.Color();

export class MeshBuilder {
  private parts: THREE.BufferGeometry[] = [];
  private base: THREE.Color;
  /** Applied to every part added afterwards (used to place many figures in one mesh). */
  transform: THREE.Matrix4 | null = null;

  constructor(baseColor: string) {
    this.base = new THREE.Color(baseColor);
  }

  setBaseColor(hex: string): this {
    this.base = new THREE.Color(hex);
    return this;
  }

  add(geo: THREE.BufferGeometry, o: PartOptions = {}): this {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    const m =
      o.matrix ??
      new THREE.Matrix4().compose(
        new THREE.Vector3(...(o.at ?? [0, 0, 0])),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((o.rot?.[0] ?? 0) * DEG, (o.rot?.[1] ?? 0) * DEG, (o.rot?.[2] ?? 0) * DEG, 'YXZ')),
        new THREE.Vector3(...(o.scale ?? [1, 1, 1])),
      );
    g.applyMatrix4(m);
    if (this.transform) g.applyMatrix4(this.transform);
    g.computeVertexNormals();
    if (o.color) tmpColor.set(o.color);
    else tmpColor.copy(this.base).multiplyScalar(o.tint ?? 1);
    if ((o.tint ?? 1) > 1 && !o.color) {
      // lighten toward white instead of oversaturating
      const k = (o.tint ?? 1) - 1;
      tmpColor.copy(this.base).lerp(new THREE.Color(1, 1, 1), k);
    }
    const n = g.attributes.position!.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts.push(g);
    if (g !== geo) geo.dispose();
    return this;
  }

  /** Box centered at `at`. */
  box(w: number, h: number, d: number, o: PartOptions = {}): this {
    return this.add(new THREE.BoxGeometry(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4)), o);
  }

  /** Box whose bottom face sits at y0. */
  boxOn(w: number, h: number, d: number, x: number, y0: number, z: number, o: PartOptions = {}): this {
    return this.box(w, h, d, { ...o, at: [x, y0 + h / 2, z] });
  }

  cylinder(rTop: number, rBottom: number, h: number, sides: number, o: PartOptions = {}): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, Math.max(3, sides), 1), o);
  }

  sphere(r: number, detail: number, o: PartOptions = {}): this {
    return this.add(new THREE.IcosahedronGeometry(r, detail), o);
  }

  cone(r: number, h: number, sides: number, o: PartOptions = {}): this {
    return this.add(new THREE.ConeGeometry(r, h, Math.max(3, sides), 1), o);
  }

  /** Cylinder spanning from a to b. */
  limb(a: THREE.Vector3, b: THREE.Vector3, rA: number, rB: number, sides: number, o: PartOptions = {}): this {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-5) return this;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return this.add(new THREE.CylinderGeometry(rB, rA, len, sides, 1), { ...o, matrix: m });
  }

  /** Triangular prism (gable roof): ridge along X, width along Z, base at y=0. */
  prism(lengthX: number, widthZ: number, height: number, o: PartOptions = {}): this {
    const shape = new THREE.Shape();
    shape.moveTo(-widthZ / 2, 0);
    shape.lineTo(widthZ / 2, 0);
    shape.lineTo(0, height);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: lengthX, bevelEnabled: false });
    g.translate(0, 0, -lengthX / 2);
    g.rotateY(Math.PI / 2);
    return this.add(g, o);
  }

  get partCount(): number {
    return this.parts.length;
  }

  build(): THREE.BufferGeometry {
    if (this.parts.length === 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
      return g;
    }
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (!merged) throw new Error('mergeGeometries failed (attribute mismatch)');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}

/** The one shared material for all scene geometry. */
let sharedMaterial: THREE.MeshLambertMaterial | null = null;
export function sceneMaterial(): THREE.MeshLambertMaterial {
  if (!sharedMaterial) sharedMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return sharedMaterial;
}

export function meshFrom(builder: MeshBuilder, material: THREE.Material = sceneMaterial()): THREE.Mesh {
  const mesh = new THREE.Mesh(builder.build(), material);
  mesh.matrixAutoUpdate = true;
  return mesh;
}
