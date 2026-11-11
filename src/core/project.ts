/** Creating projects and serializing them for files. */
import { runCommands, type CommandCall } from './commands/execute.ts';
import { CommandError } from './commands/types.ts';
import { randomProjectId } from './ids.ts';
import { FORMAT, FORMAT_VERSION, ProjectSchema, type Project } from './schema.ts';

export function emptyProject(name = '未命名專案', id = randomProjectId()): Project {
  const now = new Date().toISOString();
  return ProjectSchema.parse({ format: FORMAT, version: FORMAT_VERSION, id, name, createdAt: now, updatedAt: now });
}

/** Build a project by running commands on an empty one (throws on failure). */
export function buildProject(name: string, calls: CommandCall[], id?: string): Project {
  const base = emptyProject(name, id);
  const r = runCommands(base, calls, { time: 0, selection: [] });
  if (!r.ok) throw new Error(`template "${name}" failed at command ${r.error.index} (${r.error.cmd}): ${r.error.message}`);
  return r.project;
}

/** Stable, readable JSON for project files. */
export function serializeProject(p: Project, opts: { schemaRef?: string } = {}): string {
  const ordered = {
    ...(opts.schemaRef ? { $schema: opts.schemaRef } : {}),
    format: p.format,
    version: p.version,
    id: p.id,
    name: p.name,
    revision: p.revision,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    notes: p.notes,
    settings: p.settings,
    objects: p.objects.map((o) => ({
      id: o.id,
      type: o.type,
      name: o.name,
      color: o.color,
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      visible: o.visible,
      locked: o.locked,
      params: o.params,
      ...(o.camera ? { camera: o.camera } : {}),
      tracks: o.tracks,
      ...(o.note ? { note: o.note } : {}),
    })),
    cuts: p.cuts,
    markers: p.markers,
  };
  return JSON.stringify(ordered, null, 2);
}

/** Copy of a project with a new id/name (for "duplicate"). */
/** Top-level sections of a project that `projectJson({fields})` can include (meta is always kept). */
export const PROJECT_SECTIONS = ['settings', 'objects', 'cuts', 'markers', 'notes'] as const;

/**
 * The project as plain JSON, optionally limited to some objects (`ids`) and/or sections
 * (`fields`). id, name, revision and timestamps are always included. Saves agents tokens.
 */
export function projectJson(p: Project, opts: { ids?: readonly string[]; fields?: readonly string[] } = {}): Record<string, unknown> {
  const out = JSON.parse(serializeProject(p)) as Record<string, unknown>;
  if (opts.ids?.length) {
    const missing = opts.ids.filter((id) => !p.objects.some((o) => o.id === id));
    if (missing.length) {
      throw new CommandError('NOT_FOUND', `no object with id ${missing.map((m) => `"${m}"`).join(', ')}`, `Existing ids: ${p.objects.map((o) => o.id).slice(0, 60).join(', ')}`);
    }
    const want = new Set(opts.ids);
    out.objects = (out.objects as { id: string }[]).filter((o) => want.has(o.id));
  }
  if (opts.fields?.length) {
    const valid: readonly string[] = PROJECT_SECTIONS;
    const bad = opts.fields.filter((f) => !valid.includes(f));
    if (bad.length) throw new CommandError('INVALID_ARGS', `unknown field ${bad.map((b) => `"${b}"`).join(', ')}`, `Valid fields: ${PROJECT_SECTIONS.join(', ')}`);
    const keep = new Set(opts.fields);
    if (opts.ids?.length) keep.add('objects');
    for (const k of PROJECT_SECTIONS) if (!keep.has(k)) delete out[k];
  }
  return out;
}

export function cloneProject(p: Project, name?: string): Project {
  const now = new Date().toISOString();
  return { ...structuredClone(p), id: randomProjectId(), name: name ?? `${p.name} 副本`, revision: 0, createdAt: now, updatedAt: now };
}
