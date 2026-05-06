/**
 * End-to-end auto-pair flow tests.
 *
 * Auto-pair is the programmatic way to open a session without manual code
 * exchange.  The sequence is:
 *
 *   1.  POST /api/sessions/open  →  server mints a token and pushes it to the agent
 *   2.  Agent calls  host:claim  →  session created
 *   3.  Manager calls client:claim → auto-paired, both get peer:ready
 *
 * Two ordering variants are tested:
 *   A. Manager (client) claims the token *after* the host has already claimed it.
 *   B. Manager (client) claims the token *before* the host — gets queued,
 *      then host claims and both are instantly paired.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectWs } from "../helpers/ws.js";
import { startTestServer, type TestServer } from "../helpers/server.js";
import { post, asJson } from "../helpers/http.js";
import * as L from "../helpers/logger.js";

// ─── variant A: host claims first, then manager ───────────────────────────────

describe("Auto-pair — host claims first, manager second", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("completes the full pairing sequence", async () => {
    L.section("Auto-pair Variant A — host first, manager second");
    L.step("Actors: Agent (desktop)  ·  Admin API  ·  Host WS  ·  Manager WS");

    // ── Step 1: Register desktop agent ──────────────────────────────────────
    L.divider();
    L.scenario("Step 1 — Desktop agent connects and registers");
    const agentWs = await connectWs(`${server.wsUrl}/agent`);
    L.send("agent", "agent:hello", { user: "alice", agentId: "agent-alice-1" });
    agentWs.send({ type: "agent:hello", user: "alice", agentId: "agent-alice-1" });
    await agentWs.nextMessage(); // agent:registered
    L.recv("server", "agent:registered", "user=alice  agentId=agent-alice-1");

    // ── Step 2: API call to open a session ───────────────────────────────────
    L.divider();
    L.scenario("Step 2 — Admin API opens a session for alice");
    L.http("POST", "/api/sessions/open", 200, `{ targetUser: "alice", managerName: "Admin" }`);
    const openRes = await post(`${server.url}/api/sessions/open`, {
      targetUser: "alice",
      managerName: "Admin",
    });
    expect(openRes.status).toBe(200);
    const { token } = await asJson<{ token: string }>(openRes);
    L.step("Token minted", L.shortToken(token));

    // ── Step 3: Server pushes open-session to agent ──────────────────────────
    L.divider();
    L.scenario("Step 3 — Server pushes open-session command to desktop agent");
    const agentPush = await agentWs.nextMessage() as Record<string, unknown>;
    L.recv("agent", "open-session", `token=${L.shortToken(String(agentPush.token))}  managerName=${agentPush.managerName}`);
    expect(agentPush.type).toBe("open-session");
    expect(agentPush.token).toBe(token);
    expect(agentPush.managerName).toBe("Admin");
    expect(typeof agentPush.expiresAt).toBe("number");
    L.ok("Agent received open-session with correct token and managerName");

    // ── Step 4: Host WebSocket claims the token ──────────────────────────────
    L.divider();
    L.scenario("Step 4 — Host WS claims the auto-pair token");
    const hostWs = await connectWs(`${server.wsUrl}/ws`);
    L.send("host", "host:claim", { token: L.shortToken(token), hostName: "Alice-PC" });
    hostWs.send({ type: "host:claim", token, hostName: "Alice-PC" });

    const sessionCreated = await hostWs.nextMessage() as Record<string, unknown>;
    L.recv("host", "session:created", `code=${sessionCreated.code}`);
    expect(sessionCreated.type).toBe("session:created");
    const code = sessionCreated.code as string;
    expect(code).toHaveLength(6);
    L.ok("Session created", `code=${code}`);

    // ── Step 5: Manager claims the token ────────────────────────────────────
    L.divider();
    L.scenario("Step 5 — Manager (client) WS claims the same token");
    const managerWs = await connectWs(`${server.wsUrl}/ws`);
    L.send("manager", "client:claim", { token: L.shortToken(token), clientName: "Admin" });
    managerWs.send({ type: "client:claim", token, clientName: "Admin" });

    const approved = await managerWs.nextMessage() as Record<string, unknown>;
    L.recv("manager", "request:approved");
    expect(approved.type).toBe("request:approved");
    L.ok("Manager auto-approved — no manual host decision required");

    // ── Step 6: Both sides get peer:ready ────────────────────────────────────
    L.divider();
    L.scenario("Step 6 — Both peers receive peer:ready (WebRTC handshake can start)");
    const hostReady = await hostWs.nextMessage() as Record<string, unknown>;
    L.recv("host", "peer:ready", `role=${hostReady.role}`);
    expect(hostReady.type).toBe("peer:ready");
    expect(hostReady.role).toBe("host");

    const managerReady = await managerWs.nextMessage() as Record<string, unknown>;
    L.recv("manager", "peer:ready", `role=${managerReady.role}`);
    expect(managerReady.type).toBe("peer:ready");
    expect(managerReady.role).toBe("client");

    L.divider();
    L.ok("Variant A complete — 5-step auto-pair succeeded without any manual code exchange");

    agentWs.close(); hostWs.close(); managerWs.close();
  });
});

// ─── variant B: manager claims first (queued), host claims second ─────────────

describe("Auto-pair — manager queues first, host claims second", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("queues the manager then instantly pairs when host claims", async () => {
    L.section("Auto-pair Variant B — manager queues first, host claims second");
    L.step("Race condition scenario: manager arrives before the agent has accepted");

    // ── Step 1: Register agent ───────────────────────────────────────────────
    L.divider();
    L.scenario("Step 1 — Desktop agent registers");
    const agentWs = await connectWs(`${server.wsUrl}/agent`);
    L.send("agent", "agent:hello", { user: "bob", agentId: "agent-bob-1" });
    agentWs.send({ type: "agent:hello", user: "bob", agentId: "agent-bob-1" });
    await agentWs.nextMessage(); // agent:registered
    L.recv("server", "agent:registered", "user=bob");

    // ── Step 2: Open session via API ─────────────────────────────────────────
    L.divider();
    L.scenario("Step 2 — Admin API opens session; token pushed to agent");
    const openRes = await post(`${server.url}/api/sessions/open`, { targetUser: "bob" });
    const { token } = await asJson<{ token: string }>(openRes);
    L.step("Token minted", L.shortToken(token));
    await agentWs.nextMessage(); // consume open-session push
    L.recv("agent", "open-session", `token=${L.shortToken(token)}`);

    // ── Step 3: Manager claims FIRST (before host) ───────────────────────────
    L.divider();
    L.scenario("Step 3 — Manager claims token BEFORE host (gets queued)");
    const managerWs = await connectWs(`${server.wsUrl}/ws`);
    L.send("manager", "client:claim", { token: L.shortToken(token), clientName: "Manager" });
    managerWs.send({ type: "client:claim", token, clientName: "Manager" });
    L.step("Manager is now QUEUED — waiting for host to accept");
    // No reply yet — manager is queued; don't await here

    // ── Step 4: Host now claims the token ────────────────────────────────────
    L.divider();
    L.scenario("Step 4 — Host claims token; queued manager is instantly paired");
    const hostWs = await connectWs(`${server.wsUrl}/ws`);
    L.send("host", "host:claim", { token: L.shortToken(token), hostName: "Bob-PC" });
    hostWs.send({ type: "host:claim", token, hostName: "Bob-PC" });

    const sessionCreated = await hostWs.nextMessage() as Record<string, unknown>;
    L.recv("host", "session:created", `code=${sessionCreated.code}`);
    expect(sessionCreated.type).toBe("session:created");

    // ── Step 5: Manager unblocks — gets approved ─────────────────────────────
    L.divider();
    L.scenario("Step 5 — Queued manager is released with request:approved");
    const approved = await managerWs.nextMessage() as Record<string, unknown>;
    L.recv("manager", "request:approved");
    expect(approved.type).toBe("request:approved");
    L.ok("Queued manager was instantly approved when host claimed");

    // ── Step 6: Both peers receive peer:ready ────────────────────────────────
    L.divider();
    L.scenario("Step 6 — Both peers get peer:ready simultaneously");
    const hostReady = await hostWs.nextMessage() as Record<string, unknown>;
    L.recv("host", "peer:ready", `role=${hostReady.role}`);
    expect(hostReady.type).toBe("peer:ready");
    expect(hostReady.role).toBe("host");

    const managerReady = await managerWs.nextMessage() as Record<string, unknown>;
    L.recv("manager", "peer:ready", `role=${managerReady.role}`);
    expect(managerReady.type).toBe("peer:ready");
    expect(managerReady.role).toBe("client");

    L.divider();
    L.ok("Variant B complete — queue-and-release pairing succeeded");

    agentWs.close(); hostWs.close(); managerWs.close();
  });
});

// ─── error cases ──────────────────────────────────────────────────────────────

describe("Auto-pair error cases", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("host:claim with an invalid token returns error invalid-token", async () => {
    L.section("Auto-pair errors — host:claim with bad token");
    const hostWs = await connectWs(`${server.wsUrl}/ws`);

    L.send("host", "host:claim", { token: "not-a-real-token" });
    hostWs.send({ type: "host:claim", token: "not-a-real-token" });

    const err = await hostWs.nextMessage() as Record<string, unknown>;
    L.recv("server", "error", `code=${err.code}`);

    expect(err.type).toBe("error");
    expect(err.code).toBe("invalid-token");
    L.error("Bogus host:claim rejected", String(err.code));
    hostWs.close();
  });

  it("client:claim with an invalid token returns error invalid-token", async () => {
    L.section("Auto-pair errors — client:claim with bad token");
    const clientWs = await connectWs(`${server.wsUrl}/ws`);

    L.send("manager", "client:claim", { token: "not-a-real-token" });
    clientWs.send({ type: "client:claim", token: "not-a-real-token" });

    const err = await clientWs.nextMessage() as Record<string, unknown>;
    L.recv("server", "error", `code=${err.code}`);

    expect(err.type).toBe("error");
    expect(err.code).toBe("invalid-token");
    L.error("Bogus client:claim rejected", String(err.code));
    clientWs.close();
  });

  it("API returns 404 when target agent is not connected", async () => {
    L.section("Auto-pair errors — target agent offline");

    L.http("POST", "/api/sessions/open", 404, `{ targetUser: "ghost-user" }`);
    const res = await post(`${server.url}/api/sessions/open`, { targetUser: "ghost-user" });
    const body = await asJson(res);
    L.step("Response", `status=${res.status}  error=${body.error}`);

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent-offline");
    L.error("Correctly rejected — agent not in registry", String(body.error));
  });

  it("the same token cannot be claimed twice as host", async () => {
    L.section("Auto-pair errors — duplicate host:claim (token replay)");

    L.step("Setting up agent for charlie...");
    const agentWs = await connectWs(`${server.wsUrl}/agent`);
    agentWs.send({ type: "agent:hello", user: "charlie", agentId: "a-charlie" });
    await agentWs.nextMessage();
    L.recv("server", "agent:registered", "user=charlie");

    L.divider();
    const openRes = await post(`${server.url}/api/sessions/open`, { targetUser: "charlie" });
    const { token } = await asJson<{ token: string }>(openRes);
    L.step("Token minted", L.shortToken(token));
    await agentWs.nextMessage(); // open-session push

    L.divider();
    L.scenario("First host:claim — should succeed");
    const host1 = await connectWs(`${server.wsUrl}/ws`);
    L.send("host1", "host:claim", { token: L.shortToken(token) });
    host1.send({ type: "host:claim", token });
    const created = await host1.nextMessage() as Record<string, unknown>;
    L.recv("host1", "session:created", `code=${created.code}`);
    L.ok("First claim accepted — token consumed");

    L.divider();
    L.scenario("Second host:claim — token already used, must be rejected");
    const host2 = await connectWs(`${server.wsUrl}/ws`);
    L.send("host2", "host:claim", { token: L.shortToken(token) });
    host2.send({ type: "host:claim", token }); // second claim on same token
    const err = await host2.nextMessage() as Record<string, unknown>;
    L.recv("server", "error", `code=${err.code}`);

    expect(err.type).toBe("error");
    expect(err.code).toBe("invalid-token");
    L.error("Token replay correctly rejected", String(err.code));

    agentWs.close(); host1.close(); host2.close();
  });
});

// ─── /health reflects token count ────────────────────────────────────────────

describe("Token count in /health", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("tokens counter increments when a token is minted", async () => {
    L.section("health — token counter increments on /api/sessions/open");

    L.step("Registering agent for diana...");
    const agentWs = await connectWs(`${server.wsUrl}/agent`);
    agentWs.send({ type: "agent:hello", user: "diana", agentId: "a-diana" });
    await agentWs.nextMessage();
    L.recv("server", "agent:registered", "user=diana");

    L.divider();
    L.http("GET", "/health", 200, "snapshot BEFORE token mint");
    const before = await (await fetch(`${server.url}/health`)).json() as Record<string, number>;
    L.step("Tokens before", String(before.tokens));

    L.divider();
    L.http("POST", "/api/sessions/open", 200, `{ targetUser: "diana" }`);
    await post(`${server.url}/api/sessions/open`, { targetUser: "diana" });
    await agentWs.nextMessage(); // consume open-session
    L.step("Token minted and delivered to agent");

    L.divider();
    L.http("GET", "/health", 200, "snapshot AFTER token mint");
    const after = await (await fetch(`${server.url}/health`)).json() as Record<string, number>;
    L.step("Tokens after", String(after.tokens));

    expect(after.tokens).toBe(before.tokens + 1);
    L.ok("Token counter incremented by exactly 1");

    agentWs.close();
  });
});
