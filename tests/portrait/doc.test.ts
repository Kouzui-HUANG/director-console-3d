/** Portrait document, commands, traits and undo/redo (pure, no assets needed). */
import { describe, expect, it } from 'vitest';
import { describePortraitCommands, runPortraitCommands } from '../../src/portrait/core/commands.ts';
import { PARAM_BY_KEY } from '../../src/portrait/core/params/registry.ts';
import { TRAITS, findTrait, suggestTraits, traitValues } from '../../src/portrait/core/params/traits.ts';
import { clonePortrait, newPortrait, PORTRAIT_ID_PATTERN, portraitJsonSchema, serializePortrait, validatePortrait } from '../../src/portrait/core/schema.ts';
import { applyExternalPortrait, createPortraitStore, dispatch, isDirty, markSaved, undo, redo } from '../../src/portrait/core/store.ts';

const run = (p = newPortrait(), calls: { cmd: string; args?: Record<string, unknown> }[]) => runPortraitCommands(p, calls);

describe('portrait document', () => {
  it('creates, serializes and validates round-trip', () => {
    const p = newPortrait({ name: '林小姐', preset: 'female-eastAsian', params: { 'face.eyes.size': 0.3, 'base.sex': 0 } });
    expect(p.id).toMatch(PORTRAIT_ID_PATTERN);
    const text = serializePortrait(p);
    // registry order: base.* before face.*
    expect(text.indexOf('base.sex')).toBeLessThan(text.indexOf('face.eyes.size'));
    const r = validatePortrait(JSON.parse(text));
    expect(r.ok).toBe(true);
    expect(r.portrait!.params).toEqual({ 'base.sex': 0, 'face.eyes.size': 0.3 });
    expect(r.portrait!.framing.type).toBe('bust');
    expect(clonePortrait(p).id).not.toBe(p.id);
    expect(JSON.stringify(portraitJsonSchema())).toContain('director3d.portrait');
  });

  it('drops unknown parameters and defaults with warnings, clamps, rejects bad documents', () => {
    const p = newPortrait();
    const r = validatePortrait({ ...p, params: { 'face.nose.widht': 1, 'face.eyes.size': 9, 'face.mouth.width': 0, 'body.heightCm': null, 'face.ears.lobe': null } });
    expect(r.ok).toBe(true);
    expect(r.portrait!.params).toEqual({ 'face.eyes.size': 2 });
    expect(r.warnings.join('\n')).toContain('face.nose.width');
    expect(r.warnings.some((w) => w.includes('face.eyes.size'))).toBe(true);
    expect(validatePortrait({ ...p, id: 'bad id' }).ok).toBe(false);
    expect(validatePortrait({ ...p, version: 99 }).errors[0]!.path).toBe('version');
    expect(validatePortrait({ ...p, params: { 'face.eyes.size': 'big' } }).ok).toBe(false);
    expect(validatePortrait([]).ok).toBe(false);
  });
});

describe('traits', () => {
  it('only use known parameters within their realistic ranges, with unique names', () => {
    const names = new Set<string>();
    for (const t of TRAITS) {
      for (const n of [t.name, ...(t.aliases ?? [])]) {
        expect(names.has(n)).toBe(false);
        names.add(n);
      }
      for (const [k, v] of Object.entries(t.params)) {
        const d = PARAM_BY_KEY.get(k);
        expect(d, `${t.name} → ${k}`).toBeDefined();
        expect(v).toBeGreaterThanOrEqual(d!.range[0]);
        expect(v).toBeLessThanOrEqual(d!.range[1]);
      }
    }
    expect(TRAITS.length).toBeGreaterThan(60);
    expect(findTrait('國字臉')?.name).toBe('方臉');
    expect(findTrait(' M唇 ')?.name).toBe('M 唇');
    expect(suggestTraits('鳳眼')).toContain('丹鳳眼');
    expect(traitValues(findTrait('高鼻樑')!, 0.5)['face.nose.bridgeHeight']).toBeCloseTo(0.35);
  });
});

describe('portrait commands', () => {
  it('sets, clamps with a warning and removes defaults', () => {
    const r = run(newPortrait({ params: { 'face.mouth.width': 0.5 } }), [{ cmd: 'portrait.set', args: { params: { 'face.eyes.size': 3, 'face.mouth.width': 0, 'body.heightCm': 170 } } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.portrait.params).toEqual({ 'face.eyes.size': 2, 'body.heightCm': 170 });
    expect(r.warnings[0]).toContain('face.eyes.size');
    const cleared = run(r.portrait, [{ cmd: 'portrait.set', args: { params: { 'body.heightCm': null } } }]);
    expect(cleared.ok && cleared.portrait.params).toEqual({ 'face.eyes.size': 2 });
  });

  it('reports every error of a failed batch and changes nothing', () => {
    const p = newPortrait();
    const r = run(p, [
      { cmd: 'portrait.set', args: { params: { 'face.eyes.size': 0.5 } } },
      { cmd: 'portrait.set', args: { params: { 'face.nose.widht': 1 } } },
      { cmd: 'portrait.applyTraits', args: { traits: ['不存在的眼'] } },
      { cmd: 'portrait.sett', args: {} },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([
      [1, 'UNKNOWN_PARAM'],
      [2, 'UNKNOWN_TRAIT'],
      [3, 'UNKNOWN_COMMAND'],
    ]);
    expect(r.errors[0]!.hint).toContain('face.nose.width');
    expect(r.errors[2]!.hint).toContain('portrait.set');
    expect(p.params).toEqual({});
  });

  it('resets keys or groups, applies presets (optionally per group) and neutralizes', () => {
    const start = newPortrait({ params: { 'face.eyes.size': 0.5, 'face.nose.length': 0.4, 'body.waist': 0.3, 'expr.smile': 0.6 } });
    const r1 = run(start, [{ cmd: 'portrait.reset', args: { groups: ['nose'] } }]);
    expect(r1.ok && Object.keys(r1.portrait.params).sort()).toEqual(['body.waist', 'expr.smile', 'face.eyes.size']);
    const r2 = run(start, [{ cmd: 'portrait.applyPreset', args: { preset: 'female-eastAsian', groups: ['base'] } }]);
    expect(r2.ok && r2.portrait.params['base.eastAsian']).toBe(1);
    expect(r2.ok && r2.portrait.params['face.eyes.size']).toBe(0.5); // other groups kept
    const r3 = run(start, [{ cmd: 'portrait.applyPreset', args: { preset: 'male-european' } }]);
    expect(r3.ok && r3.portrait.preset).toBe('male-european');
    expect(r3.ok && r3.portrait.params['face.nose.length']).toBeUndefined();
    const r4 = run(start, [{ cmd: 'portrait.neutralize' }]);
    expect(r4.ok && r4.portrait.params['expr.smile']).toBeUndefined();
    const bad = run(start, [{ cmd: 'portrait.applyPreset', args: { preset: 'elf' } }]);
    expect(!bad.ok && bad.error.code).toBe('UNKNOWN_PRESET');
  });

  it('applies traits (set / add, amount) and mixes presets', () => {
    const r = run(newPortrait(), [{ cmd: 'portrait.applyTraits', args: { traits: ['丹鳳眼', '高鼻樑'], amount: 0.5 } }]);
    expect(r.ok && r.portrait.params['face.eyes.tilt']).toBeCloseTo(0.35);
    expect(r.ok && r.portrait.params['face.nose.bridgeHeight']).toBeCloseTo(0.35);
    const add = run(newPortrait({ params: { 'face.eyes.tilt': 0.2 } }), [{ cmd: 'portrait.applyTraits', args: { traits: ['上揚眼', '丹鳳眼'], mode: 'add' } }]);
    expect(add.ok && add.portrait.params['face.eyes.tilt']).toBeCloseTo(0.2 + 0.7 + 0.7);
    const mix = run(newPortrait(), [{ cmd: 'portrait.mix', args: { sources: [{ preset: 'female-eastAsian', weight: 3 }, { preset: 'female-european', weight: 1 }] } }]);
    expect(mix.ok).toBe(true);
    if (!mix.ok) return;
    expect(mix.portrait.params['base.eastAsian']).toBeCloseTo(0.75);
    expect(mix.portrait.params['base.european']).toBeCloseTo(0.25);
    expect(mix.portrait.params['body.heightCm']).toBeCloseTo(161.25);
  });

  it('randomizes deterministically per seed and updates framing', () => {
    const a = run(newPortrait(), [{ cmd: 'portrait.randomize', args: { seed: 42 } }]);
    const b = run(newPortrait(), [{ cmd: 'portrait.randomize', args: { seed: 42 } }]);
    expect(a.ok && b.ok && a.portrait.params).toEqual(b.ok && b.portrait.params);
    expect(a.ok && Object.keys(a.portrait.params).some((k) => k.startsWith('base.'))).toBe(false);
    const f = run(newPortrait(), [{ cmd: 'portrait.update', args: { name: '測試', framing: { type: 'head' } } }]);
    expect(f.ok && f.portrait.framing.type).toBe('head');
    expect(f.ok && f.portrait.name).toBe('測試');
    expect(describePortraitCommands().map((c) => c.name)).toContain('portrait.applyTraits');
  });
});

describe('portrait store', () => {
  it('undoes, redoes, merges slider drags and tracks dirty state', () => {
    const store = createPortraitStore(newPortrait());
    dispatch(store, { cmd: 'portrait.set', args: { params: { 'face.eyes.size': 0.1 } } }, { mergeKey: 'set:face.eyes.size' });
    dispatch(store, { cmd: 'portrait.set', args: { params: { 'face.eyes.size': 0.4 } } }, { mergeKey: 'set:face.eyes.size' });
    dispatch(store, { cmd: 'portrait.set', args: { params: { 'face.nose.length': 0.2 } } });
    expect(store.getState().past).toHaveLength(2);
    expect(isDirty(store.getState())).toBe(true);
    markSaved(store);
    expect(isDirty(store.getState())).toBe(false);
    undo(store);
    expect(store.getState().portrait.params).toEqual({ 'face.eyes.size': 0.4 });
    undo(store);
    expect(store.getState().portrait.params).toEqual({});
    redo(store);
    expect(store.getState().portrait.params).toEqual({ 'face.eyes.size': 0.4 });
    const r = dispatch(store, [{ cmd: 'history.undo', args: { steps: 5 } }]);
    expect(r.undone).toBe(1);
    const dry = dispatch(store, { cmd: 'portrait.set', args: { params: { 'face.eyes.size': 1 } } }, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(store.getState().portrait.params).toEqual({});
  });

  it('applies an external edit as one undoable step', () => {
    const p = newPortrait({ params: { 'face.eyes.size': 0.2 } });
    const store = createPortraitStore(p);
    expect(applyExternalPortrait(store, { ...p, name: '改名', params: { 'face.nose.length': 0.5 } })).toBe(true);
    expect(store.getState().portrait.name).toBe('改名');
    undo(store);
    expect(store.getState().portrait.params).toEqual({ 'face.eyes.size': 0.2 });
    expect(applyExternalPortrait(store, store.getState().portrait)).toBe(false);
  });
});
