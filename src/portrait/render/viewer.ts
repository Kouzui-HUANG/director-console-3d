/**
 * Portrait viewer: one white sculpture under studio lights, orbit controls, view presets and
 * offscreen snapshots / multi-view sheets. Geometry arrives in millimeters (head frame:
 * +Y up, +Z facing the viewer); the scene is in meters.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { MeshData } from '../core/mesher/surfaceNets.ts';
import { addBrowStrands } from './browShader.ts';

/** Mesh data plus an optional highlight weight per vertex (0…1) and the eyebrow chart (4 per vertex). */
export type ViewerMesh = MeshData & { highlight?: Float32Array; brow?: Float32Array; browStrands?: number };

export type ViewName = 'front' | 'threeQuarterLeft' | 'left' | 'back' | 'right' | 'threeQuarterRight' | 'top' | 'below';
export const VIEWS: Record<ViewName, { az: number; el: number; label: string }> = {
  front: { az: 0, el: 3, label: '正面' },
  threeQuarterLeft: { az: 38, el: 5, label: '左 3/4' },
  left: { az: 90, el: 3, label: '左側' },
  back: { az: 180, el: 5, label: '背面' },
  right: { az: -90, el: 3, label: '右側' },
  threeQuarterRight: { az: -38, el: 5, label: '右 3/4' },
  top: { az: 0, el: 75, label: '俯視' },
  below: { az: 0, el: -35, label: '仰視' },
};

/** The 三視圖 deliverable: front, half side (left 3/4) and side (left profile). */
export const TURNAROUND: readonly { view: ViewName; label: string }[] = [
  { view: 'front', label: '正面' },
  { view: 'threeQuarterLeft', label: '半側' },
  { view: 'left', label: '側面' },
];

export type LightPreset = 'studio' | 'soft' | 'side' | 'flat' | 'rembrandt';
export const LIGHTS: Record<LightPreset, string> = { studio: '攝影棚三點光', soft: '柔光', side: '側光（看結構）', flat: '正面平光（比對照片）', rembrandt: '林布蘭光' };
export type MaterialPreset = 'plaster' | 'clay' | 'matcap';
export const MATERIALS: Record<MaterialPreset, string> = { plaster: '石膏白', clay: '黏土灰', matcap: 'Matcap（雕塑軟體）' };

/** A clay-like matcap drawn on a canvas (light from the upper left), so no image file is needed. */
function makeMatcap(): THREE.Texture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const L = new THREE.Vector3(-0.45, 0.6, 0.66).normalize();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / (size / 2) - 1, ny = 1 - (y + 0.5) / (size / 2);
      const r2 = nx * nx + ny * ny;
      const o = (y * size + x) * 4;
      if (r2 > 1) {
        img.data[o + 3] = 255;
        continue;
      }
      const nz = Math.sqrt(1 - r2);
      const diff = Math.max(0, nx * L.x + ny * L.y + nz * L.z);
      const rim = Math.pow(1 - nz, 3) * 0.35;
      const spec = Math.pow(Math.max(0, 2 * diff * nz - L.z), 24) * 0.25;
      const v = 0.3 + 0.62 * diff + rim + spec;
      img.data[o] = Math.min(255, 255 * v * 0.93);
      img.data[o + 1] = Math.min(255, 255 * v * 0.9);
      img.data[o + 2] = Math.min(255, 255 * v * 0.86);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const DEG = Math.PI / 180;
/** Full-frame vertical half size in mm (36 × 24 sensor). */
const SENSOR_HALF_H = 12;

export class PortraitViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(16, 1, 0.01, 50);
  readonly controls: OrbitControls;
  private readonly container: HTMLElement;
  private readonly material = new THREE.MeshStandardMaterial({ color: 0xcfc9bf, roughness: 0.55, metalness: 0, envMapIntensity: 0.14 });
  private matcap: THREE.MeshMatcapMaterial | null = null;
  /** Eyebrow strand engraving strength (shared by both materials). */
  private readonly browStrands = { value: 0 };
  /** Darkened brows (photo-like test renders only). */
  private readonly browTint = { value: 0 };
  private materialPreset: MaterialPreset = 'plaster';
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass;
  private aoOn = false;
  private landmarks: THREE.Points | null = null;
  private readonly rig = new THREE.Group();
  private readonly key = new THREE.DirectionalLight(0xffffff, 2.6);
  private readonly fill = new THREE.DirectionalLight(0xffffff, 0.55);
  private readonly rim = new THREE.DirectionalLight(0xffffff, 1.4);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a40, 0.35);
  private mesh: THREE.Mesh | null = null;
  private focal = 85;
  private readonly target = new THREE.Vector3(0, 0.005, 0.01);
  private frameRadius = 0.15;
  private raf = 0;
  private dirty = true;
  private readonly ro: ResizeObserver;
  background = 0x2a2d32;

  constructor(container: HTMLElement) {
    this.container = container;
    addBrowStrands(this.material, this.browStrands, this.browTint);
    // transparent canvas over the container's CSS background: the background then looks the same
    // with and without post-processing (tone mapping would otherwise darken it)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    container.style.background = `#${this.background.toString(16).padStart(6, '0')}`;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // Lights travel with the camera, so every view is lit the same way (like a photographer's setup).
    this.scene.add(this.camera);
    this.camera.add(this.rig);
    for (const l of [this.key, this.fill, this.rim]) {
      this.rig.add(l);
      this.rig.add(l.target);
      l.target.position.set(0, 0, -1);
    }
    this.scene.add(this.hemi);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.0025;
    this.key.shadow.radius = 3;
    this.setLighting('studio');

    // ambient occlusion: RenderPass → GTAO → output (tone mapping, sRGB)
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 512, 512);
    this.gtao.updateGtaoMaterial({ radius: 0.035, distanceExponent: 1.2, thickness: 1.5, scale: 1, samples: 16 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.gtao.blendIntensity = 0.9;
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.target.copy(this.target);
    this.setFocal(85);
    this.setView('front');

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
    };
    loop();
  }

  invalidate() {
    this.dirty = true;
  }

  private draw() {
    if (this.aoOn) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, true);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.updateFov();
    this.invalidate();
  }

  private updateFov() {
    this.camera.fov = 2 * Math.atan(SENSOR_HALF_H / this.focal) / DEG;
    this.camera.updateProjectionMatrix();
  }

  /** Lens focal length in mm (full-frame equivalent). */
  setFocal(mm: number) {
    this.focal = mm;
    this.updateFov();
    this.invalidate();
  }

  setMesh(m: ViewerMesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    // always present: the materials read it (zeros = no brow strands)
    g.setAttribute('brow', new THREE.BufferAttribute(m.brow ?? new Float32Array((m.positions.length / 3) * 4), 4));
    this.browStrands.value = m.brow ? (m.browStrands ?? 0) : 0;
    g.computeBoundingSphere();
    // highlight: tint the affected area warm orange
    const tinted = !!m.highlight;
    if (m.highlight) {
      const col = new Float32Array(m.positions.length);
      for (let i = 0; i < m.highlight.length; i++) {
        const w = Math.min(1, Math.max(0, m.highlight[i]!)) ** 0.6 * 0.85;
        col[i * 3] = 1;
        col[i * 3 + 1] = 1 - 0.5 * w;
        col[i * 3 + 2] = 1 - 0.85 * w;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    for (const mat of [this.material, this.matcap]) {
      if (mat && mat.vertexColors !== tinted) {
        mat.vertexColors = tinted;
        mat.needsUpdate = true;
      }
    }
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = g;
    } else {
      this.mesh = new THREE.Mesh(g, this.materialPreset === 'matcap' ? this.matcapMaterial() : this.material);
      this.mesh.scale.setScalar(0.001);
      this.mesh.castShadow = true;
      this.mesh.receiveShadow = true;
      this.scene.add(this.mesh);
    }
    this.fitShadow();
    this.invalidate();
  }

  private fitShadow() {
    const cam = this.key.shadow.camera;
    const r = 0.45;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.05;
    cam.far = 3;
    cam.updateProjectionMatrix();
  }

  /** Where the camera looks (m) and how much must fit in view (radius, m). */
  setFraming(target: [number, number, number], radius: number) {
    this.target.set(...target);
    this.frameRadius = radius;
    this.controls.target.copy(this.target);
  }

  private distance(): number {
    const vfov = this.camera.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    return this.frameRadius / Math.sin(Math.min(vfov, hfov) / 2);
  }

  setView(name: ViewName) {
    const v = VIEWS[name];
    const d = this.distance();
    const az = v.az * DEG;
    const el = v.el * DEG;
    this.camera.position.set(this.target.x + d * Math.sin(az) * Math.cos(el), this.target.y + d * Math.sin(el), this.target.z + d * Math.cos(az) * Math.cos(el));
    this.camera.lookAt(this.target);
    this.controls.target.copy(this.target);
    this.controls.update();
    this.invalidate();
  }

  /** Where the camera looks and how much must fit — then render one view offscreen, restoring the framing. */
  renderFramed(view: ViewName, width: number, height: number, target: [number, number, number], radius: number): HTMLCanvasElement {
    const saved = { target: this.target.clone(), radius: this.frameRadius };
    this.setFraming(target, radius);
    try {
      return this.renderView(view, width, height);
    } finally {
      this.setFraming([saved.target.x, saved.target.y, saved.target.z], saved.radius);
    }
  }

  /** Point the interactive camera from an azimuth / elevation (degrees) around the framing target. */
  setOrbit(azDeg: number, elDeg: number) {
    const d = this.distance();
    const az = azDeg * DEG, el = elDeg * DEG;
    this.camera.position.set(this.target.x + d * Math.sin(az) * Math.cos(el), this.target.y + d * Math.sin(el), this.target.z + d * Math.cos(az) * Math.cos(el));
    this.camera.lookAt(this.target);
    this.controls.target.copy(this.target);
    this.controls.update();
    this.invalidate();
  }

  /**
   * Render with a photo's pinhole camera, given in the mesh frame (mm): X_cam = R·X + t with x
   * right, y down, z forward (R row-major 3×3), focal length f in pixels of a full image of
   * `full` = [width, height] with the principal point at its centre. Only the `crop` rectangle of
   * that image is rendered, into `size` pixels (same aspect). The lights follow this camera.
   */
  renderPinhole(pose: { R: ArrayLike<number>; t: ArrayLike<number>; f: number }, full: [number, number], crop: { x: number; y: number; w: number; h: number }, size: [number, number], o: { transparent?: boolean } = {}): { canvas: HTMLCanvasElement; camera: THREE.PerspectiveCamera } {
    const [width, height] = size;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const saved = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), aspect: this.camera.aspect, target: this.controls.target.clone(), near: this.camera.near };
    const prevRatio = this.renderer.getPixelRatio();
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const { R, t, f } = pose;
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.composer.setPixelRatio(1);
      this.composer.setSize(width, height);
      // camera axes in the world: x = row 0 of R, y (up) = −row 1, z (backward) = −row 2; centre −Rᵀt
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(R[0]!, R[1]!, R[2]!), new THREE.Vector3(-R[3]!, -R[4]!, -R[5]!), new THREE.Vector3(-R[6]!, -R[7]!, -R[8]!));
      this.camera.quaternion.setFromRotationMatrix(basis);
      this.camera.position.set(-(R[0]! * t[0]! + R[3]! * t[1]! + R[6]! * t[2]!) / 1000, -(R[1]! * t[0]! + R[4]! * t[1]! + R[7]! * t[2]!) / 1000, -(R[2]! * t[0]! + R[5]! * t[1]! + R[8]! * t[2]!) / 1000);
      this.camera.aspect = full[0] / full[1];
      this.camera.fov = (2 * Math.atan(full[1] / 2 / f)) / DEG;
      this.camera.near = 0.02;
      this.camera.setViewOffset(full[0], full[1], crop.x, crop.y, crop.w, crop.h);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld(true);
      const camera = this.camera.clone();
      camera.updateMatrixWorld(true);
      this.draw();
      const ctx = out.getContext('2d')!;
      if (!o.transparent) {
        ctx.fillStyle = `#${this.background.toString(16).padStart(6, '0')}`;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
      return { canvas: out, camera };
    } finally {
      this.camera.clearViewOffset();
      this.camera.near = saved.near;
      this.renderer.setPixelRatio(prevRatio);
      this.renderer.setSize(prevSize.x, prevSize.y, false);
      this.composer.setPixelRatio(prevRatio);
      this.composer.setSize(prevSize.x, prevSize.y);
      this.camera.position.copy(saved.pos);
      this.camera.quaternion.copy(saved.quat);
      this.camera.aspect = saved.aspect;
      this.controls.target.copy(saved.target);
      this.updateFov();
      this.invalidate();
    }
  }

  /** Render one view offscreen and also return the exact camera used (for picking / projecting). */
  capture(view: ViewName | null, width: number, height: number): { canvas: HTMLCanvasElement; camera: THREE.PerspectiveCamera } {
    let camera: THREE.PerspectiveCamera | null = null;
    const prevDraw = this.draw;
    this.draw = () => {
      camera = this.camera.clone();
      camera.updateMatrixWorld(true);
      prevDraw.call(this);
    };
    try {
      const canvas = this.renderView(view, width, height);
      return { canvas, camera: camera! };
    } finally {
      this.draw = prevDraw;
    }
  }

  /**
   * Ray from a camera through normalized device coordinates (x, y in −1…1, y up) against the
   * sculpture. Returns the hit triangle's vertex indices, barycentric weights and the point in mesh
   * coordinates (mm), or null.
   */
  pick(camera: THREE.PerspectiveCamera, ndcX: number, ndcY: number): { tri: [number, number, number]; bary: [number, number, number]; point: [number, number, number]; ray: { origin: [number, number, number]; dir: [number, number, number] } } | null {
    if (!this.mesh) return null;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const toLocal = new THREE.Matrix4().copy(this.mesh.matrixWorld).invert();
    const o = rc.ray.origin.clone().applyMatrix4(toLocal);
    const d = rc.ray.direction.clone().transformDirection(toLocal);
    const ray = { origin: [o.x, o.y, o.z] as [number, number, number], dir: [d.x, d.y, d.z] as [number, number, number] };
    const hit = rc.intersectObject(this.mesh, false)[0];
    if (!hit || !hit.face) return null;
    const p = hit.point.clone().applyMatrix4(toLocal);
    const pos = this.mesh.geometry.getAttribute('position');
    const A = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a), B = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b), C = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const bc = new THREE.Triangle(A, B, C).getBarycoord(p, new THREE.Vector3()) ?? new THREE.Vector3(1 / 3, 1 / 3, 1 / 3);
    return { tri: [hit.face.a, hit.face.b, hit.face.c], bary: [bc.x, bc.y, bc.z], point: [p.x, p.y, p.z], ray };
  }

  /** Project a point in mesh coordinates (mm) to normalized device coordinates with a camera. */
  projectMm(p: [number, number, number], camera: THREE.PerspectiveCamera): [number, number, number] {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    if (this.mesh) v.applyMatrix4(this.mesh.matrixWorld);
    else v.multiplyScalar(0.001);
    v.project(camera);
    return [v.x, v.y, v.z];
  }

  /** Slow orbit around the target (turntable). */
  setTurntable(on: boolean) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 2.4;
    this.invalidate();
  }

  setAO(on: boolean) {
    this.aoOn = on;
    this.invalidate();
  }

  /** Landmark points (mm, same frame as the mesh), or null to hide. */
  setLandmarks(points: Record<string, [number, number, number]> | null) {
    if (this.landmarks) {
      this.landmarks.removeFromParent();
      this.landmarks.geometry.dispose();
      (this.landmarks.material as THREE.Material).dispose();
      this.landmarks = null;
    }
    if (points && this.mesh) {
      const pos = new Float32Array(Object.values(points).flat());
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.landmarks = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xff5a36, size: 6, sizeAttenuation: false, depthTest: false }));
      this.landmarks.renderOrder = 10;
      this.mesh.add(this.landmarks);
    }
    this.invalidate();
  }

  private matcapMaterial(): THREE.MeshMatcapMaterial {
    if (!this.matcap) {
      this.matcap = new THREE.MeshMatcapMaterial({ matcap: makeMatcap(), vertexColors: this.material.vertexColors });
      addBrowStrands(this.matcap, this.browStrands, this.browTint);
    }
    return this.matcap;
  }

  setLighting(preset: LightPreset) {
    // positions in camera space: x right, y up, z toward the viewer
    const set = (l: THREE.DirectionalLight, x: number, y: number, z: number, i: number) => {
      l.position.set(x, y, z);
      l.target.position.set(0, 0, -1.2);
      l.intensity = i;
    };
    if (preset === 'studio') {
      // Intensities near 1: a white material lit much above 1 saturates and loses its form.
      set(this.key, -1.0, 0.85, 0.5, 1.45);
      set(this.fill, 1.0, 0.0, 0.5, 0.22);
      set(this.rim, 0.7, 1.0, -1.6, 0.75);
      this.hemi.intensity = 0.1;
      this.scene.environmentIntensity = 0.3;
    } else if (preset === 'soft') {
      set(this.key, -0.6, 0.8, 0.9, 0.72);
      set(this.fill, 0.9, 0.3, 0.8, 0.3);
      set(this.rim, 0, 1, -1.5, 0.35);
      this.hemi.intensity = 0.2;
      this.scene.environmentIntensity = 0.42;
    } else if (preset === 'side') {
      set(this.key, -1.4, 0.35, -0.15, 1.9);
      set(this.fill, 1, 0, 0.6, 0.08);
      set(this.rim, 1.2, 0.8, -1.2, 0.6);
      this.hemi.intensity = 0.05;
      this.scene.environmentIntensity = 0.15;
    } else if (preset === 'rembrandt') {
      // key high and to the side: the shadow-side cheek keeps a small triangle of light
      set(this.key, -1.1, 1.15, 0.75, 1.75);
      set(this.fill, 1, 0.1, 0.6, 0.06);
      set(this.rim, 0.9, 0.9, -1.4, 0.35);
      this.hemi.intensity = 0.05;
      this.scene.environmentIntensity = 0.12;
    } else {
      set(this.key, 0, 0.2, 1.4, 0.85);
      set(this.fill, 0, 1, 0.5, 0.18);
      set(this.rim, 0, 0.5, -1.5, 0.2);
      this.hemi.intensity = 0.28;
      this.scene.environmentIntensity = 0.42;
    }
    this.invalidate();
  }

  setMaterial(preset: MaterialPreset) {
    this.materialPreset = preset;
    if (this.mesh) this.mesh.material = preset === 'matcap' ? this.matcapMaterial() : this.material;
    if (preset === 'clay') {
      this.material.color.set(0xa99d93);
      this.material.roughness = 0.8;
    } else {
      this.material.color.set(0xcfc9bf);
      this.material.roughness = 0.55;
    }
    this.invalidate();
  }

  /** Darken the brows like hair in a photo (0…1): for synthetic test photos, never for the sculpture. */
  setBrowTint(v: number) {
    this.browTint.value = v;
    this.invalidate();
  }

  setWireframe(on: boolean) {
    this.material.wireframe = on;
    if (this.matcap) this.matcap.wireframe = on;
    this.invalidate();
  }

  /**
   * Render one view offscreen at a given size. Restores the interactive camera afterwards.
   * Returns a canvas (2D) holding the image.
   */
  renderView(view: ViewName | null, width: number, height: number): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const saved = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), aspect: this.camera.aspect, target: this.controls.target.clone() };
    const prevRatio = this.renderer.getPixelRatio();
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(1);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.updateFov();
    if (view) this.setView(view);
    this.draw();
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = `#${this.background.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
    this.renderer.setPixelRatio(prevRatio);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.composer.setPixelRatio(prevRatio);
    this.composer.setSize(prevSize.x, prevSize.y);
    this.camera.position.copy(saved.pos);
    this.camera.quaternion.copy(saved.quat);
    this.camera.aspect = saved.aspect;
    this.controls.target.copy(saved.target);
    this.updateFov();
    this.invalidate();
    return out;
  }

  /** Several views side by side with labels. */
  sheet(views: ViewName[], cellW: number, cellH: number, columns = views.length, caption?: string): HTMLCanvasElement {
    const rows = Math.ceil(views.length / columns);
    const top = caption ? 34 : 0;
    const out = document.createElement('canvas');
    out.width = cellW * columns;
    out.height = cellH * rows + top;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#1d1f23';
    ctx.fillRect(0, 0, out.width, out.height);
    if (caption) {
      ctx.fillStyle = '#d8dbe0';
      ctx.font = '600 18px -apple-system, "PingFang TC", sans-serif';
      ctx.fillText(caption, 12, 23);
    }
    views.forEach((v, i) => {
      const img = this.renderView(v, cellW, cellH);
      const x = (i % columns) * cellW;
      const y = top + Math.floor(i / columns) * cellH;
      ctx.drawImage(img, x, y);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x + 8, y + 8, 64, 24);
      ctx.fillStyle = '#fff';
      ctx.font = '14px -apple-system, "PingFang TC", sans-serif';
      ctx.fillText(VIEWS[v].label, x + 14, y + 25);
    });
    return out;
  }

  /**
   * Views rendered with one fixed framing, side by side with no caption: rounded tags (e.g.
   * 正面／半側／側面) in the top-left corners and thin dividers — the 三視圖 deliverable layout.
   */
  labelledSheet(views: { view: ViewName; label: string }[], cellW: number, cellH: number, target: [number, number, number], radius: number): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = cellW * views.length;
    out.height = cellH;
    const ctx = out.getContext('2d')!;
    views.forEach(({ view }, i) => ctx.drawImage(this.renderFramed(view, cellW, cellH, target, radius), i * cellW, 0));
    const s = cellH / 1080;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let i = 1; i < views.length; i++) ctx.fillRect(i * cellW - Math.max(1, Math.round(s)), 0, Math.max(1, Math.round(s)), cellH);
    ctx.font = `500 ${Math.round(22 * s)}px -apple-system, "PingFang TC", "Noto Sans TC", sans-serif`;
    ctx.textBaseline = 'middle';
    views.forEach(({ label }, i) => {
      const x = i * cellW + 14 * s, y = 14 * s, h = 36 * s, w = ctx.measureText(label).width + 22 * s;
      ctx.fillStyle = 'rgba(16,18,22,0.82)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 7 * s);
      ctx.fill();
      ctx.fillStyle = '#f1f2f4';
      ctx.fillText(label, x + 11 * s, y + h / 2 + s);
    });
    return out;
  }

  stats() {
    const info = this.renderer.info;
    return { triangles: info.render.triangles, calls: info.render.calls };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.mesh?.geometry.dispose();
    this.material.dispose();
    this.matcap?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
