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
import { resumeInvocation } from './operatorText.ts'
import {
  type IssueRecord,
  recordsFacts,
  type RunRecord,
  type ServiceRecord,
  type World,
} from './world.ts'

/** Which pass a `status` invocation is about, or the reason there is none to report. */
export type StatusTarget =
  | { kind: 'pass'; runId: string }
  | { kind: 'none'; reason: 'latest-names-none' | 'no-pass' }

/**
 * Which pass to report on, from the argument, the environment and what is on disk.
 *
 * Three questions, and only the middle one is the `latest` pointer. NAMED, it is that pass; asked for
 * `latest`, it is the pass worth RESUMING (the most recent to record a fact); asked for nothing, it is
 * the pass that ran LAST, which is usually the attempt the reader just watched fail and which by
 * construction never claimed the pointer. Answered through the pointer, that reader was told "no
 * acceptance pass found" while the journal they were asking about sat in the directory named.
 *
 * **The ARGUMENT asks a question; the environment only PINS a default.** That asymmetry is the whole of
 * this function, and it is why `ACCEPTANCE_RUN_ID` is not simply read as a second argument. The
 * variable's job is to name the pass the next RUN resumes, and the README's platform-neutral way to
 * carry it is a line in the `.env` (which `configure` writes a note about), read here through the same
 * file the pass reads so the two cannot disagree about which pass is in play. But `ACCEPTANCE_RUN_ID=latest`
 * in that file used to convert the no-argument form into the pointer form for good, and the pointer
 * REFUSES when no pass has recorded a fact: an operator with a directory full of refused attempts and
 * a `latest` line in their `.env` got "'latest' names none" and exit 1 in answer to a question they
 * never asked. So an unresolvable pointer refuses only where the command line asked for one, and
 * otherwise falls through to the pass that ran last, which is what the bare form promises.
 */
export function resolveStatusTarget(input: {
  /** The positional argument, trimmed, `undefined` when nothing was named. */
  argument: string | undefined
  /** `ACCEPTANCE_RUN_ID`, same treatment. The resume target this checkout pins, not a question. */
  pinned: string | undefined
  /** What the `latest` pointer names: the most recent pass to record a FACT, or null. */
  latestRunId: string | null
  /** The pass that wrote to the state directory most recently, or null when it holds none. */
  mostRecentRunId: string | null
}): StatusTarget {
  const { argument, pinned, latestRunId, mostRecentRunId } = input
  if (argument === 'latest') {
    return latestRunId
      ? { kind: 'pass', runId: latestRunId }
      : { kind: 'none', reason: 'latest-names-none' }
  }
  if (argument !== undefined) return { kind: 'pass', runId: argument }
  if (pinned !== undefined && pinned !== 'latest') return { kind: 'pass', runId: pinned }
  const resolved = (pinned === 'latest' ? latestRunId : null) ?? mostRecentRunId
  return resolved ? { kind: 'pass', runId: resolved } : { kind: 'none', reason: 'no-pass' }
}

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
  /**
   * The issue scenario 04 filed on the provider, or null.
   *
   * Reported beside what the pass created ON the deployment because it is the one artifact this
   * suite leaves OUTSIDE it: a failed pass leaves an open issue on somebody's repository, and the
   * person tidying up after it needs the URL from here rather than from a dead terminal.
   */
  issue: IssueRecord | null
  /** Since the last journal line. Null when the journal is empty. */
  idleMs: number | null
  /** What a resume should name after reading this report. */
  resume: ResumeAdvice
}

/**
 * Which pass, if any, is worth resuming after reading this report.
 *
 * A discriminated result rather than a run id that is sometimes this pass's: the report an operator
 * reads most often is of a pass that created NOTHING (a fresh attempt a prerequisite refused), and
 * "resume this one" is the one instruction that must not be printed there. Resuming it starts over,
 * which is the afternoon of real spend the ledger exists to avoid.
 */
export type ResumeAdvice =
  /** This pass created something, so continuing it continues that work. */
  | { kind: 'this-pass'; runId: string }
  /** This pass created nothing; that one holds the work, and is what `latest` resolves to. */
  | { kind: 'another-pass'; runId: string }
  /** This pass created nothing and no pass on disk has, so a re-run starts clean either way. */
  | { kind: 'nothing-to-resume' }

export function summarisePass(input: {
  world: World
  events: readonly JournalEvent[]
  ledgerPath: string
  journalPath: string
  now: number
  /**
   * The run id the `latest` pointer names, or null.
   *
   * Supplied rather than read here so this stays a pure reduction over the two files a pass leaves,
   * and so the CLI has one place that touches the state directory.
   */
  latestRunId: string | null
}): PassStatus {
  const { world, events, now } = input
  const last = events.at(-1)
  const services = collect(world, ['backend', 'frontend'] as const)
  const runs = collect(world, [
    'scaffoldBackend',
    'scaffoldFrontend',
    'featureBackend',
    'featureFrontend',
    'bugfix',
    'issueDelivery',
  ] as const)
  return {
    runId: world.runId,
    ledgerPath: input.ledgerPath,
    journalPath: input.journalPath,
    phases: reducePhases(events),
    services,
    runs,
    issue: world.intakeIssue,
    idleMs: last ? Math.max(0, now - last.at) : null,
    // The same predicate the PASS itself closes with (`world.ts`), rather than the same rule
    // re-derived from the projections above: the two answers are read by one operator, minutes apart.
    resume: adviseResume(world.runId, recordsFacts(world), input.latestRunId),
  }
}

/**
 * The same rule the `latest` pointer follows, read back: a pass is resumable once it has recorded a
 * FACT, and the pointer names the most recent pass that did.
 *
 * The two are computed from different sources on purpose. This pass's records come from its own
 * ledger, which is the report's subject; the pointer is what the deployment-wide "resume the thing
 * that broke" resolves to. They agree for a pass that got somewhere, and their disagreement is
 * exactly the fact worth printing: the attempt being read did nothing, and the work is elsewhere.
 */
function adviseResume(
  runId: string,
  recordedFacts: boolean,
  latestRunId: string | null,
): ResumeAdvice {
  if (recordedFacts) return { kind: 'this-pass', runId }
  if (latestRunId && latestRunId !== runId) return { kind: 'another-pass', runId: latestRunId }
  return { kind: 'nothing-to-resume' }
}

/**
 * One entry per phase, in the order the phases were first seen.
 *
 * Grouped rather than keyed on the `phase-started` event, because a journal is routinely read
 * mid-write and while a pass is resuming: a phase whose start line is in an earlier pass's tail
 * still has observations worth showing, and dropping it would report a working scenario as absent.
 *
 * The journal accumulates across every attempt at one run id, so a phase is routinely entered
 * more than once and routinely goes on after finishing (scenario 02 finishes a phase per service).
 * Two rules keep the report about NOW rather than about the file:
 *
 *   - **`phase-started` re-opens the phase**, re-anchoring `startedAt`. Left at the first entry,
 *     the elapsed time a resumed pass shows spans the night between two attempts, which answers
 *     nothing anyone asks of it.
 *   - **`finished` is the phase's LAST word, not a latch.** A phase that finished and then wrote
 *     again is still working, and rendering it `done` beside a message from before the resume is
 *     the one reading that sends someone away believing the scenario passed.
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

  if (status.services.length > 0) {
    lines.push('', 'Services')
    for (const { role, record } of status.services) {
      lines.push(`  ${role}: ${record.repoName} → frame ${record.blockId}`)
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

  if (status.issue) {
    lines.push(
      '',
      'Reported issue (on the provider, not on the deployment)',
      `  ${status.issue.owner}/${status.issue.repo}#${status.issue.number}: ${status.issue.url}`,
    )
  }

  if (status.idleMs !== null) {
    // Deliberately stated for every pass rather than only a stale one: "last wrote 8s ago" is the
    // answer to "is it alive", and a line that appears only when something is wrong makes its
    // absence carry a meaning nobody can see.
    lines.push('', `Last journal line ${formatDuration(status.idleMs)} ago.`)
  }
  lines.push('', resumeLine(status.resume))
  return lines.join('\n')
}

function resumeLine(advice: ResumeAdvice): string {
  if (advice.kind === 'this-pass') return `Resume with: ${resumeInvocation(advice.runId)}`
  if (advice.kind === 'another-pass') {
    return (
      `This pass recorded nothing, so resuming it would start over. Pass ${advice.runId} is the ` +
      `most recent that created something: ${resumeInvocation(advice.runId)}`
    )
  }
  return 'This pass recorded nothing, and neither has any other pass here: a re-run starts clean.'
}
