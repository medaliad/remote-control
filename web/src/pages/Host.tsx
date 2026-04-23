import { useCallback, useEffect, useRef, useState } from "react";
import { Signaling } from "../lib/signaling";
import { Peer, type InputEvent } from "../lib/webrtc";

/**
 * Local agent (agent/agent.js) is a small Node process running on the host
 * machine. It injects mouse events using whatever's available per platform:
 * on Windows a persistent PowerShell calling user32.dll (or, with BACKEND=vb6,
 * MouseControl.exe); on macOS an osascript helper; on Linux xdotool.
 *
 * Coupling stays tight: the agent binds to 127.0.0.1 only, checks the browser's
 * Origin header against ALLOWED_ORIGIN, and the browser only talks to loopback.
 * No rogue tab can drive the mouse just because you left control toggled on.
 */
const AGENT_WS_URL = "ws://127.0.0.1:8766";

/**
 * Host state machine. One kind at a time — tagged union means the UI can
 * exhaustively render for the current kind and nothing else. This is what
 * makes the "Session created / Waiting / Incoming / Connected / Disconnected"
 * spec sharp instead of a pile of boolean flags.
 */
type HostState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "waiting"; code: string }
  | { kind: "request"; code: string; requestId: string; clientName: string }
  | { kind: "connecting"; code: string }
  | { kind: "connected"; code: string; clientName: string }
  | { kind: "disconnected"; reason: string };

export function HostPage() {
  const [state, setState] = useState<HostState>({ kind: "idle" });
  const [hostName, setHostName] = useState("Host");
  const [allowControl, setAllowControl] = useState(false);
  const [incomingLog, setIncomingLog] = useState<string[]>([]);

  /**
   * Agent status:
   *   "off"         -- we haven't tried to connect yet
   *   "connecting"  -- WebSocket is opening
   *   "warming"     -- WS is up, but the backend (e.g. PowerShell on Windows,
   *                    or the VB6 TCP link) is not ready to inject yet
   *   "up"          -- WS open AND backend ready -- cursor will move
   *   "down"        -- couldn't reach the local agent at all
   */
  const [agentStatus, setAgentStatus] =
    useState<"off" | "connecting" | "warming" | "up" | "down">("off");
  const [agentBackend, setAgentBackend] = useState<string>("");

  const signalingRef = useRef<Signaling | null>(null);
  const peerRef      = useRef<Peer | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const agentRef     = useRef<WebSocket | null>(null);

  const videoRef     = useRef<HTMLVideoElement | null>(null);

  /** Close the local-agent WebSocket. Safe to call when it's already closed. */
  const closeAgent = useCallback(() => {
    const ws = agentRef.current;
    agentRef.current = null;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
    setAgentStatus("off");
  }, []);

  /**
   * Open (or reuse) a WebSocket to the local agent. The agent hands us
   * live status about whether the VB6 program is attached; we mirror that
   * into `agentStatus` so the operator can see it.
   */
  const ensureAgent = useCallback(() => {
    const existing = agentRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return existing;
    }

    setAgentStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(AGENT_WS_URL);
    } catch (err) {
      console.warn("[host] agent ws construct failed:", err);
      setAgentStatus("down");
      return null;
    }

    // Until the agent's first status message lands we're "warming" -- the
    // WebSocket is up but we don't yet know if the backend (PowerShell / VB6)
    // can actually inject events. The first `agent:status` upgrades us to
    // "up" or keeps us "warming" accordingly.
    ws.onopen    = () => setAgentStatus((s) => (s === "up" ? s : "warming"));
    ws.onerror   = () => setAgentStatus("down");
    ws.onclose   = () => {
      if (agentRef.current === ws) {
        agentRef.current = null;
        setAgentStatus((s) => (s === "off" ? s : "down"));
      }
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          backend?: string;
          ready?: boolean;
          // Legacy field, still present in old agent builds.
          connected?: boolean;
        };
        if (msg.type === "agent:status" || msg.type === "agent:vb6") {
          const isReady = msg.ready ?? msg.connected ?? false;
          setAgentStatus(isReady ? "up" : "warming");
          if (msg.backend) setAgentBackend(msg.backend);
        }
      } catch { /* non-JSON -- ignore */ }
    };

    agentRef.current = ws;
    return ws;
  }, []);

  /** Tear everything down. Idempotent. */
  const hardDisconnect = useCallback((reason: string) => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
    closeAgent();
    setAllowControl(false);
    setIncomingLog([]);
    setState({ kind: "disconnected", reason });
  }, [closeAgent]);

  /* ── Create session ─────────────────────────────────────────────────── */

  const createSession = useCallback(async () => {
    setState({ kind: "creating" });

    const sig = new Signaling();
    signalingRef.current = sig;

    try {
      await sig.connect();
    } catch {
      hardDisconnect("Could not reach the server.");
      return;
    }

    // Once the server hands us a code, we move to "waiting for request".
    sig.on("session:created", (msg) => {
      setState({ kind: "waiting", code: msg.code });
    });

    sig.on("request:incoming", (msg) => {
      setIncomingLog((l) => [`${fmtTime(msg.at)} — ${msg.clientName} asked to connect`, ...l].slice(0, 5));
      // We only surface one request at a time in the UI. If a second one
      // arrives while we're deciding on the first, it gets queued into the
      // log but we keep showing the first — approve/reject fires a fresh
      // "request:incoming" if any are still pending.
      setState((s) => {
        if (s.kind === "waiting") {
          return { kind: "request", code: s.code, requestId: msg.requestId, clientName: msg.clientName };
        }
        return s;
      });
    });

    sig.on("peer:ready", async () => {
      // Approved — start capturing the screen and wire up the peer connection.
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        streamRef.current = stream;

        const peer = new Peer(sig, "host", {
          onInput:        handleRemoteInput,
          onConnectionStateChange: (s) => {
            if (s === "failed" || s === "closed" || s === "disconnected") {
              // Only tear the session down on a hard failure. Transient
              // "disconnected" usually recovers on its own, so we give it a
              // moment via the server's peer:left, which is the source of truth.
              if (s === "failed" || s === "closed") hardDisconnect("WebRTC session ended.");
            }
          },
        });
        peerRef.current = peer;
        peer.addScreenStream(stream);

        // Attach the stream to our own preview so the host sees what's being
        // shared — same experience as Google Meet etc.
        if (videoRef.current) videoRef.current.srcObject = stream;

        // If the user stops sharing via the browser's native "Stop sharing"
        // button, we tear the session down cleanly.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          hardDisconnect("You stopped sharing your screen.");
        });

        // Reflect our approval flag to the client.
        sig.send({ type: "host:setControl", allowed: allowControl });

        setState((s) =>
          s.kind === "request" || s.kind === "waiting"
            ? { kind: "connected", code: s.kind === "request" ? s.code : s.code, clientName: s.kind === "request" ? s.clientName : "Client" }
            : s,
        );
      } catch (err) {
        console.error("[host] getDisplayMedia:", err);
        // User dismissed the picker / permissions denied. Tell the client.
        sig.send({ type: "host:end" });
        hardDisconnect("Screen share was cancelled.");
      }
    });

    sig.on("signal", (msg) => { void peerRef.current?.handleRemoteSignal(msg.data); });

    sig.on("peer:left", (msg) => {
      // Client disconnected. Keep the session alive — we can accept a new
      // request. Drop the video preview.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setState((s) => {
        if (s.kind === "connected" || s.kind === "connecting" || s.kind === "request") {
          return { kind: "waiting", code: s.code };
        }
        return s;
      });
      setIncomingLog((l) => [`${fmtTime(Date.now())} — client left (${msg.reason})`, ...l].slice(0, 5));
    });

    sig.on("error", (msg) => {
      console.error("[host] server error:", msg);
      setIncomingLog((l) => [`${fmtTime(Date.now())} — error: ${msg.message}`, ...l].slice(0, 5));
    });

    sig.onceClosed().then((reason) => {
      if (state.kind !== "disconnected") hardDisconnect(`Connection closed: ${reason}`);
    });

    sig.send({ type: "host:create", hostName });
  }, [hostName, allowControl, hardDisconnect, state.kind]);

  /* ── Handle remote (client) input events ────────────────────────────── */
  //
  // Mouse and wheel events are forwarded to the local agent, which relays
  // them to the VB6 program and into Windows via SetCursorPos / mouse_event.
  // If the agent isn't up we silently fall back to logging -- the operator
  // still sees something happened, they just won't see the cursor move.
  const handleRemoteInput = useCallback((ev: InputEvent) => {
    if (!allowControl) return; // defensive: client shouldn't have sent this
    if (ev.t === "hello") return;

    // 1) Forward anything mouse-shaped to the local agent.
    if (ev.t === "mouse" || ev.t === "wheel") {
      const ws = agentRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(ev)); } catch { /* agent will reconnect */ }
      }
    }

    // 2) Keep a short event trail for the sidebar regardless.
    const line =
      ev.t === "mouse" ? `mouse ${ev.kind}${ev.button != null ? ` btn=${ev.button}` : ""} @${(ev.x * 100).toFixed(1)}%,${(ev.y * 100).toFixed(1)}%`
      : ev.t === "key" ? `key ${ev.kind} ${ev.key}`
      : ev.t === "wheel" ? `wheel dx=${ev.dx} dy=${ev.dy}`
      : "input";
    setIncomingLog((l) => [`${fmtTime(Date.now())} — ${line}`, ...l].slice(0, 8));
  }, [allowControl]);

  /* ── Host actions ───────────────────────────────────────────────────── */

  const approveRequest = () => {
    if (state.kind !== "request") return;
    signalingRef.current?.send({ type: "host:approve", requestId: state.requestId });
    setState({ kind: "connecting", code: state.code });
  };
  const rejectRequest = (reason?: string) => {
    if (state.kind !== "request") return;
    signalingRef.current?.send({ type: "host:reject", requestId: state.requestId, reason });
    setState({ kind: "waiting", code: state.code });
  };
  const endSession = () => {
    signalingRef.current?.send({ type: "host:end" });
    hardDisconnect("You ended the session.");
  };

  const toggleControl = () => {
    const next = !allowControl;
    setAllowControl(next);
    signalingRef.current?.send({ type: "host:setControl", allowed: next });
    if (next) ensureAgent();
    else closeAgent();
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
  };
  const copyShareLink = (code: string) => {
    const url = `${window.location.origin}${window.location.pathname}#/client?code=${code}`;
    navigator.clipboard.writeText(url).catch(() => {});
  };

  /* ── Cleanup on unmount ─────────────────────────────────────────────── */
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    peerRef.current?.close();
    signalingRef.current?.close();
    try { agentRef.current?.close(); } catch { /* ignore */ }
  }, []);

  /* ── Render ─────────────────────────────────────────────────────────── */

  // Idle — the "Create session" form.
  if (state.kind === "idle" || state.kind === "disconnected") {
    return (
      <div className="card">
        <h1>Share your screen</h1>
        <p className="lede">
          Create a session and we'll give you a short code to share. Every
          connection request will require your explicit approval.
        </p>

        {state.kind === "disconnected" && (
          <div className="alert warn">
            <strong>Session ended.</strong> {state.reason}
          </div>
        )}

        <div className="field">
          <label htmlFor="hostName">Your display name (optional)</label>
          <input
            id="hostName"
            className="input"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            maxLength={40}
          />
        </div>

        <button className="btn primary block" onClick={createSession}>
          Create session
        </button>
      </div>
    );
  }

  if (state.kind === "creating") {
    return (
      <div className="card">
        <span className="pill" data-kind="waiting"><span className="dot" /> Creating…</span>
        <h1 style={{ marginTop: 18 }}>Setting up your session</h1>
        <p className="lede">Connecting to the signaling server.</p>
      </div>
    );
  }

  // Waiting / Request / Connecting — all share the "active session" layout.
  const code = state.code;
  const statusKind =
    state.kind === "connected" ? "connected"
    : state.kind === "request" ? "request"
    : "waiting";
  const statusLabel =
    state.kind === "waiting"    ? "Session created — waiting for a request"
    : state.kind === "request"  ? `Incoming request from ${state.clientName}`
    : state.kind === "connecting" ? "Connecting…"
    : `Connected to ${state.clientName}`;

  return (
    <div className="card wide">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span className="pill" data-kind={statusKind}><span className="dot" /> {statusLabel}</span>
        <div style={{ flex: 1 }} />
        <button className="btn danger" onClick={endSession}>End session</button>
      </div>

      {state.kind === "waiting" && (
        <>
          <h1>Waiting for a request</h1>
          <p className="lede">Share this code with the person who wants to view your screen.</p>

          <div className="code-display">
            <span className="label">Session code</span>
            <span className="code">{code}</span>
            <div style={{ display: "flex", gap: 14 }}>
              <button className="copy" onClick={() => copyCode(code)}>Copy code</button>
              <button className="copy" onClick={() => copyShareLink(code)}>Copy share link</button>
            </div>
          </div>

          <div className="alert info">
            When they enter the code, you'll see their request here and can
            approve or reject it. <strong>Nothing is shared until you approve.</strong>
          </div>
        </>
      )}

      {state.kind === "request" && (
        <>
          <h1>Incoming connection request</h1>
          <p className="lede">
            <strong>{state.clientName}</strong> is asking to view your screen on
            session <code>{state.code}</code>. You can approve or reject.
          </p>

          <div className="request-card">
            <div className="title">{state.clientName}</div>
            <div className="meta">
              Approving will prompt you to pick a screen or window to share —
              you can cancel at that step too.
            </div>
            <div className="btn-row">
              <button className="btn success" onClick={approveRequest}>Approve &amp; share</button>
              <button className="btn danger"  onClick={() => rejectRequest("rejected by host")}>Reject</button>
            </div>
          </div>
        </>
      )}

      {state.kind === "connecting" && (
        <>
          <h1>Connecting…</h1>
          <p className="lede">Please pick the screen or window you want to share.</p>
        </>
      )}

      {state.kind === "connected" && (
        <div className="session-view">
          <div>
            <div className="video-frame">
              <video ref={videoRef} autoPlay muted playsInline />
            </div>
            <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
              This is the preview of what <strong>{state.clientName}</strong> is
              seeing. You can stop at any time by clicking "End session" above
              or using your browser's native "Stop sharing" control.
            </p>
          </div>

          <aside className="side-panel">
            <div className="side-card">
              <h3>Session</h3>
              <p><code>{code}</code></p>
            </div>

            <div className="toggle">
              <div className="toggle-label">
                <span className="name">Allow remote input</span>
                <span className="hint">
                  Forwards the client's mouse events to the local agent, which
                  moves your real cursor via the OS (PowerShell / xdotool /
                  osascript / VB6 depending on platform).
                </span>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={allowControl}
                onClick={toggleControl}
              />
            </div>

            {allowControl && (
              <div className="side-card">
                <h3>Local mouse agent</h3>
                <p className="muted" style={{ fontSize: 13 }}>
                  {agentStatus === "up" && <>
                    <strong>Ready.</strong> Mouse events are being injected
                    {agentBackend ? <> via <code>{agentBackend}</code></> : null}.
                  </>}
                  {agentStatus === "warming" && <>
                    <strong>Agent connected, backend warming up.</strong>
                    {agentBackend === "vb6"
                      ? <> Start <code>MouseControl.exe</code> (compiled from <code>vb6-agent/MouseControl.vbp</code>) — it should attach within a second.</>
                      : <> PowerShell is loading the Win32 wrapper — usually less than a second. Moves queued during this time will flush as soon as it's ready.</>}
                  </>}
                  {agentStatus === "connecting" && <>Connecting to the local agent at <code>ws://127.0.0.1:8766</code>…</>}
                  {agentStatus === "down" && <>
                    <strong>Can't reach the local agent.</strong> Run <code>npm start</code> inside the <code>agent/</code> folder on the host machine (or drop the auto-start shortcut in <code>shell:startup</code>).
                  </>}
                  {agentStatus === "off" && <>Toggling on will try to connect to <code>ws://127.0.0.1:8766</code>.</>}
                </p>
              </div>
            )}

            <div className="side-card">
              <h3>Recent events</h3>
              {incomingLog.length === 0
                ? <p className="muted">No input received.</p>
                : (
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12.5, lineHeight: 1.7, color: "var(--muted)" }}>
                    {incomingLog.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
