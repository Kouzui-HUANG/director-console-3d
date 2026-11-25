/**
 * Engraved eyebrow strands: a procedural bump in the fragment shader, driven by the brow chart the
 * builder attaches to each vertex (core/mh/brows.ts → HumanMesh.brow): mm along the brow from its
 * inner end, mm above its centre line, position along it (0…1) and coverage. The hairs follow the
 * growth direction (up at the inner end, outward along the body, slightly down at the tail), in
 * two crossing layers that wander a little; each hair is a short raised ridge with its own length
 * and offset, and hairs thin out where the brow does (edges, inner end, tail). The bump fades where
 * hairs get finer than about two pixels, so zoomed-out views stay calm. The mesh itself carries
 * only the brow's mass (a 1 mm mesh cannot hold strands).
 */
import type * as THREE from 'three';

const GLSL = /* glsl */ `
varying vec4 vBrow;
uniform float uBrowStrands;
uniform float uBrowTint;
float browHash(float n) { return fract(sin(n * 127.1 + 1.7) * 43758.5453); }
float browHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float browNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  return mix(mix(browHash2(i), browHash2(i + vec2(1.0, 0.0)), s.x), mix(browHash2(i + vec2(0.0, 1.0)), browHash2(i + vec2(1.0, 1.0)), s.x), s.y);
}
// one layer of hairs at chart point p (mm), u along the brow, coverage w; 0…1
float browLayer(vec2 p, float u, float w, float spacing, float dAng, float seed) {
  float ang = mix(mix(70.0, 18.0, smoothstep(0.0, 0.35, u)), -10.0, smoothstep(0.5, 1.0, u)) + dAng + (browNoise(p * 0.22 + seed) - 0.5) * 7.0;
  vec2 d = vec2(cos(radians(ang)), sin(radians(ang)));
  float a = dot(p, d);
  float q = dot(p, vec2(-d.y, d.x)) + (browNoise(p * 0.45 + seed * 3.1) - 0.5) * 0.35;
  float id = floor(q / spacing);
  float r1 = browHash(id + seed), r2 = browHash(id * 1.37 + seed + 31.7), r3 = browHash(id * 2.11 + seed + 7.3);
  float ridge = smoothstep(0.35, 1.0, 1.0 - abs(2.0 * fract(q / spacing) - 1.0));
  float len = 3.5 + 4.0 * r1;
  float ph = fract(a / len + r2);
  float dash = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.62, 0.97, ph));
  return ridge * dash * step(r3, 0.25 + 0.9 * w);
}
float browHair(vec2 p, float u, float w) {
  return max(browLayer(p, u, w, 0.7, 0.0, 0.0), 0.7 * browLayer(p, u, w, 0.9, 5.0, 19.0)) - 0.3;
}
vec3 browNormal(vec3 n, vec3 pos, float faceDir) {
  float w = vBrow.w;
  if (w <= 0.001 || uBrowStrands <= 0.0) return n;
  vec2 p = vBrow.xy, px = dFdx(p), py = dFdy(p);
  float k = w * uBrowStrands * 0.16 * (1.0 - smoothstep(0.25, 0.6, length(abs(px) + abs(py)))); // mm
  // differences taken per pixel along the chart (not dFdx of h): no 2×2 block artefacts
  float h0 = browHair(p, vBrow.z, w);
  vec2 dH = vec2(browHair(p + px, vBrow.z, w) - h0, browHair(p + py, vBrow.z, w) - h0) * k * 0.001; // mm → scene meters
  vec3 sx = dFdx(pos), sy = dFdy(pos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

/**
 * Add the strands to a standard or matcap material (geometry must carry a vec4 `brow` attribute).
 * `strength` and `tint` are shared, so changing their values needs no recompile; tint darkens the
 * brows like hair in a photo (synthetic test photos for MediaPipe, never the sculpture itself).
 */
export function addBrowStrands(material: THREE.Material, strength: { value: number }, tint: { value: number }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBrowStrands = strength;
    shader.uniforms.uBrowTint = tint;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 brow;\nvarying vec4 vBrow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBrow = brow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 - uBrowTint * 0.82 * smoothstep(0.2, 0.45, vBrow.w);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = browNormal(normal, -vViewPosition, faceDirection);');
  };
  material.customProgramCacheKey = () => 'brow-strands-6';
  material.needsUpdate = true;
}
