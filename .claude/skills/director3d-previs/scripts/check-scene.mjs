#!/usr/bin/env node
// check-scene.mjs — runs the app's own check_scene on a project file without the MCP server.
// Use it when the director3d MCP server was started before an app update and has no check_scene tool,
// or to check a generated file before installing it. Run from the Director Console 3D repo root (Node 23.6+):
//   node .claude/skills/director3d-previs/scripts/check-scene.mjs projects/<id>.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) {
  console.error('usage: node check-scene.mjs projects/<id>.json');
  process.exit(2);
}
const imp = (p) => import(pathToFileURL(path.join(process.cwd(), p)).href);
const [v, c] = await Promise.all([imp('src/core/validate.ts'), imp('src/core/checks.ts')]);
const r = v.validateProject(JSON.parse(fs.readFileSync(file, 'utf8')));
for (const w of r.warnings) console.log(`warning ${w.path}: ${w.message}`);
if (!r.ok) {
  for (const e of r.errors) console.log(`ERROR ${e.path}: ${e.message}`);
  process.exit(1);
}
const { issues } = c.checkScene(r.project);
for (const i of issues) console.log(`${i.severity.toUpperCase()} ${i.code} [${i.ids.join(', ')}] ${i.message}${i.hint ? `\n    hint: ${i.hint}` : ''}`);
console.log(issues.length ? `${issues.length} issue(s)` : 'check_scene: no issues');
process.exit(issues.some((i) => i.severity === 'warning' || i.severity === 'error') ? 1 : 0);
