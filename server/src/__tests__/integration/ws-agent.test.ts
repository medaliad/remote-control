/**
 * Integration tests for the /agent WebSocket endpoint.
 *
 * The agent channel is used by the local desktop agent to register itself and
 * receive "open-session" commands from the signalling server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectWs, type TestWsClient } from "../helpers/ws.js";
import { startTestServer, type TestServer } from "../helpers/server.js";
import { post, asJson, waitFor } from "../helpers/http.js";
import * as L from "../helpers/logger.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function registerAgent(wsUrl: string, user: string, agentId: string): Promise<TestWsClient> {
  const agent = await connectWs(`${wsUrl}/agent`);
  agent.send({ type: "agent:hello", user, agentId });
  const reply = await agent.nextMessage() as Record<string, unknown>;
  if (reply.type !== "agent:registered") throw new Error(`Expected agent:registered, got ${reply.type}`);
  return agent;
}

// ─── agent:hello ─────────────────────────────────────────────────────────────

describe("agent:hello", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("returns agent:registered with correct user and agentId", async () => {
    L.section("agent:hello — registration handshake");
    L.step("Connecting desktop agent to /agent WebSocket...");
    const agent = await connectWs(`${server.wsUrl}/agent`);

    L.send("agent", "agent:hello", { user: "alice", agentId: "agent-abc" });
    agent.send({ type: "agent:hello", user: "alice", agentId: "agent-abc" });

    const reply = await agent.nextMessage() as Record<string, unknown>;
    L.recv("server", "agent:registered", `user=${reply.user}  agentId=${reply.agentId}`);

    expect(reply.type).toBe("agent:registered");
    expect(reply.user).toBe("alice");
    expect(reply.agentId).toBe("agent-abc");
    L.ok("User and agentId echoed back correctly");
    agent.close();
  });

  it("normalises username to lowercase", async () => {
    L.section("agent:hello — username normalisation");
    const agent = await connectWs(`${server.wsUrl}/agent`);

    L.send("agent", "agent:hello", { user: "UPPERCASE_USER", agentId: "a1" });
    agent.send({ type: "agent:hello", user: "UPPERCASE_USER", agentId: "a1" });

    const reply = await agent.nextMessage() as Record<string, unknown>;
    L.recv("server", "agent:registered", `user=${reply.user}`);

    expect(reply.user).toBe("uppercase_user");
    L.ok("Username lowercased", `"UPPERCASE_USER" → "uppercase_user"`);
    agent.close();
  });

  it("returns error bad-message when user is missing", async () => {
    L.section("agent:hello — missing user field");
    const agent = await connectWs(`${server.wsUrl}/agent`);

    L.send("agent", "agent:hello", { agentId: "a1" });
    agent.send({ type: "agent:hello", agentId: "a1" }); // no user

    const err = await agent.nextMessage() as Record<string, unknown>;
    L.recv("server", "error", `code=${err.code}`);

    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");
    L.error("Validation rejected missing user field", String(err.code));
    agent.close();
  });

  it("returns error bad-message when agentId is missing", async () => {
    L.section("agent:hello — missing agentId field");
    const agent = await connectWs(`${server.wsUrl}/agent`);

    L.send("agent", "agent:hello", { user: "alice" });
    agent.send({ type: "agent:hello", user: "alice" }); // no agentId

    const err = await agent.nextMessage() as Record<string, unknown>;
    L.recv("server", "error", `code=${err.code}`);

    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");
    L.error("Validation rejected missing agentId field", String(err.code));
    agent.close();
  });

  it("silently ignores malformed JSON without crashing the server", async () => {
    L.section("agent:hello — malformed JSON resilience");
    const agent = await connectWs(`${server.wsUrl}/agent`);

    L.step("Sending raw malformed JSON payload...", `"not-json{{{}}}"`);
    agent.ws.send("not-json{{{}}}");

    // Server should not close the connection or send a reply; just stays open
    agent.close();

    L.divider();
    L.step("Verifying server is still healthy after bad input...");
    const health = await fetch(`${server.url}/health`);
    L.http("GET", "/health", health.status, "server survived the bad frame");

    expect(health.status).toBe(200);
    L.ok("Server did not crash — still responding to HTTP requests");
  });
});

// ─── agent:ping ───────────────────────────────────────────────────────────────

describe("agent:ping", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("returns agent:pong in response to agent:ping", async () => {
    L.section("agent:ping — keepalive round-trip");
    L.step("Registering agent for bob...");
    const agent = await registerAgent(server.wsUrl, "bob", "agent-bob");
    L.recv("server", "agent:registered", "user=bob  agentId=agent-bob");

    L.divider();
    L.send("agent", "agent:ping");
    agent.send({ type: "agent:ping" });

    const pong = await agent.nextMessage() as Record<string, unknown>;
    L.recv("server", "agent:pong");

    expect(pong.type).toBe("agent:pong");
    L.ok("Keepalive ping → pong round-trip successful");
    agent.close();
  });
});

// ─── agent lookup via /api/agent/lookup ──────────────────────────────────────

describe("agent presence in /api/agent/lookup", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("is visible in lookup after connecting", async () => {
    L.section("agent lookup — agent appears after connect");
    L.step("Registering agent for carol...");
    const agent = await registerAgent(server.wsUrl, "carol", "agent-carol");
    L.recv("server", "agent:registered", "user=carol  agentId=agent-carol");

    L.divider();
    L.http("POST", "/api/agent/lookup", 200, `{ user: "carol" }`);
    const res = await post(`${server.url}/api/agent/lookup`, { user: "carol" });
    const body = await asJson(res);
    const agentInfo = body.agent as Record<string, unknown>;
    L.step("Response", `live=${body.live}  agentId=${agentInfo?.agentId}`);

    expect(body.live).toBe(true);
    expect(agentInfo.agentId).toBe("agent-carol");
    L.ok("Agent correctly listed as live in the registry");

    agent.close();
  });

  it("is removed from lookup after disconnecting", async () => {
    L.section("agent lookup — agent disappears after disconnect");
    L.step("Registering agent for dave...");
    const agent = await registerAgent(server.wsUrl, "dave", "agent-dave");
    L.recv("server", "agent:registered", "user=dave  agentId=agent-dave");

    L.divider();
    L.step("Closing agent WebSocket connection...");
    agent.close();
    await agent.waitClose();

    // Poll until the registry actually drops the entry — replaces the brittle
    // `setTimeout(50)` that used to live here.
    await waitFor(async () => {
      const r = await post(`${server.url}/api/agent/lookup`, { user: "dave" });
      return (await asJson(r)).live === false;
    });
    L.step("Registry entry cleaned up by server");

    L.divider();
    L.http("POST", "/api/agent/lookup", 200, `{ user: "dave" }`);
    const res = await post(`${server.url}/api/agent/lookup`, { user: "dave" });
    const body = await asJson(res);
    L.step("Response", `live=${body.live}`);

    expect(body.live).toBe(false);
    L.ok("Agent correctly removed from registry on disconnect");
  });
});

// ─── agent replacement ────────────────────────────────────────────────────────

describe("agent replacement", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("the new agent supersedes the old one for the same username", async () => {
    L.section("agent replacement — second registration wins");
    L.step("Registering FIRST agent for eve...", "agentId=old-agent");
    const agent1 = await registerAgent(server.wsUrl, "eve", "old-agent");
    L.recv("server", "agent:registered", "user=eve  agentId=old-agent");

    L.divider();
    L.step("Registering SECOND agent for eve (same user)...", "agentId=new-agent");
    const agent2 = await registerAgent(server.wsUrl, "eve", "new-agent");
    L.recv("server", "agent:registered", "user=eve  agentId=new-agent");

    L.step("Server should close the old agent connection automatically...");
    await expect(agent1.waitClose(2_000)).resolves.toBeUndefined();
    L.ok("Old agent connection closed by server");

    L.divider();
    L.http("POST", "/api/agent/lookup", 200, `{ user: "eve" }`);
    const res = await post(`${server.url}/api/agent/lookup`, { user: "eve" });
    const body = await asJson(res);
    const agentInfo = body.agent as Record<string, unknown>;
    L.step("Active agent", `agentId=${agentInfo?.agentId}`);

    expect(agentInfo.agentId).toBe("new-agent");
    L.ok("Registry points to the NEW agent — old entry fully replaced");

    agent2.close();
  });
});

// ─── health counter ───────────────────────────────────────────────────────────

describe("agent count in /health", () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  it("increments agents counter when agent registers", async () => {
    L.section("health — agent counter increments on registration");

    L.http("GET", "/health", 200, "snapshot BEFORE registration");
    const before = await (await fetch(`${server.url}/health`)).json() as Record<string, number>;
    L.step("Agents before", String(before.agents));

    L.divider();
    L.step("Registering agent for frank...", "agentId=a-frank");
    const agent = await registerAgent(server.wsUrl, "frank", "a-frank");
    L.recv("server", "agent:registered", "user=frank  agentId=a-frank");

    L.divider();
    L.http("GET", "/health", 200, "snapshot AFTER registration");
    const after = await (await fetch(`${server.url}/health`)).json() as Record<string, number>;
    L.step("Agents after", String(after.agents));

    expect(after.agents).toBe(before.agents + 1);
    L.ok("Health counter incremented by exactly 1");
    agent.close();
  });
});
