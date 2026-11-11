#!/usr/bin/env node
// check-extras.mjs — finds extras and vehicles that start, stop or freeze while the live camera sees them.
// check_scene does not catch this. Run from the Director Console 3D repo root (it imports the app's
// own camera math from src/core, so Node 23.6+ is needed; older Node falls back to a timing-only check):
//   node .claude/skills/director3d-previs/scripts/check-extras.mjs projects/<id>.json [--step 0.1] [--leads a,b] [--extras c,d]
// Leads (male/female/child, or --leads), props tagged "[attached:...]" and props that stay within 1.2 m of a
// lead the whole film (a bag, sunglasses) are skipped.
// Exit code 1 when something visible needs fixing.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
if (!file) {
  console.error('usage: node check-extras.mjs projects/<id>.json [--step 0.1] [--leads a,b] [--extras c,d]');
  process.exit(2);
}
const step = Number(opt('step', '0.1'));
const forcedLeads = new Set((opt('leads', '') || '').split(',').filter(Boolean));
const forcedExtras = new Set((opt('extras', '') || '').split(',').filter(Boolean));
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

let app = null;
try {
  const root = process.cwd();
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const [v, d, e] = await Promise.all([imp('src/core/validate.ts'), imp('src/core/describe.ts'), imp('src/core/evaluate.ts')]);
  const res = v.validateProject(raw);
  if (!res.ok) throw new Error('project does not validate: ' + JSON.stringify(res.errors.slice(0, 3)));
  app = { project: res.project, cameraView: d.cameraView, programCameraAt: e.programCameraAt, evaluateObject: e.evaluateObject };
} catch (err) {
  console.log(`(visibility check unavailable: ${err.message.split('\n')[0]} — timing-only check)`);
}

const project = app?.project ?? raw;
const D = project.settings?.duration ?? 10;
const LEAD_TYPES = new Set(['male', 'female', 'child']);
const isAttached = (o) => typeof o.note === 'string' && o.note.startsWith('[attached');
const subjects = project.objects.filter((o) => {
  if (o.type === 'camera' || isAttached(o)) return false;
  if (forcedExtras.has(o.id)) return true;
  if (forcedLeads.has(o.id) || LEAD_TYPES.has(o.type)) return false;
  if (o.type === 'passerby' || o.type === 'crowd') return true;
  return (o.tracks?.position?.keys?.length ?? 0) >= 2; // vehicles and other moving props
});

const times = [];
for (let t = 0; t <= D + 1e-9; t += step) times.push(Math.round(t * 1000) / 1000);
const fmt = (t) => `${t.toFixed(2)}s`;
const issues = [];
const notes = [];

// Position / pose without the app: linear interpolation of the raw keys (good enough to find motion windows).
function rawPos(o, t) {
  const k = o.tracks?.position?.keys;
  if (!k?.length) return o.position;
  if (t <= k[0].t) return k[0].v;
  if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  for (let i = 0; i < k.length - 1; i++) if (t <= k[i + 1].t) {
    const u = (t - k[i].t) / (k[i + 1].t - k[i].t);
    return k[i].v.map((a, j) => a + (k[i + 1].v[j] - a) * u);
  }
  return o.position;
}
const evalAt = (o, t) => (app ? app.evaluateObject(o, t) : { position: rawPos(o, t), params: o.params ?? {} });

// Which cut is live, and does it see the object?
const viewCache = new Map();
function seenBy(id, t) {
  if (!app) return null;
  const cam = app.programCameraAt(project, t);
  if (!cam) return null;
  const key = `${cam}|${t}`;
  if (!viewCache.has(key)) viewCache.set(key, app.cameraView(project, cam, t));
  const v = viewCache.get(key)?.objects.find((x) => x.id === id);
  if (!v) return null;
  // Objects beside or behind the lens come back as a full-frame box: report, but mark as "verify".
  const suspicious = v.coverage >= 0.98 && v.box.join(',') === '0,0,1,1';
  return { cam, suspicious };
}

const leads = project.objects.filter((o) => (LEAD_TYPES.has(o.type) || forcedLeads.has(o.id)) && !forcedExtras.has(o.id));
const ridesOnLead = (o) =>
  o.type !== 'passerby' && !forcedExtras.has(o.id) && leads.length > 0 &&
  times.every((t) => {
    const p = evalAt(o, t).position;
    return leads.some((l) => { const q = evalAt(l, t).position; return Math.hypot(p[0] - q[0], p[2] - q[2]) < 1.2; });
  });

for (const o of subjects) {
  if (ridesOnLead(o)) continue;
  if (o.type === 'crowd') {
    const pose = o.params?.pose ?? 'mixed';
    if (pose === 'walk' || pose === 'mixed') {
      const seen = times.find((t) => seenBy(o.id, t));
      const where = app ? (seen !== undefined ? ` (seen by ${seenBy(o.id, seen).cam} at ${fmt(seen)})` : ' (never in a live shot)') : '';
      (app && seen === undefined ? notes : issues).push(`FROZEN_CROWD ${o.id}: a crowd is one static mesh; pose "${pose}" shows people frozen mid-stride${where}. Use moving walkers, or pose "stand"/"sit".`);
    }
    continue;
  }
  const samples = times.map((t) => {
    const e = evalAt(o, t);
    return { t, p: e.position, pose: e.params?.pose ?? o.params?.pose };
  });
  const moving = samples.map((s, i) => {
    const n = samples[Math.min(i + 1, samples.length - 1)];
    const p = i + 1 < samples.length ? n.p : samples[i - 1]?.p ?? s.p;
    return Math.hypot(p[0] - s.p[0], p[1] - s.p[1], p[2] - s.p[2]) / step > 0.05;
  });
  const everMoves = moving.some(Boolean);
  // Transitions between standing and moving.
  for (let i = 1; i < samples.length; i++) {
    if (moving[i] === moving[i - 1]) continue;
    const t = samples[i].t;
    const what = moving[i] ? 'starts moving' : 'stops';
    const seen = seenBy(o.id, t) ?? seenBy(o.id, Math.max(0, t - step)) ?? seenBy(o.id, Math.min(D, t + step));
    if (seen) issues.push(`${moving[i] ? 'STARTS' : 'STOPS'}_ON_CAMERA ${o.id}: ${what} at ${fmt(t)} while ${seen.cam} sees it${seen.suspicious ? ' (box fills the frame — confirm with a snapshot)' : ''}. Have it already moving off-screen from t=0 and keep it moving to the end.`);
    else notes.push(`${o.id}: ${what} at ${fmt(t)} ${app ? '(not in the live shot then)' : ''}`.trim());
  }
  // Standing in a walk/run pose while seen = frozen mid-stride.
  let run = null;
  const flush = (end) => {
    if (run && end - run.t0 >= 0.2) issues.push(`FROZEN_WALK ${o.id}: pose "${run.pose}" but not moving ${fmt(run.t0)}–${fmt(end)} while ${run.cam} sees it. Keep it walking, or switch the pose (stand/phone/talk) while it waits off-screen.`);
    run = null;
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const frozen = !moving[i] && (s.pose === 'walk' || s.pose === 'run');
    const seen = frozen ? seenBy(o.id, s.t) : null;
    if (frozen && seen && !seen.suspicious) {
      if (!run) run = { t0: s.t, pose: s.pose, cam: seen.cam };
    } else flush(s.t);
  }
  flush(D);
  if (!app && everMoves) {
    const k = o.tracks?.position?.keys ?? [];
    if (k.length && (k[0].t > step || k[k.length - 1].t < D - step)) notes.push(`${o.id}: moves only ${fmt(k[0].t)}–${fmt(k[k.length - 1].t)} — check in view_camera that it is off-screen at both ends.`);
  }
}

console.log(`check-extras: ${subjects.length} extras/vehicles, ${D}s, step ${step}s${app ? '' : ' (timing only)'}`);
for (const i of issues) console.log('  ✗ ' + i);
if (notes.length) {
  console.log('  notes (off-screen, fine as long as no camera sees it):');
  for (const n of notes) console.log('    · ' + n);
}
if (!issues.length) console.log('  ✓ no extra starts, stops or freezes in a live shot');
process.exit(issues.length ? 1 : 0);
