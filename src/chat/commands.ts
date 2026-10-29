/** Chat commands and fixed texts of the plain chat (Python `chat.py`, Go `internal/chat`). */

export const USER_PROMPT = "YOU > ";
export const AI_PREFIX = "AI > ";
const COMMAND_PREFIXES = ["/", "\\"] as const;

export const NOTICE_RESET_SAVED = "Started a new conversation. The previous one stays saved.";
export const NOTICE_RESET_MEMORY = "Conversation history cleared.";
export const NOTICE_HISTORY_DISABLED = "Conversation history is disabled for this session (--no-history).";
export const NOTICE_NO_SAVED = "No saved conversations.";
export const NOTICE_CLEANUP_CANCELLED = "Cleanup cancelled. Nothing was deleted.";
export const NOTICE_GOODBYE = "Goodbye.";
export const NOTICE_REQUEST_CANCELLED = "Request cancelled.";

/**
 * The command name (lower case, without the prefix) if `text` is a single
 * word starting with `/` or a backslash; otherwise `undefined`, so a message
 * such as "/usr/bin is what?" is still sent to the model. The input is
 * already trimmed by the caller.
 */
export function parseCommand(text: string): string | undefined {
  if (!COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix)) || /\s/u.test(text)) {
    return undefined;
  }
  return text.slice(1).toLowerCase();
}

/** Only `yes`, ignoring case and surrounding whitespace, confirms a cleanup. */
export function isCleanupConfirmation(answer: string): boolean {
  return answer.trim().toLowerCase() === "yes";
}

export function helpText(persistent: boolean): string {
  const reset = persistent
    ? "start a new conversation (the previous one stays saved)"
    : "clear the conversation (history is disabled for this session)";
  const cleanup = persistent ? "delete all saved conversations (asks for confirmation)" : "not available (history is disabled)";
  const exit = persistent ? "exit the chat (the conversation stays saved)" : "exit the chat";
  return `Commands:
  /help     show this help
  /reset    ${reset}
  /cleanup  ${cleanup}
  /usage    token usage of this conversation (cost estimates are not implemented yet)
  /exit     ${exit}
Backslash aliases also work: \\help, \\reset, \\cleanup, \\usage, \\exit.
Press Ctrl+D (EOF) or Ctrl+C at the prompt to exit.
Ctrl+C while waiting for an answer cancels the request.`;
}

export function cleanupQuestion(count: number, directory: string): string {
  return `Delete ${String(count)} saved conversation(s) in ${directory}? This cannot be undone. Type 'yes' to confirm: `;
}

/** `YYYY-MM-DD HH:MM` in local time. */
export function localMinute(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
