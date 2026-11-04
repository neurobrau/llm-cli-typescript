/**
 * The one place that decides whether the fullscreen interface may be used.
 * Support is deliberately conservative: ANSI/VT terminal families that were
 * tested (xterm, screen, tmux, rxvt and their variants) on Linux. Anything
 * else falls back to the plain chat; widening the rule changes only this file.
 */
import type { TerminalEnvironment } from "./terminal.js";

const SUPPORTED_FAMILY = /^(xterm|screen|tmux|rxvt)(-|$)/u;

export function isSupportedTerm(term: string | undefined): boolean {
  return term !== undefined && term !== "" && term !== "dumb" && SUPPORTED_FAMILY.test(term);
}

export type ChatMode = "fullscreen" | "plain";

export function selectChatMode(environment: TerminalEnvironment, plainRequested: boolean): ChatMode {
  if (plainRequested) return "plain";
  if (!environment.stdinIsTTY || !environment.stdoutIsTTY || !environment.rawModeSupported) return "plain";
  return isSupportedTerm(environment.term) ? "fullscreen" : "plain";
}
