// ---------------------------------------------------------------------------
// The run FAILURE-KIND vocabulary: the closed set of ways an agent run can fault, and the
// predicate for asking whether a string is still a member of it.
//
// Its own leaf module (valibot and nothing else) because the vocabulary has consumers well
// outside the execution shapes it was born beside: the operator dashboard renders it as a
// breakdown, a platform-health alert rule names a member as the subject of a page, and the env
// parser that builds those rules asks whether an operator-typed string is one. A set that
// several layers must AGREE about is the thing least well served by living in the middle of a
// large file — and keeping it dependency-free is what lets any of them import it.
//
// The failure DIAGNOSTICS record built on top of these kinds stays in `execution.ts`, where the
// step shapes it composes live.
// ---------------------------------------------------------------------------

import * as v from 'valibot'

/**
 * How an agent run faulted, so the board can classify the failure (and hint
 * whether a retry is likely to help). The union spans both flows; a given flow
 * only ever produces a subset:
 *   - `preflight`        — rejected before dispatch (repo missing/not empty, not connected). [bootstrap]
 *   - `dispatch`         — the container accept-request itself failed (HTTP / network). [bootstrap]
 *   - `evicted`          — the container vanished mid-run (eviction/crash). Retrying spins a fresh one.
 *   - `harness_shutdown` : the harness exited cleanly mid-job. It was shut down, not lost.
 *   - `timeout`          — a container watchdog fired (inactivity or max-duration).
 *   - `agent`            — the agent / git push reported a failure.
 *   - `job_failed`       — an async container job came back failed. [execution]
 *   - `rejected`         — a human rejected a gated proposal, stopping the run. [execution]
 *   - `cancelled`        — the user (or an orphan sweep) explicitly stopped the run.
 *   - `unknown`          — anything not otherwise classified.
 */
export const agentFailureKindSchema = v.picklist([
  'preflight',
  'dispatch',
  // A `deployer` step's ephemeral-environment provisioning failed (the EnvironmentProvider
  // threw or returned `status:'failed'`) — distinct from `dispatch` (a container/runner
  // never accepting the job). The provider's verbatim error rides the failure `detail`.
  'environment',
  'evicted',
  // The harness serving the job EXITED CLEANLY while the job was still running: something shut
  // it down. Split from `evicted` because the two need opposite handling and opposite advice:
  // an eviction is worth a fresh container, and this is not (the run that reported it first had
  // an agent pattern-kill the harness's own process, so every automatic retry reproduced it).
  'harness_shutdown',
  'timeout',
  'agent',
  'job_failed',
  'rejected',
  // A companion agent could not return a parseable quality assessment (truncated /
  // malformed) even after a repair retry, so the run was failed for human attention.
  // (Exhausting the automatic rework budget no longer fails the run — it parks on the
  // companion iteration-cap gate for a human; see `companion.exceeded`.)
  'companion_rejected',
  // The run was still `running` in storage but its durable driver was gone (a crashed /
  // restarted orchestrator left the advance job orphaned), and the stale-run sweeper could
  // not recover it within the hard-stall deadline — so it is failed for human attention
  // instead of spinning `running` forever with no progress. Retry spins a fresh run.
  'stalled',
  // The run's own stored row could not be decoded (a column that must never be null, an
  // out-of-contract enum), so no driver can resume it and no board can render it. Written
  // by the engine straight through the SQL-only terminal write, because every richer path
  // begins by reading the row that cannot be read. Distinct from `stalled`, whose advice is
  // "retry": a retry re-reads the same unreadable row, so this one needs a human at the data.
  'state_unreadable',
  'cancelled',
  'unknown',
])
export type AgentFailureKind = v.InferOutput<typeof agentFailureKindSchema>

const AGENT_FAILURE_KIND_SET: ReadonlySet<string> = new Set(agentFailureKindSchema.options)

/**
 * Whether a string is a failure kind this build produces — DERIVED from the picklist, so it
 * cannot drift from it the way a hand-written second list would.
 *
 * Lives here rather than on either side because the BACKEND and the SPA have to agree about the
 * answer. Both hold a string that is only sometimes a member: the SPA renders a stored alert
 * rule (and a run row) whose kind may name a member a later release retired, and the backend
 * parses the same kind out of `PLATFORM_ALERTS_FAILURE_KIND_RATES`, where the string is whatever
 * an operator typed. A copy on each side is the copy that drifts, and the surface that drifts is
 * the one where an operator points a pager at a kind nothing produces.
 *
 * The negative case is RENDERED as the unrecognised value it is, never guessed onto a current
 * member: nothing can know which member was meant, and a rule silently re-pointed at another
 * kind pages about the wrong system.
 */
export function isAgentFailureKind(value: string): value is AgentFailureKind {
  return AGENT_FAILURE_KIND_SET.has(value)
}
