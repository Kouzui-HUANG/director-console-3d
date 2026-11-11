/**
 * Plan view (top-down floor plan) drawn with Canvas 2D from planModel(): footprints labelled
 * with ids, characters with facing arrows, camera field-of-view wedges (LIVE in red), motion
 * paths with key times, a metric grid, scale bar and north arrow. No WebGL needed.
 */
import { planModel, type PlanArea, type PlanModel, type PlanShape, type XZ } from '../core/plan.ts';
import type { Project } from '../core/schema.ts';
import { TagPlacer, UI_FONT } from './overlay.ts';

export interface PlanViewOptions {
  time: number;
  area?: PlanArea;
  width?: number;
  paths?: boolean;
}

const LIVE = '#ff4d4d';
/** Magenta, so paths never look like the (often yellow) camera wedges. */
const PATH = '#e879f9';

function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(200,200,200,${a})`;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function fmtTime(t: number): string {
  return `${Math.round(t * 100) / 100}s`;
}

function fmtMeters(v: number): string {
  return `${Math.round(v * 100) / 100}`;
}

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, size: number) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * size - uy * size * 0.55, y - uy * size + ux * size * 0.55);
  ctx.lineTo(x - ux * size + uy * size * 0.55, y - uy * size - ux * size * 0.55);
  ctx.closePath();
  ctx.fill();
}

export function renderPlanView(project: Project, opts: PlanViewOptions): { canvas: HTMLCanvasElement; model: PlanModel } {
  const model = planModel(project, opts.time, { area: opts.area, paths: opts.paths });
  const [x0, z0, x1, z1] = model.area;
  const W = Math.max(320, Math.min(3000, Math.round(opts.width ?? 1024)));
  const ppm = W / (x1 - x0);
  const H = Math.max(200, Math.round((z1 - z0) * ppm));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const px = (p: XZ): [number, number] => [(p[0] - x0) * ppm, (p[1] - z0) * ppm];
  const size = Math.max(11, Math.min(22, Math.round(W * 0.0125)));
  const tags = new TagPlacer(ctx, { x: 0, y: 0, w: W, h: H }, size);

  // Background and grid (−Z / north is up, +X / east is right).
  ctx.fillStyle = '#1a1d21';
  ctx.fillRect(0, 0, W, H);
  const step = model.grid;
  const labelEvery = Math.max(1, Math.ceil(36 / (step * ppm)));
  ctx.font = `${Math.round(size * 0.8)}px ${UI_FONT}`;
  ctx.textBaseline = 'top';
  const line = (ax: number, ay: number, bx: number, by: number, color: string, width = 1) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };
  for (let k = Math.ceil(x0 / step); k * step <= x1; k++) {
    const v = Math.round(k * step * 1e6) / 1e6;
    const x = Math.round((v - x0) * ppm) + 0.5;
    line(x, 0, x, H, v === 0 ? '#3b7bb5' : k % 5 === 0 ? '#353b44' : '#272c33', v === 0 ? 1.5 : 1);
    if (k % labelEvery === 0) {
      ctx.fillStyle = '#7d8590';
      ctx.fillText(`x ${fmtMeters(v)}`, x + 3, H - Math.round(size * 1.1));
    }
  }
  for (let k = Math.ceil(z0 / step); k * step <= z1; k++) {
    const v = Math.round(k * step * 1e6) / 1e6;
    const y = Math.round((v - z0) * ppm) + 0.5;
    line(0, y, W, y, v === 0 ? '#b5523b' : k % 5 === 0 ? '#353b44' : '#272c33', v === 0 ? 1.5 : 1);
    if (k % labelEvery === 0) {
      ctx.fillStyle = '#7d8590';
      ctx.fillText(`z ${fmtMeters(v)}`, 3, y + 2);
    }
  }

  // Shapes (terrain first, characters last).
  const drawPoly = (s: PlanShape) => {
    const pts = s.polygon.map(px);
    ctx.beginPath();
    if (s.round) {
      const [a, b, , d] = pts as [[number, number], [number, number], [number, number], [number, number]];
      const [cx, cy] = px(s.center);
      ctx.ellipse(cx, cy, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(d[0] - a[0], d[1] - a[1]) / 2, Math.atan2(b[1] - a[1], b[0] - a[0]), 0, Math.PI * 2);
    } else {
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
  };
  for (const s of model.shapes) {
    ctx.save();
    if (s.hidden) {
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([5, 4]);
    }
    const [cx, cy] = px(s.center);
    switch (s.kind) {
      case 'terrain':
        if (s.type === 'water' || s.type === 'road') {
          drawPoly(s);
          ctx.fillStyle = s.type === 'water' ? 'rgba(59,111,216,0.28)' : 'rgba(128,132,140,0.28)';
          ctx.fill();
        } else if (s.type === 'hills') {
          drawPoly(s);
          ctx.strokeStyle = 'rgba(90,140,90,0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        break;
      case 'area':
        drawPoly(s);
        ctx.fillStyle = rgba(s.color, 0.08);
        ctx.fill();
        ctx.strokeStyle = rgba(s.color, 0.9);
        ctx.lineWidth = 2.5;
        ctx.stroke();
        break;
      case 'crowd':
        drawPoly(s);
        ctx.fillStyle = rgba(s.color, 0.22);
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        break;
      case 'helper':
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        if (s.type === 'target') {
          ctx.beginPath();
          ctx.arc(cx, cy, 6, 0, Math.PI * 2);
          ctx.stroke();
        }
        line(cx - 6, cy - 6, cx + 6, cy + 6, s.color, 2);
        line(cx - 6, cy + 6, cx + 6, cy - 6, s.color, 2);
        break;
      case 'character': {
        const r = Math.max(6, 0.25 * ppm);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (s.facing) {
          const len = Math.max(16, 0.75 * ppm);
          const ex = cx + s.facing[0] * len;
          const ey = cy + s.facing[1] * len;
          line(cx, cy, ex, ey, '#ffffff', 2);
          ctx.fillStyle = '#ffffff';
          arrowHead(ctx, ex, ey, s.facing[0], s.facing[1], 7);
        }
        break;
      }
      default: {
        drawPoly(s);
        ctx.fillStyle = rgba(s.color, 0.55);
        ctx.fill();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (s.facing) {
          const [a, , , d] = s.polygon.map(px) as [number, number][];
          const half = Math.hypot(d![0] - a![0], d![1] - a![1]) / 2;
          const len = Math.max(8, half);
          ctx.globalAlpha *= 0.85;
          line(cx, cy, cx + s.facing[0] * len, cy + s.facing[1] * len, '#ffffff', 1.5);
          ctx.fillStyle = '#ffffff';
          arrowHead(ctx, cx + s.facing[0] * len, cy + s.facing[1] * len, s.facing[0], s.facing[1], 5);
        }
      }
    }
    ctx.restore();
  }

  // Motion paths.
  for (const p of model.paths) {
    const color = p.camera ? rgba(p.color, 0.95) : PATH;
    const pts = p.points.map(px);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(p.camera ? [7, 5] : []);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
    const end = pts[pts.length - 1]!;
    const before = [...pts].reverse().find((q) => Math.hypot(q[0] - end[0], q[1] - end[1]) > 3) ?? pts[0]!;
    ctx.fillStyle = color;
    arrowHead(ctx, end[0], end[1], end[0] - before[0], end[1] - before[1], 9);
    for (const k of p.keys) {
      const [kx, ky] = px(k.at);
      ctx.beginPath();
      ctx.arc(kx, ky, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.restore();
  }

  // Cameras: field-of-view wedge, aim line, body.
  const cams = [...model.cameras].sort((a, b) => Number(a.live) - Number(b.live));
  for (const c of cams) {
    const color = c.live ? LIVE : c.color;
    const [cx, cy] = px(c.position);
    const R = c.range * ppm;
    ctx.save();
    if (c.direction && c.fov < 359) {
      const a = Math.atan2(c.direction[1], c.direction[0]);
      const half = (c.fov * Math.PI) / 360;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a - half, a + half);
      ctx.closePath();
      ctx.fillStyle = rgba(color, c.live ? 0.16 : 0.1);
      ctx.fill();
      ctx.strokeStyle = rgba(color, 0.85);
      ctx.lineWidth = c.live ? 2.5 : 1.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, c.direction ? R : R * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color, 0.08);
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = rgba(color, 0.85);
      ctx.lineWidth = c.live ? 2.5 : 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (c.aim) {
      const [ax, ay] = px(c.aim);
      ctx.setLineDash([3, 4]);
      line(cx, cy, ax, ay, rgba(color, 0.7), 1.2);
      ctx.setLineDash([]);
    }
    const d = c.direction ?? [0, -1];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx + d[0] * 10, cy + d[1] * 10);
    ctx.lineTo(cx - d[0] * 6 - d[1] * 7, cy - d[1] * 6 + d[0] * 7);
    ctx.lineTo(cx - d[0] * 6 + d[1] * 7, cy - d[1] * 6 - d[0] * 7);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#0d0f12';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Title, north arrow, scale bar, legend (reserved so labels avoid them).
  const titleText = `${project.name} — plan view, north up · t=${opts.time.toFixed(2)}s · grid ${step} m`;
  tags.reserve(tags.tag(titleText, 8, 8, { fg: '#f2f2f2', bg: 'rgba(0,0,0,0.75)', bold: true }));
  const nx = W - 26;
  ctx.fillStyle = '#f2f2f2';
  arrowHead(ctx, nx, 12, 0, -1, 12);
  line(nx, 12, nx, 34, '#f2f2f2', 2);
  ctx.font = `600 ${size}px ${UI_FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillText('N', nx - size * 0.32, 38);
  tags.reserve({ x: nx - 16, y: 0, w: 32, h: 40 + size });
  const barM = [step, step * 2, step * 5].find((m) => m * ppm >= 70) ?? step * 5;
  const bx = 12;
  const by = H - Math.round(size * 2.6);
  line(bx, by, bx + barM * ppm, by, '#f2f2f2', 3);
  line(bx, by - 5, bx, by + 5, '#f2f2f2', 2);
  line(bx + barM * ppm, by - 5, bx + barM * ppm, by + 5, '#f2f2f2', 2);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillText(`${fmtMeters(barM)} m`, bx + barM * ppm + 6, by - size * 0.55);
  tags.reserve({ x: 0, y: by - 12, w: barM * ppm + 60, h: 24 });
  ctx.font = `${Math.round(size * 0.85)}px ${UI_FONT}`;
  const legend = '→ facing   ◢ camera view (LIVE red)   — path, • keys';
  const lw = ctx.measureText(legend).width + 12;
  tags.reserve(tags.tag(legend, W - lw - 8, H - Math.round(size * 2.8), { fg: '#c9ced6', bg: 'rgba(0,0,0,0.6)', size: Math.round(size * 0.85) }));

  // Labels last: characters first so they get the best spots.
  const inside = (p: XZ) => p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1;
  const labelled = [...model.shapes.filter((s) => s.kind === 'character'), ...model.shapes.filter((s) => s.kind !== 'character' && s.kind !== 'terrain')];
  for (const s of labelled) {
    if (!s.label || !inside(s.center)) continue;
    const [cx, cy] = px(s.center);
    if (s.kind === 'character') {
      const r = Math.max(6, 0.25 * ppm);
      tags.tag(s.label, cx + r + 4, cy - size * 0.7, { fg: '#ffffff', bold: true });
    } else {
      tags.tag(s.label, cx, cy, { fg: '#d7dbe0', bg: 'rgba(0,0,0,0.55)', size: Math.max(10, size - 1) }, 'center');
    }
  }
  for (const c of cams) {
    if (!inside(c.position)) continue;
    const [cx, cy] = px(c.position);
    const d = c.direction ?? [0, -1];
    tags.tag(`${c.label}${c.direction ? '' : ' ↓'}`, cx - d[0] * 22, cy - d[1] * 22, { fg: c.live ? '#ff8080' : '#ffffff', bold: c.live, bg: 'rgba(0,0,0,0.72)' }, 'center');
  }
  for (const p of model.paths) {
    for (const k of p.keys) {
      if (!inside(k.at)) continue;
      const [kx, ky] = px(k.at);
      tags.tag(fmtTime(k.t), kx + 6, ky - size - 2, { fg: p.camera ? '#ffffff' : PATH, bg: 'rgba(0,0,0,0.55)', size: Math.max(10, size - 2) });
    }
  }
  return { canvas, model };
}
