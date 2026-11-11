/** Text overlays drawn onto exported frames (timecode, camera, lens). */
import { evaluateCamera } from '../core/evaluate.ts';
import { equivalentFocal } from '../core/lens.ts';
import type { Project, SceneObject } from '../core/schema.ts';

export interface BurnIn {
  timecode: boolean;
  camera: boolean;
  lens: boolean;
  title: boolean;
}

export function timecode(t: number, fps: number): string {
  const total = Math.round(t * fps);
  const f = total % fps;
  const s = Math.floor(total / fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

/** "35mm (≈50mm)", "魚眼 180°" or "360°" for a camera at time t. */
export function lensText(project: Project, cam: SceneObject, t: number): string {
  const ev = evaluateCamera(project, cam, t);
  return ev.lens === 'standard' ? `${Math.round(ev.focalLength)}mm (≈${Math.round(equivalentFocal(ev.focalLength, ev.sensor))}mm)` : ev.lens === 'fisheye' ? `魚眼 ${Math.round(ev.fisheye.fov)}°` : '360°';
}

export function drawBurnIn(ctx: CanvasRenderingContext2D, project: Project, t: number, cameraId: string | null, opts: BurnIn): void {
  const { width: w, height: h } = ctx.canvas;
  const size = Math.max(12, Math.round(Math.min(w, h) * 0.034));
  ctx.save();
  ctx.font = `600 ${size}px -apple-system, "Segoe UI", "Noto Sans TC", "PingFang TC", sans-serif`;
  ctx.textBaseline = 'top';
  const pad = Math.round(size * 0.45);
  const box = (text: string, x: number, y: number, align: 'left' | 'right') => {
    const m = ctx.measureText(text).width;
    const bx = align === 'left' ? x : x - m - pad * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, y, m + pad * 2, size + pad * 1.4);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, bx + pad, y + pad * 0.7);
  };
  const cam = cameraId ? project.objects.find((o) => o.id === cameraId) : undefined;
  const left: string[] = [];
  if (opts.camera && cam) left.push(cam.name || cam.id);
  if (opts.lens && cam) left.push(lensText(project, cam, t));
  const margin = Math.round(size * 0.8);
  if (left.length) box(left.join('  ·  '), margin, margin, 'left');
  if (opts.timecode) box(timecode(t, project.settings.fps), w - margin, margin, 'right');
  if (opts.title) box(project.name, margin, h - margin - size - pad * 1.4, 'left');
  ctx.restore();
}
