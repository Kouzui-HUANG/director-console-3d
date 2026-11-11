/** Editor-only visuals: grid, camera frustums, aim lines, motion paths, selection boxes. */
import * as THREE from 'three';
import { EDITOR_LAYER } from '../assets/index.ts';
import { cameraObjects, evaluateCamera, programCameraAt, sampleProp } from '../core/evaluate.ts';
import { lensFov } from '../core/lens.ts';
import type { Vec3 } from '../core/math.ts';
import type { Project } from '../core/schema.ts';

function onEditorLayer<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => c.layers.set(EDITOR_LAYER));
  return o;
}

function lineMat(color: string, opacity = 1): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: true, fog: false });
}

export class EditorHelpers {
  readonly root = new THREE.Group();
  private grid: THREE.Group;
  private frustums = new THREE.Group();
  private paths = new THREE.Group();
  private selection = new THREE.Group();
  private lastKey = '';
  private lastProject: Project | null = null;

  constructor() {
    this.root.name = 'editor-helpers';
    const minor = new THREE.GridHelper(200, 200, '#3b4048', '#30343a');
    (minor.material as THREE.Material).transparent = true;
    (minor.material as THREE.Material).opacity = 0.45;
    const major = new THREE.GridHelper(200, 20, '#596170', '#4a515c');
    minor.position.y = 0.003;
    major.position.y = 0.004;
    this.grid = new THREE.Group();
    this.grid.add(minor, major);
    const axisX = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-100, 0.006, 0), new THREE.Vector3(100, 0.006, 0)]), lineMat('#b5523b'));
    const axisZ = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.006, -100), new THREE.Vector3(0, 0.006, 100)]), lineMat('#3b7bb5'));
    this.grid.add(axisX, axisZ);
    this.root.add(this.grid, this.frustums, this.paths, this.selection);
    onEditorLayer(this.root);
  }

  setGridVisible(v: boolean) {
    this.grid.visible = v;
  }

  private clear(g: THREE.Group) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
  }

  update(project: Project, t: number, selection: string[], objectFor: (id: string) => THREE.Object3D | undefined): void {
    const key = `${t}|${selection.join(',')}`;
    if (key === this.lastKey && this.lastProject === project) return;
    this.lastKey = key;
    this.lastProject = project;
    this.clear(this.frustums);
    this.clear(this.paths);
    this.clear(this.selection);
    const [rw, rh] = project.settings.resolution;
    const aspect = rw / rh;
    const live = programCameraAt(project, t);

    for (const c of cameraObjects(project)) {
      const e = evaluateCamera(project, c, t, aspect);
      const selected = selection.includes(c.id);
      const color = c.id === live ? '#ff4d4d' : selected ? '#ffd23f' : c.color;
      const len = selected ? 2.2 : 1.4;
      const pts: THREE.Vector3[] = [];
      const fov = lensFov(e.focalLength, e.sensor, aspect);
      const hx = e.lens === 'standard' ? Math.tan((fov.hfov * Math.PI) / 360) * len : len * 1.2;
      const hy = e.lens === 'standard' ? Math.tan((fov.vfov * Math.PI) / 360) * len : len * 1.2 / aspect;
      const corners = [new THREE.Vector3(-hx, -hy, -len), new THREE.Vector3(hx, -hy, -len), new THREE.Vector3(hx, hy, -len), new THREE.Vector3(-hx, hy, -len)];
      for (const k of corners) pts.push(new THREE.Vector3(), k);
      for (let i = 0; i < 4; i++) pts.push(corners[i]!, corners[(i + 1) % 4]!);
      pts.push(new THREE.Vector3(-hx * 0.35, hy * 1.08, -len), new THREE.Vector3(0, hy * 1.4, -len), new THREE.Vector3(0, hy * 1.4, -len), new THREE.Vector3(hx * 0.35, hy * 1.08, -len));
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat(color, selected || c.id === live ? 1 : 0.7));
      lines.position.set(...e.position);
      lines.rotation.set((e.rotation[0] * Math.PI) / 180, (e.rotation[1] * Math.PI) / 180, (e.rotation[2] * Math.PI) / 180, 'YXZ');
      this.frustums.add(lines);
      if (e.aimPoint && (selected || c.id === live)) {
        const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...e.position), new THREE.Vector3(...e.aimPoint)]);
        const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.15, fog: false }));
        l.computeLineDistances();
        this.frustums.add(l);
      }
    }

    for (const id of selection) {
      const obj = project.objects.find((o) => o.id === id);
      if (!obj) continue;
      const root = objectFor(id);
      if (root && obj.type !== 'camera') {
        const box = new THREE.Box3().setFromObject(root);
        if (!box.isEmpty()) this.selection.add(new THREE.Box3Helper(box, new THREE.Color('#ffd23f')));
      }
      const track = obj.tracks.position;
      if (track && track.keys.length > 1) {
        const t0 = track.keys[0]!.t;
        const t1 = track.keys[track.keys.length - 1]!.t;
        const steps = Math.min(400, Math.max(12, Math.round((t1 - t0) * project.settings.fps)));
        const samples: THREE.Vector3[] = [];
        for (let i = 0; i <= steps; i++) {
          const p = sampleProp(obj, 'position', t0 + ((t1 - t0) * i) / steps) as Vec3;
          samples.push(new THREE.Vector3(p[0], p[1] + 0.03, p[2]));
        }
        this.paths.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(samples), lineMat('#ffd23f', 0.9)));
        const keyPts = track.keys.map((k) => {
          const v = k.v as Vec3;
          return new THREE.Vector3(v[0], v[1] + 0.03, v[2]);
        });
        const pg = new THREE.BufferGeometry().setFromPoints(keyPts);
        this.paths.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: '#ffffff', size: 7, sizeAttenuation: false, fog: false, depthTest: false })));
        const now = sampleProp(obj, 'position', t) as Vec3;
        const ng = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(now[0], now[1] + 0.03, now[2])]);
        this.paths.add(new THREE.Points(ng, new THREE.PointsMaterial({ color: '#ff4d4d', size: 9, sizeAttenuation: false, fog: false, depthTest: false })));
      }
    }
    onEditorLayer(this.root);
  }

  dispose() {
    this.clear(this.frustums);
    this.clear(this.paths);
    this.clear(this.selection);
  }
}
