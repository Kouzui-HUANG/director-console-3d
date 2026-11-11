/** Contact sheets: the storyboard (frames over time) and the camera sheet (every camera at one time). */
import type { CameraView } from '../core/describe.ts';
import { programCameraAt } from '../core/evaluate.ts';
import type { Project } from '../core/schema.ts';
import type { OffscreenShots } from '../render/offscreen.ts';
import { lensText, timecode } from './burnin.ts';
import { drawFrameLabels, UI_FONT } from './overlay.ts';

/** Returns the label data for a camera at a time (cameraView + occlusion), or null. */
export type LabelViewFn = (camera: string, t: number) => CameraView | null;

export interface StoryboardOptions {
  camera?: string;
  times?: number[];
  count?: number;
  columns?: number;
  thumbWidth?: number;
  /** Draw object ids / boxes on every frame. */
  labelView?: LabelViewFn;
}

export interface CameraSheetOptions {
  time: number;
  cameras: string[];
  columns?: number;
  thumbWidth?: number;
  labelView?: LabelViewFn;
}

interface SheetCell {
  t: number;
  camera: string;
  /** Short colored tag before the caption ("#3", "camA"). */
  tag: (cameraId: string | null) => string;
  tagColor: string;
  caption: (cameraId: string | null) => string;
  border?: string;
}

/** One frame per shot (middle of each cut) if there are cuts, otherwise evenly spaced. */
export function storyboardTimes(project: Project, camera: string, count?: number): number[] {
  const d = project.settings.duration;
  if (camera === 'program' && project.cuts.length > 1 && !count) {
    const cuts = [...project.cuts].sort((a, b) => a.t - b.t);
    return cuts.map((c, i) => {
      const end = cuts[i + 1]?.t ?? d;
      return Math.min(d, (c.t + end) / 2);
    });
  }
  const n = Math.max(1, Math.min(48, count ?? 8));
  return Array.from({ length: n }, (_, i) => (d * (i + 0.5)) / n);
}

function renderSheet(project: Project, shots: OffscreenShots, title: string, cells: SheetCell[], opts: { columns?: number; thumbWidth?: number; labelView?: LabelViewFn }): HTMLCanvasElement {
  const cols = Math.max(1, Math.min(opts.columns ?? (cells.length <= 4 ? cells.length : 4), 8));
  const rows = Math.ceil(cells.length / cols);
  const [rw, rh] = project.settings.resolution;
  const tw = Math.max(160, Math.min(960, opts.thumbWidth ?? 420));
  const th = Math.round((tw * rh) / rw / 2) * 2;
  const label = 30;
  const gap = 12;
  const header = 44;
  const canvas = document.createElement('canvas');
  canvas.width = cols * tw + (cols + 1) * gap;
  canvas.height = header + rows * (th + label) + (rows + 1) * gap;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f2f2f2';
  ctx.font = `600 20px ${UI_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(title, gap, header / 2 + 4);
  try {
    cells.forEach((cell, i) => {
      const cx = gap + (i % cols) * (tw + gap);
      const cy = header + gap + Math.floor(i / cols) * (th + label + gap);
      const camId = cell.camera === 'program' ? programCameraAt(project, cell.t) : cell.camera;
      const frame = shots.render(project, cell.t, camId ?? 'program', tw, th, 'preview');
      ctx.drawImage(frame.canvas, cx, cy, tw, th);
      if (opts.labelView && frame.cameraId) {
        const view = opts.labelView(frame.cameraId, cell.t);
        if (view) drawFrameLabels(ctx, project, view, { x: cx, y: cy, w: tw, h: th }, { size: 12 });
      }
      ctx.strokeStyle = cell.border ?? '#2c3036';
      ctx.lineWidth = cell.border ? 3 : 1;
      ctx.strokeRect(cx + 0.5, cy + 0.5, tw - 1, th - 1);
      ctx.lineWidth = 1;
      ctx.font = `13px ${UI_FONT}`;
      ctx.textBaseline = 'middle';
      const tag = cell.tag(frame.cameraId);
      ctx.fillStyle = cell.tagColor;
      ctx.font = `600 13px ${UI_FONT}`;
      ctx.fillText(tag, cx, cy + th + label / 2);
      const tagW = Math.max(34, ctx.measureText(tag).width + 10);
      ctx.font = `13px ${UI_FONT}`;
      ctx.fillStyle = '#d7dbe0';
      ctx.fillText(cell.caption(frame.cameraId), cx + tagW, cy + th + label / 2, tw - tagW - 2);
    });
  } finally {
    shots.restore();
  }
  return canvas;
}

export function renderStoryboard(project: Project, shots: OffscreenShots, opts: StoryboardOptions = {}): HTMLCanvasElement {
  const camera = opts.camera ?? 'program';
  const times = opts.times?.length ? opts.times : storyboardTimes(project, camera, opts.count);
  const cells: SheetCell[] = times.map((t, i) => ({
    t,
    camera,
    tag: () => `#${i + 1}`,
    tagColor: '#ffd23f',
    caption: (camId) => {
      const cam = project.objects.find((o) => o.id === camId);
      const marker = [...project.markers].reverse().find((m) => m.t <= t + 1e-6);
      return `${timecode(t, project.settings.fps)}  ${cam ? cam.name || cam.id : ''}${marker ? `  「${marker.label}」` : ''}`;
    },
  }));
  return renderSheet(project, shots, `${project.name} — 分鏡表`, cells, opts);
}

/** Every camera (or the given ones) at one time, side by side; the LIVE camera is outlined in red. */
export function renderCameraSheet(project: Project, shots: OffscreenShots, opts: CameraSheetOptions): HTMLCanvasElement {
  const live = programCameraAt(project, opts.time);
  const cells: SheetCell[] = opts.cameras.map((id) => {
    const cam = project.objects.find((o) => o.id === id)!;
    const isLive = id === live;
    return {
      t: opts.time,
      camera: id,
      tag: () => (isLive ? `${id} LIVE` : id),
      tagColor: isLive ? '#ff6b6b' : '#ffd23f',
      caption: () => `${lensText(project, cam, opts.time)}${cam.name ? `  ${cam.name}` : ''}`,
      border: isLive ? '#ff4d4d' : undefined,
    };
  });
  return renderSheet(project, shots, `${project.name} — 機位總覽 @ ${timecode(opts.time, project.settings.fps)}`, cells, opts);
}
