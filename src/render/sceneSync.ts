/**
 * Keeps the three.js scene graph in sync with project + time.
 * Uses Immer's structural sharing: an unchanged object keeps the same reference,
 * so only changed or animated objects are touched.
 */
import * as THREE from 'three';
import { buildAsset, staticParamsKey, type BuiltAsset, type CutawayPart } from '../assets/index.ts';
import { getAssetType } from '../core/assetTypes.ts';
import { evaluateCamera, evaluateObject } from '../core/evaluate.ts';
import type { Project, SceneObject } from '../core/schema.ts';

const DEG = Math.PI / 180;

interface Entry {
  id: string;
  ref: SceneObject | null;
  key: string;
  built: BuiltAsset;
  animated: boolean;
  shadowState: boolean | null;
}

export class SceneSync {
  readonly group = new THREE.Group();
  private entries = new Map<string, Entry>();
  private lastProject: Project | null = null;
  private lastT = -1;

  constructor() {
    this.group.name = 'content';
  }

  sync(project: Project, t: number, opts: { shadows: boolean; force?: boolean }): void {
    const projectChanged = project !== this.lastProject;
    const timeChanged = t !== this.lastT;
    if (!projectChanged && !timeChanged && !opts.force) return;
    const seen = new Set<string>();
    for (const obj of project.objects) {
      seen.add(obj.id);
      let entry = this.entries.get(obj.id);
      const animated = Object.keys(obj.tracks).length > 0;
      const isCamera = obj.type === 'camera';
      const needsEval = !entry || entry.ref !== obj || animated || isCamera || opts.force;
      if (!needsEval) continue;
      const e = evaluateObject(obj, t);
      const key = `${obj.type}|${e.color}|${staticParamsKey(obj.type, e.params)}`;
      if (!entry || entry.key !== key) {
        if (entry) this.remove(entry);
        const built = buildAsset(obj.type, e.params, e.color);
        built.root.userData.objectId = obj.id;
        built.root.traverse((o) => (o.userData.objectId = obj.id));
        this.group.add(built.root);
        entry = { id: obj.id, ref: obj, key, built, animated, shadowState: null };
        this.entries.set(obj.id, entry);
      }
      entry.ref = obj;
      entry.animated = animated;
      entry.built.update?.(e.params);
      const root = entry.built.root;
      root.rotation.order = 'YXZ';
      if (isCamera) {
        const c = evaluateCamera(project, obj, t);
        root.position.set(c.position[0], c.position[1], c.position[2]);
        root.rotation.set(c.rotation[0] * DEG, c.rotation[1] * DEG, c.rotation[2] * DEG, 'YXZ');
        root.scale.set(1, 1, 1);
      } else {
        root.position.set(e.position[0], e.position[1], e.position[2]);
        root.rotation.set(e.rotation[0] * DEG, e.rotation[1] * DEG, e.rotation[2] * DEG, 'YXZ');
        root.scale.set(e.scale[0] || 1e-4, e.scale[1] || 1e-4, e.scale[2] || 1e-4);
      }
      root.visible = e.visible;
    }
    for (const [id, entry] of this.entries) if (!seen.has(id)) this.remove(entry);
    // Shadows flags (only when they change)
    for (const entry of this.entries.values()) {
      if (entry.shadowState === opts.shadows) continue;
      entry.shadowState = opts.shadows;
      const editorOnly = getAssetType(entry.ref?.type ?? '')?.editorOnly || entry.ref?.type === 'camera';
      entry.built.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = opts.shadows && !editorOnly && entry.ref?.type !== 'ground' && entry.ref?.type !== 'water';
          o.receiveShadow = opts.shadows && !editorOnly;
        }
      });
    }
    this.lastProject = project;
    this.lastT = t;
  }

  private remove(entry: Entry) {
    this.group.remove(entry.built.root);
    entry.built.dispose();
    this.entries.delete(entry.id);
  }

  objectFor(id: string): THREE.Object3D | undefined {
    return this.entries.get(id)?.built.root;
  }

  idOf(o: THREE.Object3D | null): string | null {
    let cur: THREE.Object3D | null = o;
    while (cur) {
      if (typeof cur.userData.objectId === 'string') return cur.userData.objectId;
      cur = cur.parent;
    }
    return null;
  }

  cutawayParts(): { root: THREE.Object3D; parts: CutawayPart[] }[] {
    const out: { root: THREE.Object3D; parts: CutawayPart[] }[] = [];
    for (const e of this.entries.values()) if (e.built.cutaway?.length) out.push({ root: e.built.root, parts: e.built.cutaway });
    return out;
  }

  /** Approximate scene radius (for shadow camera / fog). */
  radius(): number {
    const box = new THREE.Box3();
    for (const e of this.entries.values()) {
      if (e.ref?.type === 'ground' || e.ref?.type === 'camera') continue;
      box.expandByObject(e.built.root);
    }
    if (box.isEmpty()) return 30;
    const s = box.getBoundingSphere(new THREE.Sphere());
    return s.radius + s.center.length();
  }

  dispose(): void {
    for (const e of [...this.entries.values()]) this.remove(e);
    this.lastProject = null;
  }
}
