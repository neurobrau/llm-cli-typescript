/**
 * The single-line input editor (docs/tui-spec.md sections 6-8). Pure.
 *
 * The cursor is a UTF-16 offset that always sits between code points. Column
 * math scans at most one field width around the cursor, so even a huge draft
 * costs nothing per frame.
 */

export const DEFAULT_MAX_INPUT = 8 * 1024 * 1024;

const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

export class InputEditor {
  private value = "";
  private position = 0;

  constructor(private readonly maxLength: number = DEFAULT_MAX_INPUT) {}

  get text(): string {
    return this.value;
  }

  get cursor(): number {
    return this.position;
  }

  get isEmpty(): boolean {
    return this.value === "";
  }

  /** Replaces the draft (cursor at the end), keeping at most the allowed length. */
  set(text: string): void {
    this.value = this.clip(text, this.maxLength);
    this.position = this.value.length;
  }

  /** Restores a draft and cursor exactly as they were (the cursor is clamped to a code point boundary). */
  restore(text: string, cursor: number): void {
    this.value = this.clip(text, this.maxLength);
    let at = Math.max(0, Math.min(cursor, this.value.length));
    if (at > 0 && at < this.value.length && isLow(this.value.charCodeAt(at)) && isHigh(this.value.charCodeAt(at - 1))) at -= 1;
    this.position = at;
  }

  clear(): void {
    this.value = "";
    this.position = 0;
  }

  /** Inserts at the cursor; returns false when part of the text did not fit. */
  insert(text: string): boolean {
    const room = this.maxLength - this.value.length;
    const accepted = this.clip(text, room);
    this.value = this.value.slice(0, this.position) + accepted + this.value.slice(this.position);
    this.position += accepted.length;
    return accepted.length === text.length;
  }

  backspace(): void {
    if (this.position === 0) return;
    const start = this.before(this.position);
    this.value = this.value.slice(0, start) + this.value.slice(this.position);
    this.position = start;
  }

  delete(): void {
    if (this.position >= this.value.length) return;
    this.value = this.value.slice(0, this.position) + this.value.slice(this.after(this.position));
  }

  left(): void {
    this.position = this.before(this.position);
  }

  right(): void {
    this.position = this.after(this.position);
  }

  home(): void {
    this.position = 0;
  }

  end(): void {
    this.position = this.value.length;
  }

  /**
   * The slice of the draft shown in a field `width` columns wide, and the
   * column of the cursor in it. The field scrolls so the cursor stays visible.
   */
  viewport(width: number): { readonly visible: string; readonly column: number } {
    const columns = Math.max(1, width);
    let start = this.position;
    let column = 0;
    while (column < columns - 1 && start > 0) {
      start = this.before(start);
      column += 1;
    }
    let end = start;
    let shown = 0;
    while (shown < columns && end < this.value.length) {
      end = this.after(end);
      shown += 1;
    }
    return { visible: this.value.slice(start, end), column };
  }

  private before(index: number): number {
    if (index <= 0) return 0;
    const low = this.value.charCodeAt(index - 1);
    return isLow(low) && index >= 2 && isHigh(this.value.charCodeAt(index - 2)) ? index - 2 : index - 1;
  }

  private after(index: number): number {
    if (index >= this.value.length) return this.value.length;
    const high = this.value.charCodeAt(index);
    return isHigh(high) && index + 1 < this.value.length && isLow(this.value.charCodeAt(index + 1)) ? index + 2 : index + 1;
  }

  /** The longest prefix of `text` within `limit` UTF-16 units that does not split a pair. */
  private clip(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const cut = Math.max(0, limit);
    return cut > 0 && isHigh(text.charCodeAt(cut - 1)) ? text.slice(0, cut - 1) : text.slice(0, cut);
  }
}
