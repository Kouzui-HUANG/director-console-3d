/**
 * Sculpted eyeballs for a white model: a sphere with a corneal bulge and, optionally, an incised
 * iris ring and a drilled pupil (classical marble-bust treatment). Gaze along +Z.
 */
import type { TriMesh } from './clip.ts';

export interface EyeOptions {
  /** Corneal bulge above the sphere (mm). */
  bulge?: number;
  /** Carve iris ring and pupil. */
  carve?: boolean;
  /** Iris and pupil radii in mm (real eyes: about 6 and 1.5–3.5). */
  iris?: number;
  pupil?: number;
}

/** `basis`: row-major rotation from the eye's local frame (gaze +Z, up +Y) to world. */
export function eyeball(center: [number, number, number], R: number, o: EyeOptions = {}, seg = 96, rings = 64, basis?: readonly number[]): TriMesh {
  const bulge = o.bulge ?? 1.2;
  const carve = o.carve !== false;
  // angles from absolute sizes, so the iris keeps its real size on any eyeball radius
  const thIris = Math.asin(Math.min(0.95, (o.iris ?? 6) / R));
  const thPupil = Math.asin(Math.min(0.9, (o.pupil ?? 2.1) / R));
  const thC = thIris + 0.08; // the cornea covers the iris and a little more
  const pos: number[] = [];
  const idx: number[] = [];
  const radius = (th: number) => {
    let r = R;
    if (th < thC) {
      const t = (Math.cos(th) - Math.cos(thC)) / (1 - Math.cos(thC));
      r += bulge * t * t * (3 - 2 * t);
    }
    if (carve) {
      const g = (th - thIris) / (0.45 / R);
      r -= 0.4 * Math.exp(-g * g); // incised iris ring (≈0.4 mm deep)
      if (th < thPupil + 0.6 / R) {
        const t = Math.min(1, Math.max(0, (thPupil + 0.6 / R - th) / (1.2 / R)));
        r -= 0.9 * t * t * (3 - 2 * t); // drilled pupil (≈0.9 mm)
      }
    }
    return r;
  };
  // rings from the front pole (gaze) to the back
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI;
    const r = radius(th);
    for (let j = 0; j < seg; j++) {
      const ph = (j / seg) * Math.PI * 2;
      const lx = r * Math.sin(th) * Math.cos(ph), ly = r * Math.sin(th) * Math.sin(ph), lz = r * Math.cos(th);
      if (basis) pos.push(center[0] + basis[0]! * lx + basis[1]! * ly + basis[2]! * lz, center[1] + basis[3]! * lx + basis[4]! * ly + basis[5]! * lz, center[2] + basis[6]! * lx + basis[7]! * ly + basis[8]! * lz);
      else pos.push(center[0] + lx, center[1] + ly, center[2] + lz);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j, b = i * seg + ((j + 1) % seg), c = (i + 1) * seg + j, d = (i + 1) * seg + ((j + 1) % seg);
      idx.push(a, c, b, b, c, d);
    }
  }
  const P = Float32Array.from(pos);
  const I = Uint32Array.from(idx);
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o2 of [a, b, c]) {
      N[o2] = N[o2]! + nx;
      N[o2 + 1] = N[o2 + 1]! + ny;
      N[o2 + 2] = N[o2 + 2]! + nz;
    }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i]!, N[i + 1]!, N[i + 2]!) || 1;
    N[i] = N[i]! / l;
    N[i + 1] = N[i + 1]! / l;
    N[i + 2] = N[i + 2]! / l;
  }
  return { positions: P, normals: N, indices: I };
}

/** Least-squares-free sphere estimate: centroid and mean distance of the helper vertices. */
export function sphereOf(P: Float32Array, verts: Uint32Array, scale = 1): { center: [number, number, number]; radius: number } {
  const c: [number, number, number] = [0, 0, 0];
  for (const v of verts) for (let a = 0; a < 3; a++) c[a]! += P[v * 3 + a]! / verts.length;
  let r = 0;
  for (const v of verts) r += Math.hypot(P[v * 3]! - c[0], P[v * 3 + 1]! - c[1], P[v * 3 + 2]! - c[2]) / verts.length;
  return { center: [c[0] * scale, c[1] * scale, c[2] * scale], radius: r * scale };
}
