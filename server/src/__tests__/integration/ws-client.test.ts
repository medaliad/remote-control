/**
 * Integration tests for the /ws WebSocket endpoint — browser client protocol.
 * Every describe-block owns an isolated server instance.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { connectWs, type TestWsClient } from "../helpers/ws.js";
import { startTestServer, type TestServer } from "../helpers/server.js";
import * as L from "../helpers/logger.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Create a session and return the host WS + the 6-char session code. */
async function openSession(wsUrl: string, hostName = "Host"): Promise<{ host: TestWsClient; code: string }> {
  const host = await connectWs(`${wsUrl}/ws`);
  host.send({ type: "host:create", hostName });
  const msg = await host.nextMessage() as Record<string, string>;
  return { host, code: msg.code };
}

/** Create a session, join as client, return both sockets + the requestId. */
async function openSessionWithPendingClient(
  wsUrl: string
): Promise<{ host: TestWsClient; client: TestWsClient; code: string; requestId: string }> {
  const { host, code } = await openSession(wsUrl);
  const client = await connectWs(`${wsUrl}/ws`);
  client.send({ type: "client:join", code, clientName: "Client" });
  const incoming = await host.nextMessage() as Record<string, string>;
  return { host, client, code, requestId: incoming.requestId };
}

/**
 * Fully pair host and client, draining the 3 handshake messages by TYPE
 * (rather than by positional order — which used to be brittle).
 */
async function pairSession(
  wsUrl: string
): Promise<{ host: TestWsClient; client: TestWsClient; code: string }> {
  const { host, client, code, requestId } = await openSessionWithPendingClient(wsUrl);
  host.send({ type: "host:approve", requestId });
  // Client receives request:approved followed by peer:ready
  const c1 = await client.nextMessage() as Record<string, unknown>;
  const c2 = await client.nextMessage() as Record<string, unknown>;
  if (![c1.type, c2.type].includes("request:approved")) {
    throw new Error(`pairSession: client never saw request:approved, got [${c1.type}, ${c2.type}]`);
  }
  // Host receives peer:ready
  const hostReady = await host.nextMessage() as Record<string, unknown>;
  if (hostReady.type !== "peer:ready") {
    throw new Error(`pairSession: host expected peer:ready, got ${hostReady.type}`);
  }
  return { host, client, code };
}

// ─── connection ───────────────────────────────────────────────────────────────

describe("/ws — connection lifecycle", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("accepts a new WebSocket connection without closing it", async () => {
    L.section("Connection — open /ws");
    const ws = await connectWs(`${server.wsUrl}/ws`);
    L.ok("readyState OPEN", String(ws.ws.readyState === 1));
    expect(ws.ws.readyState).toBe(1);
    ws.close();
  });
});

// ─── host:create ─────────────────────────────────────────────────────────────

describe("host:create", () => {
  let server: TestServer;
  let host: TestWsClient;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });
  afterEach(() => { host?.close(); });

  it("returns session:created with a 6-character code", async () => {
    L.section("host:create — happy path");
    host = await connectWs(`${server.wsUrl}/ws`);
    L.send("HOST", "host:create", { hostName: "Alice" });
    host.send({ type: "host:create", hostName: "Alice" });
    const msg = await host.nextMessage() as Record<string, string>;
    L.recv("HOST", "session:created", `code="${msg.code}"`);
    expect(msg.type).toBe("session:created");
    expect(msg.code).toHaveLength(6);
  });

  it("returns error bad-message if called twice on the same socket", async () => {
    L.section("host:create — double create guard");
    host = await connectWs(`${server.wsUrl}/ws`);
    host.send({ type: "host:create" });
    const first = await host.nextMessage() as Record<string, string>;
    L.recv("HOST", "session:created", `code="${first.code}"`);

    host.send({ type: "host:create" });
    const err = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "error", `code="${err.code}"`);
    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");
  });

  it("returns error bad-message for invalid JSON", async () => {
    L.section("host:create — malformed message");
    host = await connectWs(`${server.wsUrl}/ws`);
    L.step("Sending raw non-JSON string");
    host.ws.send("not-json{{{");
    const err = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "error", `code="${err.code}"`);
    expect(err.code).toBe("bad-message");
  });

  it("returns error bad-message for an unknown message type", async () => {
    L.section("host:create — unknown message type");
    host = await connectWs(`${server.wsUrl}/ws`);
    L.send("HOST", "totally:unknown");
    host.send({ type: "totally:unknown" });
    const err = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "error", `code="${err.code}"`);
    expect(err.code).toBe("bad-message");
  });
});

// ─── client:join ─────────────────────────────────────────────────────────────

describe("client:join", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("host receives request:incoming with all expected fields", async () => {
    L.section("client:join — happy path");
    const { host, code } = await openSession(server.wsUrl, "Host");
    L.ok("Session code", code);

    const client = await connectWs(`${server.wsUrl}/ws`);
    L.send("CLIENT", "client:join", { code, clientName: "Viewer" });
    client.send({ type: "client:join", code, clientName: "Viewer" });

    const msg = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "request:incoming", `requestId=${String(msg.requestId).slice(0, 8)}…`);
    L.ok("clientName", String(msg.clientName));
    L.ok("at (timestamp)", String(msg.at));
    expect(msg.type).toBe("request:incoming");
    expect(msg.clientName).toBe("Viewer");
    expect(typeof msg.requestId).toBe("string");
    expect(typeof msg.at).toBe("number");

    host.close(); client.close();
  });

  it("accepts a lowercase / hyphenated code (normalisation)", async () => {
    L.section("client:join — code normalisation");
    const { host, code } = await openSession(server.wsUrl);
    const raw = `${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()}`;
    L.step("Original code", code);
    L.step("Normalised input", raw);
    const client = await connectWs(`${server.wsUrl}/ws`);
    client.send({ type: "client:join", code: raw });
    const msg = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "request:incoming", "normalisation worked");
    expect(msg.type).toBe("request:incoming");
    host.close(); client.close();
  });

  it("returns error invalid-code for an unknown session code", async () => {
    L.section("client:join — invalid code");
    const client = await connectWs(`${server.wsUrl}/ws`);
    L.send("CLIENT", "client:join", { code: "ZZZZZZ" });
    client.send({ type: "client:join", code: "ZZZZZZ" });
    const err = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "error", `code="${err.code}"`);
    expect(err.code).toBe("invalid-code");
    client.close();
  });

  it("returns error session-full when a client is already active", async () => {
    L.section("client:join — session-full");
    const { host, client, code } = await pairSession(server.wsUrl);
    L.ok("First client paired — session now full");

    const c2 = await connectWs(`${server.wsUrl}/ws`);
    L.send("CLIENT2", "client:join", { code });
    c2.send({ type: "client:join", code });
    const err = await c2.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT2", "error", `code="${err.code}"`);
    expect(err.code).toBe("session-full");

    host.close(); client.close(); c2.close();
  });
});

// ─── host:approve ────────────────────────────────────────────────────────────

describe("host:approve", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("sends request:approved + peer:ready to both sides", async () => {
    L.section("host:approve — full handshake");
    const { host, client, requestId } = await openSessionWithPendingClient(server.wsUrl);

    L.send("HOST", "host:approve", { requestId: requestId.slice(0, 8) + "…" });
    host.send({ type: "host:approve", requestId });

    const approved = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "request:approved");
    expect(approved.type).toBe("request:approved");

    const hostReady = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "peer:ready", `role="${hostReady.role}"`);
    expect(hostReady.role).toBe("host");

    const clientReady = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "peer:ready", `role="${clientReady.role}"`);
    expect(clientReady.role).toBe("client");

    host.close(); client.close();
  });

  it("returns error not-host when a non-host socket tries to approve", async () => {
    L.section("host:approve — not-host guard");
    const random = await connectWs(`${server.wsUrl}/ws`);
    L.send("RANDOM", "host:approve", { requestId: "fake" });
    random.send({ type: "host:approve", requestId: "fake" });
    const err = await random.nextMessage() as Record<string, unknown>;
    L.recv("RANDOM", "error", `code="${err.code}"`);
    expect(err.code).toBe("not-host");
    random.close();
  });
});

// ─── host:reject ─────────────────────────────────────────────────────────────

describe("host:reject", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("sends request:rejected to the client with the correct reason", async () => {
    L.section("host:reject — with custom reason");
    const { host, client, requestId } = await openSessionWithPendingClient(server.wsUrl);

    L.send("HOST", "host:reject", { requestId: requestId.slice(0, 8) + "…", reason: "Not authorised" });
    host.send({ type: "host:reject", requestId, reason: "Not authorised" });

    const msg = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "request:rejected", `reason="${msg.reason}"`);
    expect(msg.type).toBe("request:rejected");
    expect(msg.reason).toBe("Not authorised");

    host.close(); client.close();
  });
});

// ─── host:setControl ─────────────────────────────────────────────────────────

describe("host:setControl", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("sends control:changed to the client when toggled on and off", async () => {
    L.section("host:setControl — toggle remote input control");
    const { host, client } = await pairSession(server.wsUrl);

    L.send("HOST", "host:setControl", { allowed: true });
    host.send({ type: "host:setControl", allowed: true });
    const on = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "control:changed", `allowed=${on.allowed}`);
    expect(on.type).toBe("control:changed");
    expect(on.allowed).toBe(true);

    L.divider();

    L.send("HOST", "host:setControl", { allowed: false });
    host.send({ type: "host:setControl", allowed: false });
    const off = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "control:changed", `allowed=${off.allowed}`);
    expect(off.allowed).toBe(false);

    host.close(); client.close();
  });

  it("returns error not-host for a socket without a session", async () => {
    const ws = await connectWs(`${server.wsUrl}/ws`);
    ws.send({ type: "host:setControl", allowed: true });
    const err = await ws.nextMessage() as Record<string, unknown>;
    expect(err.code).toBe("not-host");
    ws.close();
  });
});

// ─── host:end ────────────────────────────────────────────────────────────────

describe("host:end", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("sends peer:left to the connected client when host ends the session", async () => {
    L.section("host:end — active session");
    const { host, client } = await pairSession(server.wsUrl);

    L.send("HOST", "host:end");
    host.send({ type: "host:end" });

    const left = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "peer:left", `reason="${left.reason}"`);
    expect(left.type).toBe("peer:left");
    expect(String(left.reason)).toMatch(/host ended/i);

    host.close(); client.close();
  });

  it("sends request:rejected to each pending client when host ends", async () => {
    L.section("host:end — multiple pending clients cleared");
    const { host, code } = await openSession(server.wsUrl);

    const c1 = await connectWs(`${server.wsUrl}/ws`);
    const c2 = await connectWs(`${server.wsUrl}/ws`);
    c1.send({ type: "client:join", code });
    c2.send({ type: "client:join", code });
    await host.nextMessage(); // request:incoming (c1)
    await host.nextMessage(); // request:incoming (c2)

    L.step("Both clients are pending — host ends session");
    host.send({ type: "host:end" });

    const r1 = await c1.nextMessage() as Record<string, unknown>;
    const r2 = await c2.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT1", "request:rejected", `reason="${r1.reason}"`);
    L.recv("CLIENT2", "request:rejected", `reason="${r2.reason}"`);
    expect(r1.type).toBe("request:rejected");
    expect(r2.type).toBe("request:rejected");

    host.close(); c1.close(); c2.close();
  });

  it("returns error not-host when called from a socket without a session", async () => {
    const ws = await connectWs(`${server.wsUrl}/ws`);
    ws.send({ type: "host:end" });
    const err = await ws.nextMessage() as Record<string, unknown>;
    expect(err.code).toBe("not-host");
    ws.close();
  });
});

// ─── client:cancel ───────────────────────────────────────────────────────────

describe("client:cancel", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("host receives peer:left when client cancels a pending request", async () => {
    L.section("client:cancel — pending request withdrawn");
    const { host, client } = await openSessionWithPendingClient(server.wsUrl);

    L.send("CLIENT", "client:cancel");
    client.send({ type: "client:cancel" });

    const left = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "peer:left", `reason="${left.reason}"`);
    expect(left.type).toBe("peer:left");
    expect(String(left.reason)).toMatch(/cancel/i);

    host.close(); client.close();
  });
});

// ─── signal relay ─────────────────────────────────────────────────────────────

describe("signal relay — WebRTC signalling", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("relays signal data from host to client (SDP offer)", async () => {
    L.section("signal relay — host → client (SDP offer)");
    const { host, client } = await pairSession(server.wsUrl);

    const offerPayload = { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" };
    L.send("HOST", "signal", { data: { type: "offer", sdp: "…" } });
    host.send({ type: "signal", data: offerPayload });

    const relay = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "signal", `type="${(relay.data as Record<string,string>).type}"`);
    expect(relay.type).toBe("signal");
    expect(relay.data).toMatchObject(offerPayload);

    host.close(); client.close();
  });

  it("relays signal data from client to host (SDP answer)", async () => {
    L.section("signal relay — client → host (SDP answer)");
    const { host, client } = await pairSession(server.wsUrl);

    const answerPayload = { type: "answer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" };
    L.send("CLIENT", "signal", { data: { type: "answer", sdp: "…" } });
    client.send({ type: "signal", data: answerPayload });

    const relay = await host.nextMessage() as Record<string, unknown>;
    L.recv("HOST", "signal", `type="${(relay.data as Record<string,string>).type}"`);
    expect(relay.type).toBe("signal");
    expect(relay.data).toMatchObject(answerPayload);

    host.close(); client.close();
  });

  it("returns error not-paired when signalling before being paired", async () => {
    L.section("signal relay — not-paired guard");
    const ws = await connectWs(`${server.wsUrl}/ws`);
    L.send("WS", "signal", { data: {} });
    ws.send({ type: "signal", data: {} });
    const err = await ws.nextMessage() as Record<string, unknown>;
    L.recv("WS", "error", `code="${err.code}"`);
    expect(err.code).toBe("not-paired");
    ws.close();
  });
});

// ─── disconnect cleanup ───────────────────────────────────────────────────────

describe("disconnect cleanup", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("host gets peer:left + control:changed(false) when client disconnects", async () => {
    L.section("disconnect — client disconnects during session");
    const { host, client } = await pairSession(server.wsUrl);

    L.step("Client closes WebSocket connection");
    client.close();

    // Collect both messages, then look up by type — order is not guaranteed.
    const msg1 = await host.nextMessage() as Record<string, unknown>;
    const msg2 = await host.nextMessage() as Record<string, unknown>;
    const both = [msg1, msg2];
    const peerLeft    = both.find((m) => m.type === "peer:left");
    const ctrlChanged = both.find((m) => m.type === "control:changed");
    L.recv("HOST", "peer:left",       `reason="${peerLeft?.reason}"`);
    L.recv("HOST", "control:changed", `allowed=${ctrlChanged?.allowed}`);

    expect(peerLeft, "peer:left should have arrived").toBeDefined();
    expect(ctrlChanged, "control:changed should have arrived").toBeDefined();
    expect(ctrlChanged?.allowed).toBe(false);

    host.close();
  });

  it("client gets peer:left when the host disconnects", async () => {
    L.section("disconnect — host disconnects during session");
    const { host, client } = await pairSession(server.wsUrl);

    L.step("Host closes WebSocket connection");
    host.close();

    const left = await client.nextMessage() as Record<string, unknown>;
    L.recv("CLIENT", "peer:left", `reason="${left.reason}"`);
    expect(left.type).toBe("peer:left");

    client.close();
  });
});
