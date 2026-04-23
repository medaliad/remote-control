import { useCallback, useEffect, useRef, useState } from "react";
import { Signaling } from "../lib/signaling";
import { Peer, type InputEvent } from "../lib/webrtc";

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

  const signalingRef = useRef<Signaling | null>(null);
  const peerRef      = useRef<Peer | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);

  const videoRef     = useRef<HTMLVideoElement | null>(null);

  /** Tear everything down. Idempotent. */
  const hardDisconnect = useCallback((reason: string) => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
    setAllowControl(false);
    setIncomingLog([]);
    setState({ kind: "disconnected", reason });
  }, []);

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
  // HONEST UI: we just record what the client is pressing — we never inject
  // anything at the OS level, because the browser sandbox won't let us.
  const handleRemoteInput = useCallback((ev: InputEvent) => {
    if (!allowControl) return; // shouldn't reach here but defensive
    if (ev.t === "hello") return;
    const line =
      ev.t === "mouse" ? `mouse ${ev.kind}${ev.button != null ? ` btn=${ev.button}` : ""} @${ev.x.toFixed(0)},${ev.y.toFixed(0)}`
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
                  Forwards client's mouse / keys to you over a data channel.
                  (Demo only — events are logged, not injected into your OS.)
                </span>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={allowControl}
                onClick={toggleControl}
              />
            </div>

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
