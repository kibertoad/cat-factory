// The PROGRESS JOURNAL: an append-only record of what this pass has done so far.
//
// The suite already narrates itself to stdout, and stdout is the wrong place for the question an
// operator actually has. A pass runs for an afternoon in a terminal nobody is watching, and the
// questions that follow are asked from somewhere else: which spec is it on, how long has the
// coder been working, did the backend feature merge, is it worth waiting or is it wedged. A
// scrollback buffer answers none of those from another window, and answers none of them at all
// once the terminal is gone.
//
// So every observation the suite makes is ALSO appended here as one JSON line, beside the ledger
// and keyed by the same run id. `status.ts` reduces the file into an answer; `world.ts` remains
// the record of what EXISTS, which is a different question with a different lifetime (the ledger
// is re-read to resume, the journal is only ever read by a human).
//
// **A journal write may never break a pass.** It is a reporting side channel, so a full disk or
// a read-only state directory costs the observation and not the hour-long run that produced it.
// The failure is reported once and then the suite carries on.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** What kind of thing happened. Bounded, because `status.ts` reduces on it. */
export type JournalEventKind =
  | 'phase-started'
  | 'phase-finished'
  | 'prerequisite'
  | 'milestone'
  | 'observation'
  | 'failure'

export type JournalEvent = {
  /** Epoch ms. The only clock the status reduction has. */
  at: number
  /** The spec file this came from, e.g. `02-feature-with-defect`. */
  phase: string
  kind: JournalEventKind
  message: string
}

/**
 * Append-only writer for one pass.
 *
 * Synchronous and unbuffered, for the same reason the ledger is: the process this is written for
 * is one that dies, and a buffered journal loses precisely the last observation, which is the one
 * that says what it died doing.
 */
export class Journal {
  readonly #path: string
  #phase: string
  #broken = false

  constructor(stateDir: string, runId: string, phase = 'suite') {
    this.#path = join(stateDir, `${runId}.journal.jsonl`)
    this.#phase = phase
  }

  get path(): string {
    return this.#path
  }

  /** Bind subsequent events to a spec. Returned so a caller can restore the previous one. */
  enterPhase(phase: string): string {
    const previous = this.#phase
    this.#phase = phase
    this.record('phase-started', `entered ${phase}`)
    return previous
  }

  finishPhase(message: string): void {
    this.record('phase-finished', message)
  }

  record(kind: JournalEventKind, message: string): void {
    this.#append({ at: Date.now(), phase: this.#phase, kind, message })
  }

  /**
   * Record AND print. The two channels carry the same words on purpose: a live watcher and a
   * later reader should never be reconstructing different stories, and one call site cannot
   * drift the way a `console.log` beside a `record` does.
   */
  say(kind: JournalEventKind, message: string): void {
    this.record(kind, message)
    console.log(`  ${message}`)
  }

  #append(event: JournalEvent): void {
    if (this.#broken) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      appendFileSync(this.#path, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      // Deliberately not silent, and deliberately not fatal (see the header). Latched so a
      // read-only state directory reports once rather than once per poll for an hour.
      this.#broken = true
      console.warn(
        `  warning: the progress journal at ${this.#path} could not be written, so this pass ` +
          `will not be watchable with 'pnpm run status': ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Read a journal back, skipping any line that is not a well-formed event.
 *
 * Tolerant by design: the file is appended to by a process that can be killed mid-line, so a
 * truncated tail is an ordinary state rather than a corruption to refuse. Exported for
 * `status.ts` and pinned by `test/journal.test.ts`.
 */
export function readJournal(path: string): readonly JournalEvent[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // silent-catch-ok: no journal is the normal state before a pass has written one.
    return []
  }
  const events: JournalEvent[] = []
  for (const line of raw.split('\n')) {
    const event = coerceEvent(line)
    if (event) events.push(event)
  }
  return events
}

function coerceEvent(line: string): JournalEvent | null {
  if (!line.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // silent-catch-ok: a half-written final line is expected of an append-only file (see above).
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (
    typeof record.at !== 'number' ||
    typeof record.phase !== 'string' ||
    typeof record.kind !== 'string' ||
    typeof record.message !== 'string'
  ) {
    return null
  }
  return {
    at: record.at,
    phase: record.phase,
    kind: record.kind as JournalEventKind,
    message: record.message,
  }
}
