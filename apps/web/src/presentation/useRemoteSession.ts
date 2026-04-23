"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InputEvent } from "@rc/protocol";
import type { ConnectRequest, ConnectionState } from "@/domain/ports";
import { WebSocketTransport } from "@/infrastructure/websocket-transport";
import { CanvasVideoRenderer } from "@/infrastructure/canvas-video-renderer";
import { WebAudioPlayer } from "@/infrastructure/web-audio-player";
import { MicrophoneCapture, MicUnavailableError } from "@/infrastructure/microphone-capture";
import { startSession } from "@/application/start-session";

export function useRemoteSession(relayUrl: string) {
  const [state,      setState]      = useState<ConnectionState>("idle");
  const [fps,        setFps]        = useState(0);
  const [micActive,  setMicActive]  = useState(false);
  const [micError,   setMicError]   = useState<string | null>(null);
  const [listening,  setListening]  = useState(true);
  const [hostName,   setHostName]   = useState<string | null>(null);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);

  const transportRef = useRef<WebSocketTransport | null>(null);
  const videoRef     = useRef<CanvasVideoRenderer>(new CanvasVideoRenderer());
  const audioRef     = useRef<WebAudioPlayer>(new WebAudioPlayer());
  const micRef       = useRef<MicrophoneCapture>(new MicrophoneCapture());

  useEffect(() => {
    videoRef.current.onFps(setFps);
  }, []);

  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    if (el) videoRef.current.attach(el);
    else    videoRef.current.detach();
  }, []);

  const connect = useCallback(async (req: ConnectRequest) => {
    setHostName(null);
    setErrorMsg(null);
    const transport = new WebSocketTransport(relayUrl);
    transport.onState(setState);
    transport.onPeerName(setHostName);
    transport.onError(setErrorMsg);
    transportRef.current = transport;
    try {
      await startSession(req, {
        transport,
        video: videoRef.current,
        audio: audioRef.current,
      });
    } catch (err) {
      console.warn("[session] connect failed:", (err as Error).message);
    }
  }, [relayUrl]);

  const sendInput = useCallback((e: InputEvent) => {
    audioRef.current.resumeIfSuspended();
    transportRef.current?.sendInput(e);
  }, []);

  const disconnect = useCallback(() => {
    micRef.current.stop();
    setMicActive(false);

    transportRef.current?.close();
    transportRef.current = null;
    audioRef.current.stop();
    audioRef.current = new WebAudioPlayer();
    setFps(0);
    setErrorMsg(null);
    setState("idle");
  }, []);

  const toggleMic = useCallback(async () => {
    if (micActive) {
      micRef.current.stop();
      setMicActive(false);
      setMicError(null);
      return;
    }
    setMicError(null);
    try {
      await micRef.current.start((pcm) => {
        transportRef.current?.sendMic(pcm);
      });
      setMicActive(true);
    } catch (err) {
      if (err instanceof MicUnavailableError) {
        const messages: Record<string, string> = {
          "insecure-context":  "Mic blocked: page must be served over HTTPS.",
          "permission-denied": "Mic permission denied. Allow microphone access in your browser.",
          "not-supported":     "Microphone not supported in this browser.",
        };
        setMicError(messages[err.reason] ?? "Microphone unavailable.");
        console.warn("[mic]", err.reason);
      } else {
        setMicError("Could not start microphone.");
        console.error("[mic]", err);
      }
    }
  }, [micActive]);

  const toggleListen = useCallback(() => {
    const next = !listening;
    audioRef.current.setMuted(!next);
    setListening(next);
  }, [listening]);

  useEffect(() => () => {
    transportRef.current?.close();
    audioRef.current.stop();
    videoRef.current.detach();
    micRef.current.stop();
  }, []);

  return {
    state,
    fps,
    hostName,
    errorMsg,
    micActive,
    micError,
    listening,
    attachCanvas,
    connect,
    sendInput,
    disconnect,
    toggleMic,
    toggleListen,
  };
}
