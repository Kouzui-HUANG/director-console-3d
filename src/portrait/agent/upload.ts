import { serverToken } from '../../storage/server.ts';

/** Save a canvas as exports/portraits/<name>.png through the companion server (replaces an older file); returns the path. */
export async function uploadPng(canvas: HTMLCanvasElement, name: string): Promise<string> {
  const token = serverToken();
  if (!token) throw new Error('saving needs the companion server (npm run dev)');
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  const r = await fetch(`/api/exports?dir=portraits&overwrite=1&name=${encodeURIComponent(name.endsWith('.png') ? name : `${name}.png`)}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-director-token': token },
    body: blob,
  });
  if (!r.ok) throw new Error(`upload failed: HTTP ${r.status}`);
  return ((await r.json()) as { path: string }).path;
}
