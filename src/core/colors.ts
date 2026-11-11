/** Color helpers. Canonical project color format is lowercase "#rrggbb". */

const NAMED: Record<string, string> = {
  red: '#d64541', green: '#3fa34d', blue: '#3b6fd8', yellow: '#f2c230', orange: '#ec8a2f',
  purple: '#8e5bd1', pink: '#e87aa4', brown: '#8a5a3c', black: '#1e1f22', white: '#f2f2f2',
  gray: '#8c9099', grey: '#8c9099', cyan: '#36b3c9', magenta: '#c74bb5', teal: '#2a9d8f',
  navy: '#24365e', olive: '#7f8b3b', maroon: '#7a2a2a', beige: '#d8c8a8', gold: '#d4a53a',
  silver: '#b8bcc4', skin: '#e0b89a', wood: '#9c6b43', concrete: '#a3a39d', grass: '#6f9a4f',
  water: '#4f86b0', asphalt: '#55585e', sand: '#d9c48e',
  紅: '#d64541', 紅色: '#d64541', 綠: '#3fa34d', 綠色: '#3fa34d', 藍: '#3b6fd8', 藍色: '#3b6fd8',
  黃: '#f2c230', 黃色: '#f2c230', 橙: '#ec8a2f', 橘: '#ec8a2f', 橘色: '#ec8a2f', 紫: '#8e5bd1',
  紫色: '#8e5bd1', 粉紅: '#e87aa4', 粉紅色: '#e87aa4', 棕: '#8a5a3c', 咖啡色: '#8a5a3c',
  黑: '#1e1f22', 黑色: '#1e1f22', 白: '#f2f2f2', 白色: '#f2f2f2', 灰: '#8c9099', 灰色: '#8c9099',
  青: '#36b3c9', 金: '#d4a53a', 金色: '#d4a53a', 銀: '#b8bcc4', 銀色: '#b8bcc4',
};

export const COLOR_NAMES = Object.keys(NAMED).filter((k) => /^[a-z]+$/.test(k));

/** Normalize "#abc", "#aabbcc", "rgb(1,2,3)" or a color name to "#rrggbb"; null if invalid. */
export function normalizeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const named = NAMED[s] ?? NAMED[input.trim()];
  if (named) return named;
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s);
  if (m) return rgbToHex([Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]);
  return null;
}

/** "#rrggbb" → [r, g, b] in 0..1 (sRGB). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

export function lerpColor(a: string, b: string, u: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u]);
}

/** Multiply brightness (factor < 1 darker, > 1 lighter). */
export function shade(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  if (factor <= 1) return rgbToHex([r * factor, g * factor, b * factor]);
  const t = factor - 1;
  return rgbToHex([r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t]);
}

/** HSL (h 0..360, s/l 0..1) to hex. */
export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0), f(8), f(4)]);
}

/** A palette of distinguishable colors for new characters/cameras. */
export const DISTINCT_COLORS = [
  '#3b6fd8', '#d64541', '#3fa34d', '#ec8a2f', '#8e5bd1', '#2a9d8f', '#e87aa4', '#d4a53a',
  '#5d6d7e', '#a0522d',
];
