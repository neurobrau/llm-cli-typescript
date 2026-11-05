/**
 * The drawing surface: a grid of single-column cells in named styles. The
 * renderer fills it, the terminal adapter turns it into escape sequences.
 * Every write is addressed and clipped, so nothing can fall outside the grid.
 */
import { REPLACEMENT, codePoints, isUnsafe } from "./text.js";

export type Style = "text" | "border" | "user" | "ai" | "info" | "error" | "waiting" | "selected";

export const BLANK = " ";

/**
 * One displayable cell. This is the last gate before the terminal, so no text
 * can reach it as a control: TAB/LF/CR become a space, every other control the
 * replacement mark.
 */
export function cellOf(char: string): string {
  if (!isUnsafe(char, false)) return char;
  return char === "\t" || char === "\n" || char === "\r" ? BLANK : REPLACEMENT;
}

export interface Frame {
  readonly rows: number;
  readonly cols: number;
  /** `chars[row][col]`: exactly one code point per cell. */
  readonly chars: string[][];
  readonly styles: Style[][];
  /** Where the cursor goes, or `undefined` to hide it. */
  cursor: { readonly row: number; readonly col: number } | undefined;
}

export function createFrame(rows: number, cols: number): Frame {
  return {
    rows,
    cols,
    chars: Array.from({ length: rows }, () => Array.from({ length: cols }, () => BLANK)),
    styles: Array.from({ length: rows }, () => Array.from({ length: cols }, (): Style => "text")),
    cursor: undefined,
  };
}

/** Writes `text` at (row, col), clipped to the grid and to the exclusive column `limit`. */
export function put(frame: Frame, row: number, col: number, text: string, style: Style, limit: number = frame.cols): void {
  if (row < 0 || row >= frame.rows) return;
  const chars = frame.chars[row];
  const styles = frame.styles[row];
  if (chars === undefined || styles === undefined) return;
  const end = Math.min(limit, frame.cols);
  let column = col;
  for (const char of codePoints(text)) {
    if (column >= end) break;
    if (column >= 0) {
      chars[column] = cellOf(char);
      styles[column] = style;
    }
    column += 1;
  }
}

export function rowText(frame: Frame, row: number): string {
  return (frame.chars[row] ?? []).join("");
}

export function frameLines(frame: Frame): string[] {
  return frame.chars.map((row) => row.join(""));
}
