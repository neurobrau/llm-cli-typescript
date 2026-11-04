/** Runtime status bar content (docs/tui-spec.md section 5). Pure. */
import type { StreamMetadata } from "../domain/generation.js";

export type StatusState = "READY" | "CONNECTING" | "GENERATING" | "DONE" | "CANCELLED" | "ERROR" | "WARNING";

export type StatusStyle = "text" | "waiting" | "ai" | "error";

export const STATE_STYLES: Readonly<Record<StatusState, StatusStyle>> = {
  READY: "text",
  CONNECTING: "waiting",
  GENERATING: "waiting",
  DONE: "ai",
  CANCELLED: "waiting",
  ERROR: "error",
  WARNING: "waiting",
};

/** States that stay until the next key press other than a resize. */
const TRANSIENT: ReadonlySet<StatusState> = new Set(["DONE", "CANCELLED", "ERROR", "WARNING"]);

export interface RuntimeStatus {
  readonly state: StatusState;
  readonly parts: readonly string[];
}

export const SEPARATOR = " | ";
export const CANCEL_HINT = "Ctrl+C Cancel";

export const isTransient = (status: RuntimeStatus): boolean => TRANSIENT.has(status.state);
export const statusText = (status: RuntimeStatus): string => [status.state, ...status.parts].join(SEPARATOR);
export const ready = (...parts: string[]): RuntimeStatus => ({ state: "READY", parts });
export const warning = (...parts: string[]): RuntimeStatus => ({ state: "WARNING", parts });
export const READY: RuntimeStatus = ready();

const seconds = (value: number): string => `${value.toFixed(2)}s`;

/** CONNECTING / GENERATING while a request runs; elapsed time is client-observed. */
export function activeStatus(state: "CONNECTING" | "GENERATING", elapsedSeconds: number, detail?: string): RuntimeStatus {
  return { state, parts: [...(detail === undefined ? [] : [detail]), `${elapsedSeconds.toFixed(1)}s elapsed`, CANCEL_HINT] };
}

export const WAITING_COMPLETE: RuntimeStatus = {
  state: "GENERATING",
  parts: ["Waiting for the complete response", CANCEL_HINT],
};

/**
 * DONE with provider-reported durations when there are any, else the latency
 * this client observed. Missing values are left out, never estimated.
 */
export function doneStatus(
  metadata: StreamMetadata | undefined,
  outputTokens: bigint | undefined,
  observedSeconds: number,
  firstTextSeconds: number | undefined,
): RuntimeStatus {
  const timing = metadata?.timing;
  const total = timing?.totalSeconds;
  if (total !== undefined && total > 0) {
    const parts = [`${seconds(total)} total`];
    if (timing?.loadSeconds !== undefined) parts.push(`load ${seconds(timing.loadSeconds)}`);
    const generation = timing?.evalSeconds;
    if (generation !== undefined) {
      parts.push(`generation ${seconds(generation)}`);
      if (outputTokens !== undefined && generation > 0 && outputTokens <= BigInt(Number.MAX_SAFE_INTEGER)) {
        parts.push(`${(Number(outputTokens) / generation).toFixed(2)} tok/s`);
      }
    }
    return { state: "DONE", parts };
  }
  const parts = [`${seconds(observedSeconds)} observed`];
  if (firstTextSeconds !== undefined) parts.push(`first text after ${seconds(firstTextSeconds)}`);
  return { state: "DONE", parts };
}
