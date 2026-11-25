/**
 * Portrait document state: the portrait, undo/redo history (Immer patches), dirty tracking and a
 * command log. Everything that changes the portrait goes through dispatch() — the same pattern
 * as the director's store.
 */
import { applyPatches, produceWithPatches, type Patch } from 'immer';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { getPortraitCommand, runPortraitCommands, type PortraitCommandCall, type PortraitCommandFailure, type PortraitRunResult } from './commands.ts';
import type { Portrait } from './schema.ts';

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
  calls: PortraitCommandCall[];
  ok: boolean;
  error?: PortraitCommandFailure;
  warnings: string[];
}

export interface PortraitDocState {
  portrait: Portrait;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Increments whenever the document changes. */
  rev: number;
  /** Increments when a different / reloaded portrait replaces the document. */
  loadToken: number;
  /** Revision last persisted (dirty tracking). */
  savedRev: number;
  log: LogEntry[];
}

export type PortraitStoreApi = StoreApi<PortraitDocState>;

const MAX_HISTORY = 200;
const MAX_LOG = 200;
const MERGE_WINDOW_MS = 2500;
let logSeq = 0;

export function createPortraitStore(portrait: Portrait): PortraitStoreApi {
  return createStore<PortraitDocState>(() => ({ portrait, past: [], future: [], rev: 0, loadToken: 0, savedRev: 0, log: [] }));
}

export interface DispatchOptions {
  source?: CommandSource;
  label?: string;
  /** Consecutive dispatches with the same key (within 2.5 s) become one undo step (slider drags). */
  mergeKey?: string;
  dryRun?: boolean;
  /** Skip the command log (high-frequency drags). */
  silent?: boolean;
}

export type DispatchResult = PortraitRunResult & { undone?: number; redone?: number };

function pushLog(store: PortraitStoreApi, entry: Omit<LogEntry, 'id' | 'at'>) {
  const log = [...store.getState().log, { ...entry, id: ++logSeq, at: Date.now() }];
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  store.setState({ log });
}

export function dispatch(store: PortraitStoreApi, input: PortraitCommandCall | PortraitCommandCall[], opts: DispatchOptions = {}): DispatchResult {
  const calls = Array.isArray(input) ? input : [input];
  const source = opts.source ?? 'ui';
  if (calls.length > 0 && calls.every((c) => c?.cmd === 'history.undo' || c?.cmd === 'history.redo')) {
    let undone = 0;
    let redone = 0;
    for (const c of calls) {
      const steps = Math.max(1, Math.min(100, Number((c.args as { steps?: number } | undefined)?.steps ?? 1)));
      for (let i = 0; i < steps; i++) {
        if (c.cmd === 'history.undo') undone += Number(undo(store));
        else redone += Number(redo(store));
      }
    }
    if (!opts.silent) pushLog(store, { source, calls, ok: true, warnings: [] });
    const s = store.getState();
    return { ok: true, results: [{ undone, redone }], warnings: [], portrait: s.portrait, patches: [], inverse: [], mutated: undone + redone > 0, undone, redone };
  }
  const state = store.getState();
  const result = runPortraitCommands(state.portrait, calls);
  if (!opts.silent || !result.ok) pushLog(store, { source, calls, ok: result.ok, error: result.ok ? undefined : result.error, warnings: result.warnings });
  if (!result.ok || opts.dryRun || !result.mutated) return result;
  const label = opts.label ?? getPortraitCommand(calls[0]!.cmd)?.label ?? calls[0]!.cmd;
  const past = [...state.past];
  const last = past[past.length - 1];
  const now = Date.now();
  if (opts.mergeKey && last && last.mergeKey === opts.mergeKey && now - last.at < MERGE_WINDOW_MS) {
    past[past.length - 1] = { ...last, patches: [...last.patches, ...result.patches], inverse: [...result.inverse, ...last.inverse], at: now };
  } else {
    past.push({ label, patches: result.patches, inverse: result.inverse, at: now, mergeKey: opts.mergeKey, source });
    if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  }
  store.setState({ portrait: result.portrait, past, future: [], rev: state.rev + 1 });
  return result;
}

export function undo(store: PortraitStoreApi): boolean {
  const s = store.getState();
  const entry = s.past[s.past.length - 1];
  if (!entry) return false;
  store.setState({ portrait: applyPatches(s.portrait, entry.inverse), past: s.past.slice(0, -1), future: [...s.future, entry], rev: s.rev + 1 });
  return true;
}

export function redo(store: PortraitStoreApi): boolean {
  const s = store.getState();
  const entry = s.future[s.future.length - 1];
  if (!entry) return false;
  store.setState({ portrait: applyPatches(s.portrait, entry.patches), future: s.future.slice(0, -1), past: [...s.past, entry], rev: s.rev + 1 });
  return true;
}

/** Replace the document (open / new / import). */
export function loadPortrait(store: PortraitStoreApi, portrait: Portrait): void {
  const s = store.getState();
  store.setState({ portrait, rev: s.rev + 1, loadToken: s.loadToken + 1, savedRev: s.rev + 1, past: [], future: [] });
}

export function markSaved(store: PortraitStoreApi, rev = store.getState().rev): void {
  store.setState({ savedRev: rev });
}

export function isDirty(s: PortraitDocState): boolean {
  return s.rev !== s.savedRev;
}

/** A portrait changed outside the app (an agent edited the file): apply it as ONE undoable step. */
export function applyExternalPortrait(store: PortraitStoreApi, next: Portrait, label = '外部修改'): boolean {
  const s = store.getState();
  const [portrait, patches, inverse] = produceWithPatches(s.portrait, (draft) => {
    draft.name = next.name;
    draft.notes = next.notes;
    draft.preset = next.preset;
    draft.params = next.params;
    draft.framing = next.framing;
    draft.references = next.references;
  });
  if (patches.length === 0) return false;
  const past = [...s.past, { label, patches, inverse, at: Date.now(), source: 'agent' as CommandSource }];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  const rev = s.rev + 1;
  store.setState({ portrait, past, future: [], rev, savedRev: rev });
  return true;
}
