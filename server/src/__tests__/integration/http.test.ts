/**
 * HTTP API integration tests — each describe-block owns an isolated server
 * on a random OS-assigned port.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectWs } from "../helpers/ws.js";
import { startTestServer, type TestServer } from "../helpers/server.js";
import { post, asJson } from "../helpers/http.js";
import * as L from "../helpers/logger.js";

// ─── GET /health ──────────────────────────────────────────────────────────────

describe("GET /health", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns 200 with ok:true and all required fields", async () => {
    L.section("GET /health — shape check");
    const res = await fetch(`${server.url}/health`);
    L.http("GET", "/health", res.status);
    const body = await asJson(res);
    L.ok("ok",           String(body.ok));
    L.ok("uptimeSec",    String(body.uptimeSec));
    L.ok("sessions",     String(body.sessions));
    L.ok("agents",       String(body.agents));
    L.ok("tokens",       String(body.tokens));
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.sessions).toBe("number");
    expect(typeof body.agents).toBe("number");
    expect(typeof body.tokens).toBe("number");
  });

  it("reports zero counters on a freshly started server", async () => {
    L.section("GET /health — zero counters");
    const body = await asJson(await fetch(`${server.url}/health`));
    L.ok("sessions",     String(body.sessions));
    L.ok("agents",       String(body.agents));
    expect(body.sessions).toBe(0);
    expect(body.agents).toBe(0);
  });

  it("responds to 10 concurrent requests without errors", async () => {
    L.section("GET /health — concurrent load (10 requests)");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => fetch(`${server.url}/health`))
    );
    const statuses = results.map((r) => r.status);
    L.ok("All statuses 200", statuses.every((s) => s === 200) ? "yes" : "no");
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("returns Content-Type application/json", async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});

// ─── OPTIONS /api/* — CORS pre-flight ─────────────────────────────────────────

describe("OPTIONS /api/* — CORS pre-flight", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns 204 with full CORS headers", async () => {
    L.section("OPTIONS /api/sessions/open — CORS headers");
    const res = await fetch(`${server.url}/api/sessions/open`, { method: "OPTIONS" });
    L.http("OPTIONS", "/api/sessions/open", res.status);
    L.ok("Allow-Methods", res.headers.get("access-control-allow-methods") ?? "—");
    L.ok("Allow-Headers", res.headers.get("access-control-allow-headers") ?? "—");
    L.ok("Max-Age",        res.headers.get("access-control-max-age") ?? "—");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Authorization/i);
  });
});

// ─── Method guard ─────────────────────────────────────────────────────────────

describe("HTTP method guard", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns 405 for DELETE on a static route", async () => {
    L.section("Method guard — unsupported method");
    const res = await fetch(`${server.url}/`, { method: "DELETE" });
    L.http("DELETE", "/", res.status);
    expect(res.status).toBe(405);
  });
});

// ─── POST /api/users/login ────────────────────────────────────────────────────

describe("POST /api/users/login — open server", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("registers a user and returns normalised username", async () => {
    L.section("POST /api/users/login — happy path");
    L.send("TEST", "POST /api/users/login", { user: "Alice", displayName: "Alice A" });
    const res = await post(`${server.url}/api/users/login`, { user: "Alice", displayName: "Alice A" });
    const body = await asJson(res);
    L.http("POST", "/api/users/login", res.status);
    L.ok("ok",       String(body.ok));
    L.ok("user",     String(body.user));
    L.ok("agentLive",String(body.agentLive));
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.user).toBe("alice");
    expect(body.agentLive).toBe(false);
  });

  it("normalises username to lowercase", async () => {
    const res = await post(`${server.url}/api/users/login`, { user: "UPPERCASE" });
    const body = await asJson(res);
    L.ok("normalised user", String(body.user));
    expect(body.user).toBe("uppercase");
  });

  it("returns 400 when user field is missing", async () => {
    L.section("POST /api/users/login — missing user");
    L.send("TEST", "POST /api/users/login", {});
    const res = await post(`${server.url}/api/users/login`, {});
    L.http("POST", "/api/users/login", res.status);
    L.error("Validation rejected", "missing-user");
    expect(res.status).toBe(400);
    expect((await asJson(res)).error).toBe("missing-user");
  });

  it("returns 400 when user is whitespace-only", async () => {
    const res = await post(`${server.url}/api/users/login`, { user: "   " });
    expect(res.status).toBe(400);
  });

  it("reports agentLive:true when an agent is already connected", async () => {
    L.section("POST /api/users/login — agentLive flag");
    L.step("Connecting agent WebSocket for 'carol'");
    const agentWs = await connectWs(`${server.wsUrl}/agent`);
    agentWs.send({ type: "agent:hello", user: "carol", agentId: "a-carol" });
    await agentWs.nextMessage();
    L.ok("Agent registered");

    L.send("TEST", "POST /api/users/login", { user: "carol" });
    const res  = await post(`${server.url}/api/users/login`, { user: "carol" });
    const body = await asJson(res);
    L.http("POST", "/api/users/login", res.status);
    L.ok("agentLive", String(body.agentLive));
    expect(body.agentLive).toBe(true);
    agentWs.close();
  });
});

// ─── POST /api/agent/lookup ───────────────────────────────────────────────────

describe("POST /api/agent/lookup — open server", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns live:false when no agent is registered", async () => {
    L.section("POST /api/agent/lookup — offline agent");
    L.send("TEST", "POST /api/agent/lookup", { user: "ghost" });
    const res  = await post(`${server.url}/api/agent/lookup`, { user: "ghost" });
    const body = await asJson(res);
    L.http("POST", "/api/agent/lookup", res.status);
    L.ok("live",  String(body.live));
    L.ok("agent", String(body.agent));
    expect(res.status).toBe(200);
    expect(body.live).toBe(false);
    expect(body.agent).toBeNull();
  });

  it("returns live:true with agent metadata when agent is connected", async () => {
    L.section("POST /api/agent/lookup — live agent");
    L.step("Connecting agent WebSocket for 'dave'");
    const agentWs = await connectWs(`${server.wsUrl}/agent`);
    agentWs.send({ type: "agent:hello", user: "dave", agentId: "agent-dave" });
    await agentWs.nextMessage();
    L.ok("Agent registered");

    L.send("TEST", "POST /api/agent/lookup", { user: "dave" });
    const res  = await post(`${server.url}/api/agent/lookup`, { user: "dave" });
    const body = await asJson<{ live: boolean; agent: { agentId: string; registeredAt: number } }>(res);
    L.http("POST", "/api/agent/lookup", res.status);
    L.ok("live",              String(body.live));
    L.ok("agent.agentId",     body.agent.agentId);
    L.ok("agent.registeredAt",String(body.agent.registeredAt));
    expect(body.live).toBe(true);
    expect(body.agent.agentId).toBe("agent-dave");
    expect(typeof body.agent.registeredAt).toBe("number");
    agentWs.close();
  });
});

// ─── POST /api/sessions/open ──────────────────────────────────────────────────

describe("POST /api/sessions/open — open server", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns 400 when targetUser is missing", async () => {
    L.section("POST /api/sessions/open — missing targetUser");
    const res  = await post(`${server.url}/api/sessions/open`, {});
    L.http("POST", "/api/sessions/open", res.status);
    L.error("Rejected", "missing-targetUser");
    expect(res.status).toBe(400);
    expect((await asJson(res)).error).toBe("missing-targetUser");
  });

  it("returns 404 when the target user has no live agent", async () => {
    L.section("POST /api/sessions/open — agent offline");
    L.send("TEST", "POST /api/sessions/open", { targetUser: "offline-user" });
    const res  = await post(`${server.url}/api/sessions/open`, { targetUser: "offline-user" });
    L.http("POST", "/api/sessions/open", res.status);
    L.error("Rejected", "agent-offline");
    expect(res.status).toBe(404);
    expect((await asJson(res)).error).toBe("agent-offline");
  });

  it("returns 200 with a token and pushes open-session to the agent", async () => {
    L.section("POST /api/sessions/open — full happy path");

    L.step("1. Connecting agent WebSocket for 'eve'");
    const agentWs = await connectWs(`${server.wsUrl}/agent`);
    agentWs.send({ type: "agent:hello", user: "eve", agentId: "agent-eve" });
    await agentWs.nextMessage();
    L.ok("Agent registered");

    L.step("2. Calling POST /api/sessions/open");
    L.send("TEST", "POST /api/sessions/open", { targetUser: "eve", managerName: "Admin" });
    const res  = await post(`${server.url}/api/sessions/open`, { targetUser: "eve", managerName: "Admin" });
    const body = await asJson<{ ok: boolean; token: string; expiresAt: number; user: string }>(res);
    L.http("POST", "/api/sessions/open", res.status);
    L.ok("ok",        String(body.ok));
    L.ok("token",     L.shortToken(body.token));
    L.ok("expiresAt", new Date(body.expiresAt).toISOString());
    L.ok("user",      body.user);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.token).toHaveLength(32);
    expect(body.user).toBe("eve");

    L.step("3. Agent should receive open-session push");
    const push = await agentWs.nextMessage() as Record<string, unknown>;
    L.recv("AGENT", "open-session", `token=${L.shortToken(String(push.token))}`);
    L.ok("push.type", String(push.type));
    L.ok("token matches API response", String(push.token === body.token));
    expect(push.type).toBe("open-session");
    expect(push.token).toBe(body.token);

    agentWs.close();
  });

  it("returns 400 for malformed JSON body", async () => {
    L.section("POST /api/sessions/open — malformed JSON");
    const res = await fetch(`${server.url}/api/sessions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    L.http("POST", "/api/sessions/open", res.status, "malformed body");
    expect(res.status).toBe(400);
  });

  it("rejects oversized bodies (> 16 KB) with 400 or 413", async () => {
    L.section("POST /api/sessions/open — oversized payload");
    const big = "x".repeat(20 * 1024); // 20 KB
    const res = await fetch(`${server.url}/api/sessions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(20 * 1024),
    });
    L.http("POST", "/api/sessions/open", res.status, `raw payload ~20KB`);
    // A well-behaved server must not return 200 for an unparseable/oversized body
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(500);
  });
});

// ─── API authorization ────────────────────────────────────────────────────────

describe("API authorization — token-protected server", () => {
  const TOKEN = "secret-test-token-xyz";
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer({ autopairToken: TOKEN }); });
  afterAll(async ()  => { await server.close(); });

  it("rejects requests with no Authorization header → 401", async () => {
    L.section("Authorization — no token");
    const res = await post(`${server.url}/api/sessions/open`, { targetUser: "x" });
    L.http("POST", "/api/sessions/open", res.status, "no Authorization header");
    expect(res.status).toBe(401);
    expect((await asJson(res)).error).toBe("unauthorized");
  });

  it("rejects requests with the wrong Bearer token → 401", async () => {
    L.section("Authorization — wrong token");
    const res = await post(`${server.url}/api/sessions/open`, { targetUser: "x" }, {
      Authorization: "Bearer wrong-token",
    });
    L.http("POST", "/api/sessions/open", res.status, "wrong Bearer token");
    expect(res.status).toBe(401);
  });

  it("accepts correct Bearer token in Authorization header", async () => {
    L.section("Authorization — correct Bearer token");
    const res = await post(`${server.url}/api/sessions/open`, { targetUser: "x" }, {
      Authorization: `Bearer ${TOKEN}`,
    });
    L.http("POST", "/api/sessions/open", res.status, "auth passed → 404 agent-offline");
    expect(res.status).not.toBe(401);
  });

  it("accepts correct token via ?key= query parameter", async () => {
    L.section("Authorization — ?key= query param");
    const res = await post(`${server.url}/api/sessions/open?key=${TOKEN}`, { targetUser: "x" });
    L.http("POST", `/api/sessions/open?key=${TOKEN.slice(0, 6)}…`, res.status);
    expect(res.status).not.toBe(401);
  });

  it("protects /api/users/login", async () => {
    const res = await post(`${server.url}/api/users/login`, { user: "frank" });
    L.http("POST", "/api/users/login", res.status, "no token → 401");
    expect(res.status).toBe(401);
  });

  it("protects /api/agent/lookup", async () => {
    const res = await post(`${server.url}/api/agent/lookup`, { user: "frank" });
    L.http("POST", "/api/agent/lookup", res.status, "no token → 401");
    expect(res.status).toBe(401);
  });
});

// ─── Unknown /api/* route ─────────────────────────────────────────────────────

describe("Unknown /api/* route", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns 404 ok:false not-found", async () => {
    L.section("Unknown API route");
    const res = await post(`${server.url}/api/does-not-exist`, {});
    L.http("POST", "/api/does-not-exist", res.status);
    const body = await asJson(res);
    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not-found");
  });
});

// ─── /install/bootstrap.ps1 ───────────────────────────────────────────────────

describe("GET /install/bootstrap.ps1", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns 400 when ?user is missing", async () => {
    L.section("GET /install/bootstrap.ps1 — missing user param");
    const res = await fetch(`${server.url}/install/bootstrap.ps1`);
    L.http("GET", "/install/bootstrap.ps1", res.status, "no ?user");
    expect(res.status).toBe(400);
  });

  it("returns a valid PowerShell script with user embedded", async () => {
    L.section("GET /install/bootstrap.ps1 — happy path");
    L.step("Requesting script for user 'alice'");
    const res  = await fetch(`${server.url}/install/bootstrap.ps1?user=alice`);
    const text = await res.text();
    L.http("GET", "/install/bootstrap.ps1?user=alice", res.status);
    L.ok("Content-Type",    res.headers.get("content-type") ?? "—");
    L.ok("Cache-Control",   res.headers.get("cache-control") ?? "—");
    L.ok("Contains $VEAdminUser", String(text.includes("$VEAdminUser")));
    L.ok("Contains 'alice'",      String(text.includes("alice")));
    expect(res.status).toBe(200);
    expect(text).toContain("$VEAdminUser");
    expect(text).toContain("alice");
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sanitises the username — strips special characters", async () => {
    L.section("GET /install/bootstrap.ps1 — username sanitisation");
    const res  = await fetch(`${server.url}/install/bootstrap.ps1?user=../../etc/passwd`);
    L.http("GET", "/install/bootstrap.ps1?user=…etc/passwd", res.status);
    if (res.status === 200) {
      const text = await res.text();
      expect(text).not.toContain("../");
      L.ok("Path traversal characters stripped from script");
    } else {
      L.ok("Rejected entirely with", String(res.status));
      expect(res.status).toBe(400);
    }
  });
});

// ─── /install/agent/<file> ────────────────────────────────────────────────────

describe("GET /install/agent/:file — allow-list enforcement", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("returns 404 for a filename not in the allow-list (.env)", async () => {
    L.section("GET /install/agent/.env — not in allow-list");
    const res = await fetch(`${server.url}/install/agent/.env`);
    L.http("GET", "/install/agent/.env", res.status, "blocked — not in ALLOWED set");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a filename with path separators", async () => {
    L.section("GET /install/agent/a/b — slash in name");
    const res = await fetch(`${server.url}/install/agent/a/b`);
    L.http("GET", "/install/agent/a/b", res.status, "blocked — contains '/'");
    expect(res.status).toBe(404);
  });

  it("returns 404 for URL-encoded path separators (%2F)", async () => {
    L.section("GET /install/agent/..%2Fetc — encoded slash attack");
    const res = await fetch(`${server.url}/install/agent/..%2Fetc%2Fpasswd`);
    L.http("GET", "/install/agent/..%2Fetc%2Fpasswd", res.status, "blocked — encoded traversal");
    expect(res.status).toBe(404);
  });
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────

describe("Static file serving / SPA fallback", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async ()  => { await server.close(); });

  it("never returns an unhandled exception for an unknown path", async () => {
    L.section("SPA fallback — unknown path handled gracefully");
    const res = await fetch(`${server.url}/this-page-does-not-exist`);
    L.http("GET", "/this-page-does-not-exist", res.status, "SPA fallback or 404");
    // Either SPA index.html (200) or 404 plain-text — never a 5xx crash
    expect([200, 404]).toContain(res.status);
  });
});
