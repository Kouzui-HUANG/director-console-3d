// previs-kit.mjs — helpers for writing a Director Console 3D project from a scene script (build.mjs).
// Copy this file next to build.mjs (scenes/<project-id>/) and `import * as kit from './previs-kit.mjs'`.
// Units: meters, degrees, seconds. +X east, -Z north, Y up. Yaw 0 faces +Z (south), 90 east, 180 north, -90 west.
import fs from 'node:fs';
import path from 'node:path';

export const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const rv = (v) => v.map((n) => round(n));
const rad = (deg) => (deg * Math.PI) / 180;

/** Same easing curves as the app (src/core/interpolate.ts). A key with no ease uses 'inOut'. */
export function applyEase(u, ease = 'inOut') {
  const x = Math.min(1, Math.max(0, u));
  switch (ease) {
    case 'linear': return x;
    case 'in': return x * x * x;
    case 'out': return 1 - (1 - x) ** 3;
    case 'hold': return 0;
    default: return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  }
}

/** Distance covered while easing ('out') from speed v to a stop over T seconds: v*T/3 (cubic). */
export const easeOutDistance = (v, T) => (v * T) / 3;

/** keys([[t, value, ease?], ...]) -> { keys: [...] }, sorted and rounded. `extra` e.g. { path: 'smooth' }. */
export function keys(list, extra = {}) {
  const ks = [...list]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v, ease]) => ({ t: round(t), v: Array.isArray(v) ? rv(v) : v, ...(ease ? { ease } : {}) }));
  return { keys: ks, ...extra };
}

/** Value of raw keys [[t, v, ease?], ...] at time t, interpolated like the app. Enums/booleans hold. */
export function sample(list, t) {
  const ks = [...list].sort((a, b) => a[0] - b[0]);
  if (t <= ks[0][0]) return ks[0][1];
  const last = ks[ks.length - 1];
  if (t >= last[0]) return last[1];
  let i = 0;
  while (i < ks.length - 2 && ks[i + 1][0] <= t) i++;
  const [t1, a, e] = ks[i];
  const [t2, b] = ks[i + 1];
  if (typeof a !== 'number' && !Array.isArray(a)) return a;
  const u = applyEase((t - t1) / (t2 - t1), e ?? 'inOut');
  return typeof a === 'number' ? a + (b - a) * u : a.map((x, j) => x + (b[j] - x) * u);
}

/** Unit vectors for a yaw: forward (direction of travel) and right (the character's right hand), as [x, z]. */
export const forwardOf = (yaw) => [Math.sin(rad(yaw)), Math.cos(rad(yaw))];
export const rightOf = (yaw) => [-Math.cos(rad(yaw)), Math.sin(rad(yaw))];
/** Yaw that faces from [x, z] a toward [x, z] b. */
export const yawToward = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;

/** Where the shadow of a point `height` m up lands, relative to the point: [dx, dz]. Sun azimuth 0 = from north, 90 = from east. */
export function shadowOffset(sunAzimuth, sunElevation, height) {
  const k = height / Math.tan(rad(sunElevation));
  return [-Math.sin(rad(sunAzimuth)) * k, Math.cos(rad(sunAzimuth)) * k];
}

/** A scene under construction. `duration` is the film length the extras must cover. */
export function createScene({ duration = 15 } = {}) {
  const objects = [];
  const ids = new Set();
  const add = (o) => {
    if (!o.id || ids.has(o.id)) throw new Error(`missing or duplicate id: ${o.id}`);
    ids.add(o.id);
    const obj = { name: '', color: '#9aa4b2', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, locked: false, params: {}, tracks: {}, ...o };
    obj.position = rv(obj.position);
    obj.rotation = rv(obj.rotation);
    objects.push(obj);
    return obj;
  };
  return { duration, objects, add, has: (id) => ids.has(id) };
}

/**
 * A passer-by on a straight line at constant speed for the WHOLE film, so they never start or stop on camera.
 * at: [x, z] where they are at time atT (default 0) — pin it to the moment they should cross something.
 */
export function walker(scene, { id, name = '路人', seed = 1, gender = 'auto', at, atT = 0, heading, speed = 1.3, y = 0, color, params = {} }) {
  const [fx, fz] = forwardOf(heading);
  const p = (t) => [at[0] + fx * speed * (t - atT), y, at[1] + fz * speed * (t - atT)];
  return scene.add({
    id, type: 'passerby', name, ...(color ? { color } : {}), position: p(0), rotation: [0, heading, 0],
    params: { seed, gender, pose: 'walk', ...params },
    tracks: { position: keys([[0, p(0), 'linear'], [scene.duration, p(scene.duration)]]) },
  });
}

/**
 * A passer-by along a polyline at constant speed, walking from t = 0 to the end.
 * anchor: [i, t] = reach points[i] at time t. The first and last segments are stretched or cut so the
 * walk covers exactly 0 -> duration (start them off-screen: behind the camera or outside the frame).
 * Turns at corners take `turn` seconds.
 */
export function pathWalker(scene, { id, name = '路人', seed = 1, gender = 'auto', points, speed = 1.3, anchor, turn = 0.6, y = 0, color, params = {} }) {
  const P = points.map((p) => [...p]);
  const END = scene.duration;
  const seg = (i) => Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
  const timesOf = () => {
    const ts = [anchor[1]];
    for (let i = anchor[0]; i > 0; i--) ts.unshift(ts[0] - seg(i - 1) / speed);
    for (let i = anchor[0]; i < P.length - 1; i++) ts.push(ts[ts.length - 1] + seg(i) / speed);
    return ts;
  };
  const stretch = (i, j, dt) => {
    const L = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
    const k = (L + speed * dt) / L;
    P[i] = [P[j][0] + (P[i][0] - P[j][0]) * k, P[j][1] + (P[i][1] - P[j][1]) * k];
  };
  let ts = timesOf();
  stretch(0, 1, ts[0]);
  ts = timesOf();
  stretch(P.length - 1, P.length - 2, END - ts[ts.length - 1]);
  ts = timesOf();
  const yaws = [];
  for (let i = 0; i < P.length - 1; i++) {
    let yaw = yawToward(P[i], P[i + 1]);
    if (yaws.length) {
      const prev = yaws[yaws.length - 1];
      while (yaw - prev > 180) yaw -= 360;
      while (yaw - prev < -180) yaw += 360;
    }
    yaws.push(yaw);
  }
  const rot = [[0, [0, yaws[0], 0], 'linear']];
  for (let i = 1; i < yaws.length; i++) {
    rot.push([ts[i] - turn / 2, [0, yaws[i - 1], 0], 'inOut']);
    rot.push([ts[i] + turn / 2, [0, yaws[i], 0], 'linear']);
  }
  scene.add({
    id, type: 'passerby', name, ...(color ? { color } : {}), position: [P[0][0], y, P[0][1]], rotation: [0, yaws[0], 0],
    params: { seed, gender, pose: 'walk', ...params },
    tracks: { position: keys(P.map((p, i) => [Math.max(0, ts[i]), [p[0], y, p[1]], 'linear'])), rotation: keys(rot) },
  });
  return { points: P, times: ts };
}

/**
 * A vehicle built from simple parts, driving a straight line at constant speed for the whole film.
 * at: [x, z] at time atT (e.g. where it should enter frame). parts: [{ id, type, name?, color?, params?,
 * offset: [right, y, forward] (m, in the vehicle's frame), rotation?: [x, yawExtra, z] }].
 * Drive on the correct side of the road for the location (Taiwan: keep right).
 */
export function vehicle(scene, { at, atT = 0, heading, speed, parts }) {
  const [fx, fz] = forwardOf(heading);
  const [rx, rz] = rightOf(heading);
  const base = (t) => [at[0] + fx * speed * (t - atT), at[1] + fz * speed * (t - atT)];
  for (const part of parts) {
    const { offset = [0, 0, 0], rotation = [0, 0, 0], ...rest } = part;
    const pos = (t) => {
      const [x, z] = base(t);
      return [x + rx * offset[0] + fx * offset[2], offset[1], z + rz * offset[0] + fz * offset[2]];
    };
    scene.add({
      ...rest, position: pos(0), rotation: [rotation[0], heading + rotation[1], rotation[2]],
      tracks: { position: keys([[0, pos(0), 'linear'], [scene.duration, pos(scene.duration)]]) },
    });
  }
}

/** A scooter with rider (box body, two wheels, sitting passer-by). Same options as vehicle() minus parts. */
export function scooter(scene, { id = 'scooter', name = '機車', color = '#2c4f7c', riderSeed = 63, ...opts }) {
  vehicle(scene, {
    ...opts,
    parts: [
      { id: `${id}Body`, type: 'box', name, color, params: { width: 0.55, height: 0.62, depth: 1.7 }, offset: [0, 0.18, 0] },
      { id: `${id}WheelF`, type: 'cylinder', name: `${name}前輪`, color: '#1e1e1e', params: { radius: 0.22, height: 0.12, sides: 12 }, offset: [0, 0.22, 0.65], rotation: [0, 0, 90] },
      { id: `${id}WheelR`, type: 'cylinder', name: `${name}後輪`, color: '#1e1e1e', params: { radius: 0.22, height: 0.12, sides: 12 }, offset: [0, 0.22, -0.6], rotation: [0, 0, 90] },
      { id: `${id}Rider`, type: 'passerby', name: '騎士', params: { seed: riderSeed, gender: 'male', pose: 'sit' }, offset: [0, 0.36, -0.2] },
    ],
  });
}

/**
 * A prop riding on a character (bag on a shoulder, sunglasses on the head). pos / yaw are the character's
 * RAW keys ([[t, [x,y,z], ease], ...] and [[t, yawDeg, ease], ...]); offset(t) -> [right, up, forward] in the
 * character's frame; rot(t, yaw) -> [pitch, yaw, roll]. Keys are written at every key time of the character
 * plus `step`-second samples, all linear, so the prop never drifts or floats. The object's note is tagged
 * "[attached:<parent>]" so check-extras.mjs skips it.
 */
export function attached(scene, { id, parent, type = 'box', name = '', color, params = {}, pos, yaw = [[0, 0]], offset, rot = (t, y) => [0, y, 0], extraTimes = [], step = 0.1 }) {
  const END = scene.duration;
  // Exact key times win; filler samples closer than one frame (60 fps worst case ~0.017 s, use 0.045 for 24 fps)
  // to a key time are dropped, because two keys on the same frame trigger a validation warning.
  const exact = [...new Set([0, END, ...pos.map((k) => k[0]), ...yaw.map((k) => k[0]), ...extraTimes].filter((t) => t >= 0 && t <= END))].sort((a, b) => a - b);
  const T = [...exact];
  for (let t = 0; t <= END + 1e-9; t += step) if (exact.every((x) => Math.abs(x - t) > 0.045)) T.push(round(t));
  T.sort((a, b) => a - b);
  for (let i = T.length - 1; i > 0; i--) if (T[i] - T[i - 1] < 0.045) T.splice(exact.includes(T[i]) ? i - 1 : i, 1);
  const at = (t) => {
    const p = sample(pos, t);
    const y = sample(yaw, t);
    const o = offset(t);
    const [fx, fz] = forwardOf(y);
    const [rx, rz] = rightOf(y);
    return { p: [p[0] + rx * o[0] + fx * o[2], p[1] + o[1], p[2] + rz * o[0] + fz * o[2]], r: rot(t, y) };
  };
  const first = at(0);
  return scene.add({
    id, type, name, ...(color ? { color } : {}), params, position: first.p, rotation: first.r, note: `[attached:${parent}]`,
    tracks: { position: keys(T.map((t) => [t, at(t).p, 'linear'])), rotation: keys(T.map((t) => [t, at(t).r, 'linear'])) },
  });
}

/** A camera with every field filled in (the app has no depth of field — don't add dof/tiltShift). */
export function camera(scene, { id, name = '', position, rotation, tracks, note, color = '#f0b429', ...cam }) {
  return scene.add({
    id, type: 'camera', name, color, position, ...(rotation ? { rotation } : {}), ...(tracks ? { tracks } : {}), ...(note ? { note } : {}),
    camera: {
      rig: 'tripod', lens: 'standard', focalLength: 35, sensor: 'super35',
      fisheye: { fov: 180, mapping: 'equidistant', circular: false },
      lookAt: null, follow: null, shake: { preset: 'none', amount: 0.5, seed: 1 },
      ...cam,
    },
  });
}

/**
 * Write the project file, keeping id / createdAt / revision of the existing file (from new_project).
 * Prints warnings for keys outside 0..duration and cuts to unknown cameras.
 */
export function writeProject(file, scene, { name, notes, settings = {}, cuts = [], markers = [] }) {
  const base = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!base.id) throw new Error(`${file} has no project id — create it with new_project first`);
  const d = scene.duration;
  const warn = [];
  for (const o of scene.objects) {
    for (const [prop, tr] of Object.entries(o.tracks ?? {})) {
      const late = tr.keys.filter((k) => k.t > d + 1e-6);
      if (late.length) warn.push(`${o.id}.${prop}: ${late.length} key(s) after ${d}s are never reached`);
      if (tr.keys.some((k) => k.t < 0 || k.t > 30)) warn.push(`${o.id}.${prop}: key time outside 0–30 s`);
    }
  }
  const camIds = new Set(scene.objects.filter((o) => o.type === 'camera').map((o) => o.id));
  for (const c of cuts) if (!camIds.has(c.camera)) warn.push(`cut at ${c.t}s uses unknown camera "${c.camera}"`);
  const project = {
    format: 'director3d.project',
    version: 1,
    id: base.id,
    name: name ?? base.name,
    revision: base.revision ?? 0,
    ...(base.createdAt ? { createdAt: base.createdAt } : {}),
    updatedAt: new Date().toISOString(),
    settings: {
      ...base.settings,
      ...settings,
      duration: d,
      environment: { ...(base.settings?.environment ?? {}), ...(settings.environment ?? {}) },
    },
    objects: scene.objects,
    cuts: [...cuts].sort((a, b) => a.t - b.t),
    markers: [...markers].sort((a, b) => a.t - b.t),
    ...(notes ? { notes } : {}),
  };
  const json = JSON.stringify(project, null, 2);
  fs.writeFileSync(file, json);
  // A copy next to build.mjs: diff it against the project file before the next regeneration — if they differ,
  // someone edited the scene in the app and regenerating would wipe that.
  const copy = path.join(path.dirname(path.resolve(process.argv[1] ?? '.')), 'generated.json');
  fs.writeFileSync(copy, json);
  console.log(`wrote ${file}: ${scene.objects.length} objects, ${project.cuts.length} cuts, ${project.markers.length} markers, ${d}s (copy: ${copy})`);
  for (const w of warn) console.log(`  warning: ${w}`);
  return project;
}
