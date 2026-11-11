/**
 * Renders what a shot camera sees, including special lenses:
 * standard (rectilinear), fisheye and 360° panorama (cube map → projection shader).
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { EvalCamera } from '../core/evaluate.ts';
import { lensFov } from '../core/lens.ts';
import type { EnvironmentRig } from './environment.ts';

const DEG = Math.PI / 180;

export type ShotQuality = 'thumb' | 'preview' | 'export';

export interface Rect {
  /** CSS pixels, origin bottom-left (three.js viewport convention). */
  x: number;
  y: number;
  w: number;
  h: number;
}

const projectionVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const projectionFrag = /* glsl */ `
#define PI 3.141592653589793
uniform samplerCube tCube;
uniform mat3 uRot;
uniform float uFov;
uniform int uMode;
uniform int uMapping;
uniform float uAspect;
uniform float uCircular;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 dir;
  if (uMode == 1) {
    float lon = p.x * PI;
    float lat = p.y * PI * 0.5;
    dir = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
  } else {
    vec2 q = vec2(p.x * uAspect, p.y);
    float rmax = uCircular > 0.5 ? min(uAspect, 1.0) : length(vec2(uAspect, 1.0));
    float r = length(q) / rmax;
    if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float halfFov = uFov * 0.5;
    float theta;
    if (uMapping == 0) theta = r * halfFov;
    else if (uMapping == 1) theta = 2.0 * asin(clamp(r * sin(halfFov * 0.5), -1.0, 1.0));
    else if (uMapping == 2) theta = 2.0 * atan(r * tan(min(halfFov, 3.1) * 0.5));
    else theta = asin(clamp(r * sin(min(halfFov, PI * 0.5)), -1.0, 1.0));
    float phi = atan(q.y, q.x);
    dir = vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), -cos(theta));
  }
  vec3 w = uRot * dir;
  gl_FragColor = vec4(textureCube(tCube, w).rgb, 1.0);
  #include <colorspace_fragment>
}
`;

export class ShotRenderer {
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 3000);
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  private cubeCam: THREE.CubeCamera | null = null;
  private cubeSize = 0;
  private readonly projMat = new THREE.ShaderMaterial({
    uniforms: {
      tCube: { value: null },
      uRot: { value: new THREE.Matrix3() },
      uFov: { value: Math.PI },
      uMode: { value: 0 },
      uMapping: { value: 0 },
      uAspect: { value: 16 / 9 },
      uCircular: { value: 0 },
    },
    vertexShader: projectionVert,
    fragmentShader: projectionFrag,
    depthTest: false,
    depthWrite: false,
  });
  private readonly quad = new FullScreenQuad(this.projMat);

  constructor() {
    this.camera.rotation.order = 'YXZ';
  }

  /** Configure the internal PerspectiveCamera from an evaluated camera. */
  applyCamera(cam: EvalCamera, aspect: number): THREE.PerspectiveCamera {
    const c = this.camera;
    const fov = lensFov(cam.focalLength, cam.sensor, aspect);
    c.fov = Math.min(fov.vfov, 175);
    c.aspect = aspect;
    c.near = cam.focalLength > 150 ? 0.3 : 0.08;
    c.far = 3000;
    c.position.set(cam.position[0], cam.position[1], cam.position[2]);
    c.rotation.set(cam.rotation[0] * DEG, cam.rotation[1] * DEG, cam.rotation[2] * DEG, 'YXZ');
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return c;
  }

  private ensureCube(size: number): { rt: THREE.WebGLCubeRenderTarget; cam: THREE.CubeCamera } {
    if (!this.cubeRT || this.cubeSize !== size) {
      this.cubeRT?.dispose();
      this.cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
      this.cubeCam = new THREE.CubeCamera(0.08, 3000, this.cubeRT);
      this.cubeSize = size;
    }
    return { rt: this.cubeRT, cam: this.cubeCam! };
  }

  /**
   * Render camera `cam` into `rect` of the renderer's current output (canvas).
   * `aspect` is the frame aspect (width / height) of the shot.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, env: EnvironmentRig, cam: EvalCamera, rect: Rect, quality: ShotQuality): void {
    const aspect = rect.w / rect.h;
    renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
    renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
    renderer.setScissorTest(true);
    const pr = renderer.getPixelRatio();
    const pxW = Math.max(1, Math.round(rect.w * pr));
    const pxH = Math.max(1, Math.round(rect.h * pr));

    if (cam.lens === 'fisheye' || cam.lens === 'panorama') {
      const size = quality === 'export' ? Math.min(2048, THREE.MathUtils.ceilPowerOfTwo(Math.max(pxW, pxH) * (cam.lens === 'panorama' ? 0.35 : 0.6))) : quality === 'preview' ? 512 : 256;
      const { rt, cam: cube } = this.ensureCube(size);
      cube.position.set(cam.position[0], cam.position[1], cam.position[2]);
      cube.updateMatrixWorld(true);
      env.centerOn(cube.position);
      const prevRT = renderer.getRenderTarget();
      renderer.setScissorTest(false);
      cube.update(renderer, scene);
      renderer.setRenderTarget(prevRT);
      renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
      renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
      renderer.setScissorTest(true);
      const u = this.projMat.uniforms;
      u.tCube!.value = rt.texture;
      const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(cam.rotation[0] * DEG, cam.rotation[1] * DEG, cam.rotation[2] * DEG, 'YXZ'));
      (u.uRot!.value as THREE.Matrix3).setFromMatrix4(m);
      u.uFov!.value = cam.fisheye.fov * DEG;
      u.uMode!.value = cam.lens === 'panorama' ? 1 : 0;
      u.uMapping!.value = ['equidistant', 'equisolid', 'stereographic', 'orthographic'].indexOf(cam.fisheye.mapping);
      u.uAspect!.value = aspect;
      u.uCircular!.value = cam.fisheye.circular ? 1 : 0;
      this.quad.material = this.projMat;
      this.quad.render(renderer);
      renderer.setScissorTest(false);
      return;
    }

    const camera = this.applyCamera(cam, aspect);
    env.centerOn(camera.position);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
  }

  dispose(): void {
    this.cubeRT?.dispose();
    this.projMat.dispose();
    this.quad.dispose();
  }
}
