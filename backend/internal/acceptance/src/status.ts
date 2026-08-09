// "Where is this pass?", answered from the two files a pass leaves behind.
//
// This is the read side of `journal.ts` and `world.ts`, and it exists because the question is
// asked from OUTSIDE the process doing the work: from another terminal while a run is going, or
// the next morning after one died. It reduces the ledger (what exists) and the journal (what
// happened) into one report, and it is a pure function of both plus a clock so
// `test/status.test.ts` can pin the reduction rather than the formatting.
//
// The one judgement it makes is IDLENESS. A pass that has recorded nothing for twenty minutes
// while its poll interval is ten seconds is not slow, it is dead or detached, and the difference
// between "still working" and "nothing has written here since 14:07" is the whole reason someone
// runs this.

import type { JournalEvent } from './journal.ts'
import type { RunRecord, ServiceRecord, World } from './world.ts'

export type PhaseStatus = {
  phase: string
  /** When the phase was last ENTERED, so a resumed pass measures this attempt and not the gap. */
  startedAt: number
  /** The `phase-finished` message when that was the phase's last word, else null. */
  finished: string | null
  /** The most recent event of any kind, which is what says whether it is moving. */
  lastMessage: string
  lastAt: number
}

export type PassStatus = {
  runId: string
  ledgerPath: string
  journalPath: string
  phases: readonly PhaseStatus[]
  services: readonly { role: string; record: ServiceRecord }[]
  runs: readonly { role: string; record: RunRecord }[]
  /** In-flight bootstraps: started, not yet seen to produce a service. */
  pendingBootstraps: readonly { role: string; jobId: string }[]
  /** Since the last journal line. Null when the journal is empty. */
  idleMs: number | null
}

export function summarisePass(input: {
  world: World
  events: readonly JournalEvent[]
  ledgerPath: string
  journalPath: string
  now: number
}): PassStatus {
  const { world, events, now } = input
  const last = events.at(-1)
  return {
    runId: world.runId,
    ledgerPath: input.ledgerPath,
    journalPath: input.journalPath,
    phases: reducePhases(events),
    services: collect(world, ['backend', 'frontend'] as const),
    runs: collect(world, ['featureBackend', 'featureFrontend', 'bugfix'] as const),
    pendingBootstraps: (['backend', 'frontend'] as const).flatMap((role) =>
      world.bootstrapJobs[role] ? [{ role, jobId: world.bootstrapJobs[role] }] : [],
    ),
    idleMs: last ? Math.max(0, now - last.at) : null,
  }
}

/**
 * One entry per phase, in the order the phases were first seen.
 *
 * Grouped rather than keyed on the `phase-started` event, because a journal is routinely read
 * mid-write and while a pass is resuming: a phase whose start line is in an earlier pass's tail
 * still has observations worth showing, and dropping it would report a working spec as absent.
 *
 * The journal accumulates across every attempt at one run id, so a phase is routinely entered
 * more than once and routinely goes on after finishing (spec 02 finishes a phase per service).
 * Two rules keep the report about NOW rather than about the file:
 *
 *   - **`phase-started` re-opens the phase**, re-anchoring `startedAt`. Left at the first entry,
 *     the elapsed time a resumed pass shows spans the night between two attempts, which answers
 *     nothing anyone asks of it.
 *   - **`finished` is the phase's LAST word, not a latch.** A phase that finished and then wrote
 *     again is still working, and rendering it `done` beside a message from before the resume is
 *     the one reading that sends someone away believing the spec passed.
 */
function reducePhases(events: readonly JournalEvent[]): readonly PhaseStatus[] {
  const byPhase = new Map<string, PhaseStatus>()
  for (const event of events) {
    const existing = byPhase.get(event.phase)
    const finished = event.kind === 'phase-finished' ? event.message : null
    // `Map.set` on a key it already holds keeps the original insertion order, so re-entering a
    // phase re-anchors it without reordering the report.
    if (!existing || event.kind === 'phase-started') {
      byPhase.set(event.phase, {
        phase: event.phase,
        startedAt: event.at,
        finished,
        lastMessage: event.message,
        lastAt: event.at,
      })
      continue
    }
    existing.lastMessage = event.message
    existing.lastAt = event.at
    existing.finished = finished
  }
  return [...byPhase.values()]
}

function collect<K extends keyof World>(
  world: World,
  keys: readonly K[],
): readonly { role: string; record: NonNullable<World[K]> }[] {
  return keys
    .map((key) => ({ role: String(key), record: world[key] }))
    .filter(
      (entry): entry is { role: string; record: NonNullable<World[K]> } => entry.record !== null,
    )
}

/** Render the report. Separate from the reduction so the shape can be asserted without the prose. */
export function formatPassStatus(
  status: PassStatus,
  formatDuration: (ms: number) => string,
): string {
  const lines: string[] = [
    `acceptance pass ${status.runId}`,
    `  ledger:  ${status.ledgerPath}`,
    `  journal: ${status.journalPath}`,
    '',
  ]

  if (status.phases.length === 0) {
    lines.push('No progress recorded yet: this pass has written no journal lines.')
  } else {
    lines.push('Phases')
    for (const phase of status.phases) {
      const state = phase.finished ? `done: ${phase.finished}` : `open, last: ${phase.lastMessage}`
      lines.push(`  ${phase.phase}  (${formatDuration(phase.lastAt - phase.startedAt)})  ${state}`)
    }
  }

  if (status.pendingBootstraps.length > 0) {
    lines.push('', 'Bootstraps started but not settled')
    for (const entry of status.pendingBootstraps) {
      lines.push(`  ${entry.role}: job ${entry.jobId}`)
    }
  }

  if (status.services.length > 0) {
    lines.push('', 'Services')
    for (const { role, record } of status.services) {
      lines.push(
        `  ${role}: ${record.repoName} → frame ${record.blockId} ${record.repoUrl ?? ''}`.trimEnd(),
      )
    }
  }

  if (status.runs.length > 0) {
    lines.push('', 'Runs')
    for (const { role, record } of status.runs) {
      const run = record.runId ? `run ${record.runId}` : 'not started'
      const pr = record.pullRequestUrl ? ` ${record.pullRequestUrl}` : ''
      lines.push(`  ${role}: task ${record.taskId}, ${run}${pr}`)
    }
  }

  if (status.idleMs !== null) {
    // Deliberately stated for every pass rather than only a stale one: "last wrote 8s ago" is the
    // answer to "is it alive", and a line that appears only when something is wrong makes its
    // absence carry a meaning nobody can see.
    lines.push('', `Last journal line ${formatDuration(status.idleMs)} ago.`)
  }
  lines.push('', `Resume with: ACCEPTANCE_RUN_ID=${status.runId} pnpm run acceptance`)
  return lines.join('\n')
}
