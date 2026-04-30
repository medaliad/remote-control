import type { ClientToServer, ServerToClient } from "../types";
type Handler<T extends ServerToClient["type"]> = (msg: Extract<ServerToClient, {
  type: T;
}>) => void;
export class Signaling {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<(msg: ServerToClient) => void>>();
  private openWaiters: Array<() => void> = [];
  private closeWaiters: Array<(reason: string) => void> = [];
  static url(): string {
    const meta = import.meta as unknown as {
      env?: Record<string, string | undefined>;
    };
    const envUrl = meta.env?.VITE_WS_URL ?? "";
    if (envUrl) return envUrl;
    const {
      protocol,
      host
    } = window.location;
    const wsProto = protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${host}/ws`;
  }
  connect(url: string = Signaling.url()): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws.addEventListener("open", () => {
        for (const w of this.openWaiters) w();
        this.openWaiters = [];
        resolve();
      });
      this.ws.addEventListener("error", () => reject(new Error("signaling: ws error")));
      this.ws.addEventListener("close", ev => {
        const reason = ev.reason || (ev.code === 1000 ? "closed" : `closed (${ev.code})`);
        for (const w of this.closeWaiters) w(reason);
        this.closeWaiters = [];
      });
      this.ws.addEventListener("message", ev => {
        let msg: ServerToClient;
        try {
          msg = JSON.parse(ev.data as string) as ServerToClient;
        } catch {
          return;
        }
        const set = this.handlers.get(msg.type);
        if (set) for (const h of set) h(msg);
      });
    });
  }
  send(msg: ClientToServer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }
  on<T extends ServerToClient["type"]>(type: T, fn: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    const wrapped = fn as (m: ServerToClient) => void;
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }
  onceClosed(): Promise<string> {
    return new Promise(res => {
      this.closeWaiters.push(res);
    });
  }
  close(code = 1000, reason = "client closing"): void {
    try {
      this.ws?.close(code, reason);
    } catch {}
    this.ws = null;
  }
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
