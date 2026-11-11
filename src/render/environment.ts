/** Sky, sun, ambient and fog from the project's environment settings. */
import * as THREE from 'three';
import type { Environment, EnvPreset } from '../core/schema.ts';

interface PresetLook {
  sky: string;
  horizon: string;
  groundBounce: string;
  sun: string;
  sunIntensity: number;
  hemiIntensity: number;
  fog: boolean;
}

export const ENV_LOOKS: Record<EnvPreset, PresetLook> = {
  day: { sky: '#6fa6dc', horizon: '#d3e3ef', groundBounce: '#6e6a5c', sun: '#fff4e2', sunIntensity: 2.3, hemiIntensity: 1.35, fog: true },
  golden: { sky: '#d99a62', horizon: '#f7d6a6', groundBounce: '#6a5a48', sun: '#ffb46b', sunIntensity: 2.5, hemiIntensity: 1.0, fog: true },
  dusk: { sky: '#34406e', horizon: '#c98272', groundBounce: '#3c3440', sun: '#ff8f6e', sunIntensity: 1.1, hemiIntensity: 0.85, fog: true },
  night: { sky: '#0a1222', horizon: '#1c2944', groundBounce: '#161a22', sun: '#a9c1ff', sunIntensity: 0.55, hemiIntensity: 0.55, fog: true },
  overcast: { sky: '#a3acb6', horizon: '#ccd2d7', groundBounce: '#5f625e', sun: '#ffffff', sunIntensity: 0.9, hemiIntensity: 1.75, fog: true },
  studio: { sky: '#363940', horizon: '#4a4e57', groundBounce: '#2c2e33', sun: '#ffffff', sunIntensity: 2.0, hemiIntensity: 1.4, fog: false },
};

function skyDome(): THREE.Mesh {
  const g = new THREE.SphereGeometry(1000, 24, 12);
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position!.count * 3), 3));
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}

export class EnvironmentRig {
  readonly hemi = new THREE.HemisphereLight('#ffffff', '#555555', 1);
  readonly sun = new THREE.DirectionalLight('#ffffff', 2);
  readonly sky = skyDome();
  private lastKey = '';

  constructor(scene: THREE.Scene) {
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    scene.add(this.hemi, this.sun, this.sun.target, this.sky);
  }

  /** Sky color used for the background and fog. */
  colors(env: Environment): { sky: string; horizon: string } {
    const look = ENV_LOOKS[env.preset] ?? ENV_LOOKS.day;
    return { sky: env.skyColor ?? look.sky, horizon: env.skyColor ? new THREE.Color(env.skyColor).lerp(new THREE.Color('#ffffff'), 0.35).getStyle() : look.horizon };
  }

  apply(scene: THREE.Scene, env: Environment, sceneRadius: number): void {
    const key = JSON.stringify(env) + '|' + Math.round(sceneRadius);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const look = ENV_LOOKS[env.preset] ?? ENV_LOOKS.day;
    const { sky, horizon } = this.colors(env);
    const skyC = new THREE.Color(sky);
    const horC = new THREE.Color(horizon);
    const below = new THREE.Color(look.groundBounce).lerp(horC, 0.5);
    const pos = this.sky.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.sky.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 1000;
      if (y >= 0) c.copy(horC).lerp(skyC, Math.pow(Math.min(1, y * 1.6), 0.7));
      else c.copy(horC).lerp(below, Math.min(1, -y * 3));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;

    this.hemi.color.set(look.sky).lerp(new THREE.Color('#ffffff'), 0.45);
    this.hemi.groundColor.set(look.groundBounce);
    this.hemi.intensity = look.hemiIntensity;
    this.sun.color.set(look.sun);
    this.sun.intensity = env.sunElevation <= 0 ? look.sunIntensity * 0.15 : look.sunIntensity;
    const az = (env.sunAzimuth * Math.PI) / 180;
    const el = (Math.max(-5, env.sunElevation) * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const r = Math.min(Math.max(sceneRadius, 20), 180);
    this.sun.position.copy(dir.multiplyScalar(r * 2));
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = env.shadows;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = r * 5;
    cam.updateProjectionMatrix();

    scene.background = horC.clone();
    const useFog = env.fog && look.fog;
    if (useFog) {
      const far = THREE.MathUtils.lerp(2200, 140, env.fogDensity);
      scene.fog = new THREE.Fog(horC.clone(), far * 0.12, far);
    } else scene.fog = null;
  }

  /** Keep the sky centered on whatever camera is rendering. */
  centerOn(p: THREE.Vector3): void {
    this.sky.position.copy(p);
  }
}
