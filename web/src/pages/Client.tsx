import { useCallback, useEffect, useRef, useState } from "react";
import { Signaling } from "../lib/signaling";
import { Peer, type InputEvent } from "../lib/webrtc";
import {
  Eye,
  User,
  KeyRound,
  ArrowRight,
  Loader2,
  AlertTriangle,
  XCircle,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  PowerOff,
  Send,
  Lightbulb,
  MousePointerClick,
  Shield,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";

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
  /** When true, render in chromeless / iframe-friendly mode. The remote
   *  screen takes 100% of the viewport, the toolbar floats as an overlay,
   *  the side panel is collapsed by default. */
  embed?: boolean;
  /**
   * VE Admin auto-pair: when present, the page sends `client:claim` with
   * this token instead of `client:join`, skips the code form entirely,
   * and connects straight through (no host approve step on the other end).
   */
  autoPairToken?: string | null;
}

export function ClientPage({ prefillCode, embed = false, autoPairToken = null }: Props) {
  const [state, setState] = useState<ClientState>({ kind: "idle" });
  const [code, setCode] = useState(prefillCode?.toUpperCase() ?? "");
  const [clientName, setClientName] = useState("Client");
  // The client <video> starts muted so browsers let us autoplay with an
  // audio track in the stream. The user can unmute after the first click.
  const [muted, setMuted] = useState(true);
  // Tracks whether the video element is currently in the browser's fullscreen
  // mode. We don't derive this from `document.fullscreenElement` on every
  // render because the user can exit via Esc (no click handler fires) — we
  // need the fullscreenchange event to flip the label back on its own.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Side panel visibility on the connected screen. On large viewports it
  // defaults to open (so users see the session info / tips); on small or
  // embed viewports it defaults to closed so the video gets all the space.
  // A button on the toolbar toggles it.
  const [sidePanelOpen, setSidePanelOpen] = useState(() => {
    if (embed) return false;
    if (typeof window !== "undefined") return window.innerWidth >= 1024;
    return true;
  });

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
    // Auto-pair (token) path: no code needed — the server pairs us by
    // token, and we surface a placeholder label until peer:ready lands.
    // Manual path: refuse to send if the user hasn't typed anything.
    if (!autoPairToken && !trimmed) return;
    const displayCode = trimmed || "AUTO";

    setState({ kind: "requesting", code: displayCode });

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
      // Spin up the RTCPeerConnection via simple-peer. initiator=true
      // (set inside Peer for role "client") means we open the data channel
      // and fire the first SDP offer immediately.
      const peer = new Peer(sig, "client", {
        onRemoteStream: (stream) => {
          const v = videoRef.current;
          if (!v) return;
          v.srcObject = stream;
          // Autoplay policies in Chrome/Edge/Firefox/Safari block playback
          // when the stream has audio and the element isn't muted. We
          // start muted (so the picture shows immediately) and let the
          // user toggle sound on via the "Unmute" button; that click
          // counts as a user gesture, so play() then works with audio.
          v.play().catch((err) => console.warn("[client] video.play():", err));
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

    if (autoPairToken) {
      // VE Admin path: present the manager-bound token. Server pairs us
      // straight through and responds with `request:approved` + the usual
      // `peer:ready`. There is no host-approve round-trip — the token was
      // minted by an authenticated POST /api/sessions/open, so the host
      // (the agent's local browser) auto-approves anything matching it.
      sig.send({ type: "client:claim", token: autoPairToken, clientName });
    } else {
      sig.send({ type: "client:join", code: trimmed, clientName });
    }
    // Synchronously promote to "waiting" now that the join is in flight.
    // Error / approval handlers above will transition us again when the
    // server responds.
    setState((s) => (s.kind === "requesting" ? { kind: "waiting", code: s.code } : s));
  }, [code, clientName, autoPairToken, hardDisconnect]);

  /* ── Auto-start when arriving with a pairing token ──────────────────── */
  //
  // The VE Admin manager UI embeds this page in an iframe with `?token=…`
  // — the user has already implicitly consented by clicking "Open Session"
  // on their side, so we shouldn't make them re-type a code here.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoPairToken) return;
    if (autoStartedRef.current) return;
    if (state.kind !== "idle") return;
    autoStartedRef.current = true;
    void sendRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPairToken, sendRequest]);

  const cancel = () => {
    signalingRef.current?.send({ type: "client:cancel" });
    hardDisconnect("You cancelled the request.");
  };

  const disconnect = () => hardDisconnect("You disconnected.");

  /** Toggle audio on the incoming stream. Called from a user click, so
   *  browsers will honor the unmute (autoplay policies only block the
   *  *first* unprompted playback with audio). */
  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    const v = videoRef.current;
    if (v) {
      v.muted = next;
      if (!next) v.play().catch((err) => console.warn("[client] unmute play():", err));
    }
  };

  /** Enlarge the player to full screen, or exit if already fullscreen.
   *  We fullscreen the <video> element itself rather than a wrapper div so
   *  the browser handles letterboxing/pillarboxing for us — the remote
   *  screen's aspect ratio rarely matches the local display. The mouse/key
   *  listeners attached to the same <video> element keep working while
   *  fullscreen, so remote control doesn't break when the user expands. */
  const toggleFullscreen = () => {
    const v = videoRef.current;
    if (!v) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err) =>
        console.warn("[client] exitFullscreen:", err));
    } else {
      v.requestFullscreen().catch((err) =>
        console.warn("[client] requestFullscreen:", err));
    }
  };

  // Keep `isFullscreen` in sync with the browser — the user can leave
  // fullscreen via Esc (or the OS's own UI chrome) without clicking our
  // button, and the label needs to flip back on its own.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

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

    // Throttle mousemove to one event per frame. Browsers fire mousemove
    // ~120 times per second; forwarding them all floods the data channel
    // for no perceptible benefit.
    let lastMove: { x: number; y: number } | null = null;
    let moveScheduled = false;
    const flushMove = () => {
      moveScheduled = false;
      if (!lastMove) return;
      send({ t: "mouse", x: lastMove.x, y: lastMove.y, kind: "move" });
      lastMove = null;
    };

    const localCoords = (e: MouseEvent) => {
      const rect = v.getBoundingClientRect();
      // The <video> element uses object-fit: contain by default, so the
      // actual picture is letterboxed/pillarboxed inside the element when
      // the stream's aspect ratio doesn't match the element's. Normalizing
      // against getBoundingClientRect would put a click in the black bar
      // onto the host's screen edge. Compute the real drawn area from the
      // stream's intrinsic size and map coords against THAT.
      const vW = v.videoWidth;
      const vH = v.videoHeight;
      if (!vW || !vH) {
        // Stream hasn't reported a size yet — fall back to the element box.
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top)  / rect.height;
        return { x, y };
      }
      const videoAspect = vW / vH;
      const rectAspect  = rect.width / rect.height;
      let drawW: number, drawH: number, offX: number, offY: number;
      if (videoAspect > rectAspect) {
        // Stream is wider — letterboxed top/bottom.
        drawW = rect.width;
        drawH = rect.width / videoAspect;
        offX  = 0;
        offY  = (rect.height - drawH) / 2;
      } else {
        // Stream is taller — pillarboxed left/right.
        drawH = rect.height;
        drawW = rect.height * videoAspect;
        offY  = 0;
        offX  = (rect.width - drawW) / 2;
      }
      const x = (e.clientX - rect.left - offX) / drawW;
      const y = (e.clientY - rect.top  - offY) / drawH;
      return { x, y };
    };

    const onMouseMove = (e: MouseEvent) => {
      lastMove = localCoords(e);
      if (moveScheduled) return;
      moveScheduled = true;
      requestAnimationFrame(flushMove);
    };
    const onMouseDown = (e: MouseEvent) => {
      const { x, y } = localCoords(e);
      send({ t: "mouse", x, y, button: e.button, kind: "down" });
    };
    const onMouseUp = (e: MouseEvent) => {
      const { x, y } = localCoords(e);
      send({ t: "mouse", x, y, button: e.button, kind: "up" });
    };
    // NOTE: deliberately no `click` handler. Browsers fire mousedown +
    // mouseup + click for a single physical click; forwarding all three
    // made the agent do press + release + press + release on the host,
    // which registered as a double-click. down + up is enough — the host
    // OS synthesizes clicks from those on its own, exactly like a real
    // USB mouse plugged in locally.
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

    // The browser's default click behavior on <video> is to focus the
    // element (good) but also sometimes to toggle playback controls.
    // Swallow click so we don't accidentally pause the remote stream.
    const swallowClick = (e: MouseEvent) => e.preventDefault();
    // Block the native context menu — right-click should go to the host.
    const swallowCtx   = (e: Event) => e.preventDefault();

    v.addEventListener("mousemove",   onMouseMove);
    v.addEventListener("mousedown",   onMouseDown);
    v.addEventListener("mouseup",     onMouseUp);
    v.addEventListener("click",       swallowClick);
    v.addEventListener("contextmenu", swallowCtx);
    v.addEventListener("wheel",       onWheel, { passive: false });
    // Keyboard has to live on window; video can't receive key events
    // without `tabIndex` and focus, and even then it's flaky across browsers.
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup",   onKeyUp);

    return () => {
      v.removeEventListener("mousemove",   onMouseMove);
      v.removeEventListener("mousedown",   onMouseDown);
      v.removeEventListener("mouseup",     onMouseUp);
      v.removeEventListener("click",       swallowClick);
      v.removeEventListener("contextmenu", swallowCtx);
      v.removeEventListener("wheel",       onWheel);
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
      <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <div className="absolute -top-32 -left-32 w-64 h-64 rounded-full bg-accent/20 blur-3xl pointer-events-none" />

          <div className="relative">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-accent/25 to-accent/5 border border-accent/30 text-accent-hi mb-5">
              <Eye className="w-6 h-6" strokeWidth={2.2} />
            </div>

            <h1 className="text-3xl font-bold tracking-tight mb-2">Join a session</h1>
            <p className="text-muted leading-relaxed mb-7">
              Ask the host for their session code. The host has to approve your
              request before anything is shared.
            </p>

            {state.kind === "disconnected" && (
              <div className="flex items-start gap-3 mb-6 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-100 animate-fade-in">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-400" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">Session ended.</strong> {state.reason}
                </p>
              </div>
            )}
            {state.kind === "rejected" && (
              <div className="flex items-start gap-3 mb-6 p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-100 animate-fade-in">
                <XCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-400" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">Request rejected.</strong> {state.reason}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2 mb-5">
              <label
                htmlFor="clientName"
                className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted"
              >
                Your display name
              </label>
              <div className="relative">
                <User
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle pointer-events-none"
                  strokeWidth={2.2}
                />
                <input
                  id="clientName"
                  className="w-full pl-11 pr-4 py-3.5 rounded-xl bg-surface-2/80 border border-white/[0.08] text-text placeholder:text-subtle outline-none transition-all duration-200 focus:border-accent focus:bg-surface-2 focus:ring-4 focus:ring-accent/15"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  maxLength={40}
                  placeholder="How should the host know you?"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2 mb-7">
              <label
                htmlFor="code"
                className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted flex items-center gap-1.5"
              >
                <KeyRound className="w-3 h-3" strokeWidth={2.4} />
                Session code
              </label>
              <input
                id="code"
                className="w-full px-4 py-4 rounded-xl bg-surface-2/80 border border-white/[0.08] text-center font-mono text-2xl font-bold tracking-[0.4em] uppercase outline-none transition-all duration-200 focus:border-accent focus:bg-surface-2 focus:ring-4 focus:ring-accent/15 placeholder:text-subtle/40 placeholder:tracking-[0.4em]"
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
              className="group w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-white shadow-glow transition-all duration-200 hover:shadow-glow-lg hover:-translate-y-[1px] active:translate-y-0 focus:outline-none focus:ring-4 focus:ring-accent/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-glow relative overflow-hidden"
              onClick={sendRequest}
              disabled={code.trim().length < 4}
            >
              <span className="absolute inset-0 bg-gradient-to-r from-accent via-accent-hi to-accent bg-[length:200%_100%] animate-gradient-shift" />
              <span className="relative inline-flex items-center gap-2">
                <Send className="w-4 h-4" strokeWidth={2.4} />
                Send connection request
                <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5 group-disabled:translate-x-0" strokeWidth={2.4} />
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "requesting") {
    return (
      <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <StatusPill kind="waiting" label="Sending request…" />
          <h1 className="mt-5 text-3xl font-bold tracking-tight flex items-center gap-3">
            <Loader2 className="w-6 h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
            Requesting connection
          </h1>
          <p className="mt-2 text-muted leading-relaxed">
            Contacting the signaling server with code{" "}
            <code className="font-mono text-accent-hi">{state.code}</code>.
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "waiting") {
    return (
      <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <div className="absolute -top-32 -right-32 w-64 h-64 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
          <div className="relative">
            <StatusPill kind="waiting" label="Waiting for approval" />

            <h1 className="mt-5 text-3xl font-bold tracking-tight">Waiting for the host</h1>
            <p className="mt-2 text-muted leading-relaxed mb-6">
              Your request reached the host. You'll see their screen as soon as
              they approve. Feel free to cancel if you've changed your mind.
            </p>

            {/* Animated waiting indicator */}
            <div className="flex items-center justify-center gap-2 py-8 my-2 rounded-2xl border border-dashed border-accent/30 bg-gradient-to-b from-accent/[0.08] to-transparent">
              <span className="w-2.5 h-2.5 rounded-full bg-accent-hi animate-pulse-fast" />
              <span
                className="w-2.5 h-2.5 rounded-full bg-accent-hi animate-pulse-fast"
                style={{ animationDelay: "0.2s" }}
              />
              <span
                className="w-2.5 h-2.5 rounded-full bg-accent-hi animate-pulse-fast"
                style={{ animationDelay: "0.4s" }}
              />
            </div>

            <div className="mt-6 flex items-start gap-3 p-4 rounded-xl border border-accent/20 bg-accent/[0.06]">
              <Shield className="shrink-0 mt-0.5 w-5 h-5 text-accent-hi" strokeWidth={2.2} />
              <p className="text-sm text-[#d9d3ff]/90 leading-relaxed">
                Tell the host to look for{" "}
                <strong className="text-white">{clientName}</strong> in their
                request list on session{" "}
                <code className="font-mono text-accent-hi">{state.code}</code>.
              </p>
            </div>

            <button
              className="mt-6 w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-text bg-surface-2/80 border border-white/[0.08] transition-all duration-200 hover:bg-surface-2 hover:border-white/20 focus:outline-none focus:ring-4 focus:ring-white/10"
              onClick={cancel}
            >
              <XCircle className="w-4 h-4" strokeWidth={2.4} />
              Cancel request
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "connecting") {
    return (
      <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <StatusPill kind="request" label="Approved — connecting…" />
          <h1 className="mt-5 text-3xl font-bold tracking-tight flex items-center gap-3">
            <Loader2 className="w-6 h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
            Connecting to {state.code}
          </h1>
          <p className="mt-2 text-muted leading-relaxed mb-6">
            Negotiating the peer-to-peer connection. This usually takes a
            second or two.
          </p>

          {/* Loading skeleton */}
          <div className="space-y-3 mb-6">
            <div className="h-3 w-3/4 rounded-full bg-gradient-to-r from-surface-2 via-surface-3 to-surface-2 bg-[length:200%_100%] animate-shimmer" />
            <div className="h-3 w-1/2 rounded-full bg-gradient-to-r from-surface-2 via-surface-3 to-surface-2 bg-[length:200%_100%] animate-shimmer" />
          </div>

          <button
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-text bg-surface-2/80 border border-white/[0.08] transition-all duration-200 hover:bg-surface-2 hover:border-white/20 focus:outline-none focus:ring-4 focus:ring-white/10"
            onClick={disconnect}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // connected — renders an iframe-style "remote screen" view that:
  //   - fills the available viewport (or the iframe in embed mode)
  //   - keeps the toolbar always visible but compact on small screens
  //   - lets the side panel collapse so the video can use full width
  //   - uses object-contain on <video> so the host's aspect ratio is
  //     preserved with letterboxing instead of stretching.
  return (
    <div
      className={[
        "w-full animate-slide-up",
        // Embed mode = fill the iframe edge-to-edge with no rounding/padding;
        // normal mode = keep a generous max-width and rounded card.
        embed
          ? "w-full h-screen flex flex-col"
          : "max-w-[min(1600px,100%)] mx-auto flex flex-col",
      ].join(" ")}
    >
      <div
        className={[
          "relative flex flex-col flex-1 min-h-0",
          embed
            ? "bg-black"
            : "overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl",
        ].join(" ")}
      >
        {/* ── Toolbar ───────────────────────────────────────────────── */}
        <div
          className={[
            "flex items-center gap-2 sm:gap-3 shrink-0",
            embed
              ? "px-2 sm:px-4 py-2 bg-surface/85 backdrop-blur-xl border-b border-white/[0.08]"
              : "p-3 sm:p-5 md:p-6 pb-3 sm:pb-4 md:pb-5",
          ].join(" ")}
        >
          {/* Status + control badge — collapse to single dot+code on phones */}
          <div className="flex items-center gap-2 min-w-0">
            <StatusPill kind="connected" label={`Connected to ${state.code}`} compact />
            {state.allowControl && (
              <span
                className="hidden xs:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] sm:text-[12.5px] font-medium bg-accent/15 border border-accent/30 text-accent-hi whitespace-nowrap"
                title="The host has granted you remote input."
              >
                <MousePointerClick className="w-3.5 h-3.5" strokeWidth={2.4} />
                <span className="hidden sm:inline">Remote control on</span>
                <span className="sm:hidden">Control</span>
              </span>
            )}
          </div>

          <div className="flex-1 min-w-[0.5rem]" />

          {/* Icon-only on phone, icon+label from sm: up */}
          <button
            className="inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm text-text bg-surface-2/80 border border-white/[0.08] transition-all duration-200 hover:bg-surface-2 hover:border-white/20 focus:outline-none focus:ring-4 focus:ring-white/10"
            onClick={toggleMuted}
            title={muted ? "Unmute shared audio" : "Mute shared audio"}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <VolumeX className="w-4 h-4" strokeWidth={2.2} />
            ) : (
              <Volume2 className="w-4 h-4" strokeWidth={2.2} />
            )}
            <span className="hidden md:inline">{muted ? "Unmute" : "Mute"}</span>
          </button>

          <button
            className="inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm text-text bg-surface-2/80 border border-white/[0.08] transition-all duration-200 hover:bg-surface-2 hover:border-white/20 focus:outline-none focus:ring-4 focus:ring-white/10"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4" strokeWidth={2.2} />
            ) : (
              <Maximize2 className="w-4 h-4" strokeWidth={2.2} />
            )}
            <span className="hidden md:inline">
              {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            </span>
          </button>

          {/* Side-panel toggle — only visible when there's room for one */}
          <button
            className="hidden sm:inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm text-text bg-surface-2/80 border border-white/[0.08] transition-all duration-200 hover:bg-surface-2 hover:border-white/20 focus:outline-none focus:ring-4 focus:ring-white/10"
            onClick={() => setSidePanelOpen((o) => !o)}
            title={sidePanelOpen ? "Hide info panel" : "Show info panel"}
            aria-label={sidePanelOpen ? "Hide info panel" : "Show info panel"}
            aria-expanded={sidePanelOpen}
          >
            {sidePanelOpen ? (
              <PanelRightClose className="w-4 h-4" strokeWidth={2.2} />
            ) : (
              <PanelRightOpen className="w-4 h-4" strokeWidth={2.2} />
            )}
            <span className="hidden lg:inline">{sidePanelOpen ? "Hide info" : "Info"}</span>
          </button>

          <button
            className="inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-semibold text-sm text-red-300 bg-red-500/10 border border-red-500/30 transition-all duration-200 hover:bg-red-500/20 hover:border-red-500/50 focus:outline-none focus:ring-4 focus:ring-red-500/20"
            onClick={disconnect}
            title="Disconnect from the session"
            aria-label="Disconnect"
          >
            <PowerOff className="w-4 h-4" strokeWidth={2.4} />
            <span className="hidden md:inline">Disconnect</span>
          </button>
        </div>

        {/* ── Body: video + optional side panel ─────────────────────── */}
        <div
          className={[
            "flex-1 min-h-0 flex",
            // Stack vertically on phone/tablet (panel below video), side-by-side
            // on lg+ when the panel is open.
            sidePanelOpen ? "flex-col lg:flex-row" : "flex-col",
            embed ? "" : "px-3 sm:px-5 md:px-6 pb-3 sm:pb-5 md:pb-6 gap-4 sm:gap-5",
          ].join(" ")}
        >
          {/* Video frame — fills remaining space; preserves aspect via object-contain */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div
              className={[
                "relative flex-1 min-h-0 overflow-hidden bg-black",
                embed
                  ? ""
                  : "rounded-xl sm:rounded-2xl border border-white/[0.08] shadow-soft-xl",
              ].join(" ")}
              style={{ minHeight: embed ? undefined : "min(60vh, 540px)" }}
            >
              {!embed && (
                <div className="absolute inset-0 rounded-xl sm:rounded-2xl ring-1 ring-inset ring-accent/20 pointer-events-none" />
              )}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                // `muted` is required for autoplay when the stream carries
                // audio (Chrome/Edge/Firefox/Safari autoplay policy). The
                // Unmute button above toggles it off after a user gesture.
                muted={muted}
                // tabIndex lets the video accept focus for scroll/key events.
                tabIndex={0}
                className="w-full h-full object-contain block focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
              <div className="pointer-events-none absolute top-2 sm:top-3 left-2 sm:left-3 inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider text-white border border-white/10">
                <span className="relative flex w-1.5 h-1.5">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-400" />
                </span>
                <span>Streaming</span>
              </div>
            </div>
            {!embed && (
              <p className="mt-2 sm:mt-3 text-[12.5px] sm:text-[13px] text-muted leading-relaxed px-1">
                {state.allowControl
                  ? "Remote control is on — your clicks and keys are being forwarded to the host."
                  : "View-only. The host controls whether your input is forwarded."}
              </p>
            )}
          </div>

          {/* Collapsible info panel */}
          {sidePanelOpen && (
            <aside
              className={[
                "flex flex-col gap-2.5 sm:gap-3 shrink-0 animate-fade-in",
                embed
                  ? "w-full lg:w-[300px] p-3 sm:p-4 bg-surface/85 backdrop-blur-xl border-t lg:border-t-0 lg:border-l border-white/[0.08] overflow-y-auto"
                  : "w-full lg:w-[300px]",
              ].join(" ")}
            >
              <div className="rounded-xl border border-white/[0.06] bg-surface-2/60 backdrop-blur-sm p-3 sm:p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-1.5 flex items-center gap-1.5">
                  <KeyRound className="w-3 h-3" strokeWidth={2.4} />
                  Session
                </h3>
                <p className="font-mono text-base sm:text-lg font-bold tracking-widest text-text">
                  {state.code}
                </p>
              </div>

              <div className="rounded-xl border border-white/[0.06] bg-surface-2/60 backdrop-blur-sm p-3 sm:p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                  <MousePointerClick className="w-3 h-3" strokeWidth={2.4} />
                  Input status
                </h3>
                <p className="text-muted text-[12.5px] sm:text-[13px] leading-relaxed">
                  {state.allowControl
                    ? "The host has allowed your input. Click the video area to focus it, then interact as you would locally."
                    : "The host hasn't enabled remote control. You can watch, but your clicks and keys stay on this page."}
                </p>
              </div>

              <div className="rounded-xl border border-white/[0.06] bg-surface-2/60 backdrop-blur-sm p-3 sm:p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                  <Lightbulb className="w-3 h-3" strokeWidth={2.4} />
                  Tips
                </h3>
                <p className="text-muted text-[12.5px] sm:text-[13px] leading-relaxed">
                  If the video looks blurry, try resizing the window — the
                  host's screen is scaled to fit. Click the video to focus it
                  before typing, so keys route to the host. Audio plays if the
                  host ticked "Share audio" in the browser picker.
                </p>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── UI-only helpers ─────────────────────────────────────────────────── */

function StatusPill({
  kind,
  label,
  compact = false,
}: {
  kind: "idle" | "waiting" | "request" | "connected" | "error";
  label: string;
  /** When true, on small screens render only the dot — saves toolbar width. */
  compact?: boolean;
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
    <span
      className={[
        "inline-flex items-center gap-2 rounded-full text-[12.5px] font-medium bg-surface-2/70 border border-white/[0.06] backdrop-blur-sm whitespace-nowrap",
        compact ? "px-2 sm:px-3.5 py-1 sm:py-1.5" : "px-3.5 py-1.5",
      ].join(" ")}
    >
      <span className="relative flex w-2 h-2 shrink-0">
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
      <span className={compact ? "hidden sm:inline truncate" : "truncate"}>
        {label}
      </span>
    </span>
  );
}
