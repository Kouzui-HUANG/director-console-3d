/**
 * Portrait studio controller: owns the portrait document store (commands, undo/redo), storage
 * (companion server or IndexedDB) with autosave and live reload, the viewer and the
 * MakeHuman-based builder. React components read `doc` (the portrait) and `ui` (view state).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { PortraitBridge } from './agent/bridge.ts';
import { detectServer } from '../storage/server.ts';
import { checkPortrait, type CheckIssue } from './core/checks.ts';
import { FRAMING_CUTS } from './core/framing.ts';
import { fetchAssets } from './core/mh/assets.ts';
import { HumanBuilder, type HumanMesh } from './core/mh/human.ts';
import type { Measures } from './core/mh/measure.ts';
import type { PortraitCommandCall } from './core/commands.ts';
import { PRESET_BY_ID } from './core/params/presets.ts';
import { PARAM_BY_KEY, type ParamGroup } from './core/params/registry.ts';
import { resolveParams, type ParamValues } from './core/params/resolve.ts';
import { clonePortrait, newPortrait, serializePortrait, validatePortrait, type FramingType, type Portrait } from './core/schema.ts';
import { applyExternalPortrait, createPortraitStore, dispatch, isDirty, loadPortrait, markSaved, type CommandSource, type DispatchOptions, type DispatchResult } from './core/store.ts';
import { PortraitViewer, TURNAROUND, type LightPreset, type MaterialPreset, type ViewName } from './render/viewer.ts';
import { ReferenceManager } from './photo/references.ts';
import { BrowserPortraitStore, ServerPortraitStore, type PortraitMeta, type PortraitStorage } from './storage/stores.ts';

export type Quality = 'preview' | 'standard';

export const QUALITY: Record<Quality, { level: number; label: string }> = {
  preview: { level: 1, label: '預覽' },
  standard: { level: 2, label: '標準' },
};

export const FOCALS = [35, 50, 85, 135] as const;


export interface MeshStats {
  level: number;
  vertices: number;
  triangles: number;
  ms: number;
  heightCm: number;
  headsTall: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

export interface StudioUI {
  ready: boolean;
  quality: Quality;
  pupils: boolean;
  exaggerate: boolean;
  view: ViewName;
  light: LightPreset;
  material: MaterialPreset;
  focal: number;
  turntable: boolean;
  ao: boolean;
  wireframe: boolean;
  landmarks: boolean;
  /** Parameter whose effect is highlighted on the model (hover). */
  highlight: string | null;
  busy: boolean;
  stats: MeshStats | null;
  measures: Measures | null;
  issues: CheckIssue[];
  error: string | null;
  saving: 'idle' | 'saving' | 'saved' | 'error';
  server: { connected: boolean; bridge: boolean; root?: string };
  library: PortraitMeta[];
  dialog: null | 'library' | 'help' | 'export';
  consoleOpen: boolean;
  toasts: Toast[];
  /** Expanded parameter groups and the search text of the parameter panel. */
  openGroups: ParamGroup[];
  search: string;
  traitAmount: number;
}

const PREFS_KEY = 'director3d.portrait.prefs';
const LAST_KEY = 'director3d.portrait.last';
type Prefs = Pick<StudioUI, 'quality' | 'pupils' | 'exaggerate' | 'light' | 'material' | 'focal' | 'ao' | 'openGroups' | 'traitAmount'>;
const PREF_KEYS: (keyof Prefs)[] = ['quality', 'pupils', 'exaggerate', 'light', 'material', 'focal', 'ao', 'openGroups', 'traitAmount'];

function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
  } catch {
    return {};
  }
}

let toastSeq = 0;

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const safeFilename = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'portrait';

export class PortraitStudio {
  readonly doc = createPortraitStore(newPortrait({ preset: 'female-eastAsian', params: { ...PRESET_BY_ID.get('female-eastAsian')!.params } }));
  readonly ui: StoreApi<StudioUI> = createStore<StudioUI>(() => ({
    ready: false,
    quality: 'standard',
    pupils: true,
    exaggerate: false,
    view: 'front',
    light: 'studio',
    material: 'plaster',
    focal: 85,
    turntable: false,
    ao: true,
    wireframe: false,
    landmarks: false,
    highlight: null,
    busy: false,
    stats: null,
    measures: null,
    issues: [],
    error: null,
    saving: 'idle',
    server: { connected: false, bridge: false },
    library: [],
    dialog: null,
    consoleOpen: false,
    toasts: [],
    openGroups: ['base', 'eyes'],
    search: '',
    traitAmount: 1,
    ...loadPrefs(),
  }));
  storage: PortraitStorage = new BrowserPortraitStore();
  /** Reference photos of the open portrait (analysis, comparison, fitting). */
  readonly refs: ReferenceManager = new ReferenceManager(this);
  viewer: PortraitViewer | null = null;
  builder: HumanBuilder | null = null;
  last: HumanMesh | null = null;
  private bridge: PortraitBridge | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastThumbAt = 0;
  private lastSaved = new Map<string, number>();
  private framedFor: string | null = null;
  private queued = false;
  private loop: Promise<MeshStats | null> | null = null;
  private highlightWeights: Float32Array | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Parameters (and framing) shown instead of the document's (sweeps, calibration) — never saved. */
  private previewParams: ParamValues | null = null;
  private previewFraming: FramingType | null = null;

  constructor() {
    this.ui.subscribe((s, prev) => {
      if (PREF_KEYS.some((k) => s[k] !== prev[k])) {
        try {
          localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(PREF_KEYS.map((k) => [k, s[k]]))));
        } catch {
          /* private mode */
        }
      }
      const v = this.viewer;
      if (v) {
        if (s.light !== prev.light) v.setLighting(s.light);
        if (s.material !== prev.material) v.setMaterial(s.material);
        if (s.wireframe !== prev.wireframe) v.setWireframe(s.wireframe);
        if (s.view !== prev.view) v.setView(s.view);
        if (s.focal !== prev.focal) {
          v.setFocal(s.focal);
          v.setView(s.view);
        }
        if (s.turntable !== prev.turntable) v.setTurntable(s.turntable);
        if (s.ao !== prev.ao) v.setAO(s.ao);
        if (s.landmarks !== prev.landmarks || s.measures !== prev.measures) v.setLandmarks(s.landmarks && this.last ? this.last.posedLandmarks : null);
      }
      if (s.quality !== prev.quality || s.pupils !== prev.pupils) void this.rebuild();
    });
    this.doc.subscribe((s, prev) => {
      if (s.portrait.params !== prev.portrait.params || s.portrait.framing !== prev.portrait.framing) void this.rebuild();
      if (s.portrait.framing.type !== prev.portrait.framing.type) this.framedFor = null;
      if (s.rev !== prev.rev && s.rev !== s.savedRev) this.scheduleSave();
      if (s.portrait.id !== prev.portrait.id) {
        this.remember(s.portrait.id);
        this.bridge?.hello();
      }
      if (s.portrait.references !== prev.portrait.references || s.portrait.id !== prev.portrait.id) this.refs.sync();
      else if (s.portrait.params !== prev.portrait.params) this.refs.scheduleAlign();
    });
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  async init(el: HTMLElement): Promise<() => void> {
    this.viewer = new PortraitViewer(el);
    const st = this.ui.getState();
    this.viewer.setLighting(st.light);
    this.viewer.setMaterial(st.material);
    this.viewer.setFocal(st.focal);
    this.viewer.setAO(st.ao);
    const server = await detectServer();
    this.storage = server.ok ? new ServerPortraitStore() : new BrowserPortraitStore();
    this.ui.setState({ server: { connected: server.ok, bridge: false, root: server.root } });
    if (server.ok) {
      this.bridge = new PortraitBridge({
        portraitId: () => this.doc.getState().portrait.id,
        portraitName: () => this.doc.getState().portrait.name,
        onExternalChange: (id) => void this.onExternalChange(id),
        onDeleted: (id) => void this.onDeleted(id),
        onConnection: (bridge) => this.ui.setState({ server: { ...this.ui.getState().server, bridge } }),
        api: () => window.portrait,
      });
    }
    const assets = fetchAssets().then((a) => (this.builder = new HumanBuilder(a)));
    let p: Portrait | null = null;
    const wanted = new URLSearchParams(location.search).get('portrait') ?? this.lastId();
    if (wanted) p = await this.tryLoad(wanted);
    if (!p) {
      const list = await this.storage.list().catch(() => [] as PortraitMeta[]);
      for (const m of list) {
        p = await this.tryLoad(m.id);
        if (p) break;
      }
    }
    if (!p) {
      p = this.doc.getState().portrait;
      await this.storage.save(p).catch(() => undefined);
    }
    this.open(p);
    void this.refreshLibrary();
    try {
      await assets;
    } catch (e) {
      this.ui.setState({ error: (e as Error).message });
    }
    await this.rebuild();
    this.ui.setState({ ready: true });
    this.refs.sync();
    const flush = () => {
      if (isDirty(this.doc.getState())) void this.saveNow();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      this.bridge?.dispose();
      this.viewer?.dispose();
      this.viewer = null;
    };
  }

  private lastId(): string | null {
    try {
      return localStorage.getItem(LAST_KEY);
    } catch {
      return null;
    }
  }

  private remember(id: string) {
    try {
      localStorage.setItem(LAST_KEY, id);
    } catch {
      /* private mode */
    }
    const url = new URL(location.href);
    if (url.searchParams.get('portrait') !== id) {
      url.searchParams.set('portrait', id);
      history.replaceState(null, '', url);
    }
  }

  private async tryLoad(id: string): Promise<Portrait | null> {
    try {
      const r = validatePortrait(await this.storage.load(id));
      if (r.ok && r.portrait) {
        if (r.warnings.length) this.toast(`人像 ${r.portrait.name}：${r.warnings[0]}${r.warnings.length > 1 ? `（另有 ${r.warnings.length - 1} 則）` : ''}`, 'info');
        return r.portrait;
      }
      this.toast(`人像 ${id} 有錯誤：${r.errors[0]?.path} ${r.errors[0]?.message}`, 'error');
    } catch {
      /* missing */
    }
    return null;
  }

  private open(p: Portrait) {
    loadPortrait(this.doc, p);
    this.lastSaved.set(p.id, p.revision);
    this.framedFor = null;
    this.remember(p.id);
    this.bridge?.hello();
  }

  // ---- commands ---------------------------------------------------------------------------------

  /** Run commands; for UI calls, errors become toasts. */
  run(calls: PortraitCommandCall | PortraitCommandCall[], opts: DispatchOptions = {}): DispatchResult {
    const r = dispatch(this.doc, calls, { source: 'ui', ...opts });
    if (!r.ok && (opts.source ?? 'ui') === 'ui') this.toast(`${r.error.message}${r.error.hint ? `（${r.error.hint}）` : ''}`, 'error');
    return r;
  }

  runAs(source: CommandSource, calls: PortraitCommandCall[], opts: Omit<DispatchOptions, 'source'> = {}): DispatchResult {
    return dispatch(this.doc, calls, { ...opts, source });
  }

  /** Slider drags: consecutive changes of one parameter merge into one undo step. */
  setParam(key: string, value: number | null) {
    this.run({ cmd: 'portrait.set', args: { params: { [key]: value } } }, { mergeKey: `set:${key}`, silent: true });
  }

  setParams(params: ParamValues) {
    this.run({ cmd: 'portrait.set', args: { params } });
  }

  // ---- building -----------------------------------------------------------------------------------

  /**
   * Rebuild for the current portrait and view settings. Calls made while a build runs are
   * coalesced, and every caller's promise resolves after the build that includes its change.
   */
  rebuild(): Promise<MeshStats | null> {
    this.queued = true;
    if (!this.loop) {
      this.loop = (async () => {
        let stats: MeshStats | null = null;
        try {
          while (this.queued) {
            this.queued = false;
            await new Promise((r) => setTimeout(r, 0)); // let the UI paint between rebuilds
            stats = this.buildNow();
          }
          return stats;
        } finally {
          this.loop = null;
        }
      })();
    }
    return this.loop;
  }

  private specFor(params: ParamValues, level: number, withCut = true) {
    const p = this.doc.getState().portrait;
    const r = resolveParams(params);
    return {
      r,
      spec: {
        values: r.values,
        heightCm: r.heightCm,
        headsTall: r.headsTall,
        pose: r.pose,
        gaze: r.gaze,
        brows: r.brows,
        cranium: r.cranium,
        level,
        bust: withCut ? FRAMING_CUTS[this.previewFraming ?? p.framing.type] : null,
        carveEyes: this.ui.getState().pupils,
      },
    };
  }

  private buildNow(): MeshStats | null {
    const b = this.builder;
    const v = this.viewer;
    if (!b || !v) return null;
    const p = this.doc.getState().portrait;
    const ui = this.ui.getState();
    this.ui.setState({ busy: true, error: null });
    try {
      const params = this.previewParams ?? p.params;
      const { r, spec } = this.specFor(params, QUALITY[ui.quality].level);
      const m = b.build({ ...spec, highlight: this.highlightWeights });
      this.last = m;
      v.setMesh(m);
      if (this.framedFor !== `${p.id}:${p.framing.type}`) {
        this.framedFor = `${p.id}:${p.framing.type}`;
        this.frame();
      }
      const stats: MeshStats = {
        level: QUALITY[ui.quality].level,
        vertices: m.vertexCount,
        triangles: m.triangleCount,
        ms: Math.round(m.timing.total),
        heightCm: Math.round(m.height) / 10,
        headsTall: Math.round(m.measures.headsTall * 100) / 100,
      };
      this.ui.setState({ busy: false, stats, measures: m.measures, issues: checkPortrait(m, r, params) });
      return stats;
    } catch (e) {
      this.ui.setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** Show other parameters (and framing) without touching the document (null returns to the document). */
  preview(params: ParamValues | null, o: { framing?: FramingType } = {}): Promise<MeshStats | null> {
    this.previewParams = params;
    this.previewFraming = params ? (o.framing ?? null) : null;
    return this.rebuild();
  }

  /** Show which parts of the model a parameter changes (null clears). */
  highlightParam(key: string | null) {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(
      () => {
        const b = this.builder;
        if (!key || !b) {
          if (this.highlightWeights) {
            this.highlightWeights = null;
            this.ui.setState({ highlight: null });
            void this.rebuild();
          }
          return;
        }
        const d = PARAM_BY_KEY.get(key);
        if (!d) return;
        const params = this.doc.getState().portrait.params;
        const cur = (params[key] as number | undefined) ?? d.def ?? (d.range[0] + d.range[1]) / 2;
        const step = (d.range[1] - d.range[0]) * 0.35;
        const probe = cur + step <= d.limit[1] ? cur + step : cur - step;
        const a = this.specFor({ ...params, [key]: cur }, 0, false).spec;
        const c = this.specFor({ ...params, [key]: probe }, 0, false).spec;
        this.highlightWeights = b.displacement(a, c);
        this.ui.setState({ highlight: key });
        void this.rebuild();
      },
      key ? 140 : 60,
    );
  }

  /** Point the camera for the current framing (or a named part). */
  frame(what?: 'head' | 'face' | 'all') {
    const v = this.viewer;
    const m = this.last;
    if (!v || !m) return;
    const type = this.doc.getState().portrait.framing.type;
    const mm = (p: [number, number, number]): [number, number, number] => [p[0] / 1000, p[1] / 1000, p[2] / 1000];
    const hs = m.solve.headScale * m.solve.scale;
    const target = what ?? (type === 'head' ? 'head' : 'all');
    if (target === 'head') v.setFraming(mm(m.headCenter), 0.16 * hs);
    else if (target === 'face') v.setFraming(mm(m.faceCenter), 0.095 * hs);
    else if (type === 'bust') v.setFraming(mm([0, m.headCenter[1] - 150 * hs, 0]), 0.3 * hs);
    else v.setFraming([0, (m.bounds[1] + m.bounds[4]) / 2000, 0], (0.52 * Math.max(m.bounds[4] - m.bounds[1], m.bounds[3] - m.bounds[0])) / 1000);
    v.setView(this.ui.getState().view);
  }

  setFraming(type: FramingType) {
    this.run({ cmd: 'portrait.update', args: { framing: { type } } });
  }

  // ---- library and files --------------------------------------------------------------------------

  async refreshLibrary(): Promise<PortraitMeta[]> {
    const list = await this.storage.list().catch(() => [] as PortraitMeta[]);
    this.ui.setState({ library: list });
    return list;
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 800);
  }

  async saveNow(opts: { thumbnail?: boolean } = {}): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const s = this.doc.getState();
    const p = s.portrait;
    const rev = s.rev;
    const revision = Math.max(this.lastSaved.get(p.id) ?? 0, p.revision) + 1;
    const out: Portrait = { ...p, revision, updatedAt: new Date().toISOString(), createdAt: p.createdAt ?? new Date().toISOString() };
    let thumb: string | undefined;
    if (opts.thumbnail || Date.now() - this.lastThumbAt > 15000) {
      thumb = this.thumbnail() ?? undefined;
      if (thumb) this.lastThumbAt = Date.now();
    }
    this.ui.setState({ saving: 'saving' });
    try {
      await this.storage.save(out, thumb);
      this.lastSaved.set(p.id, revision);
      markSaved(this.doc, rev);
      this.ui.setState({ saving: 'saved' });
      if (thumb) void this.refreshLibrary();
    } catch (e) {
      this.ui.setState({ saving: 'error' });
      this.toast(`儲存失敗：${(e as Error).message}`, 'error');
    }
  }

  /** Revision of the open portrait as last saved. */
  savedRevision(): number {
    const p = this.doc.getState().portrait;
    return this.lastSaved.get(p.id) ?? p.revision;
  }

  /** Small front view of the head for the library (JPEG data URL). */
  thumbnail(): string | null {
    const v = this.viewer;
    const m = this.last;
    if (!v || !m || this.highlightWeights) return null;
    try {
      const hs = m.solve.headScale * m.solve.scale;
      const c = v.renderFramed('front', 192, 216, [m.headCenter[0] / 1000, (m.headCenter[1] - 25 * hs) / 1000, m.headCenter[2] / 1000], 0.19 * hs);
      return c.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    }
  }

  async openById(id: string): Promise<boolean> {
    if (isDirty(this.doc.getState())) await this.saveNow();
    const p = await this.tryLoad(id);
    if (!p) {
      this.toast(`無法開啟人像 ${id}`, 'error');
      return false;
    }
    this.open(p);
    this.ui.setState({ dialog: null });
    return true;
  }

  async createNew(preset: string | null, name?: string): Promise<Portrait> {
    if (isDirty(this.doc.getState())) await this.saveNow();
    const p = newPortrait({ name, preset, params: preset ? { ...PRESET_BY_ID.get(preset)?.params } : {} });
    await this.storage.save(p).catch(() => undefined);
    this.open(p);
    void this.refreshLibrary();
    this.ui.setState({ dialog: null });
    return p;
  }

  async duplicate(): Promise<Portrait> {
    await this.saveNow();
    const p = clonePortrait(this.doc.getState().portrait);
    await this.storage.save(p);
    this.open(p);
    void this.refreshLibrary();
    this.toast(`已另存為「${p.name}」`, 'success');
    return p;
  }

  async remove(id: string): Promise<void> {
    await this.storage.remove(id);
    this.lastSaved.delete(id);
    const list = await this.refreshLibrary();
    if (this.doc.getState().portrait.id === id) {
      const next = list[0] ? await this.tryLoad(list[0].id) : null;
      if (next) this.open(next);
      else await this.createNew('female-eastAsian');
    }
    this.toast(this.storage.kind === 'server' ? '已移到 portraits/.trash/' : '已刪除', 'info');
  }

  async importJson(text: string): Promise<boolean> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.toast('不是有效的 JSON 檔', 'error');
      return false;
    }
    const r = validatePortrait(raw);
    if (!r.ok || !r.portrait) {
      this.toast(`人像檔有錯誤：${r.errors[0]?.path} ${r.errors[0]?.message}`, 'error');
      return false;
    }
    if (isDirty(this.doc.getState())) await this.saveNow();
    let p = r.portrait;
    const list = await this.storage.list().catch(() => [] as PortraitMeta[]);
    if (list.some((m) => m.id === p.id)) p = clonePortrait(p, p.name);
    await this.storage.save(p);
    this.open(p);
    void this.refreshLibrary();
    this.toast(`已匯入「${p.name}」${r.warnings.length ? `（${r.warnings.length} 則提醒：${r.warnings[0]}）` : ''}`, 'success');
    return true;
  }

  exportJson() {
    const p = this.doc.getState().portrait;
    downloadBlob(new Blob([serializePortrait(p)], { type: 'application/json' }), `${safeFilename(p.name)}.portrait.json`);
  }

  /** Front / 3/4 / profile sheet as a PNG download. */
  /**
   * The 三視圖 deliverable: front, left 3/4 and left profile labelled 正面／半側／側面, each a tall
   * cell (640 × 1080 → a 1920 × 1080 sheet) framing head and shoulders with the crown near the top.
   */
  turnaroundSheet(scale = 1): HTMLCanvasElement | null {
    const v = this.viewer;
    const m = this.last;
    if (!v || !m) return null;
    const hs = m.solve.headScale * m.solve.scale;
    const c = m.headCenter;
    // headCenter sits halfway between crown and chin: aim lower so the crown lands near the top, and a
    // little further back so the profile (nose to back of the skull) is centred in its cell.
    const target: [number, number, number] = [c[0] / 1000, (c[1] - 58 * hs) / 1000, (c[2] - 24 * hs) / 1000];
    const views = TURNAROUND.map((t) => ({ view: t.view, label: t.label }));
    return v.labelledSheet(views, Math.round(640 * scale), Math.round(1080 * scale), target, 0.115 * hs);
  }

  exportTurnaround() {
    const canvas = this.turnaroundSheet();
    if (!canvas) return;
    const p = this.doc.getState().portrait;
    canvas.toBlob((b) => b && downloadBlob(b, `${safeFilename(p.name)}_三視圖.png`), 'image/png');
  }

  exportSheet(views: ViewName[] = ['front', 'threeQuarterLeft', 'left'], size: [number, number] = [800, 960]) {
    const v = this.viewer;
    if (!v) return;
    const p = this.doc.getState().portrait;
    const canvas = v.sheet(views, size[0], size[1], views.length, p.name);
    canvas.toBlob((b) => b && downloadBlob(b, `${safeFilename(p.name)}.png`), 'image/png');
  }

  /** Someone else deleted a portrait: if it is the open one, switch to another (never re-save it). */
  async onDeleted(id: string): Promise<void> {
    const list = await this.refreshLibrary();
    if (this.doc.getState().portrait.id !== id) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    markSaved(this.doc);
    const next = list[0] ? await this.tryLoad(list[0].id) : null;
    if (next) this.open(next);
    else await this.createNew('female-eastAsian');
    this.toast('這個人像已在別處刪除（移到 portraits/.trash/），已切換到其他人像', 'info');
  }

  /** portraits/<id>.json changed on disk (an agent edited it): reload as one undoable step. */
  async onExternalChange(id: string): Promise<void> {
    void this.refreshLibrary();
    if (this.doc.getState().portrait.id !== id) return;
    try {
      const r = validatePortrait(await this.storage.load(id));
      if (!r.ok || !r.portrait) {
        this.toast(`外部修改的人像檔有錯誤，未套用：${r.errors[0]?.path} ${r.errors[0]?.message}`, 'error');
        return;
      }
      this.lastSaved.set(id, Math.max(this.lastSaved.get(id) ?? 0, r.portrait.revision));
      if (applyExternalPortrait(this.doc, r.portrait)) this.toast(`人像檔已在外部修改並重新載入（可復原）${r.warnings.length ? `；${r.warnings[0]}` : ''}`, 'info');
    } catch (e) {
      this.toast(`重新載入失敗：${(e as Error).message}`, 'error');
    }
  }

  // ---- misc ------------------------------------------------------------------------------------

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++toastSeq;
    this.ui.setState({ toasts: [...this.ui.getState().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => this.ui.setState({ toasts: this.ui.getState().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6500 : 3200);
  }

  openDialog(d: StudioUI['dialog']) {
    this.ui.setState({ dialog: d });
    if (d === 'library') void this.refreshLibrary();
  }
}

export const studio = new PortraitStudio();

// The studio is a singleton shared by the UI and window.portrait; reload instead of hot-swapping.
if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
}
