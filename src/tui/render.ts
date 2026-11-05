/**
 * Renders the model into a frame (docs/tui-spec.md sections 2-6): one
 * redraw-everything function. Pure: no terminal, no clock of its own.
 */
import type { ResolvedSettings } from "../domain/settings.js";
import { createFrame, put } from "./frame.js";
import type { Frame, Style } from "./frame.js";
import { MIN_COLS, MIN_ROWS, computeLayout, horizontalRule, visibleWindow } from "./layout.js";
import { footerOf, menuBox, menuLine } from "./menu.js";
import type { Layout } from "./layout.js";
import { AI_LABEL, TOKENS_LABEL, USER_LABEL } from "./model.js";
import type { EntryKind, TuiModel } from "./model.js";
import { settingsPanelRows } from "./panel.js";
import { STATE_STYLES, SEPARATOR, activeStatus, WAITING_COMPLETE, ready, statusText } from "./status.js";
import type { RuntimeStatus } from "./status.js";
import { fit, neutralize } from "./text.js";

export const HELP_LINE = " F1 /help | /reset /exit | F2-F6 settings | PgUp/PgDn scroll | Ctrl+C quit";

export interface RenderContext {
  /** `NeuroBräu TypeScript CLI <version>`. */
  readonly title: string;
  readonly settings: ResolvedSettings;
  /** Monotonic milliseconds. */
  readonly now: number;
}

const ENTRY_STYLES: Readonly<Record<EntryKind, { readonly label: Style; readonly text: Style; readonly prefix: string }>> = {
  user: { label: "user", text: "text", prefix: USER_LABEL },
  ai: { label: "ai", text: "text", prefix: AI_LABEL },
  info: { label: "info", text: "info", prefix: "" },
  error: { label: "error", text: "error", prefix: "" },
};

/** What the status bar shows now: a fresh flash, else live activity, else the stored status. */
export function currentStatus(model: TuiModel, now: number): RuntimeStatus {
  const { flash, live } = model;
  if (flash !== undefined && now < flash.until) return flash.status;
  if (live !== undefined) {
    if (!live.streaming) return WAITING_COMPLETE;
    const elapsed = Math.max(0, now - live.startedAt) / 1000;
    if (live.firstTextAt === undefined && !live.thinking) return activeStatus("CONNECTING", elapsed);
    return activeStatus("GENERATING", elapsed, live.firstTextAt === undefined ? "Thinking" : undefined);
  }
  if (model.checking !== undefined) return { state: "CONNECTING", parts: [model.checking] };
  if (model.prompt !== undefined) return ready("Type a token limit and press Enter", "Esc cancels");
  if (model.confirmingCleanup) {
    return { state: "WARNING", parts: ["Type yes to delete saved conversations; anything else cancels"] };
  }
  return model.status;
}

export function renderFrame(model: TuiModel, context: RenderContext): Frame {
  const { rows, cols } = model.size;
  const frame = createFrame(rows, cols);
  const layout = computeLayout(model.size);
  if (layout === undefined) {
    renderTooSmall(frame);
    return frame;
  }
  model.scroll = Math.min(model.scroll, model.maxScroll());
  renderBorders(frame, layout, model, context);
  renderConversation(frame, layout, model);
  renderPanel(frame, layout, model, context);
  renderStatus(frame, layout, currentStatus(model, context.now));
  renderInput(frame, layout, model);
  renderMenu(frame, layout, model);
  return frame;
}

function renderTooSmall(frame: Frame): void {
  const lines = ["Terminal too small.", `Need ${String(MIN_COLS)}x${String(MIN_ROWS)}, have ${String(frame.cols)}x${String(frame.rows)}.`, "Resize or press Ctrl+C."];
  for (const [row, line] of lines.slice(0, frame.rows).entries()) {
    put(frame, row, 0, line, "error", frame.cols - 1); // never the last cell
  }
}

function renderBorders(frame: Frame, layout: Layout, model: TuiModel, context: RenderContext): void {
  const { cols, panelX } = layout;
  // The scroll suffix must stay visible, so a long product title gives way to it.
  const suffix = model.scroll > 0 ? ` - scrolled up ${String(model.scroll)} (PgDn)` : "";
  const ruleWidth = panelX === undefined ? cols : panelX + 1;
  const title = suffix === "" ? context.title : `${fit(context.title, Math.max(1, ruleWidth - 7 - suffix.length))}${suffix}`;
  const top =
    panelX === undefined
      ? horizontalRule(cols, title)
      : horizontalRule(panelX + 1, title) + horizontalRule(cols - panelX, "LLM SETTINGS").slice(1);
  put(frame, 0, 0, top, "border");
  for (let row = layout.conversationTop; row < layout.statusSeparatorRow; row += 1) {
    put(frame, row, 0, "|", "border");
    if (panelX !== undefined) put(frame, row, panelX, "|", "border");
    put(frame, row, cols - 1, "|", "border");
  }
  put(frame, layout.statusSeparatorRow, 0, horizontalRule(cols, "Status"), "border");
  if (panelX !== undefined) put(frame, layout.statusSeparatorRow, panelX, "+", "border");
  for (const row of [layout.statusRow, layout.inputRow]) {
    put(frame, row, 0, "|", "border");
    put(frame, row, cols - 1, "|", "border");
  }
  put(frame, layout.inputSeparatorRow, 0, horizontalRule(cols, "Input"), "border");
  put(frame, layout.bottomRow, 0, horizontalRule(cols, ""), "border");
  put(frame, layout.helpRow, 0, HELP_LINE, "border", cols - 1); // the bottom-right cell is never written
}

function renderConversation(frame: Frame, layout: Layout, model: TuiModel): void {
  const width = layout.conversationWidth;
  const lines: { readonly text: string; readonly kind: EntryKind; readonly first: boolean }[] = [];
  for (const [index, entry] of model.entries.entries()) {
    if (index > 0) lines.push({ text: "", kind: "info", first: false });
    for (const [at, text] of model.linesOf(entry, width).entries()) {
      lines.push({ text, kind: entry.kind, first: at === 0 });
    }
  }
  const [start, end] = visibleWindow(lines.length, layout.conversationHeight, model.scroll);
  for (const [offset, line] of lines.slice(start, end).entries()) {
    const row = layout.conversationTop + offset;
    const style = ENTRY_STYLES[line.kind];
    const label = style.prefix;
    if (label !== "") {
      put(frame, row, 2, line.first ? label : " ".repeat(label.length), style.label, layout.conversationLimit);
    }
    put(frame, row, 2 + label.length, line.text, style.text, layout.conversationLimit);
  }
}

function renderPanel(frame: Frame, layout: Layout, model: TuiModel, context: RenderContext): void {
  if (layout.panelX === undefined) return;
  const rows = settingsPanelRows(context.settings, model.stats).slice(0, layout.conversationHeight);
  for (const [offset, row] of rows.entries()) {
    put(frame, layout.conversationTop + offset, layout.panelX + 2, row.text, row.style, layout.cols - 2);
  }
}

function renderStatus(frame: Frame, layout: Layout, status: RuntimeStatus): void {
  const limit = layout.cols - 2;
  put(frame, layout.statusRow, 2, status.state, STATE_STYLES[status.state], limit);
  const details = status.parts.map((part) => SEPARATOR + neutralize(part)).join("");
  put(frame, layout.statusRow, 2 + status.state.length, details, "text", limit);
}

function renderInput(frame: Frame, layout: Layout, model: TuiModel): void {
  const label = model.prompt === undefined ? USER_LABEL : TOKENS_LABEL;
  const fieldWidth = Math.max(1, layout.innerWidth - label.length);
  const { visible, column } = model.editor.viewport(fieldWidth);
  put(frame, layout.inputRow, 2, label, "user", layout.cols - 2);
  put(frame, layout.inputRow, 2 + label.length, neutralize(visible), "text", layout.cols - 2);
  frame.cursor = { row: layout.inputRow, col: Math.min(layout.cols - 3, 2 + label.length + column) };
}

/** The open menu as a bordered box over the conversation; the highlight is clamped to what fits now. */
function renderMenu(frame: Frame, layout: Layout, model: TuiModel): void {
  const { menu } = model;
  if (menu === undefined) return;
  const box = menuBox(menu, layout);
  menu.scrollIntoView(box.visible);
  const right = box.x + box.width;
  put(frame, box.y, box.x, horizontalRule(box.width, menu.title), "border", right);
  for (const [offset, item] of menu.items.slice(menu.top, menu.top + box.visible).entries()) {
    const row = box.y + 1 + offset;
    const style: Style = menu.top + offset === menu.index ? "selected" : "text";
    put(frame, row, box.x, "|", "border", right);
    put(frame, row, box.x + 1, ` ${menuLine(item, box.width - 4)} `, style, right - 1);
    put(frame, row, right - 1, "|", "border", right);
  }
  put(frame, box.y + box.height - 1, box.x, horizontalRule(box.width, footerOf(menu)), "border", right);
}

export { statusText };
