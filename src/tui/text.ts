/**
 * Pure text rules of the fullscreen interface: display neutralization,
 * code-point helpers and the word wrapper (Python `textwrap.wrap` as used by
 * the reference, docs/tui-spec.md sections 4 and 10). No I/O.
 *
 * Widths are counted in code points, one column each; wide (CJK, emoji)
 * characters are a documented limitation shared with the references.
 */

/** Shown instead of a control character. */
export const REPLACEMENT = "�";

/**
 * Whether one code point must never reach a terminal as is: C0 controls
 * (TAB, LF and CR excepted when `keepBreaks`), DEL, C1 controls, lone
 * surrogates and the Unicode line/paragraph separators.
 */
export function isUnsafe(char: string, keepBreaks: boolean): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x09 || code === 0x0a || code === 0x0d) return !keepBreaks;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff);
}

/**
 * The text as it may be sent to a terminal: ESC, other C0/C1 controls and
 * lone surrogates are replaced, so model, user or history text can never
 * start an escape sequence. TAB, LF and CR survive because wrapping consumes
 * them. The stored text is never changed.
 */
export function neutralize(text: string): string {
  let out = "";
  for (const char of text) out += isUnsafe(char, true) ? REPLACEMENT : char;
  return out;
}

export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Tabs to the next multiple of `size` columns; columns restart after a line break. */
export function expandTabs(text: string, size: number): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let column = 0;
  for (const char of text) {
    if (char === "\t") {
      const spaces = size - (column % size);
      out += " ".repeat(spaces);
      column += spaces;
    } else if (char === "\n" || char === "\r") {
      out += char;
      column = 0;
    } else {
      out += char;
      column += 1;
    }
  }
  return out;
}

/** Splits at LF, CRLF and CR; a final line break adds no empty line and "" is one empty line. */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

interface Chunk {
  start: number;
  readonly end: number;
  readonly space: boolean;
}

/** Runs of spaces and runs of other characters, in order, as ranges over the code points. */
function chunksOf(points: readonly string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  for (let index = 1; index <= points.length; index += 1) {
    if (index === points.length || (points[index] === " ") !== (points[start] === " ")) {
      chunks.push({ start, end: index, space: points[start] === " " });
      start = index;
    }
  }
  return chunks;
}

/**
 * `textwrap.wrap` for one line without leading spaces, with `indent` on every
 * output line. Linear in the text: chunks are ranges, never copied or re-sliced.
 */
function wrapLine(text: string, width: number, indent: string): string[] {
  const points = Array.from(text);
  const chunks = chunksOf(points);
  const available = width - indent.length;
  const lines: string[] = [];
  let next = 0;
  while (next < chunks.length) {
    const pieces: string[] = [];
    let length = 0;
    let lastIsSpace = false;
    if (lines.length > 0 && chunks[next]?.space === true) next += 1; // no spaces at the start of a wrapped line
    for (let chunk = chunks[next]; chunk !== undefined && length + (chunk.end - chunk.start) <= available; chunk = chunks[next]) {
      pieces.push(points.slice(chunk.start, chunk.end).join(""));
      length += chunk.end - chunk.start;
      lastIsSpace = chunk.space;
      next += 1;
    }
    const long = chunks[next];
    if (long !== undefined && long.end - long.start > available) {
      // A word longer than the width fills the rest of the line (nothing when no room is left).
      const room = available < 1 ? 1 : available - length;
      if (room > 0) {
        pieces.push(points.slice(long.start, long.start + room).join(""));
        lastIsSpace = long.space;
        long.start += room;
        if (long.start >= long.end) next += 1;
      }
    }
    if (pieces.length > 0 && lastIsSpace) pieces.pop(); // no spaces at the end of a line
    if (pieces.length > 0) lines.push(indent + pieces.join(""));
  }
  return lines;
}

/** One explicit line (tabs already expanded) wrapped like the reference; always at least one line. */
export function wrapParagraph(paragraph: string, width: number): string[] {
  const columns = Math.max(width, 1);
  const stripped = paragraph.replace(/^ +/, "");
  const indent = " ".repeat(Math.min(paragraph.length - stripped.length, Math.floor(columns / 2)));
  const wrapped = wrapLine(stripped, columns, indent);
  return wrapped.length === 0 ? [""] : wrapped;
}

/**
 * Wraps `text` to `width` columns: explicit breaks and blank lines are kept,
 * each line keeps its leading indentation (at most half the width) on all its
 * wrapped lines, words are filled greedily, spaces at wrap points are dropped
 * and a word longer than the width is broken. The result never contains a
 * line wider than `width`.
 */
export function wrapParagraphs(text: string, width: number): string[] {
  return splitLines(expandTabs(text, 4)).flatMap((paragraph) => wrapParagraph(paragraph, width));
}

/** Clips to `width` code points, marking a cut with `~`. */
export function fit(text: string, width: number): string {
  const points = codePoints(text);
  return points.length <= width ? text : `${points.slice(0, Math.max(0, width - 1)).join("")}~`;
}
