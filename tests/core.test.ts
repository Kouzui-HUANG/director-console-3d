import { describe, expect, it } from 'vitest';
import { runCommands } from '../src/core/commands/execute.ts';
import { describeCommands } from '../src/core/commands/registry.ts';
import { cameraView, describeScene } from '../src/core/describe.ts';
import { evaluateCamera, evaluateObject, programCameraAt } from '../src/core/evaluate.ts';
import { applyEase, sampleTrack } from '../src/core/interpolate.ts';
import { effectiveSensor, equivalentFocal, fovFromFocal, lensFov, resolutionFor } from '../src/core/lens.ts';
import { cameraForward, faceYaw, lookAngles, rotateY, unwrapDeg } from '../src/core/math.ts';
import { buildProject, emptyProject, serializeProject } from '../src/core/project.ts';
import { createDirectorStore, dispatch, redo, undo } from '../src/core/store.ts';
import { TEMPLATES, templateProject } from '../src/core/templates.ts';
import { validateProject } from '../src/core/validate.ts';
import type { Project } from '../src/core/schema.ts';

const near = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('math conventions', () => {
  it('positive yaw turns left (counter-clockwise from above)', () => {
    const v = rotateY([0, 0, 1], 90);
    near(v[0], 1);
    near(v[2], 0);
  });
  it('camera at pan 0 looks -Z; lookAngles inverts cameraForward', () => {
    const f = cameraForward(0, 0);
    near(f[2], -1);
    const { pan, tilt } = lookAngles([0, 1, 5], [3, 2, -1]);
    const g = cameraForward(pan, tilt);
    const d = [3, 1, -6];
    const len = Math.hypot(...d);
    near(g[0], d[0]! / len);
    near(g[1], d[1]! / len);
    near(g[2], d[2]! / len);
  });
  it('faceYaw points the +Z front at the target', () => {
    near(faceYaw([0, 0, 0], [1, 0, 0]), 90);
    near(faceYaw([0, 0, 0], [0, 0, -1]), 180);
  });
  it('unwrapDeg picks the closest equivalent angle', () => {
    expect(unwrapDeg(170, -170)).toBe(190);
    expect(unwrapDeg(-10, 350)).toBe(-10);
  });
});

describe('lens', () => {
  it('50mm on full frame = 39.6° horizontal', () => {
    near(fovFromFocal(50, 36), 39.6, 0.05);
  });
  it('crops the sensor to the frame aspect; portrait rotates the sensor', () => {
    const land = effectiveSensor('fullFrame', 16 / 9);
    near(land.w, 36);
    near(land.h, 20.25);
    const port = effectiveSensor('fullFrame', 9 / 16);
    near(port.h, 36);
    near(port.w, 20.25);
    near(lensFov(50, 'fullFrame', 16 / 9).hfov, 39.6, 0.05);
  });
  it('equivalent focal length', () => {
    near(equivalentFocal(50, 'fullFrame'), 50);
    expect(equivalentFocal(8.8, 'oneInch')).toBeGreaterThan(23);
  });
  it('resolution presets are even and match common sizes', () => {
    expect(resolutionFor(16 / 9, 1080)).toEqual([1920, 1080]);
    expect(resolutionFor(9 / 16, 1080)).toEqual([1080, 1920]);
    expect(resolutionFor(1, 1080)).toEqual([1080, 1080]);
    expect(resolutionFor(4 / 5, 1080)).toEqual([1080, 1350]);
    expect(resolutionFor(2.39, 1080)).toEqual([1920, 804]);
    expect(resolutionFor(16 / 9, 2160)).toEqual([3840, 2160]);
    for (const a of [1.85, 2.39, 4 / 3, 2]) for (const tier of [720, 1080, 1440, 2160]) {
      const [w, h] = resolutionFor(a, tier);
      expect(w % 2).toBe(0);
      expect(h % 2).toBe(0);
    }
  });
});

describe('interpolation', () => {
  const def = { kind: 'vec3' as const, interp: 'continuous' as const };
  it('eases', () => {
    expect(applyEase(0.5, 'linear')).toBe(0.5);
    near(applyEase(0.5, 'inOut'), 0.5);
    expect(applyEase(0.25, 'in')).toBeLessThan(0.25);
  });
  it('linear, hold and clamping', () => {
    const track = { keys: [{ t: 0, v: [0, 0, 0], ease: 'linear' as const }, { t: 2, v: [2, 0, 0] }] };
    expect(sampleTrack(track, 1, def)).toEqual([1, 0, 0]);
    expect(sampleTrack(track, -1, def)).toEqual([0, 0, 0]);
    expect(sampleTrack(track, 5, def)).toEqual([2, 0, 0]);
    const hold = { keys: [{ t: 0, v: [0, 0, 0], ease: 'hold' as const }, { t: 2, v: [2, 0, 0] }] };
    expect(sampleTrack(hold, 1.9, def)).toEqual([0, 0, 0]);
  });
  it('smooth path passes through every key', () => {
    const track = {
      path: 'smooth' as const,
      keys: [
        { t: 0, v: [0, 0, 0], ease: 'linear' as const },
        { t: 1, v: [1, 0, 1], ease: 'linear' as const },
        { t: 2, v: [2, 0, 0], ease: 'linear' as const },
      ],
    };
    const mid = sampleTrack(track, 1, def) as number[];
    near(mid[0]!, 1);
    near(mid[2]!, 1);
  });
});

function store(p: Project = emptyProject('t')) {
  return createDirectorStore(p);
}

describe('commands', () => {
  it('adds objects with readable auto ids and suggests types', () => {
    const s = store();
    const r = dispatch(s, [{ cmd: 'object.add', args: { type: 'male' } }, { cmd: 'object.add', args: { type: 'camera' } }]);
    expect(r.ok).toBe(true);
    expect(s.getState().project.objects.map((o) => o.id)).toEqual(['male_1', 'camA']);
    const bad = dispatch(s, { cmd: 'object.add', args: { type: 'man' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('UNKNOWN_TYPE');
      expect(bad.error.hint).toContain('male');
    }
  });

  it('is atomic: a failing command rolls back the whole batch', () => {
    const s = store();
    const r = dispatch(s, [
      { cmd: 'object.add', args: { type: 'box', id: 'b1' } },
      { cmd: 'object.update', args: { id: 'nope', color: 'red' } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.index).toBe(1);
    expect(s.getState().project.objects).toHaveLength(0);
  });

  it('resolves $N references to earlier results', () => {
    const s = store();
    const r = dispatch(s, [
      { cmd: 'object.add', args: { type: 'female' } },
      { cmd: 'object.update', args: { id: '$0', position: [1, 0, 2] } },
    ]);
    expect(r.ok).toBe(true);
    expect(s.getState().project.objects[0]!.position).toEqual([1, 0, 2]);
  });

  it('static vs keyed updates (After Effects style)', () => {
    const s = store();
    dispatch(s, { cmd: 'object.add', args: { type: 'male', id: 'hero' } });
    dispatch(s, { cmd: 'object.update', args: { id: 'hero', position: [1, 0, 0] } });
    expect(s.getState().project.objects[0]!.position).toEqual([1, 0, 0]);
    dispatch(s, { cmd: 'key.set', args: { id: 'hero', prop: 'position', t: 0 } });
    const r = dispatch(s, { cmd: 'object.update', args: { id: 'hero', position: [5, 0, 0], t: 2 } });
    expect(r.ok && (r.results[0] as { keyed: string[] }).keyed).toEqual(['position']);
    const hero = s.getState().project.objects[0]!;
    expect(hero.tracks.position!.keys.map((k) => k.t)).toEqual([0, 2]);
    expect(evaluateObject(hero, 1).position[0]).toBeCloseTo(3, 5);
  });

  it('undo / redo and merged drags', () => {
    const s = store();
    dispatch(s, { cmd: 'object.add', args: { type: 'box', id: 'b' } });
    for (let i = 1; i <= 5; i++) dispatch(s, { cmd: 'object.update', args: { id: 'b', position: [i, 0, 0] } }, { mergeKey: 'drag:b' });
    expect(s.getState().past).toHaveLength(2);
    expect(undo(s)).toBe(true);
    expect(s.getState().project.objects[0]!.position).toEqual([0, 0, 0]);
    expect(redo(s)).toBe(true);
    expect(s.getState().project.objects[0]!.position).toEqual([5, 0, 0]);
    dispatch(s, { cmd: 'history.undo', args: { steps: 2 } });
    expect(s.getState().project.objects).toHaveLength(0);
  });

  it('project.update recomputes resolution from aspect', () => {
    const s = store();
    dispatch(s, { cmd: 'project.update', args: { settings: { aspect: '9:16' } } });
    expect(s.getState().project.settings.resolution).toEqual([1080, 1920]);
    dispatch(s, { cmd: 'project.update', args: { settings: { resolutionTier: '720p' } } });
    expect(s.getState().project.settings.resolution).toEqual([720, 1280]);
    const bad = dispatch(s, { cmd: 'project.update', args: { settings: { duration: 45 } } });
    expect(bad.ok).toBe(false);
  });

  it('cuts drive the program camera', () => {
    const s = store();
    dispatch(s, [
      { cmd: 'object.add', args: { type: 'camera', id: 'a' } },
      { cmd: 'object.add', args: { type: 'camera', id: 'b' } },
      { cmd: 'cut.set', args: { t: 0, camera: 'a' } },
      { cmd: 'cut.set', args: { t: 3, camera: 'b' } },
    ]);
    const p = s.getState().project;
    expect(programCameraAt(p, 0)).toBe('a');
    expect(programCameraAt(p, 2.99)).toBe('a');
    expect(programCameraAt(p, 3)).toBe('b');
    dispatch(s, { cmd: 'object.remove', args: { id: 'b' } });
    expect(s.getState().project.cuts).toHaveLength(1);
  });

  it('camera.frame places the subject in the middle at the right size', () => {
    const p = buildProject('f', [
      { cmd: 'object.add', args: { type: 'male', id: 'hero', position: [2, 0, -3], rotation: [0, 30, 0] } },
      { cmd: 'object.add', args: { type: 'camera', id: 'cam' } },
      { cmd: 'camera.frame', args: { camera: 'cam', target: 'hero', shot: 'FS' } },
    ]);
    const view = cameraView(p, 'cam', 0)!;
    const hero = view.objects.find((o) => o.id === 'hero')!;
    expect(hero.inFrame).toBe('full');
    near(hero.center![0], 0.5, 0.06);
    expect(hero.shot).toBe('FS');
    const p2 = buildProject('f2', [
      { cmd: 'object.add', args: { type: 'female', id: 'a' } },
      { cmd: 'object.add', args: { type: 'camera', id: 'cam', camera: { focalLength: 50 } } },
      { cmd: 'camera.frame', args: { camera: 'cam', target: 'a', shot: 'MS', side: 'frontLeft' } },
    ]);
    expect(cameraView(p2, 'cam', 0)!.objects.find((o) => o.id === 'a')!.shot).toMatch(/MS|MCU|MLS/);
  });

  it('camera.move dollyIn and orbit create keyframes', () => {
    const p = buildProject('m', [
      { cmd: 'object.add', args: { type: 'male', id: 'hero' } },
      { cmd: 'object.add', args: { type: 'camera', id: 'cam', position: [0, 1.6, 6], camera: { lookAt: { target: 'hero' } } } },
      { cmd: 'camera.move', args: { camera: 'cam', preset: 'dollyIn', start: 0, duration: 4, amount: 2 } },
    ]);
    const cam = p.objects.find((o) => o.id === 'cam')!;
    expect(cam.tracks.position!.keys).toHaveLength(2);
    const end = evaluateCamera(p, cam, 4).position;
    expect(Math.hypot(end[0], end[2])).toBeLessThan(4.2);
    const p2 = buildProject('o', [
      { cmd: 'object.add', args: { type: 'male', id: 'hero' } },
      { cmd: 'object.add', args: { type: 'camera', id: 'cam', position: [0, 1.6, 6] } },
      { cmd: 'camera.move', args: { camera: 'cam', preset: 'orbitRight', start: 0, duration: 6, amount: 90, target: 'hero' } },
    ]);
    const c2 = p2.objects.find((o) => o.id === 'cam')!;
    const e = evaluateCamera(p2, c2, 6);
    near(Math.hypot(e.position[0], e.position[2]), 6, 0.05);
    // still aimed at the subject
    expect(cameraView(p2, 'cam', 6)!.objects.some((o) => o.id === 'hero')).toBe(true);
  });

  it('pan on a lookAt camera is rejected with a hint', () => {
    const s = store();
    dispatch(s, [
      { cmd: 'object.add', args: { type: 'box', id: 'b' } },
      { cmd: 'object.add', args: { type: 'camera', id: 'cam', camera: { lookAt: { target: 'b' } } } },
    ]);
    const r = dispatch(s, { cmd: 'camera.move', args: { camera: 'cam', preset: 'panLeft' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toContain('lookAt');
  });

  it('moveTo walks a character, turns it and restores the pose', () => {
    const p = buildProject('w', [
      { cmd: 'object.add', args: { type: 'male', id: 'hero' } },
      { cmd: 'object.moveTo', args: { id: 'hero', to: [0, -7], start: 1 } },
    ]);
    const hero = p.objects[0]!;
    const atEnd = evaluateObject(hero, 6);
    near(atEnd.position[2], -7);
    near(Math.abs(atEnd.rotation[1]), 180, 0.01);
    expect(evaluateObject(hero, 3).params.pose).toBe('walk');
    expect(atEnd.params.pose).toBe('stand');
  });

  it('every command has a JSON schema and examples', () => {
    const list = describeCommands();
    expect(list.length).toBeGreaterThan(20);
    for (const c of list) {
      expect(c.args).toBeTruthy();
      expect(c.examples.length).toBeGreaterThan(0);
    }
  });
});

describe('templates, validation and description', () => {
  it('all templates build', () => {
    for (const t of TEMPLATES) {
      const p = templateProject(t.id);
      expect(p.objects.length).toBeGreaterThan(0);
      expect(describeScene(p, 1)).toContain(p.name);
    }
  });

  it('serialize → validate round-trips', () => {
    const p = templateProject('street');
    const json = JSON.parse(serializeProject(p, { schemaRef: '../schema/project.schema.json' }));
    const r = validateProject(json);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.project!.objects.length).toBe(p.objects.length);
    expect(r.project!.cuts).toEqual(p.cuts);
  });

  it('reports useful errors and fixes dangling references', () => {
    const r = validateProject({ id: 'x', objects: [{ id: 'a', type: 'man' }] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('male');
    const r2 = validateProject({
      id: 'x',
      objects: [{ id: 'c', type: 'camera', camera: { lookAt: { target: 'ghost' } } }],
      cuts: [{ t: 0, camera: 'nope' }],
    });
    expect(r2.ok).toBe(true);
    expect(r2.project!.objects[0]!.camera!.lookAt).toBeNull();
    expect(r2.project!.cuts).toEqual([]);
    expect(r2.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('loads old files with removed depth-of-field / tilt-shift settings', () => {
    const r = validateProject({
      id: 'x',
      objects: [
        {
          id: 'c',
          type: 'camera',
          camera: { focalLength: 85, dof: { enabled: true, fStop: 1.8 }, tiltShift: { enabled: true, blur: 0.8 } },
          tracks: {
            'camera.dof.fStop': { keys: [{ t: 0, v: 2 }, { t: 2, v: 8 }] },
            'camera.tiltShift.blur': { keys: [{ t: 0, v: 0.5 }] },
            'camera.focalLength': { keys: [{ t: 0, v: 50 }, { t: 2, v: 85 }] },
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    const cam = r.project!.objects[0]!;
    expect(cam.camera).not.toHaveProperty('dof');
    expect(cam.camera).not.toHaveProperty('tiltShift');
    expect(Object.keys(cam.tracks)).toEqual(['camera.focalLength']);
    expect(r.warnings.filter((w) => w.message.includes('no longer supported'))).toHaveLength(2);
  });
});

describe('details', () => {
  it('snapped key times stay short and on the frame grid', async () => {
    const { snapTime } = await import('../src/core/interpolate.ts');
    expect(snapTime(2.6, 24)).toBe(2.5833);
    expect(snapTime(1, 24)).toBe(1);
  });

  it('new characters get distinct colors', () => {
    const p = buildProject('c', [
      { cmd: 'object.add', args: { type: 'female' } },
      { cmd: 'object.add', args: { type: 'male' } },
      { cmd: 'object.add', args: { type: 'male' } },
      { cmd: 'object.add', args: { type: 'female' } },
    ]);
    const colors = p.objects.map((o) => o.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('key.path switches a position track to a smooth curve', () => {
    const s = store();
    dispatch(s, [
      { cmd: 'object.add', args: { type: 'box', id: 'b' } },
      { cmd: 'object.followPath', args: { id: 'b', points: [[2, 0], [2, 2]], start: 0, smooth: false } },
    ]);
    expect(s.getState().project.objects[0]!.tracks.position!.path).toBe('linear');
    dispatch(s, { cmd: 'key.path', args: { id: 'b', path: 'smooth' } });
    expect(s.getState().project.objects[0]!.tracks.position!.path).toBe('smooth');
  });

  it('storyboard picks one frame per shot of the edit', async () => {
    const { storyboardTimes } = await import('../src/export/storyboard.ts');
    const p = templateProject('street');
    const times = storyboardTimes(p, 'program');
    expect(times).toHaveLength(p.cuts.length);
    for (let i = 0; i < times.length; i++) expect(programCameraAt(p, times[i]!)).toBe(p.cuts[i]!.camera);
  });
});

describe('agent ergonomics', () => {
  it('a failing batch reports every error, not just the first', () => {
    const s = store();
    const r = dispatch(s, [
      { cmd: 'object.add', args: { type: 'man', id: 'hero' } },
      { cmd: 'object.add', args: { type: 'box', id: 'b1' } },
      { cmd: 'object.updat', args: { id: 'b1' } },
      { cmd: 'object.update', args: { id: 'hero', position: [1, 0, 0] } },
      { cmd: 'object.update', args: { id: '$0', position: [2, 0, 0] } },
      { cmd: 'object.update', args: { id: 'ghost', position: [0, 0, 0] } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toEqual(r.error);
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([
      [0, 'UNKNOWN_TYPE'],
      [2, 'UNKNOWN_COMMAND'],
      [3, 'DEPENDS_ON_FAILED'],
      [4, 'DEPENDS_ON_FAILED'],
      [5, 'NOT_FOUND'],
    ]);
    expect(r.errors[3]!.hint).toContain('[0]');
    expect(r.errors[4]!.hint).toContain('b1');
    expect(s.getState().project.objects).toHaveLength(0);
  });

  it('a single failing command has exactly one error', () => {
    const r = dispatch(store(), { cmd: 'object.add', args: { type: 'man' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([r.error]);
  });

  it('projectJson filters objects and sections', async () => {
    const { projectJson } = await import('../src/core/project.ts');
    const p = templateProject('street');
    const id = p.objects[0]!.id;
    const one = projectJson(p, { ids: [id] });
    expect((one.objects as { id: string }[]).map((o) => o.id)).toEqual([id]);
    const settingsOnly = projectJson(p, { fields: ['settings'] });
    expect(Object.keys(settingsOnly)).toEqual(expect.arrayContaining(['id', 'name', 'revision', 'settings']));
    expect(settingsOnly.objects).toBeUndefined();
    expect(settingsOnly.cuts).toBeUndefined();
    expect(() => projectJson(p, { ids: ['nope'] })).toThrow(/nope/);
    expect(() => projectJson(p, { fields: ['objectz'] })).toThrow(/objectz/);
  });

  it('resolvedScene and groundHeightAt are available to the server', async () => {
    const { resolvedScene } = await import('../src/core/describe.ts');
    const { groundHeightAt } = await import('../src/core/terrain.ts');
    const p = templateProject('street');
    const cam = p.objects.find((o) => o.type === 'camera')!.id;
    const ev = resolvedScene(p, 1, { ids: [cam] });
    expect(ev.objects).toHaveLength(0);
    expect(ev.cameras.map((c) => c.id)).toEqual([cam]);
    expect(() => resolvedScene(p, 1, { ids: ['ghost'] })).toThrow(/ghost/);
    expect(groundHeightAt(p, 3, 3)).toBe(0);
    const hilly = buildProject('h', [{ cmd: 'object.add', args: { type: 'hills', id: 'h', position: [0, 2, 0] } }]);
    expect(groundHeightAt(hilly, 0, 0)).toBe(2);
    const far: number[] = [];
    for (let x = -150; x <= 150; x += 30) for (let z = -150; z <= 150; z += 30) far.push(groundHeightAt(hilly, x, z));
    expect(Math.max(...far)).toBeGreaterThan(2);
  });

  it('asset type info is plain JSON with param specs', async () => {
    const { assetTypeInfo } = await import('../src/core/assetTypes.ts');
    const info = assetTypeInfo();
    const male = info.find((d) => d.type === 'male')!;
    expect(male.params.map((f) => f.key)).toContain('pose');
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });
});

describe('plan view model', () => {
  const scene = () =>
    buildProject('plan', [
      { cmd: 'object.add', args: { type: 'male', id: 'a', position: [0, 0, 0], rotation: [0, 90, 0] } },
      { cmd: 'object.add', args: { type: 'female', id: 'w', position: [-3, 0, 2] } },
      { cmd: 'object.moveTo', args: { id: 'w', to: [-3, -4], start: 0, duration: 3 } },
      { cmd: 'object.add', args: { type: 'chair', id: 'c', position: [2, 0, 1] } },
      { cmd: 'object.update', args: { id: 'c', visible: false } },
      { cmd: 'object.add', args: { type: 'camera', id: 'camA', position: [0, 1.6, 6] } },
      { cmd: 'object.add', args: { type: 'camera', id: 'camB', position: [5, 1.6, 0], camera: { lookAt: { target: 'a' } } } },
      { cmd: 'cut.set', args: { t: 0, camera: 'camB' } },
    ]);

  it('gives facing, camera wedges, the live camera, paths and hidden objects', async () => {
    const { planModel } = await import('../src/core/plan.ts');
    const m = planModel(scene(), 0);
    const a = m.shapes.find((s) => s.id === 'a')!;
    expect(a.kind).toBe('character');
    near(a.facing![0], 1);
    near(a.facing![1], 0);
    const camA = m.cameras.find((c) => c.id === 'camA')!;
    near(camA.direction![0], 0);
    near(camA.direction![1], -1);
    expect(camA.live).toBe(false);
    const camB = m.cameras.find((c) => c.id === 'camB')!;
    expect(camB.live).toBe(true);
    expect(camB.label).toContain('LIVE');
    expect(camB.direction![0]).toBeLessThan(-0.95);
    expect(camB.aim).not.toBeNull();
    const walk = m.paths.find((p) => p.id === 'w')!;
    expect(walk.keys.length).toBeGreaterThanOrEqual(2);
    near(walk.points[0]![1], 2, 0.01);
    near(walk.points[walk.points.length - 1]![1], -4, 0.01);
    const chair = m.shapes.find((s) => s.id === 'c')!;
    expect(chair.hidden).toBe(true);
    expect(chair.label).toContain('hidden');
    expect(m.shapes[m.shapes.length - 1]!.kind).toBe('character');
  });

  it('fits the area around the action and picks a readable grid', async () => {
    const { planModel, gridStep, fitArea } = await import('../src/core/plan.ts');
    const m = planModel(templateProject('street'), 2);
    const [x0, z0, x1, z1] = m.area;
    for (const c of m.cameras) {
      expect(c.position[0]).toBeGreaterThanOrEqual(x0);
      expect(c.position[0]).toBeLessThanOrEqual(x1);
      expect(c.position[1]).toBeGreaterThanOrEqual(z0);
      expect(c.position[1]).toBeLessThanOrEqual(z1);
    }
    expect(x1 - x0).toBeLessThan(80);
    const ratio = (x1 - x0) / (z1 - z0);
    expect(ratio).toBeGreaterThanOrEqual(0.74);
    expect(ratio).toBeLessThanOrEqual(1.79);
    expect(gridStep([0, 0, 20, 15])).toBe(2);
    expect(gridStep([0, 0, 8, 6])).toBe(0.5);
    expect(fitArea([])).toEqual([-10, -10, 10, 10]);
    expect(planModel(scene(), 0, { area: [-2, -2, 2, 2] }).area).toEqual([-2, -2, 2, 2]);
    expect(() => planModel(scene(), 0, { area: [0, 0, 0, 5] })).toThrow(/area/);
    expect(planModel(scene(), 0, { paths: false }).paths).toHaveLength(0);
  });
});

describe('shot description', () => {
  it('a single MCU is an MCU, and the shoulder in an over-the-shoulder is foreground', () => {
    const single = buildProject('s', [
      { cmd: 'object.add', args: { type: 'male', id: 'a' } },
      { cmd: 'object.add', args: { type: 'camera', id: 'c' } },
      { cmd: 'camera.frame', args: { camera: 'c', target: 'a', shot: 'MCU' } },
    ]);
    expect(describeScene(single, 0)).toContain('a MCU');
    expect(describeScene(single, 0)).not.toContain('foreground');
    const ots = buildProject('o', [
      { cmd: 'object.add', args: { type: 'male', id: 'a', position: [0, 0, 1.2], rotation: [0, 180, 0] } },
      { cmd: 'object.add', args: { type: 'female', id: 'b', position: [0, 0, -1.2] } },
      { cmd: 'object.add', args: { type: 'camera', id: 'otsA' } },
      { cmd: 'camera.frame', args: { camera: 'otsA', target: 'b', shot: 'MCU', over: 'a', shoulder: 'right' } },
    ]);
    const v = cameraView(ots, 'otsA', 0)!;
    expect(v.objects.find((o) => o.id === 'b')!.foreground).toBeUndefined();
    expect(v.objects.find((o) => o.id === 'a')!.foreground).toBe(true);
    expect(describeScene(ots, 0)).toMatch(/a foreground \(over the shoulder\)/);
  });
});

describe('scene checks', () => {
  const codes = async (p: Project) => (await import('../src/core/checks.ts')).checkScene(p).issues.map((i) => i.code);

  it('templates only report their real problems', async () => {
    const { checkScene } = await import('../src/core/checks.ts');
    const expected: Record<string, string[]> = { street: ['CROSSED_LINE'], hillside: ['OVERLAP'] };
    for (const t of TEMPLATES) expect(checkScene(templateProject(t.id)).issues.map((i) => i.code)).toEqual(expected[t.id] ?? []);
  });

  it('flags physical problems', async () => {
    const p = buildProject('phys', [
      { cmd: 'object.add', args: { type: 'table', id: 'table1' } },
      { cmd: 'object.add', args: { type: 'male', id: 'a', position: [0, 0, 0.1] } },
      { cmd: 'object.add', args: { type: 'female', id: 'b', position: [0.1, 0, 0.1] } },
      { cmd: 'object.add', args: { type: 'box', id: 'crate', position: [3, 1, 0] } },
      { cmd: 'object.add', args: { type: 'building', id: 'bldg', position: [10, 0, 0] } },
      { cmd: 'object.add', args: { type: 'camera', id: 'inWall', position: [10, 2, 0] } },
      { cmd: 'object.add', args: { type: 'camera', id: 'mole', position: [-3, -0.5, 4] } },
    ]);
    const { checkScene } = await import('../src/core/checks.ts');
    const r = checkScene(p);
    const has = (code: string, ...ids: string[]) => r.issues.some((i) => i.code === code && ids.every((id) => i.ids.includes(id)));
    expect(has('OVERLAP', 'a', 'table1')).toBe(true);
    expect(has('OVERLAP', 'a', 'b')).toBe(true);
    expect(has('FLOATING', 'crate')).toBe(true);
    expect(has('CAMERA_INSIDE', 'inWall', 'bldg')).toBe(true);
    expect(has('CAMERA_UNDERGROUND', 'mole')).toBe(true);
    expect(r.issues.every((i) => i.hint)).toBe(true);
  });

  it('does not flag seated people, held items or things resting on others', async () => {
    const p = buildProject('ok', [
      { cmd: 'object.add', args: { type: 'chair', id: 'chair1' } },
      { cmd: 'object.add', args: { type: 'male', id: 'sitter', place: { sitOn: 'chair1' } } },
      { cmd: 'object.add', args: { type: 'table', id: 'table1', position: [3, 0, 0] } },
      { cmd: 'object.add', args: { type: 'box', id: 'cup', params: { width: 0.08, height: 0.1, depth: 0.08 }, place: { on: 'table1' } } },
      { cmd: 'object.add', args: { type: 'female', id: 'carrier', position: [-3, 0, 0] } },
      { cmd: 'object.add', args: { type: 'box', id: 'bag', position: [-3.25, 0.8, 0], params: { width: 0.3, height: 0.34, depth: 0.11 } } },
    ]);
    expect(await codes(p)).toEqual([]);
  });

  it('follows terrain: below the hills is flagged, standing on them is not', async () => {
    const { groundHeightAt } = await import('../src/core/terrain.ts');
    const base = buildProject('h', [{ cmd: 'object.add', args: { type: 'hills', id: 'h' } }]);
    let spot: [number, number] = [0, 0];
    for (let x = -150; x <= 150 && groundHeightAt(base, ...spot) < 1; x += 10) for (let z = -150; z <= 150 && groundHeightAt(base, ...spot) < 1; z += 10) spot = [x, z];
    const y = groundHeightAt(base, ...spot);
    expect(y).toBeGreaterThan(1);
    const sunk = buildProject('h', [{ cmd: 'object.add', args: { type: 'hills', id: 'h' } }, { cmd: 'object.add', args: { type: 'male', id: 'a', position: [spot[0], 0, spot[1]] } }]);
    expect(await codes(sunk)).toContain('BELOW_GROUND');
    const ok = buildProject('h', [{ cmd: 'object.add', args: { type: 'hills', id: 'h' } }, { cmd: 'object.add', args: { type: 'male', id: 'a', position: [spot[0], y, spot[1]] } }]);
    expect(await codes(ok)).toEqual([]);
  });

  it('flags editing problems', async () => {
    const p = buildProject('edit', [
      { cmd: 'object.add', args: { type: 'male', id: 'a', position: [0, 0, 0] } },
      { cmd: 'object.add', args: { type: 'female', id: 'b', position: [0, 0, -3] } },
      { cmd: 'object.add', args: { type: 'camera', id: 'east', position: [3, 1.6, -1.5], camera: { lookAt: { target: 'b' } } } },
      { cmd: 'object.add', args: { type: 'camera', id: 'west', position: [-3, 1.6, -1.5], camera: { lookAt: { target: 'a' } } } },
      { cmd: 'object.add', args: { type: 'camera', id: 'east2', position: [3.2, 1.6, -1.2], camera: { lookAt: { target: 'b' } } } },
      { cmd: 'object.add', args: { type: 'camera', id: 'sky', position: [0, 1.6, 5], rotation: [80, 0, 0] } },
      { cmd: 'project.update', args: { settings: { duration: 10 } } },
      { cmd: 'cut.set', args: { t: 0, camera: 'east' } },
      { cmd: 'cut.set', args: { t: 3, camera: 'west' } },
      { cmd: 'cut.set', args: { t: 5, camera: 'east' } },
      { cmd: 'cut.set', args: { t: 5.2, camera: 'east2' } },
      { cmd: 'cut.set', args: { t: 7, camera: 'east2' } },
      { cmd: 'cut.set', args: { t: 8, camera: 'sky' } },
      { cmd: 'key.set', args: { id: 'a', prop: 'position', t: 12, v: [1, 0, 0] } },
    ]);
    const found = await codes(p);
    for (const c of ['CROSSED_LINE', 'SHORT_SHOT', 'JUMP_CUT', 'SAME_CAMERA_CUT', 'EMPTY_SHOT', 'KEYS_AFTER_END']) expect(found).toContain(c);
  });

  it('flags a subject hidden behind a wall', async () => {
    const p = buildProject('hide', [
      { cmd: 'object.add', args: { type: 'male', id: 'a', position: [0, 0, 0] } },
      { cmd: 'object.add', args: { type: 'wall', id: 'w', position: [0, 0, 2.5] } },
      { cmd: 'object.add', args: { type: 'camera', id: 'c', position: [0, 1.6, 6], camera: { lookAt: { target: 'a' } } } },
    ]);
    const { checkScene } = await import('../src/core/checks.ts');
    const hidden = checkScene(p).issues.find((i) => i.code === 'SUBJECT_HIDDEN');
    expect(hidden?.ids).toEqual(['a', 'c', 'w']);
    // A doorway in the wall right in the line of sight clears it.
    const door = buildProject('door', [
      { cmd: 'object.add', args: { type: 'male', id: 'a', position: [0, 0, 0] } },
      { cmd: 'object.add', args: { type: 'wall', id: 'w', position: [0, 0, 2.5], params: { openings: [{ offset: 0, width: 1.2, height: 2.4, sill: 0 }] } } },
      { cmd: 'object.add', args: { type: 'camera', id: 'c', position: [0, 1.6, 6], camera: { lookAt: { target: 'a' } } } },
    ]);
    expect(checkScene(door).issues.map((i) => i.code)).not.toContain('SUBJECT_HIDDEN');
  });

  it('reports only what a change introduced', async () => {
    const { issueDiff } = await import('../src/core/checks.ts');
    const before = buildProject('d', [{ cmd: 'object.add', args: { type: 'table', id: 'table1' } }, { cmd: 'object.add', args: { type: 'male', id: 'a', position: [0, 0, 3] } }]);
    const r = runCommands(before, [{ cmd: 'object.update', args: { id: 'a', position: [0, 0, 0.1] } }], { time: 0, selection: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = issueDiff(before, r.project);
    expect(d.new.map((i) => i.code)).toEqual(['OVERLAP']);
    expect(issueDiff(r.project, before)).toEqual({ new: [], resolved: 1 });
  });
});

describe('object.place', () => {
  it('puts things on, next to and seats characters', () => {
    const p = buildProject('place', [
      { cmd: 'object.add', args: { type: 'table', id: 'table1' } },
      { cmd: 'object.add', args: { type: 'box', id: 'cup', params: { width: 0.08, height: 0.1, depth: 0.08 }, place: { on: 'table1' } } },
      { cmd: 'object.add', args: { type: 'male', id: 'hero', place: { relativeTo: 'table1', side: 'front', distance: 0.3 } } },
      { cmd: 'object.add', args: { type: 'sofa', id: 'sofa', position: [4, 0, 0], rotation: [0, -90, 0] } },
      { cmd: 'object.add', args: { type: 'female', id: 'mom', place: { sitOn: 'sofa' } } },
      { cmd: 'object.add', args: { type: 'box', id: 'crate', position: [0, 0, -5] } },
      { cmd: 'object.place', args: { id: 'crate', relativeTo: 'table1', side: 'east', distance: 0 } },
    ]);
    const get = (id: string) => p.objects.find((o) => o.id === id)!;
    const tableTop = 0.75;
    near(get('cup').position[1], tableTop, 0.02);
    // In front of the table (+Z), 0.3 m from its edge, facing it (north = yaw 180).
    const hero = get('hero');
    expect(hero.position[2]).toBeGreaterThan(0.5);
    near(Math.abs(hero.rotation[1]), 180, 0.5);
    expect(get('mom').position).toEqual([4, 0, 0]);
    expect(get('mom').params.pose).toBe('sit');
    near(get('mom').rotation[1], -90);
    expect(get('crate').position[0]).toBeGreaterThan(0.5);
    near(get('crate').position[2], 0, 0.01);
  });

  it('explains bad arguments', () => {
    const s = store();
    dispatch(s, [{ cmd: 'object.add', args: { type: 'male', id: 'a' } }]);
    const r = dispatch(s, { cmd: 'object.place', args: { id: 'a' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toContain('relativeTo');
    const self = dispatch(s, { cmd: 'object.place', args: { id: 'a', relativeTo: 'a' } });
    expect(self.ok).toBe(false);
  });
});
