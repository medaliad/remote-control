import { useCallback, useEffect, useRef, useState } from "react";
import { Signaling } from "../lib/signaling";
import { Peer, type InputEvent } from "../lib/webrtc";
import {
  MonitorPlay,
  Copy,
  Link as LinkIcon,
  Check,
  X,
  PowerOff,
  AlertTriangle,
  Loader2,
  Shield,
  Activity,
  Cpu,
  ShieldCheck,
  CircleDot,
  KeyRound,
} from "lucide-react";

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
      <div className="w-full max-w-lg animate-slide-up">
        <div className="relative overflow-hidden rounded-3xl glass-strong shadow-soft-xl p-8 sm:p-10">
          <div className="absolute -top-32 -right-32 w-64 h-64 rounded-full bg-accent/20 blur-3xl pointer-events-none" />

          <div className="relative">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-accent/25 to-accent/5 border border-accent/30 text-accent-hi mb-5">
              <MonitorPlay className="w-6 h-6" strokeWidth={2.2} />
            </div>

            <h1 className="text-3xl font-bold tracking-tight mb-2">
              Share your screen
            </h1>
            <p className="text-muted leading-relaxed mb-7">
              Create a session and we'll give you a short code to share. Every
              connection request will require your explicit approval.
            </p>

            {state.kind === "disconnected" && (
              <div className="flex items-start gap-3 mb-6 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-100 animate-fade-in">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-400" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">Session ended.</strong> {state.reason}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2 mb-7">
              <label
                htmlFor="hostName"
                className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted"
              >
                Your display name (optional)
              </label>
              <input
                id="hostName"
                className="w-full px-4 py-3.5 rounded-xl bg-surface-2/80 border border-white/[0.08] text-text placeholder:text-subtle outline-none transition-all duration-200 focus:border-accent focus:bg-surface-2 focus:ring-4 focus:ring-accent/15"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                maxLength={40}
              />
            </div>

            <button
              className="group w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-white shadow-glow transition-all duration-200 hover:shadow-glow-lg hover:-translate-y-[1px] active:translate-y-0 focus:outline-none focus:ring-4 focus:ring-accent/30 relative overflow-hidden"
              onClick={createSession}
            >
              <span className="absolute inset-0 bg-gradient-to-r from-accent via-accent-hi to-accent bg-[length:200%_100%] animate-gradient-shift" />
              <span className="relative inline-flex items-center gap-2">
                <MonitorPlay className="w-4 h-4" strokeWidth={2.4} />
                Create session
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "creating") {
    return (
      <div className="w-full max-w-lg animate-slide-up">
        <div className="relative overflow-hidden rounded-3xl glass-strong shadow-soft-xl p-8 sm:p-10">
          <StatusPill kind="waiting" label="Creating…" />
          <h1 className="mt-5 text-3xl font-bold tracking-tight">Setting up your session</h1>
          <p className="mt-2 text-muted leading-relaxed">Connecting to the signaling server.</p>

          {/* Loading skeleton */}
          <div className="mt-8 space-y-3">
            <div className="h-3 w-3/4 rounded-full bg-gradient-to-r from-surface-2 via-surface-3 to-surface-2 bg-[length:200%_100%] animate-shimmer" />
            <div className="h-3 w-1/2 rounded-full bg-gradient-to-r from-surface-2 via-surface-3 to-surface-2 bg-[length:200%_100%] animate-shimmer" />
            <div className="h-3 w-2/3 rounded-full bg-gradient-to-r from-surface-2 via-surface-3 to-surface-2 bg-[length:200%_100%] animate-shimmer" />
          </div>
        </div>
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
    <div className="w-full max-w-6xl animate-slide-up">
      <div className="relative overflow-hidden rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <StatusPill kind={statusKind} label={statusLabel} />
          <div className="flex-1 min-w-[1rem]" />
          <button
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-red-300 bg-red-500/10 border border-red-500/30 transition-all duration-200 hover:bg-red-500/20 hover:border-red-500/50 focus:outline-none focus:ring-4 focus:ring-red-500/20"
            onClick={endSession}
          >
            <PowerOff className="w-4 h-4" strokeWidth={2.4} />
            End session
          </button>
        </div>

        {state.kind === "waiting" && (
          <div className="animate-fade-in">
            <h1 className="text-3xl font-bold tracking-tight mb-2">Waiting for a request</h1>
            <p className="text-muted leading-relaxed mb-6">
              Share this code with the person who wants to view your screen.
            </p>

            <div className="relative overflow-hidden flex flex-col items-center gap-5 py-10 px-6 my-2 rounded-2xl border border-dashed border-accent/30 bg-gradient-to-b from-accent/[0.08] to-transparent">
              <div className="absolute inset-0 bg-dots opacity-40 pointer-events-none" />
              <span className="relative inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-hi">
                <KeyRound className="w-3.5 h-3.5" strokeWidth={2.4} />
                Session code
              </span>
              <span className="relative font-mono font-bold text-5xl sm:text-6xl tracking-[0.3em] text-gradient drop-shadow-[0_0_30px_rgba(124,106,255,0.35)]">
                {code}
              </span>
              <div className="relative flex flex-wrap items-center justify-center gap-3">
                <button
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-accent-hi bg-accent/10 border border-accent/25 transition-all duration-200 hover:bg-accent/20 hover:border-accent/40"
                  onClick={() => copyCode(code)}
                >
                  <Copy className="w-3.5 h-3.5" strokeWidth={2.4} />
                  Copy code
                </button>
                <button
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-accent-hi bg-accent/10 border border-accent/25 transition-all duration-200 hover:bg-accent/20 hover:border-accent/40"
                  onClick={() => copyShareLink(code)}
                >
                  <LinkIcon className="w-3.5 h-3.5" strokeWidth={2.4} />
                  Copy share link
                </button>
              </div>
            </div>

            <div className="mt-6 flex items-start gap-3 p-4 rounded-xl border border-accent/20 bg-accent/[0.06]">
              <Shield className="shrink-0 mt-0.5 w-5 h-5 text-accent-hi" strokeWidth={2.2} />
              <p className="text-sm text-[#d9d3ff]/90 leading-relaxed">
                When they enter the code, you'll see their request here and can
                approve or reject it.{" "}
                <strong className="text-white">Nothing is shared until you approve.</strong>
              </p>
            </div>
          </div>
        )}

        {state.kind === "request" && (
          <div className="animate-fade-in">
            <h1 className="text-3xl font-bold tracking-tight mb-2">
              Incoming connection request
            </h1>
            <p className="text-muted leading-relaxed mb-6">
              <strong className="text-text">{state.clientName}</strong> is asking
              to view your screen on session{" "}
              <code className="font-mono text-accent-hi">{state.code}</code>.
              You can approve or reject.
            </p>

            <div className="relative overflow-hidden rounded-2xl border border-accent/60 bg-gradient-to-br from-accent/20 via-accent/10 to-transparent p-6 animate-scale-in shadow-glow">
              <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-accent/30 blur-3xl pointer-events-none" />
              <div className="relative flex items-center gap-4 mb-3">
                <span className="relative inline-flex shrink-0 items-center justify-center w-12 h-12 rounded-xl bg-accent/20 border border-accent/40 text-accent-hi">
                  <CircleDot className="w-5 h-5 animate-pulse-fast" strokeWidth={2.4} />
                </span>
                <div className="flex flex-col">
                  <span className="text-lg font-semibold tracking-tight">
                    {state.clientName}
                  </span>
                  <span className="text-xs text-muted font-mono">
                    requesting access · session {state.code}
                  </span>
                </div>
              </div>
              <div className="relative text-sm text-muted leading-relaxed mb-5">
                Approving will prompt you to pick a screen or window to share —
                you can cancel at that step too.
              </div>
              <div className="relative flex flex-wrap gap-3">
                <button
                  className="group inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-white shadow-[0_0_30px_-6px_rgba(60,208,133,0.5)] transition-all duration-200 hover:-translate-y-[1px] focus:outline-none focus:ring-4 focus:ring-emerald-500/30 relative overflow-hidden"
                  onClick={approveRequest}
                >
                  <span className="absolute inset-0 bg-gradient-to-r from-emerald-500 to-emerald-400" />
                  <span className="relative inline-flex items-center gap-2">
                    <Check className="w-4 h-4" strokeWidth={2.8} />
                    Approve &amp; share
                  </span>
                </button>
                <button
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-red-300 bg-red-500/10 border border-red-500/30 transition-all duration-200 hover:bg-red-500/20 hover:border-red-500/50 focus:outline-none focus:ring-4 focus:ring-red-500/20"
                  onClick={() => rejectRequest("rejected by host")}
                >
                  <X className="w-4 h-4" strokeWidth={2.6} />
                  Reject
                </button>
              </div>
            </div>
          </div>
        )}

        {state.kind === "connecting" && (
          <div className="animate-fade-in">
            <h1 className="text-3xl font-bold tracking-tight mb-2 flex items-center gap-3">
              <Loader2 className="w-6 h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
              Connecting…
            </h1>
            <p className="text-muted leading-relaxed">
              Please pick the screen or window you want to share.
            </p>
          </div>
        )}

        {state.kind === "connected" && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 w-full animate-fade-in">
            <div>
              {/* Big, unmissable banner when remote input is enabled but the
                  agent isn't up. Without this, the operator sees their own
                  preview playing fine and has no idea why the client's clicks
                  aren't landing. */}
              {allowControl && agentStatus !== "up" && (
                <div
                  className={[
                    "flex items-start gap-3 p-4 rounded-xl mb-4 border animate-slide-up",
                    agentStatus === "down"
                      ? "border-red-500/40 bg-red-500/10 text-red-100"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-100",
                  ].join(" ")}
                >
                  <AlertTriangle
                    className={[
                      "shrink-0 mt-0.5 w-5 h-5",
                      agentStatus === "down" ? "text-red-400" : "text-amber-400",
                    ].join(" ")}
                    strokeWidth={2.2}
                  />
                  <div className="flex-1">
                    <strong className="text-sm font-semibold text-white block">
                      {agentStatus === "down" && "Remote cursor will not move — local agent is offline."}
                      {agentStatus === "warming" && "Starting local agent… your cursor will respond in a moment."}
                      {agentStatus === "connecting" && "Connecting to local agent…"}
                      {agentStatus === "off" && "Local agent not started."}
                    </strong>
                    {agentStatus === "down" && (
                      <div className="mt-1.5 text-[13px] leading-relaxed text-amber-100/80">
                        Open a terminal in the{" "}
                        <code className="font-mono text-white bg-black/30 px-1.5 py-0.5 rounded">
                          agent/
                        </code>{" "}
                        folder and run{" "}
                        <code className="font-mono text-white bg-black/30 px-1.5 py-0.5 rounded">
                          npm start
                        </code>
                        , or double-click{" "}
                        <code className="font-mono text-white bg-black/30 px-1.5 py-0.5 rounded">
                          start-host.bat
                        </code>{" "}
                        from the project root. When the agent boots correctly
                        you should see a tiny cursor jiggle on this screen.
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="relative rounded-2xl border border-white/[0.08] overflow-hidden bg-black aspect-video shadow-soft-xl group">
                <div className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-accent/20 pointer-events-none" />
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-contain block"
                />
                <div className="pointer-events-none absolute top-3 left-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider text-white border border-white/10">
                  <span className="relative flex w-1.5 h-1.5">
                    <span className="absolute inline-flex w-full h-full rounded-full bg-red-500 opacity-75 animate-ping" />
                    <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-red-500" />
                  </span>
                  Live preview
                </div>
              </div>
              <p className="mt-3 text-[13px] text-muted leading-relaxed">
                This is the preview of what{" "}
                <strong className="text-text">{state.clientName}</strong> is
                seeing. You can stop at any time by clicking "End session" above
                or using your browser's native "Stop sharing" control.
              </p>
            </div>

            <aside className="flex flex-col gap-3">
              <div className="rounded-xl border border-white/[0.06] bg-surface-2/60 backdrop-blur-sm p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-1.5 flex items-center gap-1.5">
                  <KeyRound className="w-3 h-3" strokeWidth={2.4} />
                  Session
                </h3>
                <p className="font-mono text-lg font-bold tracking-widest text-text">
                  {code}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 p-4 rounded-xl border border-white/[0.06] bg-surface-2/60 backdrop-blur-sm">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="font-semibold text-sm flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-accent-hi" strokeWidth={2.4} />
                    Remote input
                  </span>
                  <span className="text-xs text-muted leading-snug">
                    Auto-enabled on approve — the client can already click and
                    type. Flip this OFF any time as a kill-switch (agent
                    disconnects, cursor stops responding instantly).
                  </span>
                </div>
                <button
                  role="switch"
                  aria-checked={allowControl}
                  onClick={toggleControl}
                  className={[
                    "relative shrink-0 w-11 h-6 rounded-full border transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-accent/25",
                    allowControl
                      ? "bg-gradient-to-r from-accent to-accent-hi border-accent-hi shadow-glow"
                      : "bg-surface border-border-hi",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "absolute top-0.5 w-5 h-5 rounded-full transition-all duration-200 shadow-md",
                      allowControl
                        ? "left-[calc(100%-1.375rem)] bg-white"
                        : "left-0.5 bg-muted",
                    ].join(" ")}
                  />
                </button>
              </div>

              {allowControl && (
                <div className="rounded-xl border border-white/[0.06] bg-surface-2/60 backdrop-blur-sm p-4 animate-fade-in">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                    <Cpu className="w-3 h-3" strokeWidth={2.4} />
                    Local mouse agent
                  </h3>
                  <div className="flex items-center gap-2 mb-2">
                    <AgentStatusDot status={agentStatus} />
                    <span className="text-xs font-semibold uppercase tracking-wider text-text">
                      {agentStatus === "up" && "Ready"}
                      {agentStatus === "warming" && "Warming"}
                      {agentStatus === "connecting" && "Connecting"}
                      {agentStatus === "down" && "Offline"}
                      {agentStatus === "off" && "Idle"}
                    </span>
                  </div>
                  <p className="text-muted text-[13px] leading-relaxed">
                    {agentStatus === "up" && <>
                      Mouse events are being injected
                      {agentBackend ? <> via <code className="font-mono text-accent-hi">{agentBackend}</code></> : null}.
                    </>}
                    {agentStatus === "warming" && <>
                      Agent connected, backend warming up.{" "}
                      {agentBackend === "vb6"
                        ? <>Start <code className="font-mono text-accent-hi">MouseControl.exe</code> (compiled from <code className="font-mono text-accent-hi">vb6-agent/MouseControl.vbp</code>) — it should attach within a second.</>
                        : <>PowerShell is loading the Win32 wrapper — usually less than a second. Moves queued during this time will flush as soon as it's ready.</>}
                    </>}
                    {agentStatus === "connecting" && <>Connecting to the local agent at <code className="font-mono text-accent-hi">ws://127.0.0.1:8766</code>…</>}
                    {agentStatus === "down" && <>
                      Can't reach the local agent. Run <code className="font-mono text-accent-hi">npm start</code> inside the <code className="font-mono text-accent-hi">agent/</code> folder on the host machine (or drop the auto-start shortcut in <code className="font-mono text-accent-hi">shell:startup</code>).
                    </>}
                    {agentStatus === "off" && <>Toggling on will try to connect to <code className="font-mono text-accent-hi">ws://127.0.0.1:8766</code>.</>}
                  </p>
                </div>
              )}

              <div className="rounded-xl border border-white/[0.06] bg-surface-2/60 backdrop-blur-sm p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                  <Activity className="w-3 h-3" strokeWidth={2.4} />
                  Recent events
                </h3>
                {incomingLog.length === 0
                  ? <p className="text-muted text-[13px] italic">No input received.</p>
                  : (
                    <ul className="flex flex-col gap-1 font-mono text-[11.5px] leading-relaxed text-muted max-h-48 overflow-y-auto pr-1">
                      {incomingLog.map((line, i) => (
                        <li
                          key={i}
                          className="truncate py-0.5 border-b border-white/[0.04] last:border-0"
                          title={line}
                        >
                          {line}
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/* ── UI-only helpers ─────────────────────────────────────────────────── */

function StatusPill({
  kind,
  label,
}: {
  kind: "idle" | "waiting" | "request" | "connected" | "error";
  label: string;
}) {
  const dotColor =
    kind === "connected" ? "bg-emerald-400"
    : kind === "waiting" ? "bg-amber-400"
    : kind === "request" ? "bg-accent-hi"
    : kind === "error" ? "bg-red-400"
    : "bg-subtle";
  const pulse = kind === "waiting" || kind === "request";
  const ring =
    kind === "connected" ? "ring-emerald-400/40"
    : kind === "waiting" ? "ring-amber-400/40"
    : kind === "request" ? "ring-accent-hi/50"
    : kind === "error" ? "ring-red-400/40"
    : "ring-white/10";

  return (
    <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[12.5px] font-medium bg-surface-2/70 border border-white/[0.06] backdrop-blur-sm">
      <span className="relative flex w-2 h-2">
        {pulse && (
          <span
            className={[
              "absolute inline-flex w-full h-full rounded-full opacity-70",
              dotColor,
            ].join(" ")}
            style={{ animation: "ping 1.2s cubic-bezier(0, 0, 0.2, 1) infinite" }}
          />
        )}
        <span
          className={[
            "relative inline-flex w-2 h-2 rounded-full ring-2",
            dotColor,
            ring,
          ].join(" ")}
        />
      </span>
      {label}
    </span>
  );
}

function AgentStatusDot({
  status,
}: {
  status: "off" | "connecting" | "warming" | "up" | "down";
}) {
  const color =
    status === "up" ? "bg-emerald-400"
    : status === "warming" ? "bg-amber-400"
    : status === "connecting" ? "bg-accent-hi"
    : status === "down" ? "bg-red-400"
    : "bg-subtle";
  const pulse = status === "warming" || status === "connecting";
  return (
    <span className="relative flex w-2.5 h-2.5">
      {pulse && (
        <span
          className={[
            "absolute inline-flex w-full h-full rounded-full opacity-70 animate-ping",
            color,
          ].join(" ")}
        />
      )}
      <span className={`relative inline-flex w-2.5 h-2.5 rounded-full ${color}`} />
    </span>
  );
}
