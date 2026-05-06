import { WebSocket } from "ws";

export interface TestWsClient {
  ws: WebSocket;
  send(msg: unknown): void;
  /** Resolves with the next incoming message, or rejects on timeout. */
  nextMessage(timeoutMs?: number): Promise<unknown>;
  /** Waits until the socket closes (or timeout). */
  waitClose(timeoutMs?: number): Promise<void>;
  close(): void;
}

export async function connectWs(url: string): Promise<TestWsClient> {
  const ws = new WebSocket(url);

  const msgQueue: unknown[] = [];
  const msgWaiters: Array<(msg: unknown) => void> = [];

  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString("utf8"));
    const waiter = msgWaiters.shift();
    if (waiter) waiter(msg);
    else msgQueue.push(msg);
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  return {
    ws,
    send(msg: unknown) {
      ws.send(JSON.stringify(msg));
    },
    nextMessage(timeoutMs = 3_000): Promise<unknown> {
      if (msgQueue.length > 0) return Promise.resolve(msgQueue.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = msgWaiters.indexOf(resolve);
          if (idx !== -1) msgWaiters.splice(idx, 1);
          reject(new Error(`WS message timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        msgWaiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    waitClose(timeoutMs = 3_000): Promise<void> {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WS close timeout after ${timeoutMs}ms`)), timeoutMs);
        ws.once("close", () => { clearTimeout(timer); resolve(); });
      });
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}
