/**
 * Labels drawn over rendered frames (and used by the plan view) so an AI — or a person —
 * can tell which shape in an image is which object id.
 */
import { isCharacterType } from '../core/assetTypes.ts';
import { isBackgroundView, type CameraView } from '../core/describe.ts';
import type { Project } from '../core/schema.ts';

export const UI_FONT = '-apple-system, "Segoe UI", "Noto Sans TC", "PingFang TC", sans-serif';

/** Canvas rectangle, top-left origin, pixels. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TagStyle {
  fg: string;
  bg?: string;
  bold?: boolean;
  /** Font size override (px). */
  size?: number;
}

const overlaps = (a: PixelRect, b: PixelRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Draws small text tags, nudging each one up/down so it does not cover an earlier tag. */
export class TagPlacer {
  private placed: PixelRect[] = [];
  private ctx: CanvasRenderingContext2D;
  private bounds: PixelRect;
  private size: number;

  constructor(ctx: CanvasRenderingContext2D, bounds: PixelRect, size: number) {
    this.ctx = ctx;
    this.bounds = bounds;
    this.size = size;
  }

  /** Reserve an area (e.g. a title box) so tags avoid it. */
  reserve(r: PixelRect): void {
    this.placed.push(r);
  }

  /** Draw `text` with its top-left at (x, y), or centered on (x, y) with align "center". */
  tag(text: string, x: number, y: number, style: TagStyle, align: 'left' | 'center' = 'left'): PixelRect {
    const ctx = this.ctx;
    const size = style.size ?? this.size;
    ctx.font = `${style.bold ? '600 ' : ''}${size}px ${UI_FONT}`;
    const pad = Math.max(2, Math.round(size * 0.3));
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    const h = Math.round(size * 1.35);
    const b = this.bounds;
    const sx = align === 'center' ? x - w / 2 : x;
    const sy = align === 'center' ? y - h / 2 : y;
    const cx = Math.max(b.x, Math.min(b.x + b.w - w, sx));
    const cy = (v: number) => Math.max(b.y, Math.min(b.y + b.h - h, v));
    let r: PixelRect = { x: cx, y: cy(sy), w, h };
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const cand = { x: cx, y: cy(sy + k * (h + 1)), w, h };
      if (!this.placed.some((p) => overlaps(p, cand))) {
        r = cand;
        break;
      }
    }
    this.placed.push(r);
    ctx.fillStyle = style.bg ?? 'rgba(0,0,0,0.68)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = style.fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, r.x + pad, r.y + r.h / 2 + 0.5);
    return r;
  }
}

const SUBJECT = '#ffd23f';
const PROP = '#5ad1ff';

/**
 * Draw object ids, frame boxes, shot sizes and occlusion over a rendered camera frame.
 * `view` comes from cameraView() (optionally with occlusion filled in); `rect` is where the
 * frame sits on the canvas. Boxes match what view_camera reports.
 */
export function drawFrameLabels(ctx: CanvasRenderingContext2D, project: Project, view: CameraView, rect: PixelRect, opts: { size?: number } = {}): void {
  const size = opts.size ?? Math.max(11, Math.min(22, Math.round(rect.w * 0.018)));
  const typeOf = (id: string) => project.objects.find((o) => o.id === id)?.type ?? '';
  const items = view.objects.map((v) => {
    const type = typeOf(v.id);
    return { v, type, character: isCharacterType(type), background: isBackgroundView(type, v) };
  });
  const toPx = (b: [number, number, number, number]) => ({ x: rect.x + b[0] * rect.w, y: rect.y + b[1] * rect.h, w: (b[2] - b[0]) * rect.w, h: (b[3] - b[1]) * rect.h });

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  // Boxes first, so every tag ends up on top.
  for (const it of items) {
    if (it.background || !it.v.box) continue;
    const b = toPx(it.v.box);
    ctx.strokeStyle = it.character ? SUBJECT : PROP;
    ctx.lineWidth = Math.max(1.5, size / 8);
    ctx.setLineDash((it.v.occluded ?? 0) >= 0.5 ? [6, 4] : []);
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
  }
  ctx.setLineDash([]);

  const tags = new TagPlacer(ctx, rect, size);
  // Scenery goes in one line along the bottom edge instead of on top of the subjects.
  const background = items.filter((i) => i.background).map((i) => i.v.id);
  if (background.length) {
    const small = Math.max(10, size - 2);
    const text = `background: ${background.slice(0, 8).join(', ')}${background.length > 8 ? ', …' : ''}`;
    tags.tag(text, rect.x + 2, rect.y + rect.h - Math.round(small * 1.35) - 2, { fg: '#c9ced6', bg: 'rgba(0,0,0,0.55)', size: small });
  }
  const ordered = [...items.filter((i) => i.character), ...items.filter((i) => !i.character && !i.background)];
  for (const it of ordered) {
    if (!it.v.box) continue;
    const b = toPx(it.v.box);
    const occ = it.v.occluded ?? 0;
    // Same wording as describe_scene: an edge-cut shoulder in front of the subject is not an ECU.
    const shot = it.v.foreground ? 'foreground' : it.v.shot;
    const text = [it.v.id, shot, occ >= 0.3 ? `${Math.round(occ * 100)}% hidden` : ''].filter(Boolean).join(' · ');
    const h = Math.round(size * 1.35);
    tags.tag(text, b.x, b.y - h - 2 >= rect.y ? b.y - h - 2 : b.y + 2, { fg: it.character ? SUBJECT : PROP, bold: it.character });
  }
  ctx.restore();
}
