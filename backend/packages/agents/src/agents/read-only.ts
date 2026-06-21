import type { AgentKind } from '@cat-factory/kernel'

// Read-only container agents. Some agent kinds need a real checkout to do their
// work but only ever READ it: they clone the repo, explore it, and return a prose
// report/proposal — making no edits, no commits and opening no pull request. They
// run through the harness `/explore` endpoint (not `/run`), where an edit-free run
// is the expected, correct outcome rather than an "implementation produced no
// changes" failure, and where no work branch or PR is created.
//
// Today that is the `architect` (proposes a design after reading the existing code,
// whose prose proposal feeds the human gate / architect-companion) and the tech-debt
// `analysis` agent (audits the repo and emits a prioritized report). Both share the
// single reusable read-only execution path (see ContainerAgentExecutor's explore
// body + the harness `handleExplore`).

/** Container agent kinds that operate read-only (explore + report; no edits/commits/PR). */
export const READ_ONLY_AGENT_KINDS = new Set<string>(['architect', 'analysis'])

/** Whether `kind` is a read-only container agent (runs the harness `/explore` path). */
export function isReadOnlyAgentKind(kind: AgentKind): boolean {
  return READ_ONLY_AGENT_KINDS.has(kind)
}

/**
 * Appended to a read-only agent's system prompt so it never tries to edit, commit or
 * open a PR — the prose report it returns is its sole deliverable. Centralised here
 * (rather than repeated in each role prompt) so every read-only kind states the same
 * guardrail exactly once.
 */
export const READ_ONLY_GUARDRAIL =
  'IMPORTANT — this is a READ-ONLY exploration: you may read and inspect any file in ' +
  'the repository, but you MUST NOT modify, create or delete files, run commands that ' +
  'change the repository, commit, or open a pull request. Your written report is the ' +
  'only deliverable; return it as your response.'
