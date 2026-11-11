/**
 * Application state: the project document, playhead/selection, undo history and a command log.
 * Everything that changes the project goes through dispatch().
 */
import { applyPatches, produceWithPatches, type Patch } from 'immer';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { runCommands, type CommandCall, type CommandFailure, type RunResult } from './commands/execute.ts';
import { getCommand } from './commands/registry.ts';
import type { Project } from './schema.ts';

export type CommandSource = 'ui' | 'agent' | 'console' | 'system';

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  at: number;
  mergeKey?: string;
  source: CommandSource;
}

export interface LogEntry {
  id: number;
  at: number;
  source: CommandSource;
  calls: CommandCall[];
  ok: boolean;
  error?: CommandFailure;
  warnings: string[];
}

export interface UIState {
  time: number;
  playing: boolean;
  loop: boolean;
  selection: string[];
  autoKey: boolean;
}

export interface DirectorState {
  project: Project;
  ui: UIState;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Increments whenever the project document changes. */
  rev: number;
  /** Increments when a different/reloaded project replaces the document wholesale. */
  loadToken: number;
  /** Revision that was last persisted (for dirty tracking). */
  savedRev: number;
  log: LogEntry[];
}

export type DirectorStore = StoreApi<DirectorState>;

const MAX_HISTORY = 200;
const MAX_LOG = 200;
const MERGE_WINDOW_MS = 2500;
let logSeq = 0;

export function createDirectorStore(project: Project): DirectorStore {
  return createStore<DirectorState>(() => ({
    project,
    ui: { time: 0, playing: false, loop: true, selection: [], autoKey: false },
    past: [],
    future: [],
    rev: 0,
    loadToken: 0,
    savedRev: 0,
    log: [],
  }));
}

export interface DispatchOptions {
  source?: CommandSource;
  /** Label for the undo entry (default: label of the first command). */
  label?: string;
  /** Consecutive dispatches with the same mergeKey (within a short window) become one undo step. */
  mergeKey?: string;
  /** Validate and compute without committing. */
  dryRun?: boolean;
  /** Skip the command log (e.g. high-frequency drags). */
  silent?: boolean;
}

export type DispatchResult = RunResult & { undone?: number; redone?: number };

export function pushLog(store: DirectorStore, entry: Omit<LogEntry, 'id' | 'at'>) {
  const log = [...store.getState().log, { ...entry, id: ++logSeq, at: Date.now() }];
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  store.setState({ log });
}

export function dispatch(store: DirectorStore, input: CommandCall | CommandCall[], opts: DispatchOptions = {}): DispatchResult {
  const calls = Array.isArray(input) ? input : [input];
  const source = opts.source ?? 'ui';

  // History commands are handled here (not inside a batch).
  if (calls.length > 0 && calls.every((c) => c?.cmd === 'history.undo' || c?.cmd === 'history.redo')) {
    let undone = 0;
    let redone = 0;
    for (const c of calls) {
      const steps = Math.max(1, Math.min(100, Number((c.args as { steps?: number } | undefined)?.steps ?? 1)));
      for (let i = 0; i < steps; i++) {
        if (c.cmd === 'history.undo' ? undo(store) : redo(store)) c.cmd === 'history.undo' ? undone++ : redone++;
      }
    }
    if (!opts.silent) pushLog(store, { source, calls, ok: true, warnings: [] });
    const s = store.getState();
    return { ok: true, results: [{ undone, redone }], warnings: [], project: s.project, patches: [], inverse: [], time: s.ui.time, selection: s.ui.selection, mutated: undone + redone > 0, undone, redone };
  }

  const state = store.getState();
  const result = runCommands(state.project, calls, { time: state.ui.time, selection: state.ui.selection });
  if (!opts.silent || !result.ok) {
    pushLog(store, { source, calls, ok: result.ok, error: result.ok ? undefined : result.error, warnings: result.warnings });
  }
  if (!result.ok || opts.dryRun) return result;

  const ui = { ...state.ui, time: result.time, selection: result.selection };
  if (!result.mutated) {
    store.setState({ ui });
    return result;
  }
  const label = opts.label ?? getCommand(calls[0]!.cmd)?.label ?? calls[0]!.cmd;
  const past = [...state.past];
  const last = past[past.length - 1];
  const now = Date.now();
  if (opts.mergeKey && last && last.mergeKey === opts.mergeKey && now - last.at < MERGE_WINDOW_MS) {
    past[past.length - 1] = { ...last, patches: [...last.patches, ...result.patches], inverse: [...result.inverse, ...last.inverse], at: now };
  } else {
    past.push({ label, patches: result.patches, inverse: result.inverse, at: now, mergeKey: opts.mergeKey, source });
    if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  }
  store.setState({ project: result.project, ui, past, future: [], rev: state.rev + 1 });
  return result;
}

export function undo(store: DirectorStore): boolean {
  const s = store.getState();
  const entry = s.past[s.past.length - 1];
  if (!entry) return false;
  const project = applyPatches(s.project, entry.inverse);
  store.setState({ project, past: s.past.slice(0, -1), future: [...s.future, entry], rev: s.rev + 1, ui: { ...s.ui, selection: s.ui.selection.filter((id) => project.objects.some((o) => o.id === id)) } });
  return true;
}

export function redo(store: DirectorStore): boolean {
  const s = store.getState();
  const entry = s.future[s.future.length - 1];
  if (!entry) return false;
  const project = applyPatches(s.project, entry.patches);
  store.setState({ project, future: s.future.slice(0, -1), past: [...s.past, entry], rev: s.rev + 1 });
  return true;
}

/** Replace the document (open/import/external edit). */
export function loadProject(store: DirectorStore, project: Project, opts: { keepHistory?: boolean; keepTime?: boolean } = {}): void {
  const s = store.getState();
  const time = opts.keepTime ? Math.min(s.ui.time, project.settings.duration) : 0;
  store.setState({
    project,
    rev: s.rev + 1,
    loadToken: s.loadToken + 1,
    savedRev: s.rev + 1,
    past: opts.keepHistory ? s.past : [],
    future: opts.keepHistory ? s.future : [],
    ui: { ...s.ui, time, playing: false, selection: s.ui.selection.filter((id) => project.objects.some((o) => o.id === id)) },
  });
}

export function setTime(store: DirectorStore, t: number): void {
  const s = store.getState();
  const time = Math.max(0, Math.min(s.project.settings.duration, t));
  if (time !== s.ui.time) store.setState({ ui: { ...s.ui, time } });
}

export function setUI(store: DirectorStore, patch: Partial<UIState>): void {
  store.setState({ ui: { ...store.getState().ui, ...patch } });
}

export function markSaved(store: DirectorStore, rev = store.getState().rev): void {
  store.setState({ savedRev: rev });
}

export function isDirty(state: DirectorState): boolean {
  return state.rev !== state.savedRev;
}

/**
 * Apply a project that changed outside the app (e.g. an agent edited the JSON file)
 * as ONE undoable step, keeping the history.
 */
export function applyExternalProject(store: DirectorStore, next: Project, label = '外部修改'): boolean {
  const s = store.getState();
  const [project, patches, inverse] = produceWithPatches(s.project, (draft) => {
    draft.name = next.name;
    draft.notes = next.notes;
    draft.settings = next.settings;
    draft.objects = next.objects;
    draft.cuts = next.cuts;
    draft.markers = next.markers;
  });
  if (patches.length === 0) return false;
  const past = [...s.past, { label, patches, inverse, at: Date.now(), source: 'agent' as CommandSource }];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  const rev = s.rev + 1;
  store.setState({
    project,
    past,
    future: [],
    rev,
    savedRev: rev,
    ui: { ...s.ui, time: Math.min(s.ui.time, project.settings.duration), selection: s.ui.selection.filter((id) => project.objects.some((o) => o.id === id)) },
  });
  return true;
}
