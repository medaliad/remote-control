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
  | { kind: "connecting"; code: string; clientName: string }
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
  // Outbound queue for events that arrive before the agent WebSocket has
  // finished opening. Without this, the first ~100–500 ms of input after
  // approve (while the WS is still in CONNECTING) are dropped — which
  // looks exactly like "mouse doesn't move."
  const agentQueueRef = useRef<string[]>([]);
  // Whether we *want* the agent connection alive. Flips true on approve /
  // control-on, false on disconnect / control-off. The reconnect loop
  // only retries while this is true, so turning control off actually stops.
  const agentWantedRef = useRef<boolean>(false);
  // Backoff timer for reconnect.
  const agentReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latches to true the first time we drop an input event because the
  // agent WS isn't open, so the console warning fires once rather than
  // once per event. Reset whenever the agent reconnects.
  const agentDropWarnedRef = useRef<boolean>(false);
  // Mirror of allowControl so async callbacks that were created before the
  // state flipped still see the up-to-date value (React closures capture the
  // value at creation time; a ref sidesteps that).
  const allowControlRef = useRef<boolean>(false);

  const videoRef     = useRef<HTMLVideoElement | null>(null);

  /** Close the local-agent WebSocket. Safe to call when it's already closed. */
  const closeAgent = useCallback(() => {
    agentWantedRef.current = false;
    if (agentReconnectRef.current) {
      clearTimeout(agentReconnectRef.current);
      agentReconnectRef.current = null;
    }
    agentQueueRef.current = [];
    const ws = agentRef.current;
    agentRef.current = null;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
    setAgentStatus("off");
  }, []);

  /**
   * Open (or reuse) a WebSocket to the local agent. Opening is async:
   *   - While CONNECTING, events are buffered into agentQueueRef.
   *   - On OPEN, the buffer flushes and subsequent events send directly.
   *   - On CLOSE/ERROR, we retry with a 1.5s backoff as long as
   *     agentWantedRef is still true. This matters because the operator
   *     might start `npm start` in agent/ AFTER approving the client —
   *     with one-shot connect, they'd have to toggle control off/on to
   *     recover. Now it just works.
   */
  const ensureAgent = useCallback(() => {
    agentWantedRef.current = true;

    const scheduleReconnect = () => {
      if (!agentWantedRef.current) return;
      if (agentReconnectRef.current) return;
      agentReconnectRef.current = setTimeout(() => {
        agentReconnectRef.current = null;
        if (agentWantedRef.current) ensureAgent();
      }, 1500);
    };

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
      scheduleReconnect();
      return null;
    }

    // Until the agent's first status message lands we're "warming" -- the
    // WebSocket is up but we don't yet know if the backend (PowerShell / VB6)
    // can actually inject events. The first `agent:status` upgrades us to
    // "up" or keeps us "warming" accordingly.
    ws.onopen    = () => {
      agentDropWarnedRef.current = false;
      setAgentStatus((s) => (s === "up" ? s : "warming"));
      // Flush anything the operator did in the CONNECTING window.
      const q = agentQueueRef.current;
      agentQueueRef.current = [];
      for (const msg of q) {
        try { ws.send(msg); } catch { /* agent went away mid-flush */ }
      }
    };
    ws.onerror   = () => setAgentStatus("down");
    ws.onclose   = () => {
      if (agentRef.current === ws) {
        agentRef.current = null;
        setAgentStatus((s) => (s === "off" ? s : "down"));
        scheduleReconnect();
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

  /** Send an input event to the agent, or queue it if the WS isn't OPEN. */
  const sendToAgent = useCallback((ev: InputEvent) => {
    const payload = JSON.stringify(ev);
    const ws = agentRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); return; } catch { /* fall through to queue */ }
    }
    // Cap the queue so a long-offline agent doesn't balloon memory.
    // 500 events is ~8s of mousemove @60Hz — plenty for bursty reconnects.
    const q = agentQueueRef.current;
    if (q.length > 500) q.splice(0, q.length - 500);
    q.push(payload);
    // If the WS died (CLOSED) and we still want it, kick a reconnect.
    if (agentWantedRef.current && (!ws || ws.readyState === WebSocket.CLOSED)) {
      ensureAgent();
    }
  }, [ensureAgent]);

  /** Tear everything down. Idempotent. */
  const hardDisconnect = useCallback((reason: string) => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
    closeAgent();
    allowControlRef.current = false;
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
      // Approved — wire up the peer connection *before* we prompt the user
      // for a screen. The client's Peer is created in its own peer:ready
      // handler and immediately opens a DataChannel, which triggers
      // negotiationneeded → sends an SDP offer. That offer is relayed to
      // us via the server. If we were still sitting on the getDisplayMedia
      // picker at that moment, peerRef.current would be null and the offer
      // would be silently dropped — the connection would hang forever.
      const peer = new Peer(sig, "host", {
        onInput: handleRemoteInput,
        onConnectionStateChange: (s) => {
          // Only tear the session down on a hard failure. Transient
          // "disconnected" usually recovers; the server's peer:left is the
          // source of truth for the peer actually leaving.
          if (s === "failed" || s === "closed") hardDisconnect("WebRTC session ended.");
        },
      });
      peerRef.current = peer;

      // Reflect our approval flag to the client as early as possible. We
      // read from the ref so that a setAllowControl() call inside
      // approveRequest() (which fires synchronously right before we get
      // here) is already visible.
      sig.send({ type: "host:setControl", allowed: allowControlRef.current });

      // Audio: true asks the browser for tab/system audio. Chromium shows
      // a "Share audio" checkbox in the picker; on Firefox/Safari this
      // option may be unavailable and the call silently returns video-only.
      // We pass it anyway — best-effort is correct here.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (err) {
        console.error("[host] getDisplayMedia:", err);
        // User dismissed the picker / permissions denied. Tell the client.
        sig.send({ type: "host:end" });
        hardDisconnect("Screen share was cancelled.");
        return;
      }

      streamRef.current = stream;
      peer.addScreenStream(stream); // triggers renegotiation with the track(s)

      // Attach the stream to our own preview so the host sees what's being
      // shared — same experience as Google Meet etc.
      if (videoRef.current) videoRef.current.srcObject = stream;

      // If the user stops sharing via the browser's native "Stop sharing"
      // button we tear the session down — but only if *this* stream is
      // still the active one. Otherwise we'd clobber the disconnect reason
      // set by whoever initiated the teardown (e.g. the user clicking End
      // session, which stops the track too).
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (streamRef.current === stream) {
          hardDisconnect("You stopped sharing your screen.");
        }
      });

      setState((s) =>
        s.kind === "request" || s.kind === "connecting" || s.kind === "waiting"
          ? {
              kind: "connected",
              code: s.code,
              clientName:
                s.kind === "request" || s.kind === "connecting" ? s.clientName : "Client",
            }
          : s,
      );
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
      // Only tear down if *this* signaling instance is still the active one.
      // After a user-driven hardDisconnect() we've already nulled the ref and
      // surfaced a better reason; don't clobber it.
      if (signalingRef.current === sig) {
        hardDisconnect(`Connection closed: ${reason}`);
      }
    });

    sig.send({ type: "host:create", hostName });
  }, [hostName, hardDisconnect]);

  /* ── Handle remote (client) input events ────────────────────────────── */
  //
  // Mouse, wheel, and keyboard events are forwarded to the local agent,
  // which injects them via OS-native APIs (SetCursorPos / keybd_event on
  // Windows, xdotool on Linux, CGEvent on macOS). If the agent isn't up we
  // silently fall back to logging -- the operator still sees something
  // happened, they just won't see the cursor move or keys register.
  const handleRemoteInput = useCallback((ev: InputEvent) => {
    if (!allowControlRef.current) return; // defensive: client shouldn't have sent this
    if (ev.t === "hello") return;

    // 1) Forward mouse, wheel, and keyboard events to the local agent.
    //    sendToAgent queues when the WS isn't OPEN yet and kicks off a
    //    reconnect if needed, so events aren't silently lost during the
    //    approve → connect handshake (or if the agent was started late).
    if (ev.t === "mouse" || ev.t === "wheel" || ev.t === "key") {
      sendToAgent(ev);
      if (agentRef.current?.readyState !== WebSocket.OPEN && !agentDropWarnedRef.current) {
        agentDropWarnedRef.current = true;
        console.warn(
          "[host] queueing input — local agent not connected yet. " +
          "If this persists, run `npm start` in agent/ on this machine.",
        );
      }
    }

    // 2) Keep a short event trail for the sidebar regardless.
    const line =
      ev.t === "mouse" ? `mouse ${ev.kind}${ev.button != null ? ` btn=${ev.button}` : ""} @${(ev.x * 100).toFixed(1)}%,${(ev.y * 100).toFixed(1)}%`
      : ev.t === "key" ? `key ${ev.kind} ${ev.key}`
      : ev.t === "wheel" ? `wheel dx=${ev.dx} dy=${ev.dy}`
      : "input";
    setIncomingLog((l) => [`${fmtTime(Date.now())} — ${line}`, ...l].slice(0, 8));
  }, [sendToAgent]);

  /* ── Host actions ───────────────────────────────────────────────────── */

  const approveRequest = () => {
    if (state.kind !== "request") return;
    // Auto-grant remote input the moment we approve -- this is the
    // "Chrome Remote Desktop" behavior the user wants: one click, full
    // control. The kill-switch (turn OFF control mid-session) is still
    // available via the toggle in the sidebar once connected.
    allowControlRef.current = true;
    setAllowControl(true);
    ensureAgent();
    signalingRef.current?.send({ type: "host:approve", requestId: state.requestId });
    setState({ kind: "connecting", code: state.code, clientName: state.clientName });
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
    allowControlRef.current = next;
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
            {/* Big, unmissable banner when remote input is enabled but the
                agent isn't up. Without this, the operator sees their own
                preview playing fine and has no idea why the client's clicks
                aren't landing. */}
            {allowControl && agentStatus !== "up" && (
              <div
                className="alert"
                style={{
                  background: agentStatus === "down" ? "#5a1a1a" : "#4a3a1a",
                  border: `1px solid ${agentStatus === "down" ? "#d94848" : "#d9a14a"}`,
                  color: "#fff",
                  padding: "12px 14px",
                  borderRadius: 8,
                  marginBottom: 12,
                }}
              >
                <strong>
                  {agentStatus === "down" && "Remote cursor will not move — local agent is offline."}
                  {agentStatus === "warming" && "Starting local agent… your cursor will respond in a moment."}
                  {agentStatus === "connecting" && "Connecting to local agent…"}
                  {agentStatus === "off" && "Local agent not started."}
                </strong>
                {agentStatus === "down" && (
                  <div style={{ marginTop: 6, fontSize: 13 }}>
                    Open a terminal in the <code>agent/</code> folder and run <code>npm start</code>,
                    or double-click <code>start-host.bat</code> from the project root.
                    When the agent boots correctly you should see a tiny cursor
                    jiggle on this screen.
                  </div>
                )}
              </div>
            )}
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
                <span className="name">Remote input</span>
                <span className="hint">
                  Auto-enabled on approve — the client can already click and
                  type. Flip this OFF any time as a kill-switch (agent
                  disconnects, cursor stops responding instantly).
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
