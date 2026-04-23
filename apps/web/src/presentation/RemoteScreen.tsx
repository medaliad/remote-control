"use client";

import { useCallback, useEffect, useRef } from "react";
import type { InputEvent } from "@rc/protocol";
import {
  mapKeyDown,
  mapKeyUp,
  mapMouseDown,
  mapMouseMove,
  mapMouseUp,
  mapWheel,
  mapTouchStart,
  mapTouchMove,
  mapTouchEnd,
  mapTwoFingerScroll,
} from "@/application/map-dom-input";

interface Props {
  attachCanvas: (el: HTMLCanvasElement | null) => void;
  onInput:      (e: InputEvent) => void;
  captureInput: boolean;
  /** Hide the canvas while keeping it mounted so the ref stays valid. */
  visible?:     boolean;
}

export function RemoteScreen({ attachCanvas, onInput, captureInput, visible = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /**
   * Two-finger scroll needs to track the midpoint from the *previous* frame
   * so we can compute delta. Stored in a ref so it doesn't cause re-renders.
   */
  const twoFingerRef = useRef<{ x: number; y: number } | null>(null);

  // ── Global keyboard capture ──────────────────────────────────────────────
  useEffect(() => {
    if (!captureInput) return;
    const onKeyDown = (e: KeyboardEvent) => { e.preventDefault(); onInput(mapKeyDown(e)); };
    const onKeyUp   = (e: KeyboardEvent) => { e.preventDefault(); onInput(mapKeyUp(e));   };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup",   onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup",   onKeyUp);
    };
  }, [captureInput, onInput]);

  // ── Touch handlers ───────────────────────────────────────────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();                        // stop browser scroll / zoom
    const canvas = e.currentTarget;

    if (e.touches.length === 1) {
      twoFingerRef.current = null;
      const events = mapTouchStart(e.touches[0]!, canvas);
      events.forEach(onInput);
    } else if (e.touches.length === 2) {
      // Lift the left button if we were dragging with 1 finger.
      onInput(mapTouchEnd());
      // Initialise the two-finger midpoint.
      twoFingerRef.current = {
        x: (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2,
        y: (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2,
      };
    }
  }, [onInput]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = e.currentTarget;

    if (e.touches.length === 1) {
      onInput(mapTouchMove(e.touches[0]!, canvas));
    } else if (e.touches.length === 2 && twoFingerRef.current) {
      const pair = { 0: e.touches.item(0)!, 1: e.touches.item(1)! };
      const { event, next } = mapTwoFingerScroll(pair, twoFingerRef.current);
      onInput(event);
      twoFingerRef.current = next;
    }
  }, [onInput]);

  const handleTouchEnd = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    // Only send mouse-up when the last finger lifts.
    if (e.touches.length === 0) {
      twoFingerRef.current = null;
      onInput(mapTouchEnd());
    }
  }, [onInput]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <canvas
      ref={(el) => {
        canvasRef.current = el;
        attachCanvas(el);
      }}
      // ── Mouse events (desktop) ──
      onContextMenu={(e) => e.preventDefault()}
      onMouseMove={(e)   => onInput(mapMouseMove(e.nativeEvent, e.currentTarget))}
      onMouseDown={(e)   => { e.currentTarget.focus(); const m = mapMouseDown(e.nativeEvent); if (m) onInput(m); }}
      onMouseUp={(e)     => { const m = mapMouseUp(e.nativeEvent); if (m) onInput(m); }}
      onWheel={(e)       => { e.preventDefault(); onInput(mapWheel(e.nativeEvent)); }}
      // ── Touch events (mobile) ──
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      // ── Misc ──
      tabIndex={0}
      style={{
        maxWidth:       "100%",
        maxHeight:      "100%",
        width:          "auto",
        height:         "auto",
        background:     "#000",
        outline:        "none",
        display:        visible ? "block" : "none",
        // Keep remote pixels crisp — no browser blurring.
        imageRendering: "pixelated",
        // Tell the browser we handle all touch gestures ourselves.
        touchAction:    "none",
      }}
    />
  );
}
