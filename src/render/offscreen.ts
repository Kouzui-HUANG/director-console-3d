/**
 * Offscreen rendering at exact output sizes (snapshots, storyboards, thumbnails, MP4 export).
 * Uses its own WebGL renderer with preserveDrawingBuffer so frames can be read back safely,
 * sharing the viewport's scene graph. The viewport is re-synced afterwards (same task).
 */
import * as THREE from 'three';
import { evaluateCamera, programCameraAt } from '../core/evaluate.ts';
import type { Project } from '../core/schema.ts';
import { ShotRenderer, type ShotQuality } from './shotRenderer.ts';
import type { Viewport } from './viewport.ts';

export class OffscreenShots {
  private renderer: THREE.WebGLRenderer | null = null;
  private shot = new ShotRenderer();

  private viewport: Viewport;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
  }

  private ensure(w: number, h: number): THREE.WebGLRenderer {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'default' });
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.renderer.setClearColor('#000000', 1);
    }
    const s = this.renderer.getSize(new THREE.Vector2());
    if (s.x !== w || s.y !== h) this.renderer.setSize(w, h, false);
    return this.renderer;
  }

  /** Render `cameraId` (or the program camera) at time t into the offscreen canvas and return it. */
  render(project: Project, t: number, cameraId: string | 'program', w: number, h: number, quality: ShotQuality): { canvas: HTMLCanvasElement; cameraId: string | null } {
    const vp = this.viewport;
    const r = this.ensure(w, h);
    const camId = cameraId === 'program' ? programCameraAt(project, t) : cameraId;
    vp.sync.sync(project, t, { shadows: project.settings.environment.shadows });
    vp.prepareEnvironment(project);
    const obj = camId ? project.objects.find((o) => o.id === camId && o.type === 'camera') : undefined;
    const helpersVisible = vp.helpers.root.visible;
    vp.helpers.root.visible = false;
    const gizmoHelper = vp.gizmo.getHelper();
    const gizmoVisible = gizmoHelper.visible;
    gizmoHelper.visible = false;
    if (obj) {
      const ev = evaluateCamera(project, obj, t, w / h);
      this.shot.render(r, vp.scene, vp.env, ev, { x: 0, y: 0, w, h }, quality);
    } else {
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
      r.clear();
    }
    vp.helpers.root.visible = helpersVisible;
    gizmoHelper.visible = gizmoVisible;
    return { canvas: r.domElement, cameraId: camId };
  }

  /** Put the shared scene back to the viewport's own time. */
  restore(): void {
    this.viewport.forceSync();
  }

  dispose(): void {
    this.shot.dispose();
    this.renderer?.dispose();
    this.renderer = null;
  }
}

export function outputSize(project: Project, width?: number): [number, number] {
  const [rw, rh] = project.settings.resolution;
  if (!width || width >= rw) return [rw, rh];
  const w = Math.max(16, Math.round(width / 2) * 2);
  return [w, Math.max(16, Math.round((w * rh) / rw / 2) * 2)];
}
