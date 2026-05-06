import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../../session-manager.js";
import { mockWs } from "../helpers/mock-ws.js";
import * as L from "../helpers/logger.js";

// ─── tests ────────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
  let sm: SessionManager;
  beforeEach(() => { sm = new SessionManager(); });

  // ── attach / getContext ──────────────────────────────────────────────────

  describe("attach / getContext", () => {
    it("creates a fresh context for a new socket", () => {
      L.section("attach — initialises WsContext");
      const ws = mockWs();
      L.step("Attaching new mock WebSocket");
      const ctx = sm.attach(ws);
      L.ok("Context created", JSON.stringify(ctx));
      expect(ctx).toMatchObject({ sessionCode: null, role: null, pendingRequestId: null });
      expect(sm.getContext(ws)).toBe(ctx);
    });

    it("returns undefined for an unknown socket", () => {
      const ws = mockWs();
      expect(sm.getContext(ws)).toBeUndefined();
    });
  });

  // ── createSession ────────────────────────────────────────────────────────

  describe("createSession", () => {
    it("returns a session with a 6-character code and correct defaults", () => {
      L.section("createSession — session initialisation");
      const ws = mockWs();
      sm.attach(ws);
      L.step("Creating session for host 'Alice'");
      const s = sm.createSession(ws, "Alice");
      L.ok("Session code", s.code);
      L.ok("Host name",    s.hostName);
      L.ok("clientWs",     String(s.clientWs));
      L.ok("allowControl", String(s.allowControl));
      expect(s.code).toHaveLength(6);
      expect(s.hostName).toBe("Alice");
      expect(s.clientWs).toBeNull();
      expect(s.allowControl).toBe(false);
    });

    it("sets host role in the WsContext", () => {
      const ws = mockWs();
      sm.attach(ws);
      const s = sm.createSession(ws, "Alice");
      expect(sm.getContext(ws)).toMatchObject({ role: "host", sessionCode: s.code });
    });

    it("falls back to 'Host' when name is empty", () => {
      const ws = mockWs();
      sm.attach(ws);
      expect(sm.createSession(ws, "").hostName).toBe("Host");
    });

    it("generates unique codes across 30 concurrent sessions", () => {
      L.section("createSession — unique codes under load");
      const codes = new Set<string>();
      for (let i = 0; i < 30; i++) {
        const ws = mockWs();
        sm.attach(ws);
        codes.add(sm.createSession(ws, `H${i}`).code);
      }
      L.ok(`30 sessions → ${codes.size} unique codes`);
      expect(codes.size).toBe(30);
    });
  });

  // ── registerRequest ──────────────────────────────────────────────────────

  describe("registerRequest", () => {
    it("succeeds with a valid code and populates pendingRequestId", () => {
      L.section("registerRequest — happy path");
      const hostWs = mockWs();
      sm.attach(hostWs);
      const { code } = sm.createSession(hostWs, "Host");

      const clientWs = mockWs();
      sm.attach(clientWs);
      L.step("Client joining with code", code);
      const r = sm.registerRequest(clientWs, code, "Client");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      L.ok("requestId", r.requestId);
      expect(sm.getContext(clientWs)?.pendingRequestId).toBe(r.requestId);
    });

    it("normalises code before lookup (lowercase + hyphens)", () => {
      L.section("registerRequest — code normalisation");
      const hostWs = mockWs();
      sm.attach(hostWs);
      const { code } = sm.createSession(hostWs, "Host");
      const raw = `${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()}`;
      L.step("Raw input", raw);
      L.step("Expected normalised", code);
      const clientWs = mockWs();
      sm.attach(clientWs);
      expect(sm.registerRequest(clientWs, raw, "Client").ok).toBe(true);
      L.ok("Lookup succeeded after normalisation");
    });

    it("fails with invalid-code for an unknown session code", () => {
      L.section("registerRequest — invalid code");
      const ws = mockWs();
      sm.attach(ws);
      L.error("Trying unknown code", "ZZZZZZ");
      const r = sm.registerRequest(ws, "ZZZZZZ", "Client");
      L.ok("Error code", (r as { reason: string }).reason);
      expect(r).toMatchObject({ ok: false, reason: "invalid-code" });
    });

    it("fails with session-full when a client is already connected", () => {
      L.section("registerRequest — session-full guard");
      const hostWs = mockWs();
      sm.attach(hostWs);
      const { code, pending } = sm.createSession(hostWs, "Host");

      const c1 = mockWs(); sm.attach(c1);
      sm.registerRequest(c1, code, "C1");
      sm.approveRequest(hostWs, [...pending.keys()][0]!);
      L.step("First client approved — session is full");

      const c2 = mockWs(); sm.attach(c2);
      const r = sm.registerRequest(c2, code, "C2");
      L.error("Second join attempt", "session-full");
      expect(r).toMatchObject({ ok: false, reason: "session-full" });
    });
  });

  // ── approveRequest ───────────────────────────────────────────────────────

  describe("approveRequest", () => {
    function setup() {
      const hostWs = mockWs(); sm.attach(hostWs);
      const session = sm.createSession(hostWs, "Host");
      const clientWs = mockWs(); sm.attach(clientWs);
      sm.registerRequest(clientWs, session.code, "Client");
      const requestId = [...session.pending.keys()][0]!;
      return { hostWs, clientWs, session, requestId };
    }

    it("promotes client into session and clears pending map", () => {
      L.section("approveRequest — happy path");
      const { hostWs, clientWs, session, requestId } = setup();
      L.step("Approving request", requestId.slice(0, 8) + "…");
      const r = sm.approveRequest(hostWs, requestId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      L.ok("session.clientWs set", "✓");
      L.ok("pending map empty",    String(session.pending.size === 0));
      expect(r.clientWs).toBe(clientWs);
      expect(session.clientWs).toBe(clientWs);
      expect(session.pending.size).toBe(0);
    });

    it("sets client role in WsContext after approval", () => {
      const { hostWs, clientWs, requestId } = setup();
      sm.approveRequest(hostWs, requestId);
      expect(sm.getContext(clientWs)).toMatchObject({ role: "client", pendingRequestId: null });
    });

    it("returns not-host for a socket without a session", () => {
      const ws = mockWs(); sm.attach(ws);
      expect(sm.approveRequest(ws, "x")).toMatchObject({ ok: false, reason: "not-host" });
    });

    it("returns no-pending-request for an unknown requestId", () => {
      const { hostWs } = setup();
      expect(sm.approveRequest(hostWs, "bad")).toMatchObject({ ok: false, reason: "no-pending-request" });
    });

    it("returns session-full when a client is already connected", () => {
      L.section("approveRequest — session-full after double approve");
      const { hostWs, session, requestId } = setup();
      sm.approveRequest(hostWs, requestId);
      const c2 = mockWs(); sm.attach(c2);
      sm.registerRequest(c2, session.code, "C2");
      const reqId2 = [...session.pending.keys()][0]!;
      L.error("Approving second client while session is full");
      expect(sm.approveRequest(hostWs, reqId2)).toMatchObject({ ok: false, reason: "session-full" });
    });
  });

  // ── rejectRequest ────────────────────────────────────────────────────────

  describe("rejectRequest", () => {
    it("removes the pending request and returns clientWs", () => {
      L.section("rejectRequest — host rejects client");
      const hostWs = mockWs(); sm.attach(hostWs);
      const { code, pending } = sm.createSession(hostWs, "Host");
      const clientWs = mockWs(); sm.attach(clientWs);
      sm.registerRequest(clientWs, code, "Client");
      const requestId = [...pending.keys()][0]!;
      L.step("Rejecting request", requestId.slice(0, 8) + "…");
      const r = sm.rejectRequest(hostWs, requestId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      L.ok("clientWs returned", "✓");
      L.ok("pending map empty", String(pending.size === 0));
      expect(r.clientWs).toBe(clientWs);
      expect(pending.size).toBe(0);
    });

    it("returns not-host for a non-host socket", () => {
      const ws = mockWs(); sm.attach(ws);
      expect(sm.rejectRequest(ws, "x")).toMatchObject({ ok: false, reason: "not-host" });
    });

    it("returns no-pending-request for unknown requestId", () => {
      const hostWs = mockWs(); sm.attach(hostWs);
      sm.createSession(hostWs, "Host");
      expect(sm.rejectRequest(hostWs, "bad")).toMatchObject({ ok: false, reason: "no-pending-request" });
    });
  });

  // ── endSession / setControl / peerOf / cancelRequest ────────────────────

  describe("endSession", () => {
    it("removes the session and resets host context", () => {
      L.section("endSession");
      const hostWs = mockWs(); sm.attach(hostWs);
      const { code } = sm.createSession(hostWs, "Host");
      L.step("Ending session", code);
      const result = sm.endSession(hostWs);
      L.ok("Session returned", result?.code ?? "null");
      expect(result?.code).toBe(code);
      expect(sm.getContext(hostWs)).toMatchObject({ role: null, sessionCode: null });
    });

    it("returns null for a non-host socket", () => {
      const ws = mockWs(); sm.attach(ws);
      expect(sm.endSession(ws)).toBeNull();
    });
  });

  describe("setControl", () => {
    it("toggles allowControl on the session", () => {
      L.section("setControl — toggle remote input");
      const hostWs = mockWs(); sm.attach(hostWs);
      const session = sm.createSession(hostWs, "Host");
      sm.setControl(hostWs, true);
      L.ok("allowControl after true",  String(session.allowControl));
      expect(session.allowControl).toBe(true);
      sm.setControl(hostWs, false);
      L.ok("allowControl after false", String(session.allowControl));
      expect(session.allowControl).toBe(false);
    });

    it("returns null for a non-host socket", () => {
      const ws = mockWs(); sm.attach(ws);
      expect(sm.setControl(ws, true)).toBeNull();
    });
  });

  describe("peerOf", () => {
    it("returns the paired peer from both sides", () => {
      L.section("peerOf — bidirectional peer lookup");
      const hostWs = mockWs(); sm.attach(hostWs);
      const { code, pending } = sm.createSession(hostWs, "Host");
      const clientWs = mockWs(); sm.attach(clientWs);
      sm.registerRequest(clientWs, code, "Client");
      sm.approveRequest(hostWs, [...pending.keys()][0]!);
      L.ok("peerOf(host)   → clientWs", "✓");
      L.ok("peerOf(client) → hostWs",   "✓");
      expect(sm.peerOf(hostWs)).toBe(clientWs);
      expect(sm.peerOf(clientWs)).toBe(hostWs);
    });

    it("returns null before pairing or while pending", () => {
      const ws = mockWs(); sm.attach(ws);
      expect(sm.peerOf(ws)).toBeNull();
    });
  });

  describe("cancelRequest", () => {
    it("removes the pending entry and clears client context", () => {
      L.section("cancelRequest — client cancels before approval");
      const hostWs = mockWs(); sm.attach(hostWs);
      const { code, pending } = sm.createSession(hostWs, "Host");
      const clientWs = mockWs(); sm.attach(clientWs);
      sm.registerRequest(clientWs, code, "Client");
      L.step("Pending requests before cancel", String(pending.size));
      sm.cancelRequest(clientWs);
      L.ok("Pending requests after cancel",  String(pending.size));
      expect(pending.size).toBe(0);
      expect(sm.getContext(clientWs)?.pendingRequestId).toBeNull();
    });
  });

  // ── agent management ─────────────────────────────────────────────────────

  describe("agent management", () => {
    it("registers, looks up, and unregisters an agent", () => {
      L.section("agent lifecycle — register → lookup → unregister");
      const ws = mockWs();
      sm.registerAgent(ws, "alice", "agent-1");
      L.step("Registered alice / agent-1");
      const entry = sm.lookupAgent("alice");
      L.ok("lookupAgent('alice')", entry?.agentId ?? "null");
      expect(entry?.agentId).toBe("agent-1");

      sm.unregisterAgent(ws);
      L.ok("After unregister → lookupAgent returns null", String(sm.lookupAgent("alice") === null));
      expect(sm.lookupAgent("alice")).toBeNull();
    });

    it("lookup is case-insensitive", () => {
      const ws = mockWs();
      sm.registerAgent(ws, "  Alice  ", "agent-1");
      expect(sm.lookupAgent("ALICE")).not.toBeNull();
      expect(sm.lookupAgent("alice")).not.toBeNull();
    });

    it("replaces previous agent registered under the same username", () => {
      L.section("agent replacement — same user, new socket");
      const ws1 = mockWs();
      const ws2 = mockWs();
      sm.registerAgent(ws1, "alice", "old");
      L.step("Registered old agent");
      sm.registerAgent(ws2, "alice", "new");
      L.ok("New agent replaces old", sm.lookupAgent("alice")?.agentId ?? "null");
      expect(sm.lookupAgent("alice")?.agentId).toBe("new");
    });

    it("returns null for an unknown username", () => {
      expect(sm.lookupAgent("nobody")).toBeNull();
    });
  });

  // ── pairing tokens ───────────────────────────────────────────────────────

  describe("pairing tokens", () => {
    it("mints a token with a 32-char ID and future expiry", () => {
      L.section("mintToken — token structure");
      const token = sm.mintToken("alice", "Manager");
      L.ok("Token length", String(token.token.length));
      L.ok("expiresAt > now", String(token.expiresAt > Date.now()));
      expect(token.token).toHaveLength(32);
      expect(token.expiresAt).toBeGreaterThan(Date.now());
    });

    it("full auto-pair flow A: client queues first, host claims second", () => {
      L.section("auto-pair flow A — client queues before host");
      const { token } = sm.mintToken("alice", "Manager");

      L.step("1. Client claims token (no host yet)");
      const clientWs = mockWs(); sm.attach(clientWs);
      const r1 = sm.claimTokenAsClient(clientWs, token, "Manager");
      L.ok("Client status", String(r1.ok));
      expect(r1.ok).toBe("queued");

      L.step("2. Host claims token — sees queued client");
      const hostWs = mockWs(); sm.attach(hostWs);
      const r2 = sm.claimTokenAsHost(hostWs, token, "Host");
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      L.ok("Host session code",  r2.session.code);
      L.ok("pairedClient set",   String(r2.pairedClient === clientWs));
      expect(r2.pairedClient).toBe(clientWs);
    });

    it("full auto-pair flow B: host claims first, client second", () => {
      L.section("auto-pair flow B — host claims before client");
      const { token } = sm.mintToken("alice", "Manager");

      L.step("1. Host claims token first");
      const hostWs = mockWs(); sm.attach(hostWs);
      const r1 = sm.claimTokenAsHost(hostWs, token, "Host");
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      L.ok("Session created", r1.session.code);
      expect(r1.pairedClient).toBeNull();

      L.step("2. Client claims token — host already has session");
      const clientWs = mockWs(); sm.attach(clientWs);
      const r2 = sm.claimTokenAsClient(clientWs, token, "Manager");
      L.ok("Client paired immediately", String(r2.ok));
      expect(r2.ok).toBe(true);
      if (r2.ok === true) expect(r2.session.code).toBe(r1.session.code);
    });

    it("returns invalid-token for an unknown or expired token", () => {
      const hostWs = mockWs(); sm.attach(hostWs);
      expect(sm.claimTokenAsHost(hostWs, "bad", "H")).toMatchObject({ ok: false, reason: "invalid-token" });
      const clientWs = mockWs(); sm.attach(clientWs);
      expect(sm.claimTokenAsClient(clientWs, "bad", "C")).toMatchObject({ ok: false, reason: "invalid-token" });
    });

    it("token cannot be claimed as host a second time", () => {
      L.section("token reuse prevention");
      const { token } = sm.mintToken("alice", "M");
      const h1 = mockWs(); sm.attach(h1);
      sm.claimTokenAsHost(h1, token, "H1");
      L.step("First claim succeeds");
      const h2 = mockWs(); sm.attach(h2);
      const r = sm.claimTokenAsHost(h2, token, "H2");
      L.error("Second claim rejected", String(r.ok));
      expect(r).toMatchObject({ ok: false, reason: "invalid-token" });
    });
  });

  // ── onSocketClose ────────────────────────────────────────────────────────

  describe("onSocketClose — disconnect effects", () => {
    function setupPairedSession() {
      const hostWs = mockWs(); sm.attach(hostWs);
      const { code, pending } = sm.createSession(hostWs, "Host");
      const clientWs = mockWs(); sm.attach(clientWs);
      sm.registerRequest(clientWs, code, "Client");
      sm.approveRequest(hostWs, [...pending.keys()][0]!);
      return { hostWs, clientWs };
    }

    it("client-left: returns hostWs when the active client disconnects", () => {
      L.section("onSocketClose — client disconnects");
      const { hostWs, clientWs } = setupPairedSession();
      L.step("Simulating client WebSocket close");
      const effect = sm.onSocketClose(clientWs);
      L.ok("Effect kind", effect.kind);
      expect(effect.kind).toBe("client-left");
      if (effect.kind === "client-left") expect(effect.hostWs).toBe(hostWs);
    });

    it("host-left: returns notify list containing connected client", () => {
      L.section("onSocketClose — host disconnects");
      const { hostWs, clientWs } = setupPairedSession();
      L.step("Simulating host WebSocket close");
      const effect = sm.onSocketClose(hostWs);
      L.ok("Effect kind",           effect.kind);
      if (effect.kind === "host-left") {
        L.ok("Notify list size",    String(effect.notify.length));
        expect(effect.notify).toContain(clientWs);
      }
      expect(effect.kind).toBe("host-left");
    });

    it("none: pending client disconnects silently, pending map cleaned", () => {
      L.section("onSocketClose — pending client disconnects");
      const hostWs = mockWs(); sm.attach(hostWs);
      const { code, pending } = sm.createSession(hostWs, "Host");
      const clientWs = mockWs(); sm.attach(clientWs);
      sm.registerRequest(clientWs, code, "Client");
      L.step("Pending before close", String(pending.size));
      const effect = sm.onSocketClose(clientWs);
      L.ok("Effect kind", effect.kind);
      L.ok("Pending after close", String(pending.size));
      expect(effect.kind).toBe("none");
      expect(pending.size).toBe(0);
    });

    it("none: returns none for an unknown socket", () => {
      const ws = mockWs(); sm.attach(ws);
      expect(sm.onSocketClose(ws).kind).toBe("none");
    });
  });

  // ── snapshot ─────────────────────────────────────────────────────────────

  describe("snapshot", () => {
    it("returns zeroed counts on an empty manager", () => {
      expect(sm.snapshot()).toMatchObject({ sessions: 0, totalPending: 0, agents: 0, tokens: 0 });
    });

    it("counts all entities correctly after setup", () => {
      L.section("snapshot — live counter");
      const hostWs = mockWs(); sm.attach(hostWs);
      const { code } = sm.createSession(hostWs, "Host");
      const clientWs = mockWs(); sm.attach(clientWs);
      sm.registerRequest(clientWs, code, "Client");
      sm.registerAgent(mockWs(), "alice", "a1");
      sm.mintToken("alice", "M");

      const snap = sm.snapshot();
      L.ok("sessions",     String(snap.sessions));
      L.ok("totalPending", String(snap.totalPending));
      L.ok("agents",       String(snap.agents));
      L.ok("tokens",       String(snap.tokens));
      expect(snap).toMatchObject({ sessions: 1, totalPending: 1, agents: 1, tokens: 1 });
    });
  });
});
