import type { ClientToServer, ServerToClient } from "../types";

/**
 * Thin wrapper around the signaling WebSocket.
 *
 * Responsibilities:
 *   - Build the correct ws[s]://host/ws URL for both dev (Vite proxy on 5173)
 *     and prod (same-origin on whatever port the server listens on).
 *   - Provide a typed `send` and `on(type, handler)` pair.
 *   - Auto-close is intentional: the caller (page component) owns the
 *     lifecycle. No auto-reconnect — the UX spec says a disconnect is a
 *     terminal state, not something we paper over.
 */

type Handler<T extends ServerToClient["type"]> = (
  msg: Extract<ServerToClient, { type: T }>,
) => void;

export class Signaling {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<(msg: ServerToClient) => void>>();
  private openWaiters: Array<() => void> = [];
  private closeWaiters: Array<(reason: string) => void> = [];

  /** Construct the signaling URL, honoring an explicit override. */
  static url(): string {
    // Vite injects `import.meta.env` at build time. We cast via `unknown`
    // instead of depending on `vite/client` types directly so the file
    // typechecks even without Vite's global ambient declarations loaded.
    const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
    const envUrl = meta.env?.VITE_WS_URL ?? "";
    if (envUrl) return envUrl;
    const { protocol, host } = window.location;
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
      this.ws.addEventListener("close", (ev) => {
        const reason = ev.reason || (ev.code === 1000 ? "closed" : `closed (${ev.code})`);
        for (const w of this.closeWaiters) w(reason);
        this.closeWaiters = [];
      });
      this.ws.addEventListener("message", (ev) => {
        let msg: ServerToClient;
        try { msg = JSON.parse(ev.data as string) as ServerToClient; }
        catch { return; }
        const set = this.handlers.get(msg.type);
        if (set) for (const h of set) h(msg);
      });
    });
  }

  send(msg: ClientToServer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Subscribe to a single message type. Returns an unsubscribe fn. */
  on<T extends ServerToClient["type"]>(type: T, fn: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    const wrapped = fn as (m: ServerToClient) => void;
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => { set.delete(wrapped); };
  }

  /** Resolves when the socket closes; reason is "reason" or `closed (code)`. */
  onceClosed(): Promise<string> {
    return new Promise((res) => { this.closeWaiters.push(res); });
  }

  close(code = 1000, reason = "client closing"): void {
    try { this.ws?.close(code, reason); } catch { /* ignore */ }
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
