import { useCallback, useEffect, useRef, useState } from "react";
import { Signaling } from "../lib/signaling";
import { Peer, type InputEvent } from "../lib/webrtc";
import { Eye, User, KeyRound, ArrowRight, Loader2, AlertTriangle, XCircle, Volume2, VolumeX, Maximize2, Minimize2, PowerOff, Send, Lightbulb, MousePointerClick, Shield, PanelRightOpen, PanelRightClose, Mic, MicOff } from "lucide-react";
import { t } from "../i18n";
type ClientState = {
  kind: "idle";
} | {
  kind: "requesting";
  code: string;
} | {
  kind: "waiting";
  code: string;
} | {
  kind: "connecting";
  code: string;
} | {
  kind: "connected";
  code: string;
  allowControl: boolean;
} | {
  kind: "rejected";
  code: string;
  reason: string;
} | {
  kind: "disconnected";
  reason: string;
};
interface Props {
  prefillCode: string | null;
  embed?: boolean;
  autoPairToken?: string | null;
}
export function ClientPage({
  prefillCode,
  embed = false,
  autoPairToken = null
}: Props) {
  const [state, setState] = useState<ClientState>({
    kind: "idle"
  });
  const [code, setCode] = useState(prefillCode?.toUpperCase() ?? "");
  const [clientName, setClientName] = useState("Client");
  const [muted, setMuted] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(() => {
    if (embed) return false;
    if (typeof window !== "undefined") return window.innerWidth >= 1024;
    return true;
  });
  const signalingRef = useRef<Signaling | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const hardDisconnect = useCallback((reason: string, terminalKind: "disconnected" | "rejected" = "disconnected") => {
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setMicOn(false);
    setMicBusy(false);
    setMicError(null);
    setState(s => {
      if (terminalKind === "rejected" && (s.kind === "requesting" || s.kind === "waiting")) {
        return {
          kind: "rejected",
          code: s.code,
          reason
        };
      }
      return {
        kind: "disconnected",
        reason
      };
    });
  }, []);
  const sendRequest = useCallback(async () => {
    const trimmed = code.trim().toUpperCase();
    if (!autoPairToken && !trimmed) return;
    const displayCode = trimmed || "AUTO";
    setState({
      kind: "requesting",
      code: displayCode
    });
    const sig = new Signaling();
    signalingRef.current = sig;
    try {
      await sig.connect();
    } catch {
      hardDisconnect(t("client.dc.serverUnreachable"));
      return;
    }
    sig.on("request:approved", () => {
      setState(s => s.kind === "waiting" || s.kind === "requesting" ? {
        kind: "connecting",
        code: s.code
      } : s);
    });
    sig.on("request:rejected", msg => {
      hardDisconnect(msg.reason || t("client.dc.hostRejected"), "rejected");
    });
    sig.on("peer:ready", msg => {
      const peer = new Peer(sig, "client", {
        onRemoteStream: stream => {
          const v = videoRef.current;
          if (!v) return;
          v.srcObject = stream;
          v.play().catch(err => console.warn("[client] video.play():", err));
        },
        onRemoteAudioStream: stream => {
          const a = remoteAudioRef.current;
          if (!a) return;
          a.srcObject = stream;
          a.play().catch(err => console.warn("[client] remote audio play():", err));
        },
        onConnectionStateChange: s => {
          if (s === "failed" || s === "closed") hardDisconnect(t("client.dc.connectionClosed"));
        },
        onChannelOpen: () => {
          peer.sendInput({
            t: "hello",
            clientName
          });
        }
      });
      peerRef.current = peer;
      setState(s => s.kind === "connecting" || s.kind === "waiting" ? {
        kind: "connected",
        code: s.code,
        allowControl: msg.allowControl
      } : s);
    });
    sig.on("control:changed", msg => {
      setState(s => s.kind === "connected" ? {
        ...s,
        allowControl: msg.allowed
      } : s);
    });
    sig.on("signal", msg => {
      void peerRef.current?.handleRemoteSignal(msg.data);
    });
    sig.on("peer:left", msg => {
      hardDisconnect(t("client.dc.hostLeft", { reason: msg.reason }));
    });
    sig.on("error", msg => {
      const reason = msg.code === "invalid-code" ? t("client.dc.invalidCode") : msg.code === "session-full" ? t("client.dc.sessionFull") : msg.code === "session-ended" ? t("client.dc.sessionEndedEarly") : msg.message;
      hardDisconnect(reason, "rejected");
    });
    sig.onceClosed().then(reason => {
      setState(s => {
        if (s.kind === "connected" || s.kind === "connecting" || s.kind === "waiting" || s.kind === "requesting") {
          return {
            kind: "disconnected",
            reason: t("client.dc.connClosed", { reason })
          };
        }
        return s;
      });
    });
    if (autoPairToken) {
      sig.send({
        type: "client:claim",
        token: autoPairToken,
        clientName
      });
    } else {
      sig.send({
        type: "client:join",
        code: trimmed,
        clientName
      });
    }
    setState(s => s.kind === "requesting" ? {
      kind: "waiting",
      code: s.code
    } : s);
  }, [code, clientName, autoPairToken, hardDisconnect]);
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (state.kind !== "idle") return;
    const canAutoStart = !!autoPairToken || (embed && code.trim().length >= 4);
    if (!canAutoStart) return;
    autoStartedRef.current = true;
    void sendRequest();
  }, [autoPairToken, embed, code, state.kind, sendRequest]);
  const cancel = () => {
    signalingRef.current?.send({
      type: "client:cancel"
    });
    hardDisconnect(t("client.dc.cancelled"));
  };
  const disconnect = () => hardDisconnect(t("client.dc.disconnected"));
  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    const v = videoRef.current;
    if (v) {
      v.muted = next;
      if (!next) v.play().catch(err => console.warn("[client] unmute play():", err));
    }
  };
  const toggleMic = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer || micBusy) return;
    // The click on the Mic button is a guaranteed user gesture. Use it to
    // (re)play the remote audio element too — autoplay can stay blocked
    // when the connection was established without a recent user gesture,
    // and there's no other moment on this side where we get a fresh one.
    const a = remoteAudioRef.current;
    if (a && a.paused) {
      a.play().catch(err => console.warn("[client] remote audio play() on toggleMic:", err));
    }
    setMicBusy(true);
    setMicError(null);
    try {
      if (micOn) {
        peer.closeMic();
        setMicOn(false);
      } else {
        const ok = await peer.openMic();
        if (ok) {
          setMicOn(true);
        } else {
          setMicError(t("host.micUnavailable.body"));
        }
      }
    } finally {
      setMicBusy(false);
    }
  }, [micOn, micBusy]);
  const toggleFullscreen = () => {
    const v = videoRef.current;
    if (!v) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.warn("[client] exitFullscreen:", err));
    } else {
      v.requestFullscreen().catch(err => console.warn("[client] requestFullscreen:", err));
    }
  };
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const connected = state.kind === "connected";
  const controlOn = state.kind === "connected" && state.allowControl;
  useEffect(() => {
    if (!connected || !controlOn) return;
    const v = videoRef.current;
    if (!v) return;
    const send = (ev: InputEvent) => peerRef.current?.sendInput(ev);
    let lastMove: {
      x: number;
      y: number;
    } | null = null;
    let moveScheduled = false;
    const flushMove = () => {
      moveScheduled = false;
      if (!lastMove) return;
      send({
        t: "mouse",
        x: lastMove.x,
        y: lastMove.y,
        kind: "move"
      });
      lastMove = null;
    };
    const localCoords = (e: MouseEvent) => {
      const rect = v.getBoundingClientRect();
      const vW = v.videoWidth;
      const vH = v.videoHeight;
      if (!vW || !vH) {
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        return {
          x,
          y
        };
      }
      const videoAspect = vW / vH;
      const rectAspect = rect.width / rect.height;
      let drawW: number, drawH: number, offX: number, offY: number;
      if (videoAspect > rectAspect) {
        drawW = rect.width;
        drawH = rect.width / videoAspect;
        offX = 0;
        offY = (rect.height - drawH) / 2;
      } else {
        drawH = rect.height;
        drawW = rect.height * videoAspect;
        offY = 0;
        offX = (rect.width - drawW) / 2;
      }
      const x = (e.clientX - rect.left - offX) / drawW;
      const y = (e.clientY - rect.top - offY) / drawH;
      return {
        x,
        y
      };
    };
    const onMouseMove = (e: MouseEvent) => {
      lastMove = localCoords(e);
      if (moveScheduled) return;
      moveScheduled = true;
      requestAnimationFrame(flushMove);
    };
    const onMouseDown = (e: MouseEvent) => {
      const {
        x,
        y
      } = localCoords(e);
      send({
        t: "mouse",
        x,
        y,
        button: e.button,
        kind: "down"
      });
    };
    const onMouseUp = (e: MouseEvent) => {
      const {
        x,
        y
      } = localCoords(e);
      send({
        t: "mouse",
        x,
        y,
        button: e.button,
        kind: "up"
      });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send({
        t: "wheel",
        dx: e.deltaX,
        dy: e.deltaY
      });
    };
    const isVideoFocused = () => document.activeElement === v;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isVideoFocused()) return;
      e.preventDefault();
      send({
        t: "key",
        key: e.key,
        code: e.code,
        kind: "down"
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isVideoFocused()) return;
      e.preventDefault();
      send({
        t: "key",
        key: e.key,
        code: e.code,
        kind: "up"
      });
    };
    const swallowClick = (e: MouseEvent) => e.preventDefault();
    const swallowCtx = (e: Event) => e.preventDefault();
    v.addEventListener("mousemove", onMouseMove);
    v.addEventListener("mousedown", onMouseDown);
    v.addEventListener("mouseup", onMouseUp);
    v.addEventListener("click", swallowClick);
    v.addEventListener("contextmenu", swallowCtx);
    v.addEventListener("wheel", onWheel, {
      passive: false
    });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      v.removeEventListener("mousemove", onMouseMove);
      v.removeEventListener("mousedown", onMouseDown);
      v.removeEventListener("mouseup", onMouseUp);
      v.removeEventListener("click", swallowClick);
      v.removeEventListener("contextmenu", swallowCtx);
      v.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [connected, controlOn]);
  useEffect(() => () => {
    peerRef.current?.close();
    signalingRef.current?.close();
  }, []);
  if (state.kind === "idle" || state.kind === "disconnected" || state.kind === "rejected") {
    if (embed) {
      return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
          <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
            {state.kind === "idle" && <div className="flex items-center gap-3">
                <Loader2 className="w-6 h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
                <p className="text-muted leading-relaxed">{t("client.idle.connecting")}</p>
              </div>}
            {state.kind === "disconnected" && <div className="flex items-start gap-3 p-4 rounded-xl border border-warning/40 bg-amber-50 text-amber-800">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-warning" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">{t("client.sessionEnded")}</strong> {state.reason}
                </p>
              </div>}
            {state.kind === "rejected" && <div className="flex items-start gap-3 p-4 rounded-xl border border-danger/30 bg-red-50 text-red-800">
                <XCircle className="w-5 h-5 shrink-0 mt-0.5 text-danger" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">{t("client.requestRejected")}</strong> {state.reason}
                </p>
              </div>}
          </div>
        </div>;
    }
    return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <div className="absolute -top-32 -left-32 w-64 h-64 rounded-full bg-primary/10 blur-3xl pointer-events-none" />

          <div className="relative">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-accent/25 to-accent/5 border border-accent/30 text-accent-hi mb-5">
              <Eye className="w-6 h-6" strokeWidth={2.2} />
            </div>

            <h1 className="text-3xl font-bold tracking-tight mb-2">{t("client.idle.title")}</h1>
            <p className="text-muted leading-relaxed mb-7">
              {t("client.idle.intro")}
            </p>

            {state.kind === "disconnected" && <div className="flex items-start gap-3 mb-6 p-4 rounded-xl border border-warning/40 bg-amber-50 text-amber-800 animate-fade-in">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-warning" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">{t("client.sessionEnded")}</strong> {state.reason}
                </p>
              </div>}
            {state.kind === "rejected" && <div className="flex items-start gap-3 mb-6 p-4 rounded-xl border border-danger/30 bg-red-50 text-red-800 animate-fade-in">
                <XCircle className="w-5 h-5 shrink-0 mt-0.5 text-danger" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">{t("client.requestRejected")}</strong> {state.reason}
                </p>
              </div>}

            <div className="flex flex-col gap-2 mb-5">
              <label htmlFor="clientName" className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                {t("client.idle.nameLabel")}
              </label>
              <div className="relative">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle pointer-events-none" strokeWidth={2.2} />
                <input id="clientName" className="w-full pl-11 pr-4 py-3.5 rounded-xl bg-canvas border border-line text-text placeholder:text-subtle outline-none transition-all duration-200 focus:border-accent focus:bg-surface-2 focus:ring-4 focus:ring-accent/15" value={clientName} onChange={e => setClientName(e.target.value)} maxLength={40} placeholder={t("client.idle.namePlaceholder")} />
              </div>
            </div>

            <div className="flex flex-col gap-2 mb-7">
              <label htmlFor="code" className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted flex items-center gap-1.5">
                <KeyRound className="w-3 h-3" strokeWidth={2.4} />
                {t("client.idle.codeLabel")}
              </label>
              <input id="code" className="w-full px-4 py-4 rounded-xl bg-canvas border border-line text-center font-mono text-2xl font-bold tracking-[0.4em] uppercase outline-none transition-all duration-200 focus:border-accent focus:bg-surface-2 focus:ring-4 focus:ring-accent/15 placeholder:text-subtle/40 placeholder:tracking-[0.4em]" value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} maxLength={6} placeholder="ABC123" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
            </div>

            <button className="group w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-white shadow-glow transition-all duration-200 hover:shadow-glow-lg hover:-translate-y-[1px] active:translate-y-0 focus:outline-none focus:ring-4 focus:ring-accent/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-glow relative overflow-hidden" onClick={sendRequest} disabled={code.trim().length < 4}>
              <span className="absolute inset-0 bg-gradient-to-r from-accent via-accent-hi to-accent bg-[length:200%_100%] animate-gradient-shift" />
              <span className="relative inline-flex items-center gap-2">
                <Send className="w-4 h-4" strokeWidth={2.4} />
                {t("client.idle.send")}
                <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5 group-disabled:translate-x-0" strokeWidth={2.4} />
              </span>
            </button>
          </div>
        </div>
      </div>;
  }
  if (state.kind === "requesting") {
    return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <StatusPill kind="waiting" label={t("client.requesting.statusPill")} />
          <h1 className="mt-5 text-3xl font-bold tracking-tight flex items-center gap-3">
            <Loader2 className="w-6 h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
            {t("client.requesting.title")}
          </h1>
          <p className="mt-2 text-muted leading-relaxed">
            {t("client.requesting.intro", { code: state.code })}
          </p>
        </div>
      </div>;
  }
  if (state.kind === "waiting") {
    return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <div className="absolute -top-32 -right-32 w-64 h-64 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
          <div className="relative">
            <StatusPill kind="waiting" label={t("client.waiting.statusPill")} />

            <h1 className="mt-5 text-3xl font-bold tracking-tight">{t("client.waiting.title")}</h1>
            <p className="mt-2 text-muted leading-relaxed mb-6">
              {t("client.waiting.intro")}
            </p>

            <div className="flex items-center justify-center gap-2 py-8 my-2 rounded-2xl border border-dashed border-accent/30 bg-gradient-to-b from-accent/[0.08] to-transparent">
              <span className="w-2.5 h-2.5 rounded-full bg-accent-hi animate-pulse-fast" />
              <span className="w-2.5 h-2.5 rounded-full bg-accent-hi animate-pulse-fast" style={{
              animationDelay: "0.2s"
            }} />
              <span className="w-2.5 h-2.5 rounded-full bg-accent-hi animate-pulse-fast" style={{
              animationDelay: "0.4s"
            }} />
            </div>

            <div className="mt-6 flex items-start gap-3 p-4 rounded-xl border border-accent/20 bg-accent/[0.06]">
              <Shield className="shrink-0 mt-0.5 w-5 h-5 text-accent-hi" strokeWidth={2.2} />
              <p className="text-sm text-text700 leading-relaxed">
                {t("client.waiting.shield", { name: clientName, code: state.code })}
              </p>
            </div>

            <button className="mt-6 w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-text bg-canvas border border-line transition-all duration-200 hover:bg-surface-2 hover:border-border-hi focus:outline-none focus:ring-4 focus:ring-line" onClick={cancel}>
              <XCircle className="w-4 h-4" strokeWidth={2.4} />
              {t("client.waiting.cancel")}
            </button>
          </div>
        </div>
      </div>;
  }
  if (state.kind === "connecting") {
    return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <StatusPill kind="request" label={t("client.connecting.statusPill")} />
          <h1 className="mt-5 text-3xl font-bold tracking-tight flex items-center gap-3">
            <Loader2 className="w-6 h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
            {t("client.connecting.title", { code: state.code })}
          </h1>
          <p className="mt-2 text-muted leading-relaxed mb-6">
            {t("client.connecting.intro")}
          </p>

          <div className="space-y-3 mb-6">
            <div className="h-3 w-3/4 rounded-full bg-gradient-to-r from-canvas via-line to-canvas bg-[length:200%_100%] animate-shimmer" />
            <div className="h-3 w-1/2 rounded-full bg-gradient-to-r from-canvas via-line to-canvas bg-[length:200%_100%] animate-shimmer" />
          </div>

          <button className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-text bg-canvas border border-line transition-all duration-200 hover:bg-surface-2 hover:border-border-hi focus:outline-none focus:ring-4 focus:ring-line" onClick={disconnect}>
            {t("client.connecting.cancel")}
          </button>
        </div>
      </div>;
  }
  return <div className={["w-full animate-slide-up", embed ? "w-full h-screen flex flex-col" : "max-w-[min(1600px,100%)] mx-auto flex flex-col"].join(" ")}>
      <div className={["relative flex flex-col flex-1 min-h-0", embed ? "bg-black" : "overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl"].join(" ")}>
        <div className={["flex items-center gap-2 sm:gap-3 shrink-0", embed ? "px-2 sm:px-4 py-2 bg-white/95 backdrop-blur border-b border-line" : "p-3 sm:p-5 md:p-6 pb-3 sm:pb-4 md:pb-5"].join(" ")}>
          <div className="flex items-center gap-2 min-w-0">
            <StatusPill kind="connected" label={t("client.connected.statusPill", { code: state.code })} compact />
            {state.allowControl && <span className="hidden xs:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] sm:text-[12.5px] font-medium bg-accent/15 border border-accent/30 text-accent-hi whitespace-nowrap" title={t("client.connected.controlTitle")}>
                <MousePointerClick className="w-3.5 h-3.5" strokeWidth={2.4} />
                <span className="hidden sm:inline">{t("client.connected.controlOn")}</span>
                <span className="sm:hidden">{t("client.connected.controlShort")}</span>
              </span>}
          </div>

          <div className="flex-1 min-w-[0.5rem]" />

          <button className={["inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm border transition-all duration-200 focus:outline-none focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed", micOn ? "text-white bg-gradient-to-r from-accent to-accent-hi border-accent-hi shadow-glow hover:shadow-glow-lg focus:ring-accent/30" : "text-text bg-canvas border-line hover:bg-surface-2 hover:border-border-hi focus:ring-line"].join(" ")} onClick={toggleMic} disabled={micBusy} title={micOn ? t("host.connected.micToggleOff") : t("host.connected.micToggleOn")} aria-label={micOn ? t("host.connected.micToggleOff") : t("host.connected.micToggleOn")} aria-pressed={micOn}>
            {micBusy ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2.2} /> : micOn ? <Mic className="w-4 h-4" strokeWidth={2.4} /> : <MicOff className="w-4 h-4" strokeWidth={2.2} />}
            <span className="hidden md:inline">{micOn ? t("host.connected.micOn") : t("host.connected.micOff")}</span>
          </button>

          <button className="inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm text-text bg-canvas border border-line transition-all duration-200 hover:bg-surface-2 hover:border-border-hi focus:outline-none focus:ring-4 focus:ring-line" onClick={toggleMuted} title={muted ? t("client.connected.unmuteTitle") : t("client.connected.muteTitle")} aria-label={muted ? t("client.connected.unmute") : t("client.connected.mute")}>
            {muted ? <VolumeX className="w-4 h-4" strokeWidth={2.2} /> : <Volume2 className="w-4 h-4" strokeWidth={2.2} />}
            <span className="hidden md:inline">{muted ? t("client.connected.unmute") : t("client.connected.mute")}</span>
          </button>

          <button className="inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm text-text bg-canvas border border-line transition-all duration-200 hover:bg-surface-2 hover:border-border-hi focus:outline-none focus:ring-4 focus:ring-line" onClick={toggleFullscreen} title={isFullscreen ? t("client.connected.exitFullscreenTitle") : t("client.connected.fullscreen")} aria-label={isFullscreen ? t("client.connected.exitFullscreen") : t("client.connected.fullscreen")}>
            {isFullscreen ? <Minimize2 className="w-4 h-4" strokeWidth={2.2} /> : <Maximize2 className="w-4 h-4" strokeWidth={2.2} />}
            <span className="hidden md:inline">
              {isFullscreen ? t("client.connected.exitFullscreen") : t("client.connected.fullscreen")}
            </span>
          </button>

          <button className="hidden sm:inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm text-text bg-canvas border border-line transition-all duration-200 hover:bg-surface-2 hover:border-border-hi focus:outline-none focus:ring-4 focus:ring-line" onClick={() => setSidePanelOpen(o => !o)} title={sidePanelOpen ? t("host.connected.hideInfoTitle") : t("host.connected.showInfoTitle")} aria-label={sidePanelOpen ? t("host.connected.hideInfoTitle") : t("host.connected.showInfoTitle")} aria-expanded={sidePanelOpen}>
            {sidePanelOpen ? <PanelRightClose className="w-4 h-4" strokeWidth={2.2} /> : <PanelRightOpen className="w-4 h-4" strokeWidth={2.2} />}
            <span className="hidden lg:inline">{sidePanelOpen ? t("host.connected.hideInfo") : t("host.connected.showInfo")}</span>
          </button>

          <button className="inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-semibold text-sm text-red-700 bg-red-50 border border-danger/30 transition-all duration-200 hover:bg-red-100 hover:border-danger/50 focus:outline-none focus:ring-4 focus:ring-danger/20" onClick={disconnect} title={t("client.connected.disconnectTitle")} aria-label={t("client.connected.disconnect")}>
            <PowerOff className="w-4 h-4" strokeWidth={2.4} />
            <span className="hidden md:inline">{t("client.connected.disconnect")}</span>
          </button>
        </div>

        {micError && <div className="flex items-start gap-3 p-3 sm:p-4 border-b border-danger/40 bg-red-50 text-red-800 animate-slide-up shrink-0">
            <AlertTriangle className="shrink-0 mt-0.5 w-5 h-5 text-danger" strokeWidth={2.2} />
            <div className="flex-1 min-w-0">
              <strong className="text-sm font-semibold text-text900 block">{t("host.micUnavailable")}</strong>
              <p className="mt-0.5 text-[12.5px] sm:text-[13px] leading-relaxed text-red-700/90">{micError}</p>
            </div>
            <button className="text-xs font-semibold text-red-700 hover:text-red-900 px-2 py-1 rounded-md hover:bg-red-100 transition-colors" onClick={() => setMicError(null)}>{t("host.dismiss")}</button>
          </div>}

        <audio
          ref={remoteAudioRef}
          autoPlay
          playsInline
          style={{ position: "fixed", left: "-9999px", top: "-9999px", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />

        <div className={["flex-1 min-h-0 flex", sidePanelOpen ? "flex-col lg:flex-row" : "flex-col", embed ? "" : "px-3 sm:px-5 md:px-6 pb-3 sm:pb-5 md:pb-6 gap-4 sm:gap-5"].join(" ")}>
          <div className="flex-1 min-h-0 flex flex-col">
            <div className={["relative flex-1 min-h-0 overflow-hidden bg-black", embed ? "" : "rounded-xl sm:rounded-2xl border border-line shadow-soft-xl"].join(" ")} style={{
            minHeight: embed ? undefined : "min(60vh, 540px)"
          }}>
              {!embed && <div className="absolute inset-0 rounded-xl sm:rounded-2xl ring-1 ring-inset ring-accent/20 pointer-events-none" />}
              <video ref={videoRef} autoPlay playsInline muted={muted} tabIndex={0} className="w-full h-full object-contain block focus:outline-none focus:ring-2 focus:ring-accent/50" />
              <div className="pointer-events-none absolute top-2 sm:top-3 left-2 sm:left-3 inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider text-white border border-line">
                <span className="relative flex w-1.5 h-1.5">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-success opacity-75 animate-ping" />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-success" />
                </span>
                <span>{t("client.connected.streaming")}</span>
              </div>
            </div>
            {!embed && <p className="mt-2 sm:mt-3 text-[12.5px] sm:text-[13px] text-muted leading-relaxed px-1">
                {state.allowControl ? t("client.connected.controlBlurb") : t("client.connected.viewBlurb")}
              </p>}
          </div>

          {sidePanelOpen && <aside className={["flex flex-col gap-2.5 sm:gap-3 shrink-0 animate-fade-in", embed ? "w-full lg:w-[300px] p-3 sm:p-4 bg-white/95 backdrop-blur border-t lg:border-t-0 lg:border-l border-line overflow-y-auto" : "w-full lg:w-[300px]"].join(" ")}>
              <div className="rounded-xl border border-line bg-canvas p-3 sm:p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-1.5 flex items-center gap-1.5">
                  <KeyRound className="w-3 h-3" strokeWidth={2.4} />
                  {t("client.connected.session")}
                </h3>
                <p className="font-mono text-base sm:text-lg font-bold tracking-widest text-text">
                  {state.code}
                </p>
              </div>

              <div className="rounded-xl border border-line bg-canvas p-3 sm:p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                  <MousePointerClick className="w-3 h-3" strokeWidth={2.4} />
                  {t("client.connected.inputStatus")}
                </h3>
                <p className="text-muted text-[12.5px] sm:text-[13px] leading-relaxed">
                  {state.allowControl ? t("client.connected.inputAllowed") : t("client.connected.inputBlocked")}
                </p>
              </div>

              <div className="rounded-xl border border-line bg-canvas p-3 sm:p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                  <Lightbulb className="w-3 h-3" strokeWidth={2.4} />
                  {t("client.connected.tips")}
                </h3>
                <p className="text-muted text-[12.5px] sm:text-[13px] leading-relaxed">
                  {t("client.connected.tipsBody")}
                </p>
              </div>
            </aside>}
        </div>
      </div>
    </div>;
}
function StatusPill({
  kind,
  label,
  compact = false
}: {
  kind: "idle" | "waiting" | "request" | "connected" | "error";
  label: string;
  compact?: boolean;
}) {
  const dotColor = kind === "connected" ? "bg-success" : kind === "waiting" ? "bg-warning" : kind === "request" ? "bg-accent-hi" : kind === "error" ? "bg-danger" : "bg-subtle";
  const pulse = kind === "waiting" || kind === "request";
  const ring = kind === "connected" ? "ring-success/40" : kind === "waiting" ? "ring-warning/40" : kind === "request" ? "ring-accent-hi/50" : kind === "error" ? "ring-danger/40" : "ring-line";
  return <span className={["inline-flex items-center gap-2 rounded-full text-[12.5px] font-medium bg-white border border-line whitespace-nowrap", compact ? "px-2 sm:px-3.5 py-1 sm:py-1.5" : "px-3.5 py-1.5"].join(" ")}>
      <span className="relative flex w-2 h-2 shrink-0">
        {pulse && <span className={["absolute inline-flex w-full h-full rounded-full opacity-70", dotColor].join(" ")} style={{
        animation: "ping 1.2s cubic-bezier(0, 0, 0.2, 1) infinite"
      }} />}
        <span className={["relative inline-flex w-2 h-2 rounded-full ring-2", dotColor, ring].join(" ")} />
      </span>
      <span className={compact ? "hidden sm:inline truncate" : "truncate"}>
        {label}
      </span>
    </span>;
}
