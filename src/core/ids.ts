import { ID_PATTERN } from './schema.ts';

/** First free "<base>_<n>" (n ≥ 1). */
export function nextId(base: string, existing: Iterable<string>): string {
  const used = new Set(existing);
  const clean = base.replace(/[^A-Za-z0-9_-]/g, '') || 'obj';
  const prefix = /^[A-Za-z]/.test(clean) ? clean : `o${clean}`;
  for (let i = 1; ; i++) {
    const id = `${prefix}_${i}`;
    if (!used.has(id)) return id;
  }
}

/** Camera ids/names: camA / "A 機", camB / "B 機", ... then cam27... */
export function nextCameraId(existing: Iterable<string>): { id: string; letter: string } {
  const used = new Set(existing);
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(`cam${letter}`)) return { id: `cam${letter}`, letter };
  }
  for (let i = 27; ; i++) {
    if (!used.has(`cam${i}`)) return { id: `cam${i}`, letter: String(i) };
  }
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function randomProjectId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `p_${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10)}`;
}
