/**
 * Project storage backends with one interface:
 *  - BrowserStore: IndexedDB (works anywhere, per browser)
 *  - ServerStore: the local companion server → projects/<id>.json on disk (agents can edit files)
 */
import { serializeProject } from '../core/project.ts';
import type { Project } from '../core/schema.ts';
import { api } from './server.ts';

export { api, detectServer, serverToken } from './server.ts';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
  revision: number;
  thumbnail?: string | null;
  objects?: number;
  duration?: number;
}

export interface ProjectStore {
  kind: 'browser' | 'server';
  label: string;
  list(): Promise<ProjectMeta[]>;
  load(id: string): Promise<unknown>;
  save(project: Project, thumbnail?: string | null): Promise<void>;
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

const DB_NAME = 'director3d';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface StoredProject {
  id: string;
  json: string;
}

export class BrowserStore implements ProjectStore {
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

  async list(): Promise<ProjectMeta[]> {
    const db = await this.conn;
    const metas = await tx<ProjectMeta[]>(db, 'meta', 'readonly', (s) => s.getAll() as IDBRequest<ProjectMeta[]>);
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<unknown> {
    const db = await this.conn;
    const rec = await tx<StoredProject | undefined>(db, 'projects', 'readonly', (s) => s.get(id) as IDBRequest<StoredProject | undefined>);
    if (!rec) throw new Error(`找不到專案 ${id}`);
    return JSON.parse(rec.json);
  }

  async save(project: Project, thumbnail?: string | null): Promise<void> {
    const db = await this.conn;
    await tx(db, 'projects', 'readwrite', (s) => s.put({ id: project.id, json: serializeProject(project) }));
    const prev = await tx<ProjectMeta | undefined>(db, 'meta', 'readonly', (s) => s.get(project.id) as IDBRequest<ProjectMeta | undefined>);
    const meta: ProjectMeta = {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt ?? new Date().toISOString(),
      revision: project.revision,
      thumbnail: thumbnail === undefined ? (prev?.thumbnail ?? null) : thumbnail,
      objects: project.objects.length,
      duration: project.settings.duration,
    };
    await tx(db, 'meta', 'readwrite', (s) => s.put(meta));
  }

  async remove(id: string): Promise<void> {
    const db = await this.conn;
    await tx(db, 'projects', 'readwrite', (s) => s.delete(id));
    await tx(db, 'meta', 'readwrite', (s) => s.delete(id));
  }
}

// ---------------------------------------------------------------------------
// Companion server
// ---------------------------------------------------------------------------

export class ServerStore implements ProjectStore {
  kind = 'server' as const;
  label = '本機資料夾（projects/）';

  list(): Promise<ProjectMeta[]> {
    return api<ProjectMeta[]>('/api/projects');
  }
  load(id: string): Promise<unknown> {
    return api<unknown>(`/api/projects/${encodeURIComponent(id)}`);
  }
  async save(project: Project, thumbnail?: string | null): Promise<void> {
    await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ project: JSON.parse(serializeProject(project)), thumbnail }),
    });
  }
  async remove(id: string): Promise<void> {
    await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
