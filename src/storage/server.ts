/**
 * Talking to the local companion server (shared by the director and the portrait studio; kept
 * free of project code so pages only load what they use).
 */

export function serverToken(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="director3d-token"]')?.content || null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = serverToken();
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-director-token': token } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function detectServer(): Promise<{ ok: boolean; version?: string; root?: string }> {
  if (!serverToken()) return { ok: false };
  try {
    return await api<{ ok: boolean; version: string; root: string }>('/api/health');
  } catch {
    return { ok: false };
  }
}
