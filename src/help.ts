import { PROGRAM_NAME } from "./args.js";

const EDITION = "NeuroBräu TypeScript CLI";

export function versionText(version: string): string {
  return `${EDITION} ${version}\n`;
}

export function usageHint(): string {
  return `Try '${PROGRAM_NAME} --help' for usage.\n`;
}

export function helpText(version: string): string {
  return `usage: ${PROGRAM_NAME} [-h] [--version]

${EDITION} ${version} (bootstrap skeleton)

This build only prints help and version information. Prompt and chat modes
are future work; no LLM provider is available and no requests are made.

options:
  -h, --help     show this help message and exit
  --version      show program's version number and exit

With no arguments, this help is shown.
`;
}
