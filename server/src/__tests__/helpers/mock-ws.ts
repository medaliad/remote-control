/**
 * Lightweight WebSocket mock for unit tests of SessionManager and other code
 * that only cares about EventEmitter behaviour, readyState, and the send/close
 * methods — without spinning up a real socket.
 */
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { WebSocket } from "ws";

export type MockWs = WebSocket & {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

/** Create a fake WebSocket suitable for direct injection into SessionManager. */
export function mockWs(): MockWs {
  const em = new EventEmitter() as unknown as MockWs;
  em.readyState = 1; // OPEN
  em.send = vi.fn();
  em.close = vi.fn();
  em.terminate = vi.fn();
  return em;
}
