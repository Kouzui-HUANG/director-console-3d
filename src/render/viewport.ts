/**
 * The interactive 3D viewport: editor / top / camera / program / multiview modes,
 * render-on-demand loop, picking, transform gizmo and picture-in-picture program monitor.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { getAssetType } from '../core/assetTypes.ts';
import { cameraObjects, evaluateCamera, programCameraAt } from '../core/evaluate.ts';
import type { Vec3 } from '../core/math.ts';
import type { Project } from '../core/schema.ts';
import { EditorHelpers } from './editorHelpers.ts';
import { EnvironmentRig } from './environment.ts';
import { SceneSync } from './sceneSync.ts';
import { ShotRenderer, type ShotQuality } from './shotRenderer.ts';

const DEG = Math.PI / 180;
const TERRAIN = new Set(['ground', 'hills', 'water', 'road', 'cityBlock']);

export type ViewMode = 'editor' | 'top' | 'camera' | 'program' | 'multiview';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameInfo {
  mode: ViewMode;
  width: number;
  height: number;
  shot: { cameraId: string; rect: ScreenRect } | null;
  pip: { cameraId: string; rect: ScreenRect } | null;
  cells: { cameraId: string; rect: ScreenRect; live: boolean; name: string }[];
  labels: { id: string; text: string; x: number; y: number; live: boolean }[];
}

export interface ViewportOptions {
  pixelRatioCap: number;
  pip: boolean;
  shadows: boolean;
  grid: boolean;
}

export interface TransformChange {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}

export interface ViewportCallbacks {
  onPick(id: string | null, additive: boolean): void;
  onTransform(id: string, change: TransformChange, phase: 'start' | 'change' | 'end'): void;
  onCellPick?(cameraId: string, double: boolean): void;
  onFrame?(info: FrameInfo): void;
  onContextLost?(lost: boolean): void;
}

export function fitRect(aspect: number, w: number, h: number, margin = 0): ScreenRect {
  const aw = w - margin * 2;
  const ah = h - margin * 2;
  let rw = aw;
  let rh = aw / aspect;
  if (rh > ah) {
    rh = ah;
    rw = ah * aspect;
  }
  return { x: Math.round((w - rw) / 2), y: Math.round((h - rh) / 2), w: Math.max(1, Math.round(rw)), h: Math.max(1, Math.round(rh)) };
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sync = new SceneSync();
  readonly env: EnvironmentRig;
  readonly shot = new ShotRenderer();
  readonly helpers = new EditorHelpers();
  readonly editorCam = new THREE.PerspectiveCamera(50, 1, 0.05, 6000);
  readonly topCam = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 6000);
  readonly orbit: OrbitControls;
  readonly topControls: OrbitControls;
  readonly gizmo: TransformControls;
  private gizmoHelper: THREE.Object3D;
  mode: ViewMode = 'editor';
  viewCamera: string | null = null;
  gizmoMode: GizmoMode = 'translate';
  private project: Project | null = null;
  private time = 0;
  private selection: string[] = [];
  private dirty = true;
  private rafId = 0;
  private disposed = false;
  private width = 1;
  private height = 1;
  private opts: ViewportOptions;
  private cb: ViewportCallbacks;
  private radiusFor: Project | null = null;
  private sceneRadius = 30;
  private dragging = false;
  private dragId: string | null = null;
  private down: { x: number; y: number; button: number } | null = null;
  private lastInfo: FrameInfo | null = null;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  readonly canvas: HTMLCanvasElement;

  private container: HTMLElement;

  constructor(container: HTMLElement, cb: ViewportCallbacks, opts: ViewportOptions) {
    this.container = container;
    this.cb = cb;
    this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'default' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.pixelRatioCap));
    this.renderer.setClearColor('#0d0e10', 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '3D 視窗');
    this.canvas.dataset.testid = 'viewport-canvas';
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);
    this.env = new EnvironmentRig(this.scene);
    this.scene.add(this.sync.group, this.helpers.root);

    this.editorCam.position.set(9, 7, 13);
    this.editorCam.layers.enable(1);
    this.topCam.position.set(0, 400, 0);
    this.topCam.up.set(0, 0, -1);
    this.topCam.lookAt(0, 0, 0);
    this.topCam.layers.enable(1);

    this.orbit = new OrbitControls(this.editorCam, this.canvas);
    this.orbit.target.set(0, 1, 0);
    this.orbit.enableDamping = false;
    this.orbit.screenSpacePanning = true;
    this.orbit.addEventListener('change', () => this.requestRender());
    this.orbit.update();

    this.topControls = new OrbitControls(this.topCam, this.canvas);
    this.topControls.enableRotate = false;
    this.topControls.screenSpacePanning = true;
    this.topControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.topControls.zoomToCursor = true;
    this.topControls.enabled = false;
    this.topControls.addEventListener('change', () => this.requestRender());

    this.gizmo = new TransformControls(this.editorCam, this.canvas);
    this.gizmo.setSize(0.9);
    this.gizmo.setSpace('local');
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('change', () => this.requestRender());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = Boolean((e as unknown as { value: boolean }).value);
      this.dragging = dragging;
      this.orbit.enabled = !dragging && this.mode === 'editor';
      this.topControls.enabled = !dragging && this.mode === 'top';
      if (dragging) {
        this.dragId = this.selection.length === 1 ? this.selection[0]! : null;
        if (this.dragId) this.cb.onTransform(this.dragId, {}, 'start');
      } else if (this.dragId) {
        this.cb.onTransform(this.dragId, {}, 'end');
        this.dragId = null;
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      const o = this.gizmo.object;
      if (!o || !this.dragId) return;
      const change: TransformChange = {};
      if (this.gizmo.mode === 'translate') change.position = [o.position.x, o.position.y, o.position.z].map((v) => Math.round(v * 1000) / 1000) as Vec3;
      if (this.gizmo.mode === 'rotate') {
        const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ');
        change.rotation = [e.x / DEG, e.y / DEG, e.z / DEG].map((v) => Math.round(v * 100) / 100) as Vec3;
      }
      if (this.gizmo.mode === 'scale') change.scale = [o.scale.x, o.scale.y, o.scale.z].map((v) => Math.max(0.001, Math.round(v * 1000) / 1000)) as Vec3;
      this.cb.onTransform(this.dragId, change, 'change');
    });

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('dblclick', this.onDblClick);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  setOptions(opts: Partial<ViewportOptions>) {
    this.opts = { ...this.opts, ...opts };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.opts.pixelRatioCap));
    this.helpers.setGridVisible(this.opts.grid);
    this.resize();
    this.forceSync();
  }

  setState(project: Project, time: number, selection: string[]): void {
    const changed = project !== this.project || time !== this.time || selection !== this.selection;
    if (!changed) return;
    this.project = project;
    this.time = time;
    this.selection = selection;
    this.sync.sync(project, time, { shadows: project.settings.environment.shadows && this.opts.shadows });
    this.helpers.update(project, time, selection, (id) => this.sync.objectFor(id));
    this.updateGizmo();
    this.requestRender();
  }

  forceSync(): void {
    if (!this.project) return;
    this.sync.sync(this.project, this.time, { shadows: this.project.settings.environment.shadows && this.opts.shadows, force: true });
    this.requestRender();
  }

  setMode(mode: ViewMode, cameraId: string | null = this.viewCamera): void {
    this.mode = mode;
    this.viewCamera = cameraId;
    this.orbit.enabled = mode === 'editor';
    this.topControls.enabled = mode === 'top';
    this.gizmo.camera = mode === 'top' ? this.topCam : this.editorCam;
    this.updateGizmo();
    this.requestRender();
  }

  setGizmoMode(m: GizmoMode): void {
    this.gizmoMode = m;
    this.updateGizmo();
    this.requestRender();
  }

  setSnap(on: boolean): void {
    this.gizmo.setTranslationSnap(on ? 0.25 : null);
    this.gizmo.setRotationSnap(on ? 15 * DEG : null);
    this.gizmo.setScaleSnap(on ? 0.25 : null);
  }

  private updateGizmo(): void {
    const p = this.project;
    const id = this.selection.length === 1 ? this.selection[0]! : null;
    const obj = id && p ? p.objects.find((o) => o.id === id) : undefined;
    const root = id ? this.sync.objectFor(id) : undefined;
    const editable = obj && root && !obj.locked && (this.mode === 'editor' || this.mode === 'top') && !(obj.type === 'camera' && obj.camera?.follow);
    if (!editable) {
      if (this.gizmo.object && !this.dragging) this.gizmo.detach();
      return;
    }
    let mode: GizmoMode = this.gizmoMode;
    if (obj.type === 'camera' && (mode === 'scale' || (mode === 'rotate' && obj.camera?.lookAt))) mode = 'translate';
    if (this.gizmo.object !== root && !this.dragging) this.gizmo.attach(root);
    this.gizmo.setMode(mode);
    this.gizmo.showY = !(this.mode === 'top' && mode === 'translate');
    this.gizmo.showX = !(this.mode === 'top' && mode === 'rotate');
    this.gizmo.showZ = !(this.mode === 'top' && mode === 'rotate');
  }

  requestRender(): void {
    this.dirty = true;
  }

  private loop = () => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.renderFrame();
    } catch (e) {
      console.error('render failed', e);
    }
  };

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.opts.pixelRatioCap));
    this.renderer.setSize(w, h);
    this.editorCam.aspect = w / h;
    this.editorCam.updateProjectionMatrix();
    this.updateTopFrustum();
    this.requestRender();
  }

  private updateTopFrustum(): void {
    const half = 30;
    const a = this.width / this.height;
    this.topCam.left = -half * a;
    this.topCam.right = half * a;
    this.topCam.top = half;
    this.topCam.bottom = -half;
    this.topCam.updateProjectionMatrix();
  }

  private frameAspect(): number {
    const r = this.project?.settings.resolution ?? [16, 9];
    return r[0] / r[1];
  }

  private applyCutaway(cam: THREE.Camera, top: boolean): () => void {
    const hidden: THREE.Object3D[] = [];
    const camPos = cam.position;
    for (const { root, parts } of this.sync.cutawayParts()) {
      if (!root.visible) continue;
      root.updateMatrixWorld(true);
      for (const part of parts) {
        if (!part.object.visible) continue;
        const n = part.normal.clone().transformDirection(root.matrixWorld);
        const c = part.center.clone().applyMatrix4(root.matrixWorld);
        const toCam = top ? new THREE.Vector3(0, 1, 0) : camPos.clone().sub(c);
        if (n.dot(toCam) > 0.001) {
          part.object.visible = false;
          hidden.push(part.object);
        }
      }
    }
    return () => hidden.forEach((o) => (o.visible = true));
  }

  /** Apply sky/lights/fog for a project (also used by offscreen renders while the tab is hidden). */
  prepareEnvironment(project: Project): void {
    if (this.radiusFor !== project) {
      this.sceneRadius = this.sync.radius();
      this.radiusFor = project;
    }
    this.env.apply(this.scene, project.settings.environment, this.sceneRadius);
  }

  /** Render one shot camera into a rect (CSS px, top-left origin). */
  private renderShot(cameraId: string, rect: ScreenRect, quality: ShotQuality): boolean {
    const p = this.project;
    const obj = p?.objects.find((o) => o.id === cameraId && o.type === 'camera');
    if (!p || !obj) return false;
    const ev = evaluateCamera(p, obj, this.time, rect.w / rect.h);
    const helpersVisible = this.helpers.root.visible;
    const gizmoVisible = this.gizmoHelper.visible;
    this.helpers.root.visible = false;
    this.gizmoHelper.visible = false;
    this.shot.render(this.renderer, this.scene, this.env, ev, { x: rect.x, y: this.height - rect.y - rect.h, w: rect.w, h: rect.h }, quality);
    this.helpers.root.visible = helpersVisible;
    this.gizmoHelper.visible = gizmoVisible;
    return true;
  }

  private renderFrame(): void {
    const p = this.project;
    const r = this.renderer;
    const w = this.width;
    const h = this.height;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    const info: FrameInfo = { mode: this.mode, width: w, height: h, shot: null, pip: null, cells: [], labels: [] };
    if (!p) {
      r.clear();
      return;
    }
    this.prepareEnvironment(p);
    const aspect = this.frameAspect();
    const live = programCameraAt(p, this.time);

    if (this.mode === 'editor' || this.mode === 'top') {
      const cam = this.mode === 'top' ? this.topCam : this.editorCam;
      this.gizmoHelper.visible = !!this.gizmo.object;
      this.env.sky.visible = this.mode !== 'top';
      const restore = this.applyCutaway(cam, this.mode === 'top');
      this.env.centerOn(cam.position);
      r.render(this.scene, cam);
      restore();
      this.env.sky.visible = true;
      // labels
      const v = new THREE.Vector3();
      for (const c of cameraObjects(p)) {
        const root = this.sync.objectFor(c.id);
        if (!root) continue;
        v.copy(root.position).add(new THREE.Vector3(0, 0.32, 0)).project(cam);
        if (v.z > 1 || v.z < -1) continue;
        info.labels.push({ id: c.id, text: c.name || c.id, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, live: c.id === live });
      }
      for (const id of this.selection) {
        const o = p.objects.find((x) => x.id === id);
        const root = this.sync.objectFor(id);
        if (!o || !root || o.type === 'camera') continue;
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) continue;
        v.set((box.min.x + box.max.x) / 2, box.max.y + 0.15, (box.min.z + box.max.z) / 2).project(cam);
        if (v.z > 1 || v.z < -1) continue;
        info.labels.push({ id, text: o.name || o.id, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, live: false });
      }
      if (this.opts.pip && live && w > 360) {
        const pw = Math.round(Math.min(w * 0.3, 360));
        const ph = Math.round(pw / aspect);
        const rect = { x: w - pw - 12, y: h - ph - 12, w: pw, h: ph };
        if (ph < h * 0.6 && this.renderShot(live, rect, 'thumb')) info.pip = { cameraId: live, rect };
      }
    } else if (this.mode === 'camera' || this.mode === 'program') {
      r.setClearColor('#0d0e10', 1);
      r.clear();
      const camId = this.mode === 'program' ? live : (this.viewCamera ?? live);
      if (camId) {
        const rect = fitRect(aspect, w, h, 14);
        if (this.renderShot(camId, rect, 'preview')) info.shot = { cameraId: camId, rect };
      }
    } else {
      r.setClearColor('#0d0e10', 1);
      r.clear();
      const cams = cameraObjects(p).slice(0, 16);
      const n = cams.length;
      if (n) {
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cw = w / cols;
        const ch = h / rows;
        cams.forEach((c, i) => {
          const cx = (i % cols) * cw;
          const cy = Math.floor(i / cols) * ch;
          const inner = fitRect(aspect, cw, ch - 22, 6);
          const rect = { x: Math.round(cx + inner.x), y: Math.round(cy + inner.y + 18), w: inner.w, h: inner.h };
          if (this.renderShot(c.id, rect, 'thumb')) info.cells.push({ cameraId: c.id, rect, live: c.id === live, name: c.name || c.id });
        });
      }
    }
    this.lastInfo = info;
    this.cb.onFrame?.(info);
  }

  // ---- interaction -----------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, button: e.button };
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || d.button !== 0 || this.dragging) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    if (this.mode === 'multiview') {
      const cell = this.cellAt(e.clientX, e.clientY);
      if (cell) this.cb.onCellPick?.(cell, false);
      return;
    }
    if (this.mode !== 'editor' && this.mode !== 'top') return;
    if ((this.gizmo as unknown as { axis: string | null }).axis) return;
    this.cb.onPick(this.pick(e.clientX, e.clientY, false), e.shiftKey || e.metaKey || e.ctrlKey);
  };

  private onDblClick = (e: MouseEvent) => {
    if (this.mode === 'multiview') {
      const cell = this.cellAt(e.clientX, e.clientY);
      if (cell) this.cb.onCellPick?.(cell, true);
      return;
    }
    if (this.mode !== 'editor' && this.mode !== 'top') return;
    const id = this.pick(e.clientX, e.clientY, true);
    if (id) this.cb.onPick(id, false);
  };

  private cellAt(clientX: number, clientY: number): string | null {
    const b = this.canvas.getBoundingClientRect();
    const x = clientX - b.left;
    const y = clientY - b.top;
    const cell = this.lastInfo?.cells.find((c) => x >= c.rect.x && x <= c.rect.x + c.rect.w && y >= c.rect.y - 20 && y <= c.rect.y + c.rect.h);
    return cell?.cameraId ?? null;
  }

  private activeCam(): THREE.Camera {
    return this.mode === 'top' ? this.topCam : this.editorCam;
  }

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const b = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - b.left) / b.width) * 2 - 1, -((clientY - b.top) / b.height) * 2 + 1);
  }

  private visibleChain(o: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = o;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  /** Object id under the cursor (terrain only if includeTerrain or nothing else). */
  pick(clientX: number, clientY: number, includeTerrain: boolean): string | null {
    const p = this.project;
    if (!p) return null;
    const cam = this.activeCam();
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), cam);
    this.raycaster.layers.enableAll();
    const restore = this.applyCutaway(cam, this.mode === 'top');
    const hits = this.raycaster.intersectObjects(this.sync.group.children, true).filter((h) => this.visibleChain(h.object));
    restore();
    let terrain: string | null = null;
    for (const h of hits) {
      const id = this.sync.idOf(h.object);
      if (!id) continue;
      const type = p.objects.find((o) => o.id === id)?.type ?? '';
      if (TERRAIN.has(type)) {
        terrain ??= id;
        continue;
      }
      return id;
    }
    return includeTerrain ? terrain : null;
  }

  /** World point on the ground/terrain under the cursor (for drag & drop placement). */
  groundPointAt(clientX: number, clientY: number): Vec3 | null {
    const cam = this.activeCam();
    if (this.mode !== 'editor' && this.mode !== 'top') return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), cam);
    this.raycaster.layers.set(0);
    const restore = this.applyCutaway(cam, this.mode === 'top');
    const hits = this.raycaster.intersectObjects(this.sync.group.children, true).filter((h) => {
      if (!this.visibleChain(h.object)) return false;
      const id = this.sync.idOf(h.object);
      const type = this.project?.objects.find((o) => o.id === id)?.type ?? '';
      return TERRAIN.has(type) || type === 'room' || type === 'stairs';
    });
    restore();
    if (hits[0]) return [hits[0].point.x, Math.max(0, hits[0].point.y), hits[0].point.z];
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, pt) ? [pt.x, 0, pt.z] : null;
  }

  /** Point in front of the editor camera on the ground (for "add" buttons). */
  viewCenterOnGround(): Vec3 {
    const b = this.canvas.getBoundingClientRect();
    return this.groundPointAt(b.left + b.width / 2, b.top + b.height * 0.6) ?? [0, 0, 0];
  }

  /** Current editor camera pose as [x,y,z] and [tilt, pan, roll] degrees. */
  editorPose(): { position: Vec3; rotation: Vec3 } {
    const e = new THREE.Euler().setFromQuaternion(this.editorCam.quaternion, 'YXZ');
    const pos = this.editorCam.position;
    return {
      position: [pos.x, pos.y, pos.z].map((v) => Math.round(v * 1000) / 1000) as Vec3,
      rotation: [e.x / DEG, e.y / DEG, e.z / DEG].map((v) => Math.round(v * 100) / 100) as Vec3,
    };
  }

  /** Frame the selection (or everything) in the editor view. */
  frameSelection(): void {
    const box = new THREE.Box3();
    const ids = this.selection.length ? this.selection : (this.project?.objects ?? []).filter((o) => !TERRAIN.has(o.type)).map((o) => o.id);
    for (const id of ids) {
      const root = this.sync.objectFor(id);
      if (root) box.expandByObject(root);
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(6, 2, 6));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(1, sphere.radius);
    if (this.mode === 'top') {
      this.topControls.target.set(sphere.center.x, 0, sphere.center.z);
      this.topCam.position.set(sphere.center.x, 400, sphere.center.z);
      this.topCam.zoom = 30 / (r * 1.3);
      this.topCam.updateProjectionMatrix();
      this.topControls.update();
    } else {
      const dir = this.editorCam.position.clone().sub(this.orbit.target).normalize();
      const dist = r / Math.sin((this.editorCam.fov * DEG) / 2) * 1.1;
      this.orbit.target.copy(sphere.center);
      this.editorCam.position.copy(sphere.center).add(dir.multiplyScalar(dist));
      this.orbit.update();
    }
    this.requestRender();
  }

  /** Frame the action area (characters and cameras; else everything) from a 3/4 high angle. */
  frameAll(): void {
    const p = this.project;
    if (!p) return;
    const box = new THREE.Box3();
    const people = p.objects.filter((o) => getAssetType(o.type)?.category === 'character' && o.type !== 'crowd');
    const cams = p.objects.filter((o) => o.type === 'camera');
    const focus = people.length ? [...people, ...cams] : p.objects.filter((o) => !TERRAIN.has(o.type));
    for (const o of focus) {
      const root = this.sync.objectFor(o.id);
      if (root) box.expandByObject(root);
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(8, 2, 8));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(2.5, Math.min(sphere.radius, 400));
    const dir = new THREE.Vector3(0.85, 0.7, 1.2).normalize();
    const dist = (r / Math.sin((this.editorCam.fov * DEG) / 2)) * 0.95;
    this.orbit.target.copy(sphere.center);
    this.editorCam.position.copy(sphere.center).add(dir.multiplyScalar(dist));
    this.orbit.update();
    this.topControls.target.set(sphere.center.x, 0, sphere.center.z);
    this.topCam.position.set(sphere.center.x, 400, sphere.center.z);
    this.topCam.zoom = Math.max(0.05, 30 / (r * 1.3));
    this.topCam.updateProjectionMatrix();
    this.topControls.update();
    this.requestRender();
  }

  /** Move the editor view to look through a camera (for fine adjustments in editor mode). */
  matchEditorToCamera(cameraId: string): void {
    const p = this.project;
    const obj = p?.objects.find((o) => o.id === cameraId);
    if (!p || !obj) return;
    const ev = evaluateCamera(p, obj, this.time);
    this.editorCam.position.set(...ev.position);
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(ev.rotation[0] * DEG, ev.rotation[1] * DEG, 0, 'YXZ'));
    this.orbit.target.copy(this.editorCam.position).add(fwd.multiplyScalar(5));
    this.orbit.update();
    this.requestRender();
  }

  /** Render synchronously (benchmarks / tests); waits for the GPU to finish. */
  renderNow(): number {
    const t0 = performance.now();
    this.renderFrame();
    this.renderer.getContext().finish();
    return performance.now() - t0;
  }

  stats(): { calls: number; triangles: number; geometries: number; textures: number } {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures };
  }

  lastFrameInfo(): FrameInfo | null {
    return this.lastInfo;
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.cb.onContextLost?.(true);
  };

  private onContextRestored = () => {
    this.cb.onContextLost?.(false);
    this.forceSync();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.topControls.dispose();
    this.sync.dispose();
    this.helpers.dispose();
    this.shot.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

export function isTerrainType(type: string): boolean {
  return TERRAIN.has(type) || getAssetType(type)?.category === 'terrain';
}
