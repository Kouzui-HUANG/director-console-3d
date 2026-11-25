/**
 * WebSocket link to the companion server for the portrait page. Registers the tab as a portrait
 * tab (the director's agent requests never come here), receives notices about portrait files
 * changed on disk, and answers portrait agent requests (HTTP /api/portrait-rpc, MCP portrait3d)
 * by calling window.portrait methods.
 */
import { serverToken } from '../../storage/server.ts';

export interface PortraitBridgeHost {
  portraitId(): string;
  portraitName(): string;
  onExternalChange(id: string): void;
  /** A portrait file was deleted by someone else (agent, another tab). */
  onDeleted(id: string): void;
  onConnection(connected: boolean): void;
  /** The agent API whose methods remote requests may call (window.portrait). */
  api(): object | undefined;
}

export class PortraitBridge {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private readonly host: PortraitBridgeHost;

  constructor(host: PortraitBridgeHost) {
    this.host = host;
    this.connect();
    window.addEventListener('focus', () => this.hello());
    document.addEventListener('visibilitychange', () => this.hello());
  }

  private connect() {
    const token = serverToken();
    if (!token || this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/bridge?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.host.onConnection(true);
      this.hello();
    };
    ws.onclose = () => {
      this.host.onConnection(false);
      if (this.closed) return;
      setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++));
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string; id?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'portrait-changed' && msg.id) this.host.onExternalChange(msg.id);
      else if (msg.type === 'portrait-deleted' && msg.id) this.host.onDeleted(msg.id);
      else if (msg.type === 'ping') this.send({ type: 'pong' });
      else if (msg.type === 'rpc') void this.onRpc(msg as unknown as { id: string; method: string; params?: unknown });
    };
  }

  private async onRpc(msg: { id: string; method: string; params?: unknown }) {
    try {
      const api = this.host.api() as Record<string, unknown> | undefined;
      const fn = api && Object.hasOwn(api, msg.method) ? api[msg.method] : undefined;
      if (typeof fn !== 'function') throw Object.assign(new Error(`unknown method "${msg.method}"`), { code: 'UNKNOWN_METHOD', hint: 'help() lists the methods.' });
      const args = Array.isArray(msg.params) ? msg.params : msg.params === undefined ? [] : [msg.params];
      const result = await (fn as (...a: unknown[]) => unknown).apply(api, args);
      this.send({ type: 'rpc-result', id: msg.id, result: result === undefined ? null : result });
    } catch (e) {
      const err = e as { message?: string; code?: unknown; hint?: unknown };
      this.send({
        type: 'rpc-result',
        id: msg.id,
        error: { message: e instanceof Error ? e.message : String(e), ...(typeof err?.code === 'string' ? { code: err.code } : {}), ...(typeof err?.hint === 'string' ? { hint: err.hint } : {}) },
      });
    }
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Tell the server who we are (call again when the open portrait changes). */
  hello() {
    this.send({ type: 'hello', kind: 'portrait', projectId: this.host.portraitId(), projectName: this.host.portraitName(), focused: document.hasFocus(), visible: document.visibilityState === 'visible', at: Date.now() });
  }

  dispose() {
    this.closed = true;
    this.ws?.close();
  }
}
