import type { AgentKind } from '@cat-factory/kernel'

// Read-only container agents. Some agent kinds need a real checkout to do their
// work but only ever READ it: they clone the repo, explore it, and return a prose
// report/proposal — making no edits, no commits and opening no pull request. They
// dispatch through the generic, manifest-driven `agent` kind in `explore` mode (the
// SAME path a registered `container-explore` kind takes), where an edit-free run is
// the expected, correct outcome rather than an "implementation produced no changes"
// failure, and where no work branch or PR is created.
//
// Today that is the `architect` (proposes a design after reading the existing code,
// whose prose proposal feeds the human gate / architect-companion) and the tech-debt
// `analysis` agent (audits the repo and emits a prioritized report). Both share the
// single reusable read-only dispatch (see ContainerAgentExecutor's
// `buildRegisteredAgentBody` explore path + the harness `handleAgent`).

// The `bug-investigator` joins this set: it reads the codebase from a raw bug report and
// returns a prose enriched report (+ an optional, confidence-gated hypothesis), making no
// edits — the same read-only contract as architect/analysis.
//
// The `spike` (a timeboxed research/investigation kind) joins it too: it explores the codebase
// read-only and returns structured findings; the findings document is committed by a BACKEND
// post-op over `RepoFiles`, not by the container, so the read-only container contract holds.
/** Container agent kinds that operate read-only (explore + report; no edits/commits/PR). */
export const READ_ONLY_AGENT_KINDS = new Set<string>([
  'architect',
  'analysis',
  'bug-investigator',
  'spike',
])

/** Whether `kind` is a read-only container agent (runs the harness `/explore` path). */
export function isReadOnlyAgentKind(kind: AgentKind): boolean {
  return READ_ONLY_AGENT_KINDS.has(kind)
}

/**
 * Appended to a read-only agent's system prompt so it never tries to edit, commit or
 * open a PR — the prose report it returns is its sole deliverable. Centralised here
 * (rather than repeated in each role prompt) so every read-only kind states the same
 * guardrail exactly once.
 *
 * It states what the AGENT may do and claims nothing about the surface it runs on, nor about what
 * the platform does around it. Both of those were asserted here once and both were false.
 * `applySurfaceDirectives` appends this through `systemPromptFor`, which the INLINE executor and
 * the consensus panel also call, so a carve-out phrased as "the sentinel file the instructions
 * below ask you for" named a file nothing asks a panel participant for, in an environment with no
 * working directory to write it to. And "no commit or push happens on this step" is false for
 * `spike`, whose findings document is committed and published by a backend post-op: what is true
 * on every path is that the commit is not the agent's to make.
 *
 * The reconciliation with the effort report the container-dispatch chokepoint appends lives in
 * `EFFORT_REPORT_GUIDANCE` instead, that being the only half of the pair which reaches every kind
 * the other half can contradict: the bespoke `merger` / `on-call` prompts never pass through
 * `systemPromptFor` at all, so a carve-out written here could not reach them.
 */
export const READ_ONLY_GUARDRAIL =
  'IMPORTANT — this is a READ-ONLY exploration: you may read and inspect any file in ' +
  'the repository, but you MUST NOT modify, create or delete its files, run commands that ' +
  'change it, commit, or open a pull request: no commit or push on this step is yours to make. ' +
  'Your written report is the only deliverable; return it as your response, and whatever the ' +
  'platform persists from this step it writes itself, from that report.'
