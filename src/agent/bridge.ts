/**
 * WebSocket bridge to the local companion server. The server forwards agent requests
 * (HTTP /api/rpc and MCP tools) to this tab, and notifies us about project files that
 * changed on disk.
 */
import type { DirectorApp } from '../app/app.ts';
import { serverToken } from '../storage/stores.ts';
import type { DirectorApi } from './api.ts';

interface RpcMessage {
  type: 'rpc';
  id: string;
  method: string;
  params?: unknown;
  jobId?: string;
}

export class AgentBridge {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;

  private app: DirectorApp;
  private api: DirectorApi;

  constructor(app: DirectorApp, api: DirectorApi) {
    this.app = app;
    this.api = api;
    this.connect();
    window.addEventListener('focus', () => this.hello());
    document.addEventListener('visibilitychange', () => this.hello());
    app.store.subscribe((s, prev) => {
      if (s.project.id !== prev.project.id) this.hello();
    });
  }

  private connect() {
    const token = serverToken();
    if (!token || this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/bridge?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.app.ui.setState({ server: { ...this.app.ui.getState().server, connected: true, bridge: true } });
      this.hello();
    };
    ws.onclose = () => {
      this.app.ui.setState({ server: { ...this.app.ui.getState().server, bridge: false } });
      if (this.closed) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onmessage = (ev) => void this.onMessage(ev.data);
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private hello() {
    const p = this.app.store.getState().project;
    this.send({ type: 'hello', projectId: p.id, projectName: p.name, focused: document.hasFocus(), visible: document.visibilityState === 'visible', at: Date.now() });
  }

  private resolve(method: string): ((params: unknown) => unknown) | null {
    let target: unknown = this.api;
    let owner: unknown = null;
    for (const part of method.split('.')) {
      if (!target || typeof target !== 'object' || !(part in (target as object))) return null;
      owner = target;
      target = (target as Record<string, unknown>)[part];
    }
    return typeof target === 'function' ? (target as (p: unknown) => unknown).bind(owner) : null;
  }

  private async onMessage(data: unknown) {
    let msg: { type: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === 'project-changed') {
      void this.app.onExternalChange(String(msg.id));
      return;
    }
    if (msg.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (msg.type !== 'rpc') return;
    const rpc = msg as unknown as RpcMessage;
    try {
      const fn = this.resolve(rpc.method);
      if (!fn) throw new Error(`unknown method "${rpc.method}"`);
      let params = rpc.params;
      if (rpc.method === 'exportVideo' && rpc.jobId) {
        const jobId = rpc.jobId;
        params = { ...((params as object) ?? {}), onProgress: (fraction: number, frame: number, total: number) => this.send({ type: 'job-progress', jobId, fraction, frame, total }) };
      }
      const args = Array.isArray(params) ? params : params === undefined ? [] : [params];
      const result = await (fn as (...a: unknown[]) => unknown)(...args);
      this.send({ type: 'rpc-result', id: rpc.id, result: result === undefined ? null : result });
    } catch (e) {
      const err = e as { message?: string; code?: unknown; hint?: unknown };
      this.send({
        type: 'rpc-result',
        id: rpc.id,
        error: { message: e instanceof Error ? e.message : String(e), ...(typeof err?.code === 'string' ? { code: err.code } : {}), ...(typeof err?.hint === 'string' ? { hint: err.hint } : {}) },
      });
    }
  }

  dispose() {
    this.closed = true;
    this.ws?.close();
  }
}
