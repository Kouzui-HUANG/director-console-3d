/**
 * Build-time benchmark for the MakeHuman-based portrait mesh (single thread, Node).
 *   node scripts/portrait-bench.ts [--runs 3]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssets } from '../src/portrait/core/mh/assets.ts';
import { HumanBuilder } from '../src/portrait/core/mh/human.ts';
import { PRESET_BY_ID } from '../src/portrait/core/params/presets.ts';
import { resolveParams } from '../src/portrait/core/params/resolve.ts';

const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 3;
const dir = path.resolve(import.meta.dirname, '..', 'public', 'portrait', 'mh');
const buf = (f: string) => {
  const b = readFileSync(path.join(dir, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const t0 = performance.now();
const hb = new HumanBuilder(parseAssets(JSON.parse(readFileSync(path.join(dir, 'mh.json'), 'utf8')), buf('base.bin'), buf('targets.bin'), buf('weights.bin')));
console.log(`assets + topology: ${(performance.now() - t0).toFixed(0)} ms, ${hb.modifiers.length} modifiers`);
for (const id of ['male-european', 'female-eastAsian']) {
  // presets solve an absolute height and pose the arms (the studio's normal path)
  const r = resolveParams(PRESET_BY_ID.get(id)!.params);
  const label = id;
  for (const level of [1, 2]) {
    for (const bust of [false, true]) {
      let best = Infinity;
      let tris = 0;
      for (let i = 0; i < RUNS; i++) {
        const m = hb.build({ values: r.values, heightCm: r.heightCm, headsTall: r.headsTall, pose: r.pose, gaze: r.gaze, level, bust: bust ? { below: 0.19, half: 0.085, sideAngle: 60 } : null });
        best = Math.min(best, m.timing.total);
        tris = m.triangleCount;
      }
      console.log(`${label.padEnd(17)} level ${level} ${bust ? 'bust ' : 'body '} ${best.toFixed(0).padStart(4)} ms  ${(tris / 1e4).toFixed(1)}萬三角面`);
    }
  }
}
