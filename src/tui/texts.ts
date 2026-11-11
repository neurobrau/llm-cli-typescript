/** Fixed texts of the fullscreen interface (docs/tui-spec.md sections 4-9). */
import type { Message } from "../domain/generation.js";
import { AI_PREFIX, USER_PROMPT } from "../chat/commands.js";
import { REPLACEMENT, isUnsafe } from "./text.js";

export const TUI_HELP = `Commands:
  /help     show this help
  /reset    start a new conversation (the previous one stays saved)
  /cleanup  delete all saved conversations (asks for confirmation)
  /usage    token usage and ESTIMATED cost of this conversation
  /exit     exit the application (the conversation stays saved)
Backslash aliases also work: \\help, \\reset, \\cleanup, \\usage, \\exit.
Keys: F1 this help, Enter send, Backspace/Delete edit, Left/Right/Home/End move,
Ctrl+U clear input, PgUp/PgDn/Up/Down scroll, Ctrl+D (empty input) or Ctrl+C quit.
Ctrl+C while a response is generated cancels it.
F2 model, F3 provider (each provider/model keeps its own conversation).
F4 reasoning, F5 max output tokens, F6 answer style (keep the conversation;
they apply from the next message and are saved per model, the style globally).
In menus: Up/Down/PgUp/PgDn/Home/End move, Enter selects, Esc or Ctrl+D cancels.`;

export const NOTICE_BUSY = "A response is being generated; wait or press Ctrl+C";
export const NOTICE_BUSY_SETTINGS = "Settings cannot change while a response is generated";
export const NOTICE_STILL_CLOSING = "The cancelled response is still closing; try again shortly";
export const NOTICE_WORKING = "Please wait; the conversation is being updated";
export const NOTICE_WAIT_CHECK = "Wait for the current check or press Ctrl+C";
export const NOTICE_INPUT_FULL = "The input is too long; the extra text was dropped";
export const NOTICE_NOT_SAVED = " The partial answer above was not saved.";

/**
 * The committed conversation as `--transcript-on-exit` prints it: labels and
 * unchanged content, one blank line between messages, one final newline,
 * nothing for an empty conversation.
 */
export function transcriptText(messages: readonly Message[], options: { readonly terminal: boolean }): string {
  if (messages.length === 0) return "";
  const shown = (content: string): string => (options.terminal ? safeForTerminal(content) : content);
  return `${messages.map((message) => `${message.role === "user" ? USER_PROMPT : AI_PREFIX}${shown(message.content)}`).join("\n\n")}\n`;
}

/**
 * Text for a terminal that prints it: ESC and the other C0/C1 controls, DEL, lone
 * surrogates and the Unicode line/paragraph separators become U+FFFD. Newlines (LF,
 * CRLF) and tabs stay; a lone CR (it would overwrite the line) is replaced too.
 * Only the printed copy changes, never the stored message.
 */
export function safeForTerminal(content: string): string {
  let out = "";
  const points = Array.from(content);
  for (const [index, char] of points.entries()) {
    const loneCarriageReturn = char === "\r" && points[index + 1] !== "\n";
    out += loneCarriageReturn || (char !== "\r" && isUnsafe(char, true)) ? REPLACEMENT : char;
  }
  return out;
}
