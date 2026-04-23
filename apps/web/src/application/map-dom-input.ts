import type { InputEvent, Modifiers, MouseButton } from "@rc/protocol";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function modifiersOf(e: KeyboardEvent | MouseEvent): Modifiers {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

function buttonOf(n: number): MouseButton | null {
  if (n === 0) return "left";
  if (n === 1) return "middle";
  if (n === 2) return "right";
  return null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Normalise a client-space point to 0–1 relative to an element. */
function normalise(clientX: number, clientY: number, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  return {
    x: clamp01(rect.width  > 0 ? (clientX - rect.left) / rect.width  : 0),
    y: clamp01(rect.height > 0 ? (clientY - rect.top)  / rect.height : 0),
  };
}

// ─── Mouse ────────────────────────────────────────────────────────────────────

export function mapMouseMove(e: MouseEvent, el: HTMLElement): InputEvent {
  const { x, y } = normalise(e.clientX, e.clientY, el);
  return { kind: "mouse-move", x, y };
}

export function mapMouseDown(e: MouseEvent): InputEvent | null {
  const b = buttonOf(e.button);
  return b ? { kind: "mouse-down", button: b } : null;
}

export function mapMouseUp(e: MouseEvent): InputEvent | null {
  const b = buttonOf(e.button);
  return b ? { kind: "mouse-up", button: b } : null;
}

export function mapWheel(e: WheelEvent): InputEvent {
  return { kind: "mouse-wheel", deltaX: e.deltaX, deltaY: e.deltaY };
}

// ─── Touch → Mouse ────────────────────────────────────────────────────────────
//
//  Gesture map:
//    1 finger move   →  mouse-move (cursor follows finger)
//    1 finger tap    →  mouse-down + mouse-up  (left click)
//    2 fingers move  →  mouse-wheel  (scroll)

// Minimal interfaces so these functions accept both the native DOM Touch /
// TouchList types and React's synthetic equivalents without any casting.
interface TouchPoint { clientX: number; clientY: number }
interface TouchPair  { 0: TouchPoint; 1: TouchPoint }

/**
 * Called on touchmove with a single touch point.
 * Returns a mouse-move event.
 */
export function mapTouchMove(touch: TouchPoint, el: HTMLElement): InputEvent {
  const { x, y } = normalise(touch.clientX, touch.clientY, el);
  return { kind: "mouse-move", x, y };
}

/**
 * Called on touchstart — moves the cursor to the touch position
 * and sends a left mouse-down.
 */
export function mapTouchStart(touch: TouchPoint, el: HTMLElement): InputEvent[] {
  const { x, y } = normalise(touch.clientX, touch.clientY, el);
  return [
    { kind: "mouse-move", x, y },
    { kind: "mouse-down", button: "left" },
  ];
}

/**
 * Called on touchend — sends a left mouse-up.
 */
export function mapTouchEnd(): InputEvent {
  return { kind: "mouse-up", button: "left" };
}

/**
 * Called on touchmove with exactly two touches — maps to a scroll event.
 * `prev` is the previous midpoint so we can compute delta.
 */
export function mapTwoFingerScroll(
  curr: TouchPair,
  prev: { x: number; y: number },
): { event: InputEvent; next: { x: number; y: number } } {
  const midX   = (curr[0].clientX + curr[1].clientX) / 2;
  const midY   = (curr[0].clientY + curr[1].clientY) / 2;
  const deltaX = (prev.x - midX) * 2;   // ×2 for comfortable scroll speed
  const deltaY = (prev.y - midY) * 2;
  return {
    event: { kind: "mouse-wheel", deltaX, deltaY },
    next:  { x: midX, y: midY },
  };
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

export function mapKeyDown(e: KeyboardEvent): InputEvent {
  return { kind: "key-down", key: e.key, code: e.code, modifiers: modifiersOf(e) };
}

export function mapKeyUp(e: KeyboardEvent): InputEvent {
  return { kind: "key-up", key: e.key, code: e.code, modifiers: modifiersOf(e) };
}
