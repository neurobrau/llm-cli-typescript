/**
 * The visible state of the fullscreen interface: conversation entries, scroll
 * position, draft, status and flash. It holds no network, storage or terminal
 * objects; the controller changes it and the renderer reads it. Entries are
 * what the screen shows - they are not the committed conversation.
 */
import { InputEditor } from "./editor.js";
import { computeLayout } from "./layout.js";
import type { Size } from "./layout.js";
import type { PanelStats } from "./panel.js";
import { READY, isTransient } from "./status.js";
import type { RuntimeStatus } from "./status.js";
import { expandTabs, neutralize, splitLines, wrapParagraph } from "./text.js";

export type EntryKind = "user" | "ai" | "info" | "error";

export const USER_LABEL = "YOU > ";
export const AI_LABEL = "AI > ";

export interface Entry {
  readonly id: number;
  readonly kind: EntryKind;
  text: string;
  cachedWidth: number;
  cachedText: string;
  cachedLines: readonly string[];
  /** Wrapped lines per explicit line, so a growing answer only re-wraps what changed. */
  cachedParagraphs: { readonly source: string; readonly lines: readonly string[] }[];
}

/** What the status bar shows for a request that is running. */
export interface LiveRequest {
  readonly startedAt: number;
  readonly streaming: boolean;
  firstTextAt: number | undefined;
  thinking: boolean;
}

const labelOf = (kind: EntryKind): string => (kind === "user" ? USER_LABEL : kind === "ai" ? AI_LABEL : "");

export class TuiModel {
  readonly entries: Entry[] = [];
  readonly editor: InputEditor;
  /** Lines scrolled up from the bottom; 0 follows the newest text. */
  scroll = 0;
  status: RuntimeStatus = READY;
  afterTransient: RuntimeStatus | undefined;
  flash: { readonly status: RuntimeStatus; readonly until: number } | undefined;
  live: LiveRequest | undefined;
  /** A blocking storage operation (reset, cleanup) is running. */
  working = false;
  confirmingCleanup = false;
  stats: PanelStats = { input: undefined, output: undefined, total: undefined, cached: undefined, reasoning: undefined, context: undefined, any: false };
  size: Size;
  private nextId = 1;

  constructor(size: Size, maxInput?: number) {
    this.size = size;
    this.editor = new InputEditor(maxInput);
  }

  add(kind: EntryKind, text: string): Entry {
    const entry: Entry = { id: this.nextId, kind, text, cachedWidth: -1, cachedText: "", cachedLines: [], cachedParagraphs: [] };
    this.nextId += 1;
    this.entries.push(entry);
    return entry;
  }

  clearEntries(): void {
    this.entries.length = 0;
    this.scroll = 0;
  }

  /** Lines of one entry at the conversation width; display text is neutralized, the stored text is not. */
  linesOf(entry: Entry, width: number): readonly string[] {
    if (entry.cachedWidth !== width || entry.cachedText !== entry.text) {
      const columns = Math.max(1, width - labelOf(entry.kind).length);
      if (entry.cachedWidth !== width) entry.cachedParagraphs = [];
      const sources = splitLines(expandTabs(neutralize(entry.text), 4));
      const paragraphs = sources.map((source, index) => {
        const cached = entry.cachedParagraphs[index];
        return cached?.source === source ? cached : { source, lines: wrapParagraph(source, columns) };
      });
      entry.cachedParagraphs = paragraphs;
      entry.cachedLines = paragraphs.flatMap((paragraph) => paragraph.lines);
      entry.cachedWidth = width;
      entry.cachedText = entry.text;
    }
    return entry.cachedLines;
  }

  /** Total transcript lines, with one blank line between entries. */
  totalLines(width: number): number {
    let total = 0;
    for (const [index, entry] of this.entries.entries()) {
      total += this.linesOf(entry, width).length + (index === 0 ? 0 : 1);
    }
    return total;
  }

  /**
   * Applies `change` so that a reader who scrolled up keeps seeing the same
   * lines: the offset grows by the number of lines the change added.
   */
  anchored(change: () => void): void {
    const layout = computeLayout(this.size);
    if (layout === undefined || this.scroll === 0) {
      change();
      return;
    }
    const before = this.totalLines(layout.conversationWidth);
    change();
    this.scroll += this.totalLines(layout.conversationWidth) - before;
  }

  maxScroll(): number {
    const layout = computeLayout(this.size);
    return layout === undefined ? 0 : Math.max(0, this.totalLines(layout.conversationWidth) - layout.conversationHeight);
  }

  scrollBy(delta: number): void {
    this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll + delta));
  }

  pageSize(): number {
    const layout = computeLayout(this.size);
    return layout === undefined ? 1 : Math.max(1, layout.conversationHeight - 1);
  }

  /** A transient status ends with the next key press other than a resize. */
  releaseTransient(): void {
    if (isTransient(this.status)) {
      this.status = this.afterTransient ?? READY;
      this.afterTransient = undefined;
    }
  }

  flashStatus(status: RuntimeStatus, now: number, durationMs: number): void {
    this.flash = { status, until: now + durationMs };
  }
}
