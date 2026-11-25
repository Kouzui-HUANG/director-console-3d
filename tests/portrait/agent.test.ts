/** Agent reports shared by the tab and the headless server. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReport, commandList, issueDiff, measureReport, paramList, portraitView, presetList } from '../../src/portrait/core/agent.ts';
import { parseAssets } from '../../src/portrait/core/mh/assets.ts';
import { HumanBuilder } from '../../src/portrait/core/mh/human.ts';
import { PRESET_BY_ID } from '../../src/portrait/core/params/presets.ts';
import { newPortrait } from '../../src/portrait/core/schema.ts';

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'portrait', 'mh');
const HAVE = existsSync(path.join(DIR, 'weights.bin'));

describe('agent listings', () => {
  it('lists parameters, presets, traits and commands', () => {
    const groups = paramList() as { group: string; params: string[] }[];
    expect(groups).toHaveLength(14);
    expect(groups.find((g) => g.group === 'nose')!.params.some((p) => p.startsWith('face.nose.bridgeHeight 山根高度'))).toBe(true);
    const spec = paramList({ keys: ['body.heightCm'] }) as { default: unknown; unit: string }[];
    expect(spec[0]!.default).toBeNull();
    expect(spec[0]!.unit).toBe('cm');
    expect(() => paramList({ keys: ['nope'] })).toThrow(/unknown parameter/);
    expect(() => paramList({ group: 'nope' })).toThrow(/unknown group/);
    const p = presetList({ recipes: true });
    expect(p.presets.map((x) => x.id)).toContain('male-european');
    expect(JSON.stringify(p.traits)).toContain('丹鳳眼');
    expect(String(commandList())).toContain('portrait.applyTraits');
    expect((commandList('portrait.set') as { examples: unknown[] }).examples.length).toBeGreaterThan(0);
  });

  it('shows only changed parameters, or every value', () => {
    const doc = newPortrait({ params: { 'face.eyes.size': 0.4 } });
    expect(portraitView(doc).changed).toEqual([{ key: 'face.eyes.size', label: '眼睛大小', value: 0.4 }]);
    const full = portraitView(doc, { resolved: true }).params as Record<string, unknown>;
    expect(full['face.nose.width']).toBe(0);
    expect(full['body.heightCm']).toBeNull();
  });

  it('diffs check results', () => {
    const a = { code: 'X', level: 'warning' as const, message: 'a' };
    const b = { code: 'Y', level: 'note' as const, message: 'b' };
    expect(issueDiff([a], [a, b])).toEqual({ new: [b], resolved: 0 });
    expect(issueDiff([a, b], [b])).toEqual({ new: [], resolved: 1 });
  });
});

describe.skipIf(!HAVE)('measure report', () => {
  const buf = (f: string) => {
    const b = readFileSync(path.join(DIR, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const hb = HAVE ? new HumanBuilder(parseAssets(JSON.parse(readFileSync(path.join(DIR, 'mh.json'), 'utf8')), buf('base.bin'), buf('targets.bin'), buf('weights.bin'))) : (null as unknown as HumanBuilder);

  it('compares with an average person of the same base and height, in words', () => {
    const base = { ...PRESET_BY_ID.get('male-european')!.params };
    const plain = measureReport(hb, newPortrait({ params: { 'base.sex': 1, 'base.european': 1, 'body.heightCm': 178 } }));
    expect(Math.abs(plain.z.ipd!)).toBeLessThan(0.05); // the reference itself
    expect(plain.description).toEqual([]);
    expect(plain.summary).toMatch(/^男性・歐美・25 歲・身高 178 cm・頭身比 7\.9\d・胸像$/);
    const wide = measureReport(hb, newPortrait({ params: { ...base, 'face.eyes.spacing': 1, 'face.nose.alarWidth': 1 } }));
    expect(wide.z.intercanthal).toBeGreaterThan(1);
    expect(wide.description.some((d) => d.startsWith('眼距偏寬'))).toBe(true);
    expect(wide.description.some((d) => d.startsWith('鼻翼偏寬'))).toBe(true);
    expect(wide.measures.height).toBeCloseTo(1780, 0);
    expect(wide.ratios.noseWidthToIntercanthal).toBeGreaterThan(0.5);
  });

  it('checks with the framing applied', () => {
    const issues = checkReport(hb, newPortrait({ params: { 'body.headsTall': 4.5 }, framing: { type: 'head' } }));
    expect(issues.map((i) => i.code)).toContain('HEADS_TALL');
  });
});
