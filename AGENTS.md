# NeuroBräu TypeScript

Read the active task in `.agent-tasks/` before editing. Implement only that task and stop for owner review.

## Scope and owner control

- Node.js 24, TypeScript, native ESM, npm, and tsc. Run the emitted CLI with `node dist/cli.js` once implemented.
- No commits, pushes, tags, releases, npm publication, remote repository changes, or next-task work without explicit owner authorization.
- Python and Go sibling repositories are read-only references. Never edit their files, Git state, or caches.
- No global installation, PATH changes, shell-profile edits, real API calls, or model downloads.
- Never read real API keys, user history, or user configuration during development checks. Use fake providers/mock servers and temporary HOME/XDG values in child processes.
- Do not commit `.agent-tasks/`, secrets, dependencies, or generated artifacts.

## Implementation

- Strict types; no unjustified any, non-null assertions, lint suppressions, or swallowed errors.
- Keep provider SDKs out of domain/session/storage contracts. Use AbortController for future I/O cancellation.
- Persisted JSON must follow the reference schemas and canonical serialization. Do not silently round large integers.
- New production dependencies require a concrete justification in the report. Add code and directories only when needed by the active task.
- `.aiignore` is advisory and may not be honored by an agent. Follow these instructions regardless.

## Verification and report

Required checks: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run check` (use `npm ci` for installs once the lockfile exists). Distinguish blocked checks from passing checks. Report changed files, commands/results, versions, deviations, and remaining limitations. Stop for owner review.
