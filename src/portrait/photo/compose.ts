/** Comparison images (photo vs. the portrait seen by the photo's camera) for agents and downloads. */
import type { CompareView } from './references.ts';

export type CompareMode = 'side' | 'overlay' | 'landmarks' | 'all';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode the comparison image'));
    img.src = src;
  });
}

const BG = '#2a2d32';
const FONT = '-apple-system, "PingFang TC", "Noto Sans TC", sans-serif';

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number) {
  g.font = `600 15px ${FONT}`;
  const w = g.measureText(text).width + 16;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(x + 8, y + 8, w, 26);
  g.fillStyle = '#fff';
  g.fillText(text, x + 16, y + 26);
}

/** One panel: the photo with landmarks — photo (green) vs. model (red), outline photo (cyan) vs. silhouette (orange). */
function drawLandmarks(g: CanvasRenderingContext2D, v: CompareView, photo: HTMLImageElement, render: HTMLImageElement, x: number) {
  const [W, H] = v.size;
  g.fillStyle = '#000';
  g.fillRect(x, 0, W, H);
  g.globalAlpha = 0.5;
  g.drawImage(photo, x, 0, W, H);
  g.globalAlpha = 0.22;
  g.drawImage(render, x, 0, W, H);
  g.globalAlpha = 1;
  const { photo: ph, model: mo, outlinePhoto: op, outlineModel: om } = v.points;
  g.lineWidth = 1.2;
  g.strokeStyle = 'rgba(255,90,70,0.9)';
  g.beginPath();
  ph.forEach((p, i) => {
    g.moveTo(x + mo[i]![0], mo[i]![1]);
    g.lineTo(x + p[0], p[1]);
  });
  om.forEach((p, i) => {
    g.moveTo(x + p[0], p[1]);
    g.lineTo(x + op[i]![0], op[i]![1]);
  });
  g.stroke();
  const dots = (pts: [number, number][], color: string, r: number) => {
    g.fillStyle = color;
    for (const p of pts) {
      g.beginPath();
      g.arc(x + p[0], p[1], r, 0, Math.PI * 2);
      g.fill();
    }
  };
  dots(ph, '#4be08a', 1.8);
  dots(mo, '#ff5a46', 1.8);
  if (op.length > 1) {
    g.strokeStyle = '#3cc8ff';
    g.lineWidth = 2;
    g.beginPath();
    op.forEach((p, i) => (i ? g.lineTo(x + p[0], p[1]) : g.moveTo(x + p[0], p[1])));
    g.stroke();
    g.strokeStyle = '#ffa53c';
    g.beginPath();
    om.forEach((p, i) => (i ? g.lineTo(x + p[0], p[1]) : g.moveTo(x + p[0], p[1])));
    g.stroke();
  }
}

export async function composeCompare(v: CompareView, mode: CompareMode = 'all', opacity = 0.5): Promise<HTMLCanvasElement> {
  const [W, H] = v.size;
  const [photo, render] = await Promise.all([loadImage(v.photo), loadImage(v.render)]);
  const panels = mode === 'all' ? ['side', 'model', 'overlay', 'landmarks'] : mode === 'side' ? ['side', 'model'] : [mode];
  const footer = 30;
  const c = document.createElement('canvas');
  c.width = W * panels.length;
  c.height = H + footer;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1d1f23';
  g.fillRect(0, 0, c.width, c.height);
  panels.forEach((p, i) => {
    const x = i * W;
    if (p === 'side') {
      g.drawImage(photo, x, 0, W, H);
      label(g, '照片', x, 0);
    } else if (p === 'model') {
      g.fillStyle = BG;
      g.fillRect(x, 0, W, H);
      g.drawImage(render, x, 0, W, H);
      label(g, '人像（照片的相機）', x, 0);
    } else if (p === 'overlay') {
      g.drawImage(photo, x, 0, W, H);
      g.globalAlpha = Math.max(0, Math.min(1, opacity));
      g.drawImage(render, x, 0, W, H);
      g.globalAlpha = 1;
      label(g, `疊合 ${Math.round(opacity * 100)}%`, x, 0);
    } else {
      drawLandmarks(g, v, photo, render, x);
      label(g, '特徵點：綠＝照片 紅＝人像', x, 0);
    }
  });
  const r = v.report;
  g.fillStyle = '#c9ced6';
  g.font = `13px ${FONT}`;
  const cam = r.camera;
  const worst = [...r.measures].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 3).map((m) => `${m.label}${m.diff > 0 ? '+' : ''}${m.diff}%`);
  g.fillText(`特徵點誤差 ${r.error}%${r.outline !== null ? `・輪廓 ${r.outline}%` : ''}（瞳距的百分比）・頭轉 ${cam.yaw}°・俯仰 ${cam.pitch}°・焦距約 ${cam.focal35mm} mm・照片比人像：${worst.join('、') || '—'}`, 10, H + 20);
  return c;
}
