import { useCallback, useEffect, useRef, useState } from "react";
import { Signaling } from "../lib/signaling";
import { Peer, type InputEvent } from "../lib/webrtc";
import { Voice } from "../lib/voice";
import { MonitorPlay, Copy, Link as LinkIcon, Check, X, PowerOff, AlertTriangle, Loader2, Shield, Activity, Cpu, ShieldCheck, CircleDot, KeyRound, PanelRightOpen, PanelRightClose, Mic, MicOff } from "lucide-react";
import { t } from "../i18n";
const AGENT_WS_URL = "ws://127.0.0.1:8766";
type HostState = {
  kind: "idle";
} | {
  kind: "creating";
} | {
  kind: "waiting";
  code: string;
} | {
  kind: "request";
  code: string;
  requestId: string;
  clientName: string;
} | {
  kind: "connecting";
  code: string;
  clientName: string;
} | {
  kind: "connected";
  code: string;
  clientName: string;
} | {
  kind: "disconnected";
  reason: string;
};
interface HostProps {
  embed?: boolean;
  autoPairToken?: string | null;
}
export function HostPage({
  embed = false,
  autoPairToken = null
}: HostProps = {}) {
  const [state, setState] = useState<HostState>({
    kind: "idle"
  });
  const [hostName, setHostName] = useState("Host");
  const [allowControl, setAllowControl] = useState(false);
  const [incomingLog, setIncomingLog] = useState<string[]>([]);
  const [sidePanelOpen, setSidePanelOpen] = useState(() => {
    if (embed) return false;
    if (typeof window !== "undefined") return window.innerWidth >= 1024;
    return true;
  });
  const [agentStatus, setAgentStatus] = useState<"off" | "connecting" | "warming" | "up" | "down">("off");
  const [agentBackend, setAgentBackend] = useState<string>("");
  const [micOn, setMicOn] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  // True once the LiveKit room has actually connected. The mic button stays
  // disabled until then so users can't click it while voice is still
  // negotiating (which would just fail with a "room not connected" warning).
  const [voiceReady, setVoiceReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const signalingRef = useRef<Signaling | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const voiceRef = useRef<Voice | null>(null);
  const sessionCodeRef = useRef<string>("");
  const streamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const agentRef = useRef<WebSocket | null>(null);
  const agentQueueRef = useRef<string[]>([]);
  const agentWantedRef = useRef<boolean>(false);
  const agentReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentDropWarnedRef = useRef<boolean>(false);
  const allowControlRef = useRef<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
      try {
        ws.close();
      } catch {}
    }
    setAgentStatus("off");
  }, []);
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
    ws.onopen = () => {
      agentDropWarnedRef.current = false;
      setAgentStatus(s => s === "up" ? s : "warming");
      const q = agentQueueRef.current;
      agentQueueRef.current = [];
      for (const msg of q) {
        try {
          ws.send(msg);
        } catch {}
      }
    };
    ws.onerror = () => setAgentStatus("down");
    ws.onclose = () => {
      if (agentRef.current === ws) {
        agentRef.current = null;
        setAgentStatus(s => s === "off" ? s : "down");
        scheduleReconnect();
      }
    };
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          backend?: string;
          ready?: boolean;
          connected?: boolean;
        };
        if (msg.type === "agent:status" || msg.type === "agent:vb6") {
          const isReady = msg.ready ?? msg.connected ?? false;
          setAgentStatus(isReady ? "up" : "warming");
          if (msg.backend) setAgentBackend(msg.backend);
        }
      } catch {}
    };
    agentRef.current = ws;
    return ws;
  }, []);
  const sendToAgent = useCallback((ev: InputEvent) => {
    const payload = JSON.stringify(ev);
    const ws = agentRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
        return;
      } catch {}
    }
    const q = agentQueueRef.current;
    if (q.length > 500) q.splice(0, q.length - 500);
    q.push(payload);
    if (agentWantedRef.current && (!ws || ws.readyState === WebSocket.CLOSED)) {
      ensureAgent();
    }
  }, [ensureAgent]);
  const hardDisconnect = useCallback((reason: string) => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    voiceRef.current?.close();
    voiceRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
    closeAgent();
    allowControlRef.current = false;
    setAllowControl(false);
    setIncomingLog([]);
    setMicOn(false);
    setMicBusy(false);
    setMicError(null);
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setState({
      kind: "disconnected",
      reason
    });
  }, [closeAgent]);
  const createSession = useCallback(async () => {
    setState({
      kind: "creating"
    });
    const sig = new Signaling();
    signalingRef.current = sig;
    try {
      await sig.connect();
    } catch {
      hardDisconnect(t("host.dc.serverUnreachable"));
      return;
    }
    sig.on("session:created", msg => {
      sessionCodeRef.current = msg.code;
      setState({
        kind: "waiting",
        code: msg.code
      });
    });
    sig.on("request:incoming", msg => {
      setIncomingLog(l => [`${fmtTime(msg.at)} — ${msg.clientName}`, ...l].slice(0, 5));
      setState(s => {
        if (s.kind === "waiting") {
          return {
            kind: "request",
            code: s.code,
            requestId: msg.requestId,
            clientName: msg.clientName
          };
        }
        return s;
      });
    });
    sig.on("peer:ready", async msg => {
      if (autoPairToken && !allowControlRef.current) {
        allowControlRef.current = true;
        setAllowControl(true);
        ensureAgent();
      }
      const peer = new Peer(sig, "host", {
        onInput: handleRemoteInput,
        onConnectionStateChange: s => {
          if (s === "failed" || s === "closed") hardDisconnect(t("host.dc.connectionClosed"));
        }
      });
      peerRef.current = peer;
      // Connect to the LiveKit room for voice. Room name == session code.
      // The server includes the code in every peer:ready, so we use that
      // directly. We also fall back to sessionCodeRef (set on
      // session:created) to be defensive against an older server.
      const code = (msg.code || sessionCodeRef.current || "").toString();
      if (code) sessionCodeRef.current = code;
      const voice = new Voice({
        onRemoteAudioStream: stream => {
          const a = remoteAudioRef.current;
          if (!a) return;
          if (a.srcObject !== stream) a.srcObject = stream;
          a.play().catch(err => console.warn("[host] remote audio play():", err));
        },
      });
      voiceRef.current = voice;
      setVoiceReady(false);
      if (code) {
        void voice.open(code, "host", hostName).then(ok => {
          if (ok) {
            setVoiceReady(true);
          } else {
            console.warn("[host] LiveKit voice unavailable - mic button will fail to publish");
          }
        });
      } else {
        console.warn("[host] no session code in peer:ready - voice disabled");
      }
      sig.send({
        type: "host:setControl",
        allowed: allowControlRef.current
      });
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
      } catch (err) {
        console.error("[host] getDisplayMedia:", err);
        sig.send({
          type: "host:end"
        });
        hardDisconnect(t("host.dc.shareCancelled"));
        return;
      }
      streamRef.current = stream;
      peer.addScreenStream(stream);
      if (videoRef.current) videoRef.current.srcObject = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (streamRef.current === stream) {
          hardDisconnect(t("host.dc.youStopped"));
        }
      });
      setState(s => s.kind === "request" || s.kind === "connecting" || s.kind === "waiting" ? {
        kind: "connected",
        code: s.code,
        clientName: s.kind === "request" || s.kind === "connecting" ? s.clientName : "Client"
      } : s);
    });
    sig.on("signal", msg => {
      void peerRef.current?.handleRemoteSignal(msg.data);
    });
    sig.on("peer:left", msg => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      voiceRef.current?.close();
      voiceRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      setMicOn(false);
      setMicBusy(false);
      setMicError(null);
      setVoiceReady(false);
      setState(s => {
        if (s.kind === "connected" || s.kind === "connecting" || s.kind === "request") {
          return {
            kind: "waiting",
            code: s.code
          };
        }
        return s;
      });
      setIncomingLog(l => [`${fmtTime(Date.now())} — ${t("host.event.clientLeft", { reason: msg.reason })}`, ...l].slice(0, 5));
    });
    sig.on("error", msg => {
      console.error("[host] server error:", msg);
      setIncomingLog(l => [`${fmtTime(Date.now())} — ${t("host.event.error", { message: msg.message })}`, ...l].slice(0, 5));
    });
    sig.onceClosed().then(reason => {
      if (signalingRef.current === sig) {
        hardDisconnect(t("host.dc.connClosed", { reason }));
      }
    });
    if (autoPairToken) {
      sig.send({
        type: "host:claim",
        token: autoPairToken,
        hostName
      });
    } else {
      sig.send({
        type: "host:create",
        hostName
      });
    }
  }, [hostName, autoPairToken, hardDisconnect]);
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoPairToken) return;
    if (autoStartedRef.current) return;
    if (state.kind !== "idle") return;
    autoStartedRef.current = true;
    void createSession();
  }, [autoPairToken, createSession]);
  const handleRemoteInput = useCallback((ev: InputEvent) => {
    if (!allowControlRef.current) return;
    if (ev.t === "hello") return;
    if (ev.t === "mouse" || ev.t === "wheel" || ev.t === "key") {
      sendToAgent(ev);
      if (agentRef.current?.readyState !== WebSocket.OPEN && !agentDropWarnedRef.current) {
        agentDropWarnedRef.current = true;
        console.warn("[host] queueing input — local agent not connected yet. " + "If this persists, run `npm start` in agent/ on this machine.");
      }
    }
    const line = ev.t === "mouse" ? `mouse ${ev.kind}${ev.button != null ? ` btn=${ev.button}` : ""} @${(ev.x * 100).toFixed(1)}%,${(ev.y * 100).toFixed(1)}%` : ev.t === "key" ? `key ${ev.kind} ${ev.key}` : ev.t === "wheel" ? `wheel dx=${ev.dx} dy=${ev.dy}` : "input";
    setIncomingLog(l => [`${fmtTime(Date.now())} — ${line}`, ...l].slice(0, 8));
  }, [sendToAgent]);
  const approveRequest = () => {
    if (state.kind !== "request") return;
    allowControlRef.current = true;
    setAllowControl(true);
    ensureAgent();
    signalingRef.current?.send({
      type: "host:approve",
      requestId: state.requestId
    });
    setState({
      kind: "connecting",
      code: state.code,
      clientName: state.clientName
    });
  };
  const rejectRequest = (reason?: string) => {
    if (state.kind !== "request") return;
    signalingRef.current?.send({
      type: "host:reject",
      requestId: state.requestId,
      reason
    });
    setState({
      kind: "waiting",
      code: state.code
    });
  };
  const endSession = () => {
    signalingRef.current?.send({
      type: "host:end"
    });
    hardDisconnect(t("host.dc.youEnded"));
  };
  const toggleControl = () => {
    const next = !allowControl;
    allowControlRef.current = next;
    setAllowControl(next);
    signalingRef.current?.send({
      type: "host:setControl",
      allowed: next
    });
    if (next) ensureAgent();else closeAgent();
  };
  const toggleMic = useCallback(async () => {
    const voice = voiceRef.current;
    if (!voice || micBusy || !voiceReady) return;
    // The click on the Mic button is a guaranteed user gesture. Use it to
    // (re)play the remote audio element too - LiveKit's <audio> element
    // can stay paused if autoplay was blocked, and this is our only
    // reliably-user-driven moment to recover it.
    const a = remoteAudioRef.current;
    if (a && a.paused) {
      a.play().catch(err => console.warn("[host] remote audio play() on toggleMic:", err));
    }
    setMicBusy(true);
    setMicError(null);
    try {
      if (micOn) {
        voice.closeMic();
        setMicOn(false);
      } else {
        const ok = await voice.openMic();
        if (ok) {
          setMicOn(true);
        } else {
          setMicError(t("host.micUnavailable.body"));
        }
      }
    } finally {
      setMicBusy(false);
    }
  }, [micOn, micBusy, voiceReady]);
  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
  };
  const copyShareLink = (code: string) => {
    const url = `${window.location.origin}${window.location.pathname}#/client?code=${code}`;
    navigator.clipboard.writeText(url).catch(() => {});
  };
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    peerRef.current?.close();
    voiceRef.current?.close();
    signalingRef.current?.close();
    try {
      agentRef.current?.close();
    } catch {}
  }, []);
  if (state.kind === "idle" || state.kind === "disconnected") {
    if (embed || autoPairToken) {
      return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
          <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
            {state.kind === "idle" && <div className="flex items-center gap-3">
                <Loader2 className="w-6 h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
                <p className="text-muted leading-relaxed">{t("host.idle.preparing")}</p>
              </div>}
            {state.kind === "disconnected" && <div className="flex items-start gap-3 p-4 rounded-xl border border-warning/40 bg-amber-50 text-amber-800">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-warning" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">{t("host.idle.sessionEnded")}</strong> {state.reason}
                </p>
              </div>}
          </div>
        </div>;
    }
    return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <div className="absolute -top-32 -right-32 w-64 h-64 rounded-full bg-primary/10 blur-3xl pointer-events-none" />

          <div className="relative">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-accent/25 to-accent/5 border border-accent/30 text-accent-hi mb-5">
              <MonitorPlay className="w-6 h-6" strokeWidth={2.2} />
            </div>

            <h1 className="text-3xl font-bold tracking-tight mb-2">
              {t("host.idle.title")}
            </h1>
            <p className="text-muted leading-relaxed mb-7">
              {t("host.idle.intro")}
            </p>

            {state.kind === "disconnected" && <div className="flex items-start gap-3 mb-6 p-4 rounded-xl border border-warning/40 bg-amber-50 text-amber-800 animate-fade-in">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-warning" strokeWidth={2.2} />
                <p className="text-sm leading-relaxed">
                  <strong className="font-semibold">{t("host.idle.sessionEnded")}</strong> {state.reason}
                </p>
              </div>}

            <div className="flex flex-col gap-2 mb-7">
              <label htmlFor="hostName" className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                {t("host.idle.nameLabel")}
              </label>
              <input id="hostName" className="w-full px-4 py-3.5 rounded-xl bg-canvas border border-line text-text placeholder:text-subtle outline-none transition-all duration-200 focus:border-accent focus:bg-surface-2 focus:ring-4 focus:ring-accent/15" value={hostName} onChange={e => setHostName(e.target.value)} maxLength={40} />
            </div>

            <button className="group w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-white shadow-glow transition-all duration-200 hover:shadow-glow-lg hover:-translate-y-[1px] active:translate-y-0 focus:outline-none focus:ring-4 focus:ring-accent/30 relative overflow-hidden" onClick={createSession}>
              <span className="absolute inset-0 bg-gradient-to-r from-accent via-accent-hi to-accent bg-[length:200%_100%] animate-gradient-shift" />
              <span className="relative inline-flex items-center gap-2">
                <MonitorPlay className="w-4 h-4" strokeWidth={2.4} />
                {t("host.idle.create")}
              </span>
            </button>
          </div>
        </div>
      </div>;
  }
  if (state.kind === "creating") {
    return <div className="w-full max-w-lg animate-slide-up px-3 sm:px-0 m-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-6 sm:p-8 md:p-10">
          <StatusPill kind="waiting" label={t("host.creating.label")} />
          <h1 className="mt-5 text-3xl font-bold tracking-tight">{t("host.creating.title")}</h1>
          <p className="mt-2 text-muted leading-relaxed">{t("host.creating.subtitle")}</p>

          <div className="mt-8 space-y-3">
            <div className="h-3 w-3/4 rounded-full bg-gradient-to-r from-canvas via-line to-canvas bg-[length:200%_100%] animate-shimmer" />
            <div className="h-3 w-1/2 rounded-full bg-gradient-to-r from-canvas via-line to-canvas bg-[length:200%_100%] animate-shimmer" />
            <div className="h-3 w-2/3 rounded-full bg-gradient-to-r from-canvas via-line to-canvas bg-[length:200%_100%] animate-shimmer" />
          </div>
        </div>
      </div>;
  }
  const code = state.code;
  const statusKind = state.kind === "connected" ? "connected" : state.kind === "request" ? "request" : "waiting";
  const statusLabel = state.kind === "waiting" ? t("host.waiting.statusPill") : state.kind === "request" ? t("host.request.statusPill", { name: state.clientName }) : state.kind === "connecting" ? t("host.connecting.statusPill") : t("host.connected.statusPill", { name: state.clientName });
  if (state.kind === "connected") {
    return <div className={["w-full animate-slide-up", embed ? "h-screen flex flex-col" : "max-w-[min(1600px,100%)] mx-auto flex flex-col"].join(" ")}>
        <div className={["relative flex flex-col flex-1 min-h-0", embed ? "bg-black" : "overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl"].join(" ")}>
          <div className={["flex items-center gap-2 sm:gap-3 shrink-0", embed ? "px-2 sm:px-4 py-2 bg-white/95 backdrop-blur border-b border-line" : "p-3 sm:p-5 md:p-6 pb-3 sm:pb-4 md:pb-5"].join(" ")}>
            <div className="flex items-center gap-2 min-w-0">
              <StatusPill kind={statusKind} label={statusLabel} compact />
            </div>
            <div className="flex-1 min-w-[0.5rem]" />
            <button className={["inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm border transition-all duration-200 focus:outline-none focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed", micOn ? "text-white bg-gradient-to-r from-accent to-accent-hi border-accent-hi shadow-glow hover:shadow-glow-lg focus:ring-accent/30" : "text-text bg-canvas border-line hover:bg-surface-2 hover:border-border-hi focus:ring-line"].join(" ")} onClick={toggleMic} disabled={micBusy || !voiceReady} title={!voiceReady ? "Connecting voice…" : micOn ? t("host.connected.micToggleOff") : t("host.connected.micToggleOn")} aria-label={!voiceReady ? "Connecting voice…" : micOn ? t("host.connected.micToggleOff") : t("host.connected.micToggleOn")} aria-pressed={micOn}>
              {micBusy || !voiceReady ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2.2} /> : micOn ? <Mic className="w-4 h-4" strokeWidth={2.4} /> : <MicOff className="w-4 h-4" strokeWidth={2.2} />}
              <span className="hidden md:inline">{micOn ? t("host.connected.micOn") : t("host.connected.micOff")}</span>
            </button>
            <button className="hidden sm:inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-medium text-sm text-text bg-canvas border border-line transition-all duration-200 hover:bg-surface-2 hover:border-border-hi focus:outline-none focus:ring-4 focus:ring-line" onClick={() => setSidePanelOpen(o => !o)} title={sidePanelOpen ? t("host.connected.hideInfoTitle") : t("host.connected.showInfoTitle")} aria-label={sidePanelOpen ? t("host.connected.hideInfoTitle") : t("host.connected.showInfoTitle")} aria-expanded={sidePanelOpen}>
              {sidePanelOpen ? <PanelRightClose className="w-4 h-4" strokeWidth={2.2} /> : <PanelRightOpen className="w-4 h-4" strokeWidth={2.2} />}
              <span className="hidden lg:inline">{sidePanelOpen ? t("host.connected.hideInfo") : t("host.connected.showInfo")}</span>
            </button>
            <button className="inline-flex items-center gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl font-semibold text-sm text-red-700 bg-red-50 border border-danger/30 transition-all duration-200 hover:bg-red-100 hover:border-danger/50 focus:outline-none focus:ring-4 focus:ring-danger/20" onClick={endSession} title={t("host.connected.endSession")} aria-label={t("host.connected.endSession")}>
              <PowerOff className="w-4 h-4" strokeWidth={2.4} />
              <span className="hidden md:inline">{t("host.connected.endSession")}</span>
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

          {allowControl && agentStatus !== "up" && <div className={["flex items-start gap-3 p-3 sm:p-4 border-b animate-slide-up shrink-0", agentStatus === "down" ? "border-danger/40 bg-red-50 text-red-800" : "border-warning/40 bg-amber-50 text-amber-800"].join(" ")}>
              <AlertTriangle className={["shrink-0 mt-0.5 w-5 h-5", agentStatus === "down" ? "text-danger" : "text-warning"].join(" ")} strokeWidth={2.2} />
              <div className="flex-1 min-w-0">
                <strong className="text-sm font-semibold text-text900 block">
                  {agentStatus === "down" && t("host.warn.cursorOffline")}
                  {agentStatus === "warming" && t("host.warn.starting")}
                  {agentStatus === "connecting" && t("host.warn.connecting")}
                  {agentStatus === "off" && t("host.warn.notStarted")}
                </strong>
                {agentStatus === "down" && <div className="mt-1.5 text-[12.5px] sm:text-[13px] leading-relaxed text-amber-700/90">
                    {t("host.warn.fixIntro")}
                    <ol className="list-decimal pl-5 mt-1.5 space-y-0.5">
                      <li>{t("host.warn.fix1")}</li>
                      <li>
                        {t("host.warn.fix2.before")}
                        <code className="font-mono text-text900 bg-white border border-line px-1.5 py-0.5 rounded">agent</code>
                        {t("host.warn.fix2.after")}
                      </li>
                    </ol>
                  </div>}
              </div>
            </div>}

          <div className={["flex-1 min-h-0 flex", sidePanelOpen ? "flex-col lg:flex-row" : "flex-col", embed ? "" : "px-3 sm:px-5 md:px-6 pb-3 sm:pb-5 md:pb-6 gap-4 sm:gap-5"].join(" ")}>
            <div className="flex-1 min-h-0 flex flex-col">
              <div className={["relative flex-1 min-h-0 overflow-hidden bg-black group", embed ? "" : "rounded-xl sm:rounded-2xl border border-line shadow-soft-xl"].join(" ")} style={{
              minHeight: embed ? undefined : "min(60vh, 540px)"
            }}>
                {!embed && <div className="absolute inset-0 rounded-xl sm:rounded-2xl ring-1 ring-inset ring-accent/20 pointer-events-none" />}
                <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-contain block" />
                <div className="pointer-events-none absolute top-2 sm:top-3 left-2 sm:left-3 inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider text-white border border-line">
                  <span className="relative flex w-1.5 h-1.5">
                    <span className="absolute inline-flex w-full h-full rounded-full bg-red-500 opacity-75 animate-ping" />
                    <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-red-500" />
                  </span>
                  {t("host.connected.livePreview")}
                </div>
              </div>
              {!embed && <p className="mt-2 sm:mt-3 text-[12.5px] sm:text-[13px] text-muted leading-relaxed px-1">
                  {t("host.connected.previewBlurb", { name: state.clientName })}
                </p>}
            </div>

            {sidePanelOpen && <aside className={["flex flex-col gap-2.5 sm:gap-3 shrink-0 animate-fade-in", embed ? "w-full lg:w-[300px] p-3 sm:p-4 bg-white/95 backdrop-blur border-t lg:border-t-0 lg:border-l border-line overflow-y-auto" : "w-full lg:w-[300px]"].join(" ")}>
                <div className="rounded-xl border border-line bg-canvas p-3 sm:p-4">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-1.5 flex items-center gap-1.5">
                    <KeyRound className="w-3 h-3" strokeWidth={2.4} />
                    {t("host.connected.session")}
                  </h3>
                  <p className="font-mono text-base sm:text-lg font-bold tracking-widest text-text">
                    {code}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 p-3 sm:p-4 rounded-xl border border-line bg-canvas">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold text-sm flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-accent-hi" strokeWidth={2.4} />
                      {t("host.connected.remoteInput")}
                    </span>
                    <span className="text-xs text-muted leading-snug">
                      {t("host.connected.remoteInputBlurb")}
                    </span>
                  </div>
                  <button role="switch" aria-checked={allowControl} onClick={toggleControl} className={["relative shrink-0 w-11 h-6 rounded-full border transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-accent/25", allowControl ? "bg-gradient-to-r from-accent to-accent-hi border-accent-hi shadow-glow" : "bg-canvas border-border-hi"].join(" ")}>
                    <span className={["absolute top-0.5 w-5 h-5 rounded-full transition-all duration-200 shadow-md", allowControl ? "left-[calc(100%-1.375rem)] bg-white" : "left-0.5 bg-muted"].join(" ")} />
                  </button>
                </div>

                {allowControl && <div className="rounded-xl border border-line bg-canvas p-3 sm:p-4 animate-fade-in">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                      <Cpu className="w-3 h-3" strokeWidth={2.4} />
                      {t("host.connected.localAgent")}
                    </h3>
                    <div className="flex items-center gap-2 mb-2">
                      <AgentStatusDot status={agentStatus} />
                      <span className="text-xs font-semibold uppercase tracking-wider text-text">
                        {agentStatus === "up" && t("host.connected.agent.up")}
                        {agentStatus === "warming" && t("host.connected.agent.warming")}
                        {agentStatus === "connecting" && t("host.connected.agent.connecting")}
                        {agentStatus === "down" && t("host.connected.agent.down")}
                        {agentStatus === "off" && t("host.connected.agent.off")}
                      </span>
                    </div>
                    <p className="text-muted text-[12.5px] sm:text-[13px] leading-relaxed">
                      {agentStatus === "up" && (
                        agentBackend
                          ? t("host.connected.agent.upBlurb") + t("host.connected.agent.upBlurbVia", { backend: agentBackend })
                          : t("host.connected.agent.upBlurb") + "."
                      )}
                      {agentStatus === "warming" && (
                        agentBackend === "vb6"
                          ? t("host.connected.agent.warmingBlurbVb6")
                          : t("host.connected.agent.warmingBlurb")
                      )}
                      {agentStatus === "connecting" && t("host.connected.agent.connectingBlurb")}
                      {agentStatus === "down" && t("host.connected.agent.downBlurb")}
                      {agentStatus === "off" && t("host.connected.agent.offBlurb")}
                    </p>
                  </div>}

                <div className="rounded-xl border border-line bg-canvas p-3 sm:p-4">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted mb-2 flex items-center gap-1.5">
                    <Activity className="w-3 h-3" strokeWidth={2.4} />
                    {t("host.connected.recentEvents")}
                  </h3>
                  {incomingLog.length === 0 ? <p className="text-muted text-[13px] italic">{t("host.connected.noEvents")}</p> : <ul className="flex flex-col gap-1 font-mono text-[11.5px] leading-relaxed text-muted max-h-48 overflow-y-auto pr-1">
                        {incomingLog.map((line, i) => <li key={i} className="truncate py-0.5 border-b border-line last:border-0" title={line}>
                            {line}
                          </li>)}
                      </ul>}
                </div>
              </aside>}
          </div>
        </div>
      </div>;
  }
  return <div className="w-full max-w-3xl lg:max-w-6xl animate-slide-up px-3 sm:px-0 m-auto">
      <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl glass-strong shadow-soft-xl p-4 sm:p-6 md:p-8">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
          <StatusPill kind={statusKind} label={statusLabel} />
          <div className="flex-1 min-w-[1rem]" />
          <button className="inline-flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl font-semibold text-sm text-red-700 bg-red-50 border border-danger/30 transition-all duration-200 hover:bg-red-100 hover:border-danger/50 focus:outline-none focus:ring-4 focus:ring-danger/20" onClick={endSession}>
            <PowerOff className="w-4 h-4" strokeWidth={2.4} />
            <span className="hidden sm:inline">{t("host.connected.endSession")}</span>
            <span className="sm:hidden">{t("host.connected.endSession")}</span>
          </button>
        </div>

        {state.kind === "waiting" && <div className="animate-fade-in">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">{t("host.waiting.title")}</h1>
            <p className="text-muted leading-relaxed mb-5 sm:mb-6 text-sm sm:text-base">
              {t("host.waiting.intro")}
            </p>

            <div className="relative overflow-hidden flex flex-col items-center gap-4 sm:gap-5 py-8 sm:py-10 px-4 sm:px-6 my-2 rounded-2xl border border-dashed border-accent/30 bg-gradient-to-b from-accent/[0.08] to-transparent">
              <div className="absolute inset-0 bg-dots opacity-40 pointer-events-none" />
              <span className="relative inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-hi">
                <KeyRound className="w-3.5 h-3.5" strokeWidth={2.4} />
                {t("host.waiting.codeLabel")}
              </span>
              <span className="relative font-mono font-bold text-4xl xs:text-5xl sm:text-6xl tracking-[0.25em] sm:tracking-[0.3em] text-gradient drop-shadow-[0_0_30px_rgba(0,139,249,0.18)] break-all text-center">
                {code}
              </span>
              <div className="relative flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                <button className="inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium text-accent-hi bg-accent/10 border border-accent/25 transition-all duration-200 hover:bg-accent/20 hover:border-accent/40" onClick={() => copyCode(code)}>
                  <Copy className="w-3.5 h-3.5" strokeWidth={2.4} />
                  {t("host.waiting.copyCode")}
                </button>
                <button className="inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium text-accent-hi bg-accent/10 border border-accent/25 transition-all duration-200 hover:bg-accent/20 hover:border-accent/40" onClick={() => copyShareLink(code)}>
                  <LinkIcon className="w-3.5 h-3.5" strokeWidth={2.4} />
                  <span className="hidden xs:inline">{t("host.waiting.copyLink")}</span>
                  <span className="xs:hidden">{t("host.waiting.linkShort")}</span>
                </button>
              </div>
            </div>

            <div className="mt-5 sm:mt-6 flex items-start gap-3 p-3 sm:p-4 rounded-xl border border-accent/20 bg-accent/[0.06]">
              <Shield className="shrink-0 mt-0.5 w-5 h-5 text-accent-hi" strokeWidth={2.2} />
              <p className="text-[13px] sm:text-sm text-text700 leading-relaxed">
                {t("host.waiting.shieldBody")}{" "}
                <strong className="text-text900 font-semibold">{t("host.waiting.shieldHead")}</strong>
              </p>
            </div>
          </div>}

        {state.kind === "request" && <div className="animate-fade-in">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
              {t("host.request.title")}
            </h1>
            <p className="text-muted leading-relaxed mb-5 sm:mb-6 text-sm sm:text-base">
              {t("host.request.intro", { name: state.clientName, code: state.code })}
            </p>

            <div className="relative overflow-hidden rounded-2xl border border-accent/60 bg-gradient-to-br from-accent/20 via-accent/10 to-transparent p-4 sm:p-6 animate-scale-in shadow-glow">
              <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-primary/15 blur-3xl pointer-events-none" />
              <div className="relative flex items-center gap-3 sm:gap-4 mb-3">
                <span className="relative inline-flex shrink-0 items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-accent/20 border border-accent/40 text-accent-hi">
                  <CircleDot className="w-5 h-5 animate-pulse-fast" strokeWidth={2.4} />
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-base sm:text-lg font-semibold tracking-tight truncate">
                    {state.clientName}
                  </span>
                  <span className="text-xs text-muted font-mono truncate">
                    {t("host.request.requestingMeta", { code: state.code })}
                  </span>
                </div>
              </div>
              <div className="relative text-[13px] sm:text-sm text-muted leading-relaxed mb-4 sm:mb-5">
                {t("host.request.helper")}
              </div>
              <div className="relative flex flex-wrap gap-2 sm:gap-3">
                <button className="group inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl font-semibold text-white shadow-[0_0_30px_-6px_rgba(60,208,133,0.5)] transition-all duration-200 hover:-translate-y-[1px] focus:outline-none focus:ring-4 focus:ring-success/30 relative overflow-hidden" onClick={approveRequest}>
                  <span className="absolute inset-0 bg-gradient-to-r from-success to-success" />
                  <span className="relative inline-flex items-center gap-2">
                    <Check className="w-4 h-4" strokeWidth={2.8} />
                    {t("host.request.approve")}
                  </span>
                </button>
                <button className="inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl font-semibold text-red-700 bg-red-50 border border-danger/30 transition-all duration-200 hover:bg-red-100 hover:border-danger/50 focus:outline-none focus:ring-4 focus:ring-danger/20" onClick={() => rejectRequest("rejected by host")}>
                  <X className="w-4 h-4" strokeWidth={2.6} />
                  {t("host.request.reject")}
                </button>
              </div>
            </div>
          </div>}

        {state.kind === "connecting" && <div className="animate-fade-in">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2 flex items-center gap-3">
              <Loader2 className="w-5 sm:w-6 h-5 sm:h-6 text-accent-hi animate-spin" strokeWidth={2.4} />
              {t("host.connecting.title")}
            </h1>
            <p className="text-muted leading-relaxed text-sm sm:text-base">
              {t("host.connecting.intro")}
            </p>
          </div>}

      </div>
    </div>;
}
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
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
function AgentStatusDot({
  status
}: {
  status: "off" | "connecting" | "warming" | "up" | "down";
}) {
  const color = status === "up" ? "bg-success" : status === "warming" ? "bg-warning" : status === "connecting" ? "bg-accent-hi" : status === "down" ? "bg-danger" : "bg-subtle";
  const pulse = status === "warming" || status === "connecting";
  return <span className="relative flex w-2.5 h-2.5">
      {pulse && <span className={["absolute inline-flex w-full h-full rounded-full opacity-70 animate-ping", color].join(" ")} />}
      <span className={`relative inline-flex w-2.5 h-2.5 rounded-full ${color}`} />
    </span>;
}
