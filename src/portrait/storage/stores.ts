/**
 * Portrait storage with one interface:
 *  - ServerPortraitStore: the companion server → portraits/<id>.json (agents can edit the files)
 *  - BrowserPortraitStore: IndexedDB (works without the server, per browser)
 */
import { api, serverToken } from '../../storage/server.ts';
import { serializePortrait, type Portrait } from '../core/schema.ts';

export interface PortraitMeta {
  id: string;
  name: string;
  preset: string | null;
  framing: string;
  /** Number of changed parameters. */
  params: number;
  updatedAt: string;
  revision: number;
  thumbnail?: string | null;
}

export interface PortraitStorage {
  kind: 'browser' | 'server';
  label: string;
  list(): Promise<PortraitMeta[]>;
  load(id: string): Promise<unknown>;
  save(p: Portrait, thumbnail?: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  /** Store a reference photo; returns its id and the file name recorded in the portrait. */
  saveRef(portraitId: string, image: Blob): Promise<{ refId: string; file: string }>;
  loadRef(portraitId: string, file: string): Promise<Blob>;
}

const metaOf = (p: Portrait, thumbnail: string | null | undefined): PortraitMeta => ({
  id: p.id,
  name: p.name,
  preset: p.preset,
  framing: p.framing.type,
  params: Object.keys(p.params).length,
  updatedAt: p.updatedAt ?? new Date().toISOString(),
  revision: p.revision,
  thumbnail: thumbnail ?? null,
});

// ---- IndexedDB ---------------------------------------------------------------------------------

const DB_NAME = 'director3d-portrait';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('portraits')) db.createObjectStore('portraits', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('refs')) db.createObjectStore('refs', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class BrowserPortraitStore implements PortraitStorage {
  kind = 'browser' as const;
  label = '瀏覽器（IndexedDB）';
  private db: Promise<IDBDatabase> | null = null;

  private get conn(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = openDb();
      navigator.storage?.persist?.().catch(() => undefined);
    }
    return this.db;
  }

  async list(): Promise<PortraitMeta[]> {
    const metas = await tx<PortraitMeta[]>(await this.conn, 'meta', 'readonly', (s) => s.getAll() as IDBRequest<PortraitMeta[]>);
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<unknown> {
    const rec = await tx<{ id: string; json: string } | undefined>(await this.conn, 'portraits', 'readonly', (s) => s.get(id) as IDBRequest<{ id: string; json: string } | undefined>);
    if (!rec) throw new Error(`找不到人像 ${id}`);
    return JSON.parse(rec.json);
  }

  async save(p: Portrait, thumbnail?: string | null): Promise<void> {
    const db = await this.conn;
    await tx(db, 'portraits', 'readwrite', (s) => s.put({ id: p.id, json: serializePortrait(p) }));
    const prev = await tx<PortraitMeta | undefined>(db, 'meta', 'readonly', (s) => s.get(p.id) as IDBRequest<PortraitMeta | undefined>);
    await tx(db, 'meta', 'readwrite', (s) => s.put(metaOf(p, thumbnail === undefined ? prev?.thumbnail : thumbnail)));
  }

  async remove(id: string): Promise<void> {
    const db = await this.conn;
    await tx(db, 'portraits', 'readwrite', (s) => s.delete(id));
    await tx(db, 'meta', 'readwrite', (s) => s.delete(id));
  }

  async saveRef(portraitId: string, image: Blob): Promise<{ refId: string; file: string }> {
    const refId = `ref${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const ext = image.type.includes('png') ? 'png' : image.type.includes('webp') ? 'webp' : 'jpg';
    const file = `refs/${portraitId}/${refId}.${ext}`;
    await tx(await this.conn, 'refs', 'readwrite', (s) => s.put({ key: file, blob: image }));
    return { refId, file };
  }

  async loadRef(_portraitId: string, file: string): Promise<Blob> {
    const rec = await tx<{ key: string; blob: Blob } | undefined>(await this.conn, 'refs', 'readonly', (s) => s.get(file) as IDBRequest<{ key: string; blob: Blob } | undefined>);
    if (!rec) throw new Error(`找不到參考照片 ${file}`);
    return rec.blob;
  }
}

// ---- companion server --------------------------------------------------------------------------

export class ServerPortraitStore implements PortraitStorage {
  kind = 'server' as const;
  label = '本機資料夾（portraits/）';
  list(): Promise<PortraitMeta[]> {
    return api<PortraitMeta[]>('/api/portraits');
  }
  load(id: string): Promise<unknown> {
    return api<unknown>(`/api/portraits/${encodeURIComponent(id)}`);
  }
  async save(p: Portrait, thumbnail?: string | null): Promise<void> {
    await api(`/api/portraits/${encodeURIComponent(p.id)}`, { method: 'PUT', body: JSON.stringify({ portrait: JSON.parse(serializePortrait(p)), thumbnail }) });
  }
  async remove(id: string): Promise<void> {
    await api(`/api/portraits/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async saveRef(portraitId: string, image: Blob): Promise<{ refId: string; file: string }> {
    const token = serverToken();
    const r = await fetch(`/api/portraits/${encodeURIComponent(portraitId)}/refs`, { method: 'POST', headers: { 'content-type': image.type || 'image/jpeg', ...(token ? { 'x-director-token': token } : {}) }, body: image });
    const data = (await r.json()) as { refId?: string; file?: string; error?: { message: string } };
    if (!r.ok || !data.refId) throw new Error(data.error?.message ?? `HTTP ${r.status}`);
    return { refId: data.refId, file: data.file! };
  }

  async loadRef(portraitId: string, file: string): Promise<Blob> {
    const token = serverToken();
    const name = file.split('/').pop()!;
    const r = await fetch(`/api/portraits/${encodeURIComponent(portraitId)}/refs/${encodeURIComponent(name)}`, { headers: token ? { 'x-director-token': token } : {} });
    if (!r.ok) throw new Error(`找不到參考照片 ${file}（HTTP ${r.status}）`);
    return r.blob();
  }
}
