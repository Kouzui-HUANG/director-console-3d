/**
 * Frame-accurate offline video export: every frame t = i / fps is rendered exactly,
 * then encoded with WebCodecs through Mediabunny. Slow machines just take longer.
 * Codec ladder: H.264 (avc) → VP9 → AV1 in MP4, then VP9/VP8 in WebM.
 */
import { programCameraAt } from '../core/evaluate.ts';
import type { Project } from '../core/schema.ts';
import type { OffscreenShots } from '../render/offscreen.ts';
import { drawBurnIn, type BurnIn } from './burnin.ts';

export type ExportQuality = 'draft' | 'standard' | 'high';

export interface VideoExportOptions {
  /** "program" follows the cut list; otherwise a camera id. */
  source: string;
  start: number;
  end: number;
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  burnIn: BurnIn;
  onProgress?: (p: { frame: number; total: number; fraction: number; etaSec: number }) => void;
  signal?: AbortSignal;
}

export interface VideoExportResult {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
  codec: string;
  frames: number;
  duration: number;
  width: number;
  height: number;
  seconds: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super('export cancelled');
  }
}

export async function exportVideo(project: Project, shots: OffscreenShots, opts: VideoExportOptions): Promise<VideoExportResult> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('這個瀏覽器不支援 WebCodecs，無法輸出影片。請使用最新版 Chrome。');
  }
  const mb = await import('mediabunny');
  const width = Math.max(16, Math.round(opts.width / 2) * 2);
  const height = Math.max(16, Math.round(opts.height / 2) * 2);
  const level = opts.quality === 'draft' ? 'medium' : opts.quality === 'high' ? 'very-high' : 'high';
  const quality = new mb.Quality(level);
  let codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height, quality, frameRate: opts.fps });
  let container: 'mp4' | 'webm' = 'mp4';
  if (!codec) {
    codec = await mb.getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height, quality, frameRate: opts.fps });
    container = 'webm';
  }
  if (!codec) throw new Error(`這台電腦的瀏覽器無法以 ${width}×${height} 編碼影片，請降低解析度再試。`);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new mb.Output({
    format: container === 'mp4' ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(),
    target: new mb.BufferTarget(),
  });
  const source = new mb.CanvasSource(canvas, { codec, quality, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: opts.fps });
  await output.start();

  const fps = opts.fps;
  const startFrame = Math.round(opts.start * fps);
  const endFrame = Math.max(startFrame + 1, Math.round(opts.end * fps));
  const total = endFrame - startFrame;
  const began = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw new ExportCancelled();
      const t = (startFrame + i) / fps;
      const cameraId = opts.source === 'program' ? programCameraAt(project, t) : opts.source;
      const frame = shots.render(project, t, cameraId ?? 'program', width, height, 'export');
      ctx.drawImage(frame.canvas, 0, 0, width, height);
      if (opts.burnIn.timecode || opts.burnIn.camera || opts.burnIn.lens || opts.burnIn.title) drawBurnIn(ctx, project, t, frame.cameraId, opts.burnIn);
      await source.add(i / fps, 1 / fps);
      if (opts.onProgress && (i % 3 === 0 || i === total - 1)) {
        const elapsed = (performance.now() - began) / 1000;
        const fraction = (i + 1) / total;
        opts.onProgress({ frame: i + 1, total, fraction, etaSec: fraction > 0 ? (elapsed / fraction) * (1 - fraction) : 0 });
      }
    }
    source.close();
    await output.finalize();
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    shots.restore();
  }
  const buffer = (output.target as InstanceType<typeof mb.BufferTarget>).buffer;
  if (!buffer) throw new Error('影片封裝失敗');
  const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
  return {
    blob: new Blob([buffer], { type: mime }),
    mime,
    ext: container,
    codec,
    frames: total,
    duration: total / fps,
    width,
    height,
    seconds: (performance.now() - began) / 1000,
  };
}

/** Read an exported file back and report what is inside (used by tests / agents). */
export async function probeVideo(blob: Blob): Promise<{ duration: number; codec: string | null; packets: number; width: number; height: number }> {
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const duration = await input.computeDuration();
  const track = await input.getPrimaryVideoTrack();
  if (!track) return { duration, codec: null, packets: 0, width: 0, height: 0 };
  const stats = await track.computePacketStats();
  return { duration, codec: (await track.getCodecParameterString()) ?? track.codec ?? null, packets: stats.packetCount, width: track.displayWidth, height: track.displayHeight };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function safeFilename(name: string): string {
  return (name || 'director3d').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}
