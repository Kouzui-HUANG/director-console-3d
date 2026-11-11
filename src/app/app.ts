/**
 * Application hub: wires the core store, storage, viewport, offscreen rendering,
 * playback, autosave and the agent bridge together. React components read from
 * `app.store` (project document) and `app.ui` (editor UI state).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { CommandCall } from '../core/commands/execute.ts';
import { programCameraAt } from '../core/evaluate.ts';
import { cloneProject, emptyProject, serializeProject } from '../core/project.ts';
import type { Project } from '../core/schema.ts';
import {
  applyExternalProject,
  createDirectorStore,
  dispatch,
  loadProject,
  markSaved,
  pushLog,
  setTime,
  setUI,
  type CommandSource,
  type DirectorStore,
  type DispatchOptions,
  type DispatchResult,
} from '../core/store.ts';
import { templateProject } from '../core/templates.ts';
import { validateProject } from '../core/validate.ts';
import { downloadBlob, safeFilename } from '../export/mp4.ts';
import { OffscreenShots, outputSize } from '../render/offscreen.ts';
import { Viewport, type FrameInfo, type GizmoMode, type TransformChange, type ViewMode } from '../render/viewport.ts';
import { BrowserStore, detectServer, ServerStore, type ProjectMeta, type ProjectStore } from '../storage/stores.ts';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface Prefs {
  quality: QualityLevel;
  pip: boolean;
  grid: boolean;
  previewShadows: boolean;
  guides: { thirds: boolean; safe: boolean; center: boolean; hud: boolean };
  timelineHeight: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface ExportJob {
  fraction: number;
  frame: number;
  total: number;
  etaSec: number;
  cancel: () => void;
}

export interface AppUI {
  viewMode: ViewMode;
  viewCamera: string | null;
  gizmoMode: GizmoMode;
  dialog: null | 'projects' | 'export' | 'help' | 'settings';
  consoleOpen: boolean;
  toasts: Toast[];
  server: { connected: boolean; bridge: boolean; root?: string };
  saving: 'idle' | 'saving' | 'saved' | 'error';
  exportJob: ExportJob | null;
  frame: FrameInfo | null;
  contextLost: boolean;
  projects: ProjectMeta[];
  leftTab: 'assets' | 'outliner';
  ready: boolean;
  fatal: string | null;
}

const PREFS_KEY = 'director3d:prefs';
const LAST_KEY = 'director3d:lastProject';

function loadPrefs(): Prefs {
  const defaults: Prefs = {
    quality: 'medium',
    pip: true,
    grid: true,
    previewShadows: false,
    guides: { thirds: true, safe: false, center: false, hud: true },
    timelineHeight: 230,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw), guides: { ...defaults.guides, ...(JSON.parse(raw).guides ?? {}) } };
  } catch {
    /* private mode etc. */
  }
  return defaults;
}

export const PIXEL_RATIO: Record<QualityLevel, number> = { low: 1, medium: 1.5, high: 2 };

let toastSeq = 0;

export class DirectorApp {
  readonly store: DirectorStore = createDirectorStore(emptyProject());
  readonly prefs: StoreApi<Prefs> = createStore<Prefs>(() => loadPrefs());
  readonly ui: StoreApi<AppUI> = createStore<AppUI>(() => ({
    viewMode: 'editor',
    viewCamera: null,
    gizmoMode: 'translate',
    dialog: null,
    consoleOpen: false,
    toasts: [],
    server: { connected: false, bridge: false },
    saving: 'idle',
    exportJob: null,
    frame: null,
    contextLost: false,
    projects: [],
    leftTab: 'assets',
    ready: false,
    fatal: null,
  }));
  storage: ProjectStore = new BrowserStore();
  viewport: Viewport | null = null;
  shots: OffscreenShots | null = null;
  private lastSaved = new Map<string, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastThumbAt = 0;
  private playRaf = 0;
  private lastTick = 0;
  private dragSeq = 0;
  private dragLast: CommandCall | null = null;
  private onExternalHook: ((id: string) => void) | null = null;

  constructor() {
    this.prefs.subscribe((p) => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(p));
      } catch {
        /* ignore */
      }
    });
    this.store.subscribe((s, prev) => {
      if (s.rev !== prev.rev && s.rev !== s.savedRev) this.scheduleSave();
      if (s.project.id !== prev.project.id) this.rememberProject(s.project.id);
    });
  }

  // ---- lifecycle ---------------------------------------------------------------------

  async init(): Promise<void> {
    const server = await detectServer();
    this.storage = server.ok ? new ServerStore() : new BrowserStore();
    this.ui.setState({ server: { connected: server.ok, bridge: false, root: server.root } });
    const params = new URLSearchParams(location.search);
    let project: Project | null = null;
    const wanted = params.get('project') ?? this.lastProjectId();
    if (wanted) project = await this.tryLoad(wanted);
    if (!project) {
      const list = await this.storage.list().catch(() => []);
      for (const m of list) {
        project = await this.tryLoad(m.id);
        if (project) break;
      }
    }
    if (!project) {
      project = templateProject(params.get('template') ?? 'street');
      await this.storage.save(project).catch(() => undefined);
    }
    this.open(project);
    void this.refreshProjects();
    this.ui.setState({ ready: true });
  }

  private lastProjectId(): string | null {
    try {
      return localStorage.getItem(LAST_KEY);
    } catch {
      return null;
    }
  }

  private rememberProject(id: string) {
    try {
      localStorage.setItem(LAST_KEY, id);
    } catch {
      /* ignore */
    }
    const url = new URL(location.href);
    if (url.searchParams.get('project') !== id) {
      url.searchParams.set('project', id);
      url.searchParams.delete('template');
      history.replaceState(null, '', url);
    }
  }

  private async tryLoad(id: string): Promise<Project | null> {
    try {
      const raw = await this.storage.load(id);
      const r = validateProject(raw);
      if (r.ok && r.project) return r.project;
      this.toast(`專案 ${id} 有錯誤：${r.errors[0]?.path} ${r.errors[0]?.message}`, 'error');
    } catch {
      /* not found */
    }
    return null;
  }

  // ---- viewport -----------------------------------------------------------------------

  attachViewport(el: HTMLElement): () => void {
    const prefs = this.prefs.getState();
    let vp: Viewport;
    try {
      vp = new Viewport(
        el,
        {
          onPick: (id, additive) => this.pick(id, additive),
          onTransform: (id, change, phase) => this.onGizmo(id, change, phase),
          onCellPick: (cameraId, double) => this.onMultiviewPick(cameraId, double),
          onFrame: (info) => this.ui.setState({ frame: info }),
          onContextLost: (lost) => this.ui.setState({ contextLost: lost }),
        },
        { pixelRatioCap: PIXEL_RATIO[prefs.quality], pip: prefs.pip, shadows: prefs.previewShadows, grid: prefs.grid },
      );
    } catch (e) {
      this.ui.setState({ fatal: `無法啟動 3D（WebGL）：${(e as Error).message}。請確認 Chrome 的「使用硬體加速」已開啟。` });
      return () => undefined;
    }
    this.viewport = vp;
    this.shots = new OffscreenShots(vp);
    const push = () => {
      const s = this.store.getState();
      vp.setState(s.project, s.ui.time, s.ui.selection);
    };
    const unsubStore = this.store.subscribe(push);
    const unsubPrefs = this.prefs.subscribe((p) => vp.setOptions({ pixelRatioCap: PIXEL_RATIO[p.quality], pip: p.pip, shadows: p.previewShadows, grid: p.grid }));
    const unsubLoad = this.store.subscribe((st, prev) => {
      if (st.loadToken !== prev.loadToken) requestAnimationFrame(() => vp.frameAll());
    });
    const unsubUI = this.ui.subscribe((u, prev) => {
      if (u.viewMode !== prev.viewMode || u.viewCamera !== prev.viewCamera) vp.setMode(u.viewMode, u.viewCamera);
      if (u.gizmoMode !== prev.gizmoMode) vp.setGizmoMode(u.gizmoMode);
    });
    push();
    vp.setMode(this.ui.getState().viewMode, this.ui.getState().viewCamera);
    if (this.store.getState().loadToken > 0) requestAnimationFrame(() => vp.frameAll());
    return () => {
      unsubLoad();
      unsubStore();
      unsubPrefs();
      unsubUI();
      this.shots?.dispose();
      vp.dispose();
      this.viewport = null;
      this.shots = null;
    };
  }

  private pick(id: string | null, additive: boolean) {
    const sel = this.store.getState().ui.selection;
    if (!id) {
      if (!additive) setUI(this.store, { selection: [] });
      return;
    }
    if (additive) setUI(this.store, { selection: sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id] });
    else setUI(this.store, { selection: [id] });
  }

  select(ids: string[]) {
    setUI(this.store, { selection: ids });
  }

  private onGizmo(id: string, change: TransformChange, phase: 'start' | 'change' | 'end') {
    if (phase === 'start') {
      this.dragSeq++;
      this.dragLast = null;
      return;
    }
    if (phase === 'end') {
      if (this.dragLast) pushLog(this.store, { source: 'ui', calls: [this.dragLast], ok: true, warnings: [] });
      this.dragLast = null;
      return;
    }
    const s = this.store.getState();
    const obj = s.project.objects.find((o) => o.id === id);
    if (!obj) return;
    const args: Record<string, unknown> = { id };
    if (s.ui.autoKey) args.key = true;
    if (change.position) args.position = change.position;
    if (change.scale) args.scale = change.scale;
    if (change.rotation) {
      const cur = obj.rotation;
      args.rotation = change.rotation.map((v, i) => {
        const d = ((((v - cur[i]! + 180) % 360) + 360) % 360) - 180;
        return Math.round((cur[i]! + d) * 100) / 100;
      });
    }
    const call = { cmd: 'object.update', args };
    this.dragLast = call;
    const r = dispatch(this.store, call, { mergeKey: `drag:${id}:${this.dragSeq}`, silent: true, source: 'ui', label: '拖曳物件' });
    if (!r.ok) this.toast(r.error.message, 'error');
  }

  private onMultiviewPick(cameraId: string, double: boolean) {
    if (double) {
      this.setView('camera', cameraId);
      return;
    }
    const t = this.store.getState().ui.time;
    this.run({ cmd: 'cut.set', args: { t, camera: cameraId } });
    this.toast(`${t.toFixed(2)}s 切到 ${this.store.getState().project.objects.find((o) => o.id === cameraId)?.name ?? cameraId}`, 'info');
  }

  setView(mode: ViewMode, camera?: string | null) {
    const s = this.store.getState();
    let cam = camera === undefined ? this.ui.getState().viewCamera : camera;
    if (mode === 'camera' && !cam) {
      const selCam = s.ui.selection.find((id) => s.project.objects.find((o) => o.id === id)?.type === 'camera');
      cam = selCam ?? programCameraAt(s.project, s.ui.time);
    }
    this.ui.setState({ viewMode: mode, viewCamera: cam ?? null });
  }

  // ---- commands ------------------------------------------------------------------------

  /** Run commands from the UI; shows a toast on failure. */
  run(calls: CommandCall | CommandCall[], opts: DispatchOptions = {}): DispatchResult {
    const r = dispatch(this.store, calls, { source: 'ui', ...opts });
    if (!r.ok) this.toast(`${r.error.message}${r.error.hint ? `（${r.error.hint}）` : ''}`, 'error');
    else for (const w of r.warnings.slice(0, 2)) this.toast(w, 'info');
    return r;
  }

  runAs(source: CommandSource, calls: CommandCall | CommandCall[], opts: DispatchOptions = {}): DispatchResult {
    return dispatch(this.store, calls, { ...opts, source });
  }

  // ---- playback ------------------------------------------------------------------------

  play() {
    const s = this.store.getState();
    if (s.ui.time >= s.project.settings.duration - 1e-3) setTime(this.store, 0);
    setUI(this.store, { playing: true });
    this.lastTick = performance.now();
    cancelAnimationFrame(this.playRaf);
    this.playRaf = requestAnimationFrame(this.tick);
  }

  pause() {
    setUI(this.store, { playing: false });
    cancelAnimationFrame(this.playRaf);
    const s = this.store.getState();
    const fps = s.project.settings.fps;
    setTime(this.store, Math.round(s.ui.time * fps) / fps);
  }

  togglePlay() {
    if (this.store.getState().ui.playing) this.pause();
    else this.play();
  }

  private tick = (now: number) => {
    const s = this.store.getState();
    if (!s.ui.playing) return;
    // Real-time playback: slow machines skip frames instead of slowing down (capped for tab switches).
    const dt = Math.min(1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const d = s.project.settings.duration;
    let t = s.ui.time + dt;
    if (t >= d) {
      if (s.ui.loop) t = t % d;
      else {
        setTime(this.store, d);
        this.pause();
        return;
      }
    }
    setTime(this.store, t);
    this.playRaf = requestAnimationFrame(this.tick);
  };

  seek(t: number) {
    setTime(this.store, t);
  }

  stepFrames(n: number) {
    const s = this.store.getState();
    const fps = s.project.settings.fps;
    setTime(this.store, Math.round((s.ui.time + n / fps) * fps) / fps);
  }

  // ---- projects --------------------------------------------------------------------------

  open(project: Project) {
    this.pause();
    loadProject(this.store, project);
    this.lastSaved.set(project.id, project.revision);
    this.rememberProject(project.id);
    this.ui.setState({ viewCamera: null, viewMode: this.ui.getState().viewMode === 'camera' ? 'editor' : this.ui.getState().viewMode });
  }

  async refreshProjects(): Promise<ProjectMeta[]> {
    const list = await this.storage.list().catch(() => [] as ProjectMeta[]);
    this.ui.setState({ projects: list });
    return list;
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 800);
  }

  async saveNow(opts: { thumbnail?: boolean } = {}): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const s = this.store.getState();
    const p = s.project;
    const rev = s.rev;
    const revision = Math.max(this.lastSaved.get(p.id) ?? 0, p.revision) + 1;
    const out: Project = { ...p, revision, updatedAt: new Date().toISOString(), createdAt: p.createdAt ?? new Date().toISOString() };
    let thumb: string | undefined;
    if (opts.thumbnail || Date.now() - this.lastThumbAt > 20000) {
      thumb = this.thumbnail() ?? undefined;
      if (thumb) this.lastThumbAt = Date.now();
    }
    this.ui.setState({ saving: 'saving' });
    try {
      await this.storage.save(out, thumb);
      this.lastSaved.set(p.id, revision);
      markSaved(this.store, rev);
      this.ui.setState({ saving: 'saved' });
      if (thumb) void this.refreshProjects();
    } catch (e) {
      this.ui.setState({ saving: 'error' });
      this.toast(`儲存失敗：${(e as Error).message}`, 'error');
    }
  }

  thumbnail(): string | null {
    if (!this.shots) return null;
    const s = this.store.getState();
    try {
      const [w, h] = outputSize(s.project, 320);
      const { canvas } = this.shots.render(s.project, s.ui.time, 'program', w, h, 'thumb');
      const url = canvas.toDataURL('image/jpeg', 0.72);
      this.shots.restore();
      return url;
    } catch {
      return null;
    }
  }

  async openById(id: string): Promise<boolean> {
    if (this.store.getState().rev !== this.store.getState().savedRev) await this.saveNow();
    const p = await this.tryLoad(id);
    if (!p) {
      this.toast(`無法開啟專案 ${id}`, 'error');
      return false;
    }
    this.open(p);
    return true;
  }

  async createProject(template: string, name?: string): Promise<Project> {
    if (this.store.getState().rev !== this.store.getState().savedRev) await this.saveNow();
    const p = templateProject(template, name);
    await this.storage.save(p);
    this.open(p);
    void this.refreshProjects();
    return p;
  }

  async duplicateProject(): Promise<Project> {
    await this.saveNow();
    const p = cloneProject(this.store.getState().project);
    await this.storage.save(p);
    this.open(p);
    void this.refreshProjects();
    return p;
  }

  async deleteProject(id: string): Promise<void> {
    await this.storage.remove(id);
    this.lastSaved.delete(id);
    const list = await this.refreshProjects();
    if (this.store.getState().project.id === id) {
      const next = list[0] ? await this.tryLoad(list[0].id) : null;
      if (next) this.open(next);
      else await this.createProject('blank', '未命名專案');
    }
  }

  async importJson(text: string): Promise<boolean> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.toast('不是有效的 JSON 檔', 'error');
      return false;
    }
    const r = validateProject(raw);
    if (!r.ok || !r.project) {
      this.toast(`專案檔有錯誤：${r.errors[0]?.path} ${r.errors[0]?.message}`, 'error');
      return false;
    }
    let p = r.project;
    const list = await this.storage.list().catch(() => [] as ProjectMeta[]);
    if (list.some((m) => m.id === p.id)) p = cloneProject(p, p.name);
    await this.storage.save(p);
    this.open(p);
    void this.refreshProjects();
    this.toast(`已匯入「${p.name}」`, 'success');
    return true;
  }

  exportJson() {
    const p = this.store.getState().project;
    downloadBlob(new Blob([serializeProject(p)], { type: 'application/json' }), `${safeFilename(p.name)}.director3d.json`);
  }

  /** Called by the server bridge when projects/<id>.json changed on disk (not by us). */
  async onExternalChange(id: string): Promise<void> {
    this.onExternalHook?.(id);
    void this.refreshProjects();
    if (this.store.getState().project.id !== id) return;
    try {
      const raw = await this.storage.load(id);
      const r = validateProject(raw);
      if (!r.ok || !r.project) {
        this.toast(`外部修改的專案檔有錯誤，未套用：${r.errors[0]?.path} ${r.errors[0]?.message}`, 'error');
        return;
      }
      this.lastSaved.set(id, Math.max(this.lastSaved.get(id) ?? 0, r.project.revision));
      if (applyExternalProject(this.store, r.project)) this.toast('專案檔已在外部修改並重新載入（可復原）', 'info');
    } catch (e) {
      this.toast(`重新載入失敗：${(e as Error).message}`, 'error');
    }
  }

  setExternalHook(fn: ((id: string) => void) | null) {
    this.onExternalHook = fn;
  }

  // ---- misc ----------------------------------------------------------------------------------

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++toastSeq;
    this.ui.setState({ toasts: [...this.ui.getState().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => this.ui.setState({ toasts: this.ui.getState().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6500 : 3200);
  }

  openDialog(d: AppUI['dialog']) {
    this.ui.setState({ dialog: d });
    if (d === 'projects') void this.refreshProjects();
  }
}

export const app = new DirectorApp();

// Dev only: the app is a singleton shared by the UI, window.director and the bridge.
// Hot-swapping it would split state between old and new instances, so reload the page instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
}
