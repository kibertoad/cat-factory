import type { ObservedToolServer, ToolServerObservedStatus } from '@cat-factory/contracts'
import { isToolServerObservedStatus } from '@cat-factory/contracts'
import type { PipelineStep } from '@cat-factory/kernel'

// Pure helpers for the OBSERVED half of a step's tool-server record: what the agent's CLI
// reported about the servers it loaded, folded onto the record the dispatch already wrote.
//
// The dispatch half (`recordDispatchAttribution` → `step.toolServers.wired`/`unavailable`) is the
// PLATFORM's account: what it promised the agent and what it deliberately withheld. This is the
// CLI's account of what it managed to start, and it is the only source for the failure mode the
// platform's half structurally cannot see — a server that passed every check and then failed to
// come up in the container. NO repository access, and nothing here is a control signal: no run
// behaviour branches on an observation.

/**
 * Fold the CLI's tool-server startup report onto a step, returning whether anything changed.
 *
 * Applied at two sites that between them cover every poll disposition: the live poll, and once in
 * the dispatcher AHEAD of the settled branch tree, so all five persisting arms inherit it (where
 * `applyValidationReport` instead has a call per path). The coverage matters for the same reason
 * as there, plus one of its own: the CLI announces its servers ONCE, near the start of the run, so
 * a job that settles between two polls is never seen `running` and only its terminal poll can
 * deliver the report.
 *
 * Two guards that are load-bearing rather than defensive:
 *
 *  - it REFUSES to create the record. `step.toolServers` is written at dispatch and carries the
 *    `agentKind` the lists belong to; minting one here would produce a record with no kind (or a
 *    guessed one) describing servers nobody can attribute. A step with no dispatch record has
 *    nothing for an observation to be beside, and an observation with nothing to compare against
 *    is not the missing half of anything.
 *  - an unreadable or EMPTY payload leaves the step untouched rather than writing `[]`. Absent
 *    means "not observed" on this field, and the harness never publishes an empty list, so an
 *    empty one here is a producer this code does not understand — writing it through would turn
 *    "we did not look" into "we looked and the CLI loaded nothing", which is the one reading that
 *    would send an operator after a healthy server.
 */
export function applyObservedToolServers(step: PipelineStep, raw: unknown): boolean {
  const record = step.toolServers
  if (!record) return false
  const observed = coerceObservedToolServers(raw)
  if (!observed) return false
  if (sameObservation(record.observed, observed)) return false
  step.toolServers = { ...record, observed }
  return true
}

/**
 * Parse a harness observation defensively; `null` for absent, unparseable or empty payloads.
 *
 * Entries are validated INDIVIDUALLY and a malformed one is dropped rather than failing the whole
 * report: the rows are independent facts about independent servers, so one row this image cannot
 * read is no reason to discard what the CLI said about the others. A status outside the closed
 * vocabulary becomes `unknown` rather than dropping the row, for the reason the vocabulary
 * documents — the CLI's status words are a third party's, and a server whose state cannot be named
 * is still a server the CLI knew about.
 */
export function coerceObservedToolServers(raw: unknown): ObservedToolServer[] | null {
  if (!Array.isArray(raw)) return null
  const observed: ObservedToolServer[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    const toolCount = record.toolCount
    observed.push({
      id,
      status: coerceObservedStatus(record.status),
      // Guarded on the NUMBER rather than on truthiness: `0` is a server that connected and
      // exposed nothing, which is the single most useful count on this field and the one a
      // truthiness check would silently turn into "not counted".
      ...(typeof toolCount === 'number' && Number.isFinite(toolCount) && toolCount >= 0
        ? { toolCount }
        : {}),
    })
  }
  return observed.length ? observed : null
}

/** Narrow a reported status onto the closed vocabulary, defaulting to `unknown`. */
function coerceObservedStatus(raw: unknown): ToolServerObservedStatus {
  return isToolServerObservedStatus(raw) ? raw : 'unknown'
}

/**
 * Whether an incoming observation says the same thing as the one already recorded, so an idle
 * poll re-offering the CLI's one announcement does not churn storage or the event stream. Ordered
 * comparison, because the producer emits the CLI's own order and re-emits it unchanged.
 */
function sameObservation(
  previous: readonly ObservedToolServer[] | undefined,
  next: readonly ObservedToolServer[],
): boolean {
  if (!previous || previous.length !== next.length) return false
  return previous.every((server, index) => {
    const other = next[index]!
    return (
      server.id === other.id &&
      server.status === other.status &&
      server.toolCount === other.toolCount
    )
  })
}
