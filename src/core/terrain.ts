/** Terrain height functions shared by the 3D builder and by agents/editor ground snapping. */
import type { Params } from './fields.ts';
import type { Project } from './schema.ts';
import { roundTo, smoothstep } from './math.ts';
import { fbm2 } from './noise.ts';

export function hillsHeight(p: Params, x: number, z: number): number {
  const size = Number(p.size ?? 300);
  const height = Number(p.height ?? 25);
  const scale = Number(p.scale ?? 3);
  const seed = Number(p.seed ?? 3);
  const flat = Number(p.flatRadius ?? 25);
  let v = fbm2((x / size) * scale + 50, (z / size) * scale + 50, seed, 4);
  v = Math.max(0, (v - 0.3) / 0.7);
  const r = Math.hypot(x, z);
  const fall = smoothstep(flat, flat + Math.max(8, size * 0.12), r);
  return height * v * v * 1.6 * fall;
}

/** Height of the terrain (visible hills objects) under a ground point; 0 on flat ground. */
export function groundHeightAt(project: Project, x: number, z: number): number {
  let y = 0;
  for (const o of project.objects) {
    if (o.type !== 'hills' || !o.visible) continue;
    y = Math.max(y, o.position[1] + hillsHeight(o.params, x - o.position[0], z - o.position[2]) * o.scale[1]);
  }
  return roundTo(y, 3);
}
