/**
 * Reference photos of the open portrait (browser): loading, local MediaPipe analysis, alignment
 * with the current parameters, comparison images and fitting. Images are stored with the portrait
 * (portraits/refs/<id>/ through the companion server, else IndexedDB) and never leave the machine;
 * the document lists them (portrait.addReference / removeReference), so changes are undoable.
 */
import { createStore } from 'zustand/vanilla';
import type { PortraitStudio } from '../app.ts';
import type { ParamGroup } from '../core/params/registry.ts';
import type { ParamValues } from '../core/params/resolve.ts';
import type { CommandSource } from '../core/store.ts';
import { readExif, trustedFocal35 } from './exif.ts';
import { alignedParams, alignPhoto, cameraRotation, expressionFromBlendshapes, fitPortrait, LandmarkModel, type FitResult, type Observation } from './fit.ts';
import type { FaceDetection } from './mediapipe.ts';
import { LEFT_BROW, LEFT_EYE, LIPS, RIGHT_BROW, RIGHT_EYE } from './regions.ts';

export type CameraInfo = ReturnType<typeof alignPhoto>['info'];

export interface RefItem {
  id: string;
  file: string;
  note: string;
  focal35: number | null;
  status: 'loading' | 'ready' | 'noface' | 'error';
  error?: string;
  /** Object URL of the image, for <img>. */
  url?: string;
  width?: number;
  height?: number;
  /** The current portrait seen by this photo's camera: median landmark / outline error (% of the pupil distance) and the camera. */
  align?: { error: number; outline: number | null; camera: CameraInfo };
  /** Expression read from the photo (expr.* values). */
  expression?: Record<string, number>;
}

export interface CompareMeasure {
  key: string;
  label: string;
  /** Ratios to the photo's pupil distance (the model is projected with the photo's camera). */
  photo: number;
  model: number;
  /** photo / model − 1, in %. */
  diff: number;
}

export interface CompareReport {
  refId: string;
  note: string;
  /** Median landmark distance and outline distance, % of the pupil distance. */
  error: number;
  outline: number | null;
  regions: Record<string, number>;
  camera: CameraInfo;
  measures: CompareMeasure[];
  expression: Record<string, number>;
}

export interface ComparePoints {
  photo: [number, number][];
  model: [number, number][];
  outlinePhoto: [number, number][];
  outlineModel: [number, number][];
}

/** What the compare view frames: the face (default) or the whole head with ears and crown. */
export type CompareFrame = 'face' | 'head';

export interface CompareView {
  refId: string;
  size: [number, number];
  frame: CompareFrame;
  /** The photo cropped to the face (JPEG data URL). */
  photo: string;
  /** The portrait seen by the photo's camera, same crop, transparent background (PNG data URL). */
  render: string;
  /** Landmarks in crop pixels. */
  points: ComparePoints;
  report: CompareReport;
  /** The portrait's parameters when compared (the view is stale once they change). */
  params: ParamValues;
}

export interface FitSummary {
  applied: boolean;
  refIds: string[];
  changed: FitResult['changed'];
  photos: (FitResult['photos'][number] & { refId: string })[];
  error: FitResult['error'];
  outline: FitResult['outline'];
  iterations: number;
  /** The parameter changes (null = back to default). */
  patch: Record<string, number | null>;
  ms: number;
}

export interface RefsState {
  items: RefItem[];
  compare: CompareView | null;
  busy: null | 'adding' | 'compare' | 'fit';
  fit: FitSummary | null;
}

interface Loaded {
  bitmap: ImageBitmap | null;
  url: string;
  det: FaceDetection | null;
  error?: string;
}

const NOSE = [1, 2, 4, 5, 6, 19, 45, 48, 64, 94, 97, 98, 115, 129, 168, 195, 197, 220, 275, 278, 294, 326, 327, 344, 358, 440];
const REGIONS: [string, Set<number>][] = [
  ['眼睛', new Set([...LEFT_EYE, ...RIGHT_EYE])],
  ['眉毛', new Set([...LEFT_BROW, ...RIGHT_BROW])],
  ['鼻子', new Set(NOSE)],
  ['嘴唇', new Set(LIPS)],
];

/** 2D measurements compared between photo and model: pairs of landmark distances (averaged), contour points marked "o". */
const MEASURES: { key: string; label: string; pairs: [number | `o${number}`, number | `o${number}`][] }[] = [
  { key: 'eyeWidth', label: '眼睛寬度', pairs: [[33, 133], [362, 263]] },
  { key: 'eyeOpening', label: '眼睛開合', pairs: [[159, 145], [386, 374]] },
  { key: 'intercanthal', label: '內眼角距', pairs: [[133, 362]] },
  { key: 'noseWidth', label: '鼻翼寬', pairs: [[129, 358]] },
  { key: 'noseLength', label: '鼻長', pairs: [[168, 2]] },
  { key: 'mouthWidth', label: '嘴寬', pairs: [[61, 291]] },
  { key: 'upperLip', label: '上唇厚', pairs: [[0, 13]] },
  { key: 'lowerLip', label: '下唇厚', pairs: [[14, 17]] },
  { key: 'philtrum', label: '人中長', pairs: [[2, 0]] },
  { key: 'faceWidth', label: '臉寬（耳前）', pairs: [['o234', 'o454']] },
  { key: 'jawWidth', label: '下顎寬', pairs: [['o172', 'o397']] },
  { key: 'lowerFace', label: '下臉長（鼻底到下巴）', pairs: [[2, 'o152']] },
];

const MAX_SIDE = 2400;

/** Keep JPEG / PNG / WebP up to 2400 px as they are; otherwise re-encode as JPEG (orientation applied). */
async function normalizeImage(blob: Blob, bitmap: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && ['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) return blob;
  const c = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

export class ReferenceManager {
  readonly store = createStore<RefsState>(() => ({ items: [], compare: null, busy: null, fit: null }));
  private readonly studio: PortraitStudio;
  private readonly cache = new Map<string, Loaded>();
  private readonly jobs = new Map<string, Promise<void>>();
  private model: LandmarkModel | null = null;
  private alignTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(studio: PortraitStudio) {
    this.studio = studio;
  }

  /** The landmark model (needs the MakeHuman data). */
  landmarkModel(): LandmarkModel {
    const b = this.studio.builder;
    if (!b) throw new Error('the MakeHuman data is still loading');
    if (!this.model || this.model.builder !== b) this.model = new LandmarkModel(b);
    return this.model;
  }

  private key(portraitId: string, file: string) {
    return `${portraitId}/${file}`;
  }

  /** Mirror the document's reference list (after loading, undo / redo, switching portraits). */
  sync() {
    const p = this.studio.doc.getState().portrait;
    const prev = this.store.getState();
    const items: RefItem[] = p.references.map((r) => {
      const c = this.cache.get(this.key(p.id, r.file));
      const old = prev.items.find((i) => i.id === r.id && i.file === r.file);
      return {
        id: r.id,
        file: r.file,
        note: r.note,
        focal35: r.focal35 ?? null,
        status: !c ? 'loading' : c.error ? 'error' : c.det ? 'ready' : 'noface',
        ...(c?.error ? { error: c.error } : {}),
        ...(c?.url ? { url: c.url } : {}),
        ...(c?.bitmap ? { width: c.bitmap.width, height: c.bitmap.height } : {}),
        ...(old?.align ? { align: old.align } : {}),
        ...(c?.det ? { expression: expressionFromBlendshapes(c.det.blendshapes) } : {}),
      };
    });
    const compare = prev.compare && items.some((i) => i.id === prev.compare!.refId) ? prev.compare : null;
    this.store.setState({ items, compare });
    for (const it of items) if (it.status === 'loading') void this.load(p.id, it.file);
    this.scheduleAlign();
  }

  private load(portraitId: string, file: string): Promise<void> {
    const key = this.key(portraitId, file);
    const running = this.jobs.get(key);
    if (running) return running;
    const job = (async () => {
      let entry: Loaded;
      try {
        entry = await this.analyze(await this.studio.storage.loadRef(portraitId, file));
      } catch (e) {
        entry = { bitmap: null, url: '', det: null, error: (e as Error).message };
      }
      this.cache.set(key, entry);
      this.jobs.delete(key);
      if (this.studio.doc.getState().portrait.id === portraitId) this.sync();
    })();
    this.jobs.set(key, job);
    return job;
  }

  private async analyze(blob: Blob): Promise<Loaded> {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const { detectFace } = await import('./mediapipe.ts');
    const det = await detectFace(bitmap);
    return { bitmap, url: URL.createObjectURL(blob), det };
  }

  /** Wait until every reference of the open portrait is loaded and analysed. */
  async settle(): Promise<void> {
    const p = this.studio.doc.getState().portrait;
    await Promise.all(p.references.map((r) => (this.cache.has(this.key(p.id, r.file)) ? null : this.load(p.id, r.file))));
  }

  /** Store a photo with the portrait, analyse it and record it (one undoable step). */
  async add(input: Blob, o: { note?: string; source?: CommandSource } = {}): Promise<RefItem> {
    const p = this.studio.doc.getState().portrait;
    this.store.setState({ busy: 'adding' });
    try {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(input, { imageOrientation: 'from-image' });
      } catch {
        throw new Error('無法讀取這張圖片（支援 JPEG、PNG、WebP）');
      }
      const exif = input.type === 'image/jpeg' || !input.type ? readExif(await input.arrayBuffer()) : null;
      const focal35 = trustedFocal35(exif, bitmap.width, bitmap.height);
      const image = await normalizeImage(input, bitmap);
      bitmap.close();
      const { refId, file } = await this.studio.storage.saveRef(p.id, image);
      this.cache.set(this.key(p.id, file), await this.analyze(image));
      const r = this.studio.runAs(o.source ?? 'ui', [{ cmd: 'portrait.addReference', args: { id: refId, file, note: o.note ?? '', focal35 } }]);
      if (!r.ok) throw new Error(r.error.message);
      this.sync();
      this.alignNow();
      return this.item(refId);
    } finally {
      this.store.setState({ busy: null });
    }
  }

  remove(refId: string, source: CommandSource = 'ui') {
    const r = this.studio.runAs(source, [{ cmd: 'portrait.removeReference', args: { id: refId } }]);
    if (!r.ok) throw new Error(r.error.message);
  }

  item(refId: string): RefItem {
    const it = this.store.getState().items.find((i) => i.id === refId);
    if (!it) {
      const ids = this.store.getState().items.map((i) => i.id);
      throw Object.assign(new Error(`no reference photo "${refId}"`), { code: 'NOT_FOUND', hint: ids.length ? `References: ${ids.join(', ')}` : 'This portrait has no reference photos yet.' });
    }
    return it;
  }

  private detection(it: RefItem): FaceDetection {
    const p = this.studio.doc.getState().portrait;
    const c = this.cache.get(this.key(p.id, it.file));
    if (!c?.det) throw Object.assign(new Error(it.status === 'noface' ? `no face found in reference photo ${it.id}` : `reference photo ${it.id} is ${it.status}${it.error ? `: ${it.error}` : ''}`), { code: 'NOT_READY' });
    return c.det;
  }

  private observation(it: RefItem): Observation {
    return { ...this.detection(it), focal35: it.focal35 };
  }

  scheduleAlign() {
    if (this.alignTimer) clearTimeout(this.alignTimer);
    this.alignTimer = setTimeout(() => this.alignNow(), 250);
  }

  /** Camera and errors of the current parameters for every analysed photo. */
  alignNow() {
    if (!this.studio.builder) return;
    const params = this.studio.doc.getState().portrait.params;
    const model = this.landmarkModel();
    const items = this.store.getState().items.map((it) => {
      if (it.status !== 'ready') return it;
      const a = alignPhoto(model, params, this.observation(it));
      return { ...it, align: { error: a.error, outline: a.outlineError, camera: a.info } };
    });
    this.store.setState({ items });
  }

  /** The portrait rendered with the photo's camera next to the photo, plus measured differences. */
  async compare(refId: string, o: { size?: number; frame?: CompareFrame } = {}): Promise<CompareView> {
    // Without an explicit frame, keep the one the open compare view uses (the UI's re-compare).
    const frame: CompareFrame = o.frame ?? this.store.getState().compare?.frame ?? 'face';
    await this.settle();
    const it = this.item(refId);
    const det = this.detection(it);
    const p = this.studio.doc.getState().portrait;
    const bitmap = this.cache.get(this.key(p.id, it.file))!.bitmap!;
    const viewer = this.studio.viewer;
    if (!viewer) throw new Error('3D view is not ready yet');
    const model = this.landmarkModel();
    this.store.setState({ busy: 'compare' });
    try {
      const a = alignPhoto(model, p.params, this.observation(it));
      // crop (4:5) around the face, a little larger than the landmarks — or, for "head", larger and
      // higher so the crown, the ears and the head outline are in the picture
      const P = det.points;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < 468; k++) {
        x0 = Math.min(x0, P[k * 3]!);
        x1 = Math.max(x1, P[k * 3]!);
        y0 = Math.min(y0, P[k * 3 + 1]!);
        y1 = Math.max(y1, P[k * 3 + 1]!);
      }
      const ch = Math.max((x1 - x0) * 1.25, y1 - y0) * (frame === 'head' ? 2 : 1.45);
      const cw = ch * 0.8;
      const crop = { x: (x0 + x1) / 2 - cw / 2, y: (y0 + y1) / 2 - ch / 2 - (y1 - y0) * (frame === 'head' ? 0.22 : 0.04), w: cw, h: ch };
      const H = Math.max(320, Math.min(1400, Math.round(o.size ?? 720)));
      const W = Math.round(H * 0.8);
      // the portrait in the frame the camera was fitted in (no height / heads-tall / head turn)
      let render: HTMLCanvasElement;
      try {
        await this.studio.preview(alignedParams(p.params), { framing: 'full' });
        render = viewer.renderPinhole({ R: cameraRotation(a.cam), t: a.cam.t, f: a.cam.f }, [det.width, det.height], crop, [W, H], { transparent: true }).canvas;
      } finally {
        await this.studio.preview(null);
      }
      const photo = document.createElement('canvas');
      photo.width = W;
      photo.height = H;
      const g = photo.getContext('2d')!;
      g.fillStyle = '#111';
      g.fillRect(0, 0, W, H);
      g.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
      const s = W / crop.w;
      const at = (x: number, y: number): [number, number] => [r2((x - crop.x) * s), r2((y - crop.y) * s)];
      const points: ComparePoints = {
        photo: model.ks.map((_, i) => at(a.uv[i * 2]!, a.uv[i * 2 + 1]!)),
        model: model.ks.map((_, i) => at(a.proj[i * 2]!, a.proj[i * 2 + 1]!)),
        outlinePhoto: a.outline.map((c) => at(...c.photo)),
        outlineModel: a.outline.map((c) => at(...c.model)),
      };
      const view: CompareView = { refId, size: [W, H], frame, photo: photo.toDataURL('image/jpeg', 0.9), render: render.toDataURL('image/png'), points, report: this.report(it, det, a, model), params: p.params };
      this.store.setState({ compare: view });
      return view;
    } finally {
      this.store.setState({ busy: null });
    }
  }

  private report(it: RefItem, det: FaceDetection, a: ReturnType<typeof alignPhoto>, model: LandmarkModel): CompareReport {
    const errs = new Map<string, number[]>();
    model.ks.forEach((k, i) => {
      const e = (Math.hypot(a.uv[i * 2]! - a.proj[i * 2]!, a.uv[i * 2 + 1]! - a.proj[i * 2 + 1]!) / a.iod) * 100;
      const region = REGIONS.find(([, set]) => set.has(k))?.[0] ?? '臉部其他';
      errs.set(region, [...(errs.get(region) ?? []), e]);
    });
    const index = new Map(model.ks.map((k, i) => [k, i]));
    const outline = new Map(a.outline.map((c) => [c.k, c]));
    // a point on the photo / on the model by landmark ("o…" = the outline)
    const photoAt = (k: number | `o${number}`): [number, number] | null => {
      const n = typeof k === 'number' ? k : Number(k.slice(1));
      return [det.points[n * 3]!, det.points[n * 3 + 1]!];
    };
    const modelAt = (k: number | `o${number}`): [number, number] | null => {
      if (typeof k === 'number') {
        const i = index.get(k);
        return i === undefined ? null : [a.proj[i * 2]!, a.proj[i * 2 + 1]!];
      }
      return outline.get(Number(k.slice(1)))?.model ?? null;
    };
    const measures: CompareMeasure[] = [];
    for (const m of MEASURES) {
      let ph = 0, mo = 0, ok = true;
      for (const [u, v] of m.pairs) {
        const pu = photoAt(u), pv = photoAt(v), mu = modelAt(u), mv = modelAt(v);
        if (!pu || !pv || !mu || !mv) {
          ok = false;
          break;
        }
        ph += Math.hypot(pu[0] - pv[0], pu[1] - pv[1]) / m.pairs.length;
        mo += Math.hypot(mu[0] - mv[0], mu[1] - mv[1]) / m.pairs.length;
      }
      if (!ok || mo <= 0) continue;
      measures.push({ key: m.key, label: m.label, photo: Math.round((ph / a.iod) * 1000) / 1000, model: Math.round((mo / a.iod) * 1000) / 1000, diff: Math.round((ph / mo - 1) * 1000) / 10 });
    }
    return {
      refId: it.id,
      note: it.note,
      error: a.error,
      outline: a.outlineError,
      regions: Object.fromEntries([...errs].map(([k, v]) => [k, r2(median(v))])),
      camera: a.info,
      measures,
      expression: expressionFromBlendshapes(det.blendshapes),
    };
  }

  /**
   * Fit the face parameters to the analysed photos (all, or `refIds`). Applies the result as one
   * undoable portrait.set unless dryRun.
   */
  async fit(o: { refIds?: string[]; groups?: ParamGroup[]; keys?: string[]; expression?: 'estimate' | 'neutral' | 'keep'; lambda?: number; iterations?: number; outline?: boolean; dryRun?: boolean; source?: CommandSource } = {}): Promise<FitSummary> {
    await this.settle();
    const p = this.studio.doc.getState().portrait;
    for (const id of o.refIds ?? []) this.item(id);
    const items = this.store.getState().items.filter((i) => i.status === 'ready' && (!o.refIds || o.refIds.includes(i.id)));
    if (!items.length) throw Object.assign(new Error('no analysed reference photo with a face'), { code: 'NO_PHOTOS', hint: 'Add a photo where the face is visible (portrait.addReference / portrait_add_reference).' });
    const photos = items.map((it) => this.observation(it));
    this.store.setState({ busy: 'fit' });
    await new Promise((r) => setTimeout(r, 30)); // let the UI show it
    try {
      const t0 = performance.now();
      const res = fitPortrait(this.landmarkModel(), p.params, photos, { groups: o.groups, keys: o.keys, expression: o.expression, lambda: o.lambda, iterations: o.iterations, contour: !!o.outline });
      const patch: Record<string, number | null> = {};
      for (const k of new Set([...Object.keys(p.params), ...Object.keys(res.params)])) {
        const before = p.params[k] ?? null, after = res.params[k] ?? null;
        if (before !== after) patch[k] = after;
      }
      let applied = false;
      if (!o.dryRun && Object.keys(patch).length) {
        const r = this.studio.runAs(o.source ?? 'ui', [{ cmd: 'portrait.set', args: { params: patch } }]);
        if (!r.ok) throw new Error(r.error.message);
        applied = true;
      }
      const summary: FitSummary = {
        applied,
        refIds: items.map((i) => i.id),
        changed: res.changed,
        photos: res.photos.map((ph, i) => ({ refId: items[i]!.id, ...ph })),
        error: res.error,
        outline: res.outline,
        iterations: res.iterations,
        patch,
        ms: Math.round(performance.now() - t0),
      };
      this.store.setState({ fit: summary });
      return summary;
    } finally {
      this.store.setState({ busy: null });
    }
  }

  closeCompare() {
    this.store.setState({ compare: null });
  }
}
