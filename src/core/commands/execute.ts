/**
 * Atomic command batches: every command in a batch succeeds, or nothing changes.
 * Produces Immer patches for undo/redo. When a batch fails, it is re-checked command by
 * command so callers (agents especially) get every error at once, not one per round trip.
 */
import { current, enablePatches, produce, produceWithPatches, type Patch } from 'immer';
import type { Project } from '../schema.ts';
import { checkInvariants } from '../validate.ts';
import { getCommand, suggestCommand } from './registry.ts';
import { CommandError, type CommandContext } from './types.ts';

enablePatches();

export interface CommandCall {
  cmd: string;
  args?: Record<string, unknown>;
}

export interface CommandFailure {
  /** Index of the failing command in the batch (-1 = batch-level). */
  index: number;
  cmd: string;
  code: string;
  message: string;
  hint?: string;
  path?: (string | number)[];
}

export interface RunOk {
  ok: true;
  results: unknown[];
  warnings: string[];
  project: Project;
  patches: Patch[];
  inverse: Patch[];
  time: number;
  selection: string[];
  /** True if the project document changed. */
  mutated: boolean;
}
export interface RunErr {
  ok: false;
  /** The failure that stopped the batch (same as errors[0]). */
  error: CommandFailure;
  /**
   * Every failure found by re-checking the batch command by command (failed commands are
   * skipped, later ones still checked). Commands that depend on a failed one report
   * DEPENDS_ON_FAILED.
   */
  errors: CommandFailure[];
  warnings: string[];
}
export type RunResult = RunOk | RunErr;

export interface RunOptions {
  time: number;
  selection: string[];
}

/** Mutable state shared by the commands of one batch run. */
interface ExecState {
  time: number;
  selection: string[];
  warnings: string[];
  results: unknown[];
  /** Index of the command being run (-1 = batch-level checks). */
  index: number;
  cmd: string;
  multi: boolean;
  /** Commands that failed (only during the error re-check). */
  failed: Set<number>;
}

function newState(opts: RunOptions, multi: boolean): ExecState {
  return { time: opts.time, selection: opts.selection, warnings: [], results: [], index: -1, cmd: '', multi, failed: new Set() };
}

/** Replace "$N" / "$N.field" strings with results of earlier commands in the batch. */
function resolveRefs(value: unknown, st: ExecState): unknown {
  if (typeof value === 'string') {
    const m = /^\$(\d+)(?:\.([A-Za-z_]\w*))?$/.exec(value);
    if (m) {
      const i = Number(m[1]);
      if (st.failed.has(i)) throw new CommandError('DEPENDS_ON_FAILED', `"${value}" refers to command [${i}], which failed`, `Fix command [${i}] first.`);
      const r = st.results[i] as Record<string, unknown> | undefined;
      const field = m[2] ?? 'id';
      if (r && r[field] !== undefined) return r[field];
      throw new CommandError('BAD_REFERENCE', `"${value}" does not refer to an earlier command result with "${field}"`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, st));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, st);
    return out;
  }
  return value;
}

function fmtIssuePath(path: readonly PropertyKey[]): string {
  return path.length ? `${path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.')}: ` : '';
}

function makeContext(draft: Project, st: ExecState): CommandContext {
  return {
    draft,
    get time() {
      return st.time;
    },
    setTime(t: number) {
      st.time = t;
    },
    get selection() {
      return st.selection;
    },
    setSelection(ids: string[]) {
      st.selection = ids;
    },
    warn(m: string) {
      st.warnings.push(st.multi && st.index >= 0 ? `[${st.index}] ${m}` : m);
    },
    obj(id: string) {
      const o = draft.objects.find((x) => x.id === id);
      if (!o) {
        const ids = draft.objects.map((x) => x.id);
        throw new CommandError('NOT_FOUND', `no object with id "${id}"`, ids.length ? `Existing ids: ${ids.slice(0, 40).join(', ')}` : 'The scene is empty.');
      }
      return o;
    },
    snapshot() {
      return current(draft) as Project;
    },
  };
}

/** Validate one call and apply it to the draft. */
function execCall(ctx: CommandContext, call: CommandCall | undefined, st: ExecState): { result: unknown; mutates: boolean } {
  if (!call || typeof call !== 'object' || typeof call.cmd !== 'string') {
    throw new CommandError('INVALID_CALL', 'each command must look like {"cmd": "object.add", "args": {...}}');
  }
  st.cmd = call.cmd;
  if (call.cmd.startsWith('history.')) {
    throw new CommandError('INVALID_CALL', `${call.cmd} cannot be mixed with other commands in one batch`, 'Send history.undo / history.redo on their own.');
  }
  const def = getCommand(call.cmd);
  if (!def) throw new CommandError('UNKNOWN_COMMAND', `unknown command "${call.cmd}"`, suggestCommand(call.cmd));
  const raw = resolveRefs(call.args ?? {}, st);
  const parsed = def.args.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new CommandError(
      'INVALID_ARGS',
      `${call.cmd}: ${fmtIssuePath(issue.path)}${issue.message}`,
      `Example: ${JSON.stringify({ cmd: def.name, args: def.examples[0] ?? {} })}`,
      issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    );
  }
  return { result: def.apply(ctx, parsed.data) ?? {}, mutates: def.mutates !== false };
}

function invariantError(project: Project): CommandError | null {
  const problems = checkInvariants(project);
  return problems.length ? new CommandError('INVALID_STATE', problems[0]!, problems.slice(1, 4).join('; ') || undefined) : null;
}

function toFailure(e: unknown, index: number, cmd: string): CommandFailure {
  if (e instanceof CommandError) return { index, cmd, code: e.code, message: e.message, hint: e.hint, path: e.path };
  return { index, cmd, code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

export function runCommands(project: Project, calls: CommandCall[], opts: RunOptions): RunResult {
  const st = newState(opts, Array.isArray(calls) && calls.length > 1);
  let mutated = false;
  try {
    if (!Array.isArray(calls)) throw new CommandError('INVALID_CALL', 'expected an array of {"cmd": "...", "args": {...}}');
    const [next, patches, inverse] = produceWithPatches(project, (draft) => {
      const ctx = makeContext(draft as Project, st);
      for (let i = 0; i < calls.length; i++) {
        st.index = i;
        const r = execCall(ctx, calls[i], st);
        st.results.push(r.result);
        if (r.mutates) mutated = true;
      }
      st.index = -1;
      const bad = invariantError(draft as Project);
      if (bad) throw bad;
    });
    return { ok: true, results: st.results, warnings: st.warnings, project: next, patches, inverse, time: st.time, selection: st.selection, mutated: mutated && patches.length > 0 };
  } catch (e) {
    const error = toFailure(e, st.index, st.cmd);
    const errors = error.index >= 0 && calls.length > 1 ? [error, ...recheck(project, calls, opts).filter((f) => f.index > error.index)] : [error];
    return { ok: false, error, errors, warnings: st.warnings };
  }
}

/**
 * Re-run a failed batch one command at a time: a failing command is skipped (the project is
 * left as it was before it) and checking continues, so independent errors all show up.
 * Never commits anything.
 */
function recheck(project: Project, calls: CommandCall[], opts: RunOptions): CommandFailure[] {
  const st = newState(opts, true);
  const failures: CommandFailure[] = [];
  /** ids that a failed object.add would have created → index of that command. */
  const notCreated = new Map<string, number>();
  let state = project;
  for (let i = 0; i < calls.length; i++) {
    st.index = i;
    st.cmd = '';
    const before = { time: st.time, selection: st.selection, warnings: st.warnings.length };
    try {
      state = produce(state, (draft) => {
        st.results[i] = execCall(makeContext(draft as Project, st), calls[i], st).result;
      });
    } catch (e) {
      Object.assign(st, { time: before.time, selection: before.selection });
      st.warnings.length = before.warnings;
      st.failed.add(i);
      const f = toFailure(e, i, st.cmd || String(calls[i]?.cmd ?? ''));
      if (f.code === 'NOT_FOUND') {
        for (const [id, k] of notCreated) {
          if (!f.message.includes(`"${id}"`)) continue;
          f.code = 'DEPENDS_ON_FAILED';
          f.hint = `Command [${k}] (object.add "${id}") failed, so "${id}" does not exist. Fix command [${k}] first.`;
          break;
        }
      }
      failures.push(f);
      const call = calls[i];
      if (call?.cmd === 'object.add' && typeof call.args?.id === 'string') notCreated.set(call.args.id, i);
    }
  }
  if (!failures.length) {
    const bad = invariantError(state);
    if (bad) failures.push(toFailure(bad, -1, st.cmd));
  }
  return failures;
}
