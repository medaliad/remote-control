import { useCallback, useEffect, useRef, useState } from "react";
import { Signaling } from "../lib/signaling";
import { Peer, type InputEvent } from "../lib/webrtc";

/**
 * Client state machine — the mirror of HostPage. Same idea: one tagged kind
 * at a time, each kind maps to exactly one chunk of UI.
 *
 * UX contract (per spec):
 *   idle        → entering code, nothing happens yet
 *   requesting  → we sent client:join, waiting on server ack
 *   waiting     → server has notified host, we're waiting for approval
 *   connecting  → approved, negotiating WebRTC
 *   connected   → stream is playing
 *   rejected    → host said no (terminal, but offer retry)
 *   disconnected → any other end-state (host closed, network dropped, etc.)
 */
type ClientState =
  | { kind: "idle" }
  | { kind: "requesting"; code: string }
  | { kind: "waiting"; code: string }
  | { kind: "connecting"; code: string }
  | { kind: "connected"; code: string; allowControl: boolean }
  | { kind: "rejected"; code: string; reason: string }
  | { kind: "disconnected"; reason: string };

interface Props {
  /** Optional ?code=… from the URL — lets the host share a one-click link. */
  prefillCode: string | null;
}

export function ClientPage({ prefillCode }: Props) {
  const [state, setState] = useState<ClientState>({ kind: "idle" });
  const [code, setCode] = useState(prefillCode?.toUpperCase() ?? "");
  const [clientName, setClientName] = useState("Client");

  const signalingRef = useRef<Signaling | null>(null);
  const peerRef      = useRef<Peer | null>(null);
  const videoRef     = useRef<HTMLVideoElement | null>(null);

  /** Unified teardown. Safe to call twice. */
  const hardDisconnect = useCallback((reason: string, terminalKind: "disconnected" | "rejected" = "disconnected") => {
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState((s) => {
      if (terminalKind === "rejected" && (s.kind === "requesting" || s.kind === "waiting")) {
        return { kind: "rejected", code: s.code, reason };
      }
      return { kind: "disconnected", reason };
    });
  }, []);

  /* ── Start request ──────────────────────────────────────────────────── */

  const sendRequest = useCallback(async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;

    setState({ kind: "requesting", code: trimmed });

    const sig = new Signaling();
    signalingRef.current = sig;

    try {
      await sig.connect();
    } catch {
      hardDisconnect("Could not reach the server.");
      return;
    }

    // After server validates the code, we transition to "waiting" — it's
    // already told the host, and now we wait for approve/reject. There's
    // no explicit "request:sent" ack; the absence of an `error` message
    // means it worked. We flip to "waiting" optimistically right after
    // sending. If an error comes back, the error handler transitions us
    // to "rejected" and the setState below becomes a no-op because state
    // is no longer "requesting".

    sig.on("request:approved", () => {
      setState((s) => (s.kind === "waiting" || s.kind === "requesting"
        ? { kind: "connecting", code: s.code }
        : s));
    });

    sig.on("request:rejected", (msg) => {
      hardDisconnect(msg.reason || "The host rejected your request.", "rejected");
    });

    sig.on("peer:ready", (msg) => {
      // Create the RTCPeerConnection now. We're polite — we back off on
      // negotiation collisions.
      const peer = new Peer(sig, "client", {
        onRemoteStream: (stream) => {
          if (videoRef.current) videoRef.current.srcObject = stream;
        },
        onConnectionStateChange: (s) => {
          if (s === "failed" || s === "closed") hardDisconnect("WebRTC session ended.");
        },
        onChannelOpen: () => {
          // Send a friendly hello so the host's event log has a marker.
          peer.sendInput({ t: "hello", clientName });
        },
      });
      peerRef.current = peer;

      setState((s) => (s.kind === "connecting" || s.kind === "waiting"
        ? { kind: "connected", code: s.code, allowControl: msg.allowControl }
        : s));
    });

    sig.on("control:changed", (msg) => {
      setState((s) => (s.kind === "connected" ? { ...s, allowControl: msg.allowed } : s));
    });

    sig.on("signal", (msg) => { void peerRef.current?.handleRemoteSignal(msg.data); });

    sig.on("peer:left", (msg) => {
      hardDisconnect(`Host left: ${msg.reason}`);
    });

    sig.on("error", (msg) => {
      // "invalid-code" is the common case — we bounce straight to a
      // rejected-style screen so the user can retype without confusion.
      const reason =
        msg.code === "invalid-code" ? "That code isn't valid. Ask the host for a new one."
        : msg.code === "session-full" ? "The host already has another viewer connected."
        : msg.code === "session-ended" ? "The host ended the session before you joined."
        : msg.message;
      hardDisconnect(reason, "rejected");
    });

    sig.onceClosed().then((reason) => {
      setState((s) => {
        if (s.kind === "connected" || s.kind === "connecting" || s.kind === "waiting" || s.kind === "requesting") {
          return { kind: "disconnected", reason: `Connection closed: ${reason}` };
        }
        return s;
      });
    });

    sig.send({ type: "client:join", code: trimmed, clientName });
    // Synchronously promote to "waiting" now that the join is in flight.
    // Error / approval handlers above will transition us again when the
    // server responds.
    setState((s) => (s.kind === "requesting" ? { kind: "waiting", code: s.code } : s));
  }, [code, clientName, hardDisconnect]);

  const cancel = () => {
    signalingRef.current?.send({ type: "client:cancel" });
    hardDisconnect("You cancelled the request.");
  };

  const disconnect = () => hardDisconnect("You disconnected.");

  /* ── Input forwarding (only when allowed) ───────────────────────────── */
  //
  // We attach listeners to the <video> element rather than `window` so the
  // remote stream only captures events when the viewer is actually focused
  // on the screen share, not when they're typing into the browser's URL bar.

  const connected = state.kind === "connected";
  const controlOn = state.kind === "connected" && state.allowControl;

  useEffect(() => {
    if (!connected || !controlOn) return;
    const v = videoRef.current;
    if (!v) return;

    const send = (ev: InputEvent) => peerRef.current?.sendInput(ev);

    const localCoords = (e: MouseEvent) => {
      const rect = v.getBoundingClientRect();
      // Normalize to the displayed video area. Host can multiply by remote
      // resolution — we don't know it here.
      const x = ((e.clientX - rect.left) / rect.width);
      const y = ((e.clientY - rect.top)  / rect.height);
      return { x, y };
    };

    const onMouseMove = (e: MouseEvent) => {
      const { x, y } = localCoords(e);
      send({ t: "mouse", x, y, kind: "move" });
    };
    const onMouseDown = (e: MouseEvent) => {
      const { x, y } = localCoords(e);
      send({ t: "mouse", x, y, button: e.button, kind: "down" });
    };
    const onMouseUp = (e: MouseEvent) => {
      const { x, y } = localCoords(e);
      send({ t: "mouse", x, y, button: e.button, kind: "up" });
    };
    const onClick = (e: MouseEvent) => {
      const { x, y } = localCoords(e);
      send({ t: "mouse", x, y, button: e.button, kind: "click" });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send({ t: "wheel", dx: e.deltaX, dy: e.deltaY });
    };
    // Only capture keys when the video area is actually focused. This lets
    // the user still type in the browser URL bar, DevTools, etc. without
    // those keys leaking to the host.
    //
    // preventDefault() here stops the browser from acting on the key locally
    // (e.g., Tab moving focus, Space scrolling). We skip preventDefault for
    // browser-level shortcuts we can't block anyway (Ctrl+W, Ctrl+T, F5 in
    // many browsers) -- trying just produces console warnings.
    const isVideoFocused = () => document.activeElement === v;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isVideoFocused()) return;
      e.preventDefault();
      send({ t: "key", key: e.key, code: e.code, kind: "down" });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isVideoFocused()) return;
      e.preventDefault();
      send({ t: "key", key: e.key, code: e.code, kind: "up" });
    };

    v.addEventListener("mousemove", onMouseMove);
    v.addEventListener("mousedown", onMouseDown);
    v.addEventListener("mouseup",   onMouseUp);
    v.addEventListener("click",     onClick);
    v.addEventListener("wheel",     onWheel, { passive: false });
    // Keyboard has to live on window; video can't receive key events
    // without `tabIndex` and focus, and even then it's flaky across browsers.
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup",   onKeyUp);

    return () => {
      v.removeEventListener("mousemove", onMouseMove);
      v.removeEventListener("mousedown", onMouseDown);
      v.removeEventListener("mouseup",   onMouseUp);
      v.removeEventListener("click",     onClick);
      v.removeEventListener("wheel",     onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup",   onKeyUp);
    };
  }, [connected, controlOn]);

  /* ── Cleanup on unmount ─────────────────────────────────────────────── */
  useEffect(() => () => {
    peerRef.current?.close();
    signalingRef.current?.close();
  }, []);

  /* ── Render ─────────────────────────────────────────────────────────── */

  if (state.kind === "idle" || state.kind === "disconnected" || state.kind === "rejected") {
    return (
      <div className="card">
        <h1>Join a session</h1>
        <p className="lede">
          Ask the host for their session code. The host has to approve your
          request before anything is shared.
        </p>

        {state.kind === "disconnected" && (
          <div className="alert warn">
            <strong>Session ended.</strong> {state.reason}
          </div>
        )}
        {state.kind === "rejected" && (
          <div className="alert error">
            <strong>Request rejected.</strong> {state.reason}
          </div>
        )}

        <div className="field">
          <label htmlFor="clientName">Your display name</label>
          <input
            id="clientName"
            className="input"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            maxLength={40}
            placeholder="How should the host know you?"
          />
        </div>

        <div className="field">
          <label htmlFor="code">Session code</label>
          <input
            id="code"
            className="input code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            maxLength={6}
            placeholder="ABC123"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <button
          className="btn primary block"
          onClick={sendRequest}
          disabled={code.trim().length < 4}
        >
          Send connection request
        </button>
      </div>
    );
  }

  if (state.kind === "requesting") {
    return (
      <div className="card">
        <span className="pill" data-kind="waiting"><span className="dot" /> Sending request…</span>
        <h1 style={{ marginTop: 18 }}>Requesting connection</h1>
        <p className="lede">Contacting the signaling server with code <code>{state.code}</code>.</p>
      </div>
    );
  }

  if (state.kind === "waiting") {
    return (
      <div className="card">
        <span className="pill" data-kind="waiting"><span className="dot" /> Waiting for approval</span>
        <h1 style={{ marginTop: 18 }}>Waiting for the host</h1>
        <p className="lede">
          Your request reached the host. You'll see their screen as soon as
          they approve. Feel free to cancel if you've changed your mind.
        </p>
        <div className="alert info">
          Tell the host to look for <strong>{clientName}</strong> in their
          request list on session <code>{state.code}</code>.
        </div>
        <button className="btn secondary block" onClick={cancel}>Cancel request</button>
      </div>
    );
  }

  if (state.kind === "connecting") {
    return (
      <div className="card">
        <span className="pill" data-kind="request"><span className="dot" /> Approved — connecting…</span>
        <h1 style={{ marginTop: 18 }}>Connecting to {state.code}</h1>
        <p className="lede">Negotiating the peer-to-peer connection. This usually takes a second or two.</p>
        <button className="btn secondary block" onClick={disconnect}>Cancel</button>
      </div>
    );
  }

  // connected
  return (
    <div className="card wide">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span className="pill" data-kind="connected">
          <span className="dot" /> Connected to {state.code}
        </span>
        {state.allowControl && (
          <span className="pill" data-kind="request" title="The host has granted you remote input.">
            <span className="dot" /> Remote control on
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn danger" onClick={disconnect}>Disconnect</button>
      </div>

      <div className="session-view">
        <div>
          <div className="video-frame">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              // tabIndex lets the video accept focus for scroll/key events.
              tabIndex={0}
            />
          </div>
          <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
            {state.allowControl
              ? "Remote control is on — your clicks and keys are being forwarded to the host."
              : "View-only. The host controls whether your input is forwarded."}
          </p>
        </div>

        <aside className="side-panel">
          <div className="side-card">
            <h3>Session</h3>
            <p><code>{state.code}</code></p>
          </div>

          <div className="side-card">
            <h3>Input status</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              {state.allowControl
                ? "The host has allowed your input. Click the video area to focus it, then interact as you would locally."
                : "The host hasn't enabled remote control. You can watch, but your clicks and keys stay on this page."}
            </p>
          </div>

          <div className="side-card">
            <h3>Tips</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              If the video looks blurry, try resizing the window — the host's
              screen is scaled to fit. Click the video to focus it before
              typing, so keys route to the host. Audio plays if the host
              ticked "Share audio" in the browser picker.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
