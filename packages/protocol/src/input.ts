export type MouseButton = "left" | "right" | "middle";

export type InputEvent =
  | { kind: "mouse-move"; x: number; y: number }
  | { kind: "mouse-down"; button: MouseButton }
  | { kind: "mouse-up"; button: MouseButton }
  | { kind: "mouse-wheel"; deltaX: number; deltaY: number }
  | { kind: "key-down"; key: string; code: string; modifiers: Modifiers }
  | { kind: "key-up"; key: string; code: string; modifiers: Modifiers };

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export const DATA_CHANNEL_LABEL = "rc-input" as const;
