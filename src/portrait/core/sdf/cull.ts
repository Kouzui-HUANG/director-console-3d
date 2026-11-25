/**
 * Spatial culling: keep only the nodes that can change the distance field near the surface inside
 * a box. Polynomial smooth min/max equal plain min/max when their operands differ by more than
 * the blend radius, so a far-away shape changes nothing — but "far" depends on what happens
 * AFTER the shape:
 *  - removing a far union shape only changes values far OUTSIDE the surface; a later smooth
 *    union of radius k can lower such values by up to 1.25·k before they converge, so every
 *    later union widens the reach of earlier union shapes (subtractions/intersections only raise
 *    values and never bring them back toward the surface);
 *  - symmetrically, a far subtraction only changes values deep INSIDE, and later subtractions /
 *    intersections widen its reach.
 * The list is scanned backwards, accumulating both kinds of later blend radii (for groups,
 * conservatively, the children start from the sum of both plus the group's own radius). A node is
 * kept when its bounding box lies within (band + own radius + later radii) × Lipschitz factor of
 * the box. Intersections are always kept. Tests check culled vs full evaluation within the band
 * and that meshes have no missing faces.
 */
import { NODE, OP, type Box, type Program } from './program.ts';

/** Distance between node i's bounding box and a box (0 when they overlap). */
function boxDistance(P: Program, i: number, b: Box): number {
  const o = i * 6;
  const a = P.aabb;
  const dx = Math.max(a[o]! - b[3], b[0] - a[o + 3]!, 0);
  const dy = Math.max(a[o + 1]! - b[4], b[1] - a[o + 4]!, 0);
  const dz = Math.max(a[o + 2]! - b[5], b[2] - a[o + 5]!, 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** How much a later blend of radius k extends the relevance of earlier nodes. */
const LATER = 1.25;

let KEEP = new Uint8Array(1024);
const STACK_U = new Float64Array(128);
const STACK_S = new Float64Array(128);

/**
 * Writes the culled list for `box` into `out` and returns its length. `list` must be a valid list
 * (Program.all or the output of a previous cull for a box that contains this one).
 */
export function cullList(P: Program, list: Int32Array, n: number, box: Box, band: number, out: Int32Array): number {
  if (KEEP.length < n) KEEP = new Uint8Array(n * 2);
  const keep = KEEP;
  let laterU = 0; // later union radii (outside values)
  let laterS = 0; // later subtraction / intersection radii (inside values)
  let depth = 0;
  for (let li = n - 1; li >= 0; li--) {
    const i = list[li]!;
    const kind = P.kind[i];
    const op = P.op[i];
    const k = P.k[i]!;
    if (kind === NODE.begin) {
      // start of a kept, non-atomic group: back to the parent level, the group counts as one op
      keep[li] = 1;
      depth--;
      laterU = STACK_U[depth]!;
      laterS = STACK_S[depth]!;
      if (op === OP.union) laterU += LATER * k;
      else laterS += LATER * k;
      continue;
    }
    const kp = op === OP.inter || boxDistance(P, i, box) <= (band + k + (op === OP.union ? laterU : laterS)) * P.lip[i]!;
    if (kind === NODE.prim) {
      keep[li] = kp ? 1 : 0;
      if (kp) {
        if (op === OP.union) laterU += LATER * k;
        else laterS += LATER * k;
      }
      continue;
    }
    // group end: decide for the whole group
    const begin = P.match[i]!;
    if (!kp || P.atomic[i]) {
      const flag = kp ? 1 : 0;
      keep[li] = flag;
      while (li > 0 && list[li] !== begin) keep[--li] = flag;
      if (kp) {
        if (op === OP.union) laterU += LATER * k;
        else laterS += LATER * k;
      }
      continue;
    }
    keep[li] = 1;
    STACK_U[depth] = laterU;
    STACK_S[depth] = laterS;
    depth++;
    const c = laterU + laterS + LATER * k;
    laterU = c;
    laterS = c;
  }
  let m = 0;
  for (let li = 0; li < n; li++) if (keep[li]) out[m++] = list[li]!;
  return m;
}
