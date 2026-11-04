/** Geometry of the fullscreen layout (docs/tui-spec.md section 2). Pure. */
import { codePoints } from "./text.js";

export const MIN_COLS = 40;
export const MIN_ROWS = 12;
export const PANEL_WIDTH = 22;
export const PANEL_MIN_COLS = 64;
/** Content columns of the settings panel. */
export const PANEL_CONTENT_WIDTH = PANEL_WIDTH - 4;

export interface Size {
  readonly rows: number;
  readonly cols: number;
}

export interface Layout extends Size {
  /** Column of the panel separator, or `undefined` when the panel is hidden. */
  readonly panelX: number | undefined;
  readonly conversationTop: number;
  readonly conversationHeight: number;
  /** Width available to conversation text. */
  readonly conversationWidth: number;
  /** Exclusive column limit of conversation text. */
  readonly conversationLimit: number;
  readonly innerWidth: number;
  readonly statusSeparatorRow: number;
  readonly statusRow: number;
  readonly inputSeparatorRow: number;
  readonly inputRow: number;
  readonly bottomRow: number;
  readonly helpRow: number;
}

/** The layout for a terminal size, or `undefined` below the 40x12 minimum. */
export function computeLayout(size: Size): Layout | undefined {
  const { rows, cols } = size;
  if (rows < MIN_ROWS || cols < MIN_COLS) return undefined;
  const panelX = cols >= PANEL_MIN_COLS ? cols - PANEL_WIDTH : undefined;
  return {
    rows,
    cols,
    panelX,
    conversationTop: 1,
    conversationHeight: rows - 7,
    conversationWidth: panelX === undefined ? cols - 4 : cols - 25,
    conversationLimit: panelX === undefined ? cols - 2 : panelX - 1,
    innerWidth: cols - 4,
    statusSeparatorRow: rows - 6,
    statusRow: rows - 5,
    inputSeparatorRow: rows - 4,
    inputRow: rows - 3,
    bottomRow: rows - 2,
    helpRow: rows - 1,
  };
}

/** A `+-[ title ]----+` border line of exactly `width` code points. */
export function horizontalRule(width: number, title: string): string {
  const label = title === "" ? "" : `[ ${title} ]`;
  const inner = codePoints(`-${label}`.padEnd(Math.max(0, width - 2), "-")).slice(0, Math.max(0, width - 2));
  return `+${inner.join("")}+`;
}

/** The visible window [start, end) of `total` lines, `scroll` lines up from the bottom. */
export function visibleWindow(total: number, height: number, scroll: number): readonly [number, number] {
  const end = total - scroll;
  return [Math.max(0, end - height), end];
}
