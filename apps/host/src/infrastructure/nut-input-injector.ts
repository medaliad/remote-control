import { keyboard, mouse, Button, Point, screen, Key } from "@nut-tree-fork/nut-js";
import type { InputEvent, MouseButton } from "@rc/protocol";
import type { InputInjectorPort } from "@/domain/ports";

const BUTTON_MAP: Record<MouseButton, Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE,
};

export class NutInputInjector implements InputInjectorPort {
  async apply(event: InputEvent): Promise<void> {
    switch (event.kind) {
      case "mouse-move": {
        const w = await screen.width();
        const h = await screen.height();
        await mouse.setPosition(new Point(event.x * w, event.y * h));
        return;
      }
      case "mouse-down":
        await mouse.pressButton(BUTTON_MAP[event.button]);
        return;
      case "mouse-up":
        await mouse.releaseButton(BUTTON_MAP[event.button]);
        return;
      case "mouse-wheel":
        if (event.deltaY !== 0) await mouse.scrollDown(Math.round(event.deltaY));
        if (event.deltaX !== 0) await mouse.scrollRight(Math.round(event.deltaX));
        return;
      case "key-down": {
        const k = mapKey(event.code);
        if (k) await keyboard.pressKey(k);
        return;
      }
      case "key-up": {
        const k = mapKey(event.code);
        if (k) await keyboard.releaseKey(k);
        return;
      }
    }
  }
}

function mapKey(code: string): Key | null {
  const table: Record<string, Key> = {
    Enter: Key.Enter,
    Escape: Key.Escape,
    Backspace: Key.Backspace,
    Tab: Key.Tab,
    Space: Key.Space,
    ArrowUp: Key.Up,
    ArrowDown: Key.Down,
    ArrowLeft: Key.Left,
    ArrowRight: Key.Right,
    ShiftLeft: Key.LeftShift,
    ShiftRight: Key.RightShift,
    ControlLeft: Key.LeftControl,
    ControlRight: Key.RightControl,
    AltLeft: Key.LeftAlt,
    AltRight: Key.RightAlt,
    MetaLeft: Key.LeftSuper,
    MetaRight: Key.RightSuper,
  };
  if (table[code]) return table[code];
  const m = /^Key([A-Z])$/.exec(code);
  if (m) {
    const letter = m[1] as keyof typeof Key;
    return (Key as unknown as Record<string, Key>)[letter] ?? null;
  }
  const d = /^Digit([0-9])$/.exec(code);
  if (d) {
    const digit = `Num${d[1]}` as keyof typeof Key;
    return (Key as unknown as Record<string, Key>)[digit] ?? null;
  }
  return null;
}
