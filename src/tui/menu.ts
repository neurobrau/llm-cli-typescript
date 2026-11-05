/**
 * Selection menus (docs/tui-spec.md section 4b). Pure: list state, key
 * handling and geometry; no drawing, no I/O. Item identity (`id`) is kept
 * apart from the display text, which may be clipped or sanitized for display.
 */
import type { Layout } from "./layout.js";
import type { NamedKey } from "./keys.js";
import { codePointLength, fit } from "./text.js";

export const MENU_MIN_WIDTH = 30;

export interface MenuItem {
  /** What selecting the item means to its kind; never shown. */
  readonly id: string;
  readonly label: string;
  /** Shown right-aligned when it fits. */
  readonly note?: string;
  /** The effective current choice, marked with `*`. */
  readonly current?: boolean;
}

export type MenuKind = "provider" | "model" | "reasoning" | "max-tokens" | "style";

export type MenuAction = "select" | "cancel" | undefined;

export class Menu {
  index: number;
  top: number;

  private constructor(
    readonly kind: MenuKind,
    readonly title: string,
    readonly items: readonly MenuItem[],
    index: number,
  ) {
    this.index = index;
    this.top = index;
  }

  /** Opens with the current item highlighted (the first when none is current). An empty menu cannot be opened. */
  static create(kind: MenuKind, title: string, items: readonly MenuItem[]): Menu | undefined {
    if (items.length === 0) return undefined;
    const current = items.findIndex((item) => item.current === true);
    return new Menu(kind, title, items, Math.max(0, current));
  }

  get selected(): MenuItem {
    return this.items[this.index] ?? this.items[0] ?? { id: "", label: "" };
  }

  moveTo(index: number, visible: number): void {
    this.index = Math.max(0, Math.min(this.items.length - 1, index));
    this.scrollIntoView(visible);
  }

  scrollIntoView(visible: number): void {
    const rows = Math.max(1, visible);
    if (this.index < this.top) this.top = this.index;
    else if (this.index >= this.top + rows) this.top = this.index - rows + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.items.length - rows)));
  }

  /** Applies a key; the caller owns everything that is not list navigation. */
  handle(key: NamedKey, visible: number): MenuAction {
    switch (key) {
      case "enter":
        return "select";
      case "escape":
      case "ctrl-d":
        return "cancel";
      case "up":
        this.moveTo(this.index - 1, visible);
        return undefined;
      case "down":
        this.moveTo(this.index + 1, visible);
        return undefined;
      case "pageup":
        this.moveTo(this.index - Math.max(1, visible - 1), visible);
        return undefined;
      case "pagedown":
        this.moveTo(this.index + Math.max(1, visible - 1), visible);
        return undefined;
      case "home":
        this.moveTo(0, visible);
        return undefined;
      case "end":
        this.moveTo(this.items.length - 1, visible);
        return undefined;
      default:
        return undefined;
    }
  }
}

/** `* label    note` padded to `width` (0: natural length); the note only when it fits, a long label cut with `~`. */
export function menuLine(item: MenuItem, width: number): string {
  const left = `${item.current === true ? "*" : " "} ${item.label}`;
  const note = item.note ?? "";
  if (width <= 0) return note === "" ? left : `${left}  ${note}`;
  const shown = note !== "" && codePointLength(left) + codePointLength(note) + 2 <= width ? `  ${note}` : "";
  const room = width - codePointLength(shown);
  const clipped = fit(left, room);
  const padding = Math.max(0, room - codePointLength(clipped));
  return clipped + " ".repeat(padding) + shown;
}

export interface MenuBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Items that fit (at most the conversation height - 2). */
  readonly visible: number;
}

export const footerOf = (menu: Menu): string => `${String(menu.index + 1)}/${String(menu.items.length)} Enter=OK Esc=cancel`;

export function menuVisible(layout: Layout): number {
  return Math.max(1, layout.conversationHeight - 2);
}

/** Box geometry: wide enough for the content, capped at C-2, centered over the conversation if it fits there. */
export function menuBox(menu: Menu, layout: Layout): MenuBox {
  const visible = Math.min(menuVisible(layout), menu.items.length);
  const longest = Math.max(...menu.items.map((item) => codePointLength(menuLine(item, 0))));
  const wanted = Math.max(MENU_MIN_WIDTH, longest + 4, codePointLength(menu.title) + 6, codePointLength(footerOf(menu)) + 6);
  const width = Math.min(layout.cols - 2, wanted);
  const height = visible + 2;
  const { panelX } = layout;
  const area = panelX !== undefined && panelX > 0 && width <= panelX - 2 ? panelX : layout.cols;
  return {
    x: Math.floor((area - width) / 2),
    y: layout.conversationTop + Math.max(0, Math.floor((layout.conversationHeight - height) / 2)),
    width,
    height,
    visible,
  };
}
