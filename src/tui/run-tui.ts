/**
 * Composition of one fullscreen chat run: startup (key, settings, history)
 * first - with no terminal change - then the terminal and the controller, then
 * the mapping of the outcome to exit codes and the optional transcript.
 */
import { PROGRAM_NAME } from "../args.js";
import type { ChatInvocation } from "../args.js";
import { startChat } from "../application/chat-startup.js";
import type { ChatStartupDependencies } from "../application/chat-startup.js";
import { PreferencesService } from "../application/preferences.js";
import { ProviderHub } from "../application/provider-hub.js";
import { Workspace } from "../application/workspace.js";
import { fixedFailure, startupFailure } from "../chat/run-chat.js";
import { OutputError, write } from "../io.js";
import type { Io } from "../io.js";
import { EXIT_SIGHUP, EXIT_SIGINT, EXIT_SIGTERM, TuiController } from "./controller.js";
import type { TerminalEnvironment, TuiHost } from "./terminal.js";
import { transcriptText } from "./texts.js";

export interface TuiRunDependencies extends ChatStartupDependencies {
  readonly title: string;
  readonly cleanupTimeoutMs: number;
  readonly host: TuiHost;
  readonly terminalEnvironment: TerminalEnvironment;
}

const SIGNAL_CODES = { SIGINT: EXIT_SIGINT, SIGTERM: EXIT_SIGTERM, SIGHUP: EXIT_SIGHUP } as const;

export async function runTui(invocation: ChatInvocation, io: Io, deps: TuiRunDependencies): Promise<number> {
  const { host } = deps;
  const startup = new AbortController();
  let startupCode: number = EXIT_SIGINT;
  let controller: TuiController | undefined;
  const unregister = host.signals.register((signal) => {
    if (controller === undefined) {
      if (!startup.signal.aborted) startupCode = SIGNAL_CODES[signal];
      startup.abort();
    } else if (signal === "SIGINT") {
      controller.interrupt();
    } else {
      controller.terminate(SIGNAL_CODES[signal]);
    }
  });
  try {
    let started;
    try {
      started = await startChat(invocation, deps, startup.signal);
    } catch (error: unknown) {
      const code = await startupFailure(error, startup.signal, io);
      return startup.signal.aborted ? startupCode : code;
    }
    if (startup.signal.aborted) {
      await write(io.stderr, `${PROGRAM_NAME}: interrupted\n`);
      return startupCode; // no terminal change and no request after an interrupt during startup
    }
    // The workspace gets the very settings store that loaded the file and the loaded document: settings are
    // neither loaded twice nor rebuilt, so a store disabled at startup stays unwritable for the whole run.
    const workspace = new Workspace({
      hub: new ProviderHub({ initial: started.provider, createProvider: deps.createProvider, checkProviderReady: deps.checkProviderReady }),
      preferences: new PreferencesService({
        stored: started.storedSettings,
        saver: started.settingsStore,
        overrides: {
          ...(invocation.reasoning === undefined ? {} : { reasoning: invocation.reasoning }),
          ...(invocation.maxOutputTokens === undefined ? {} : { maxOutputTokens: invocation.maxOutputTokens }),
          ...(invocation.answerStyle === undefined ? {} : { answerStyle: invocation.answerStyle }),
        },
      }),
      session: started.session,
      provider: started.provider,
      settings: started.settings,
      history: started.history,
      clock: deps.clock,
      newId: deps.newId,
      activeTracker: started.activeTracker,
    });
    controller = new TuiController({
      title: deps.title,
      workspace,
      warnings: started.warnings,
      terminal: host.createTerminal(deps.terminalEnvironment),
      timers: host.timers,
      stream: invocation.stream,
      cleanupTimeoutMs: deps.cleanupTimeoutMs,
    });
    let code: number;
    try {
      const result = await controller.run(); // the terminal is restored when this returns or throws
      if (result.diagnostic !== undefined) await write(io.stderr, `${PROGRAM_NAME}: error: ${result.diagnostic}\n`);
      code = result.code;
    } catch (error: unknown) {
      if (error instanceof OutputError) throw error;
      code = await fixedFailure(error, io);
    }
    if (invocation.transcriptOnExit) {
      await write(io.stdout, transcriptText(workspace.session.snapshot().messages, { terminal: deps.terminalEnvironment.stdoutIsTTY }));
    }
    return code;
  } catch (error: unknown) {
    if (error instanceof OutputError) throw error;
    return await fixedFailure(error, io);
  } finally {
    unregister();
  }
}
