// The FILES a pass leaves in its state directory, and which passes a directory holds.
//
// One module owns the layout because three readers need it and each spelled it out for itself: the
// ledger (`ledger.ts`), the journal (`journal.ts`), and whatever command a suite gives an operator
// to ask where a pass got to, which built both paths a third time. A fourth spelling is a pass an
// operator cannot find.
//
// It knows the NAMES and the write times, never the contents: `ledger.ts` reads a ledger and a
// suite's own status reduction reads a journal. That separation is what lets `findMostRecentPass`
// answer for a pass which recorded no fact at all, and that pass is the common one: an attempt a
// prerequisite refused writes a journal saying why and never opens a ledger.
//
// **A pass's identity is its FILE NAME.** The run id inside a ledger is a copy of it, so the two can
// disagree only through a copied or renamed file, and every reader here takes the name. What the
// contents say when they disagree is `LedgerStore`'s business, and it refuses.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const LEDGER_SUFFIX = '.json'
const JOURNAL_SUFFIX = '.journal.jsonl'

/**
 * The pointer to the most recent pass that CREATED something, so a resume asked for as `latest` has
 * something to resolve.
 *
 * A pointer rather than a default: resuming stays an EXPLICIT act. A suite that silently picked up
 * the previous pass would turn "run the acceptance suite" into "continue whatever half-built thing
 * is lying around", and the ledger's whole value is that a resume is something an operator chose
 * after reading why the last one stopped.
 *
 * Written on the first FACT rather than when a pass opens its ledger. The two differ for exactly the
 * pass that creates nothing, and that pass is the common one: a fresh attempt refused by a
 * prerequisite. Pointed at on OPEN, it overwrote the pointer to the half-built pass whose leftover
 * services are why the refusal fired, so the `latest` the refusal itself printed
 * resolved to an empty ledger and the pass holding the work became reachable only by an id nobody
 * had written down. A pass that died mid-run is unaffected: it recorded its task before starting it.
 *
 * So this pointer answers "what is worth RESUMING", which is a different question from "what ran
 * last" ({@link findMostRecentPass}). Keep them apart: conflating them is the bug above in the other
 * direction, where the attempt an operator is asking about is the one the report cannot reach.
 */
const LATEST_POINTER = 'latest.json'

/**
 * Where a pass keeps its ledger and journal, with a relative path resolved against a base a SUITE
 * chooses.
 *
 * Called ONCE, by whoever resolves the configuration, and every reader below then takes the
 * absolute answer. That is the seam that lets a suite anchor its state directory on its own package
 * (which is where an operator's configuration file lives) while this kit, which has no package of
 * its own to speak of, stays out of the decision: resolved against the kit's install path, a
 * relative `.acceptance` would land inside `node_modules`.
 *
 * Idempotent, so passing an already-resolved directory back through it is a no-op rather than a
 * second join.
 */
export function resolveStateDir(stateDir: string, baseDir: string): string {
  return isAbsolute(stateDir) ? stateDir : join(baseDir, stateDir)
}

/** Where the `latest` pointer lives, for the refusal that has to name the file it read. */
export function latestPointerPath(stateDir: string): string {
  return join(stateDir, LATEST_POINTER)
}

/** One pass's files, resolved together so no caller re-spells a suffix. */
export type PassPaths = {
  dir: string
  runId: string
  ledgerPath: string
  journalPath: string
}

export function passPaths(stateDir: string, runId: string): PassPaths {
  return {
    dir: stateDir,
    runId,
    ledgerPath: join(stateDir, `${runId}${LEDGER_SUFFIX}`),
    journalPath: join(stateDir, `${runId}${JOURNAL_SUFFIX}`),
  }
}

export type PassOnDisk = PassPaths & {
  /** Epoch ms of the later of the two files, i.e. when this pass last did anything. */
  lastWrittenAt: number
}

/**
 * Every pass the state directory holds, sorted by run id.
 *
 * A pass counts when EITHER file exists, because the two answer different questions and a pass
 * routinely has only one: a refused attempt has a journal and no ledger, and a ledger whose journal
 * was pruned is still resumable.
 */
export function listPasses(stateDir: string): readonly PassOnDisk[] {
  let entries: readonly string[]
  try {
    entries = readdirSync(stateDir)
  } catch {
    // silent-catch-ok: no state directory is the normal state before any pass has run.
    return []
  }
  const runIds = new Set<string>()
  for (const name of entries) {
    if (name === LATEST_POINTER) continue
    // The journal is tested first: `.jsonl` does not end with `.json`, but reading the suffixes in
    // the other order still invites the next reader to assume it does.
    const runId = name.endsWith(JOURNAL_SUFFIX)
      ? name.slice(0, -JOURNAL_SUFFIX.length)
      : name.endsWith(LEDGER_SUFFIX)
        ? name.slice(0, -LEDGER_SUFFIX.length)
        : ''
    if (runId) runIds.add(runId)
  }
  return [...runIds].sort().map((runId) => {
    const paths = passPaths(stateDir, runId)
    return {
      ...paths,
      lastWrittenAt: Math.max(mtimeOf(paths.ledgerPath), mtimeOf(paths.journalPath)),
    }
  })
}

/**
 * The pass that ran most recently, whether or not it created anything: what a suite's status report
 * answers when an operator names no run id.
 *
 * NOT the `latest` pointer, deliberately. That names the pass worth RESUMING, and the pass someone
 * asks a status report about is the attempt they just watched fail, which is by construction the one that
 * recorded no fact and therefore never claimed the pointer. Reported through the pointer, a first
 * refused attempt answered "no acceptance pass found" while its journal sat in the directory being
 * read, and a later one silently rendered an older pass as if it were the attempt that just failed.
 *
 * By WRITE TIME rather than by the highest id: a minted id is a timestamp and sorts chronologically,
 * but a hand-named one ("friday-rerun") sorts nowhere, and this is the reading whose whole job is to
 * find the pass an operator did not write down. Ties keep the lower id, which only a directory
 * touched by something other than a pass can produce.
 */
export function findMostRecentPass(stateDir: string): string | null {
  const passes = listPasses(stateDir)
  const newest = passes.reduce<PassOnDisk | null>(
    (best, pass) => (best === null || pass.lastWrittenAt > best.lastWrittenAt ? pass : best),
    null,
  )
  return newest?.runId ?? null
}

/** The `latest` pointer FILE and what it names, or null when there is no such file. */
export type LatestPointer = {
  path: string
  /** The pass it resolves to, or null when the file is malformed or names nothing. */
  runId: string | null
}

/**
 * The `latest` pointer as it stands on disk.
 *
 * Three states rather than two, which is why this is not {@link readLatestRunId} with a path
 * bolted on: no pointer at all, a pointer naming a pass, and a pointer naming NOTHING (malformed,
 * hand-edited, or left behind by a ledger someone removed). A resume treats the last two alike and
 * is right to; a CLEANUP does not, because a dangling pointer is exactly the file that outlives
 * every pass in the directory and then resolves a `latest` resume onto a state directory
 * with no ledgers at all. Collapsing "absent" into it would have the reset announce removing a
 * file that was never there.
 */
export function readLatestPointer(stateDir: string): LatestPointer | null {
  const path = latestPointerPath(stateDir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // silent-catch-ok: no pointer is the normal state before any pass has recorded a fact.
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const runId = (parsed as { runId?: unknown } | null)?.runId
    return { path, runId: typeof runId === 'string' && runId.length > 0 ? runId : null }
  } catch {
    // silent-catch-ok: a malformed pointer is discarded, exactly as a malformed ledger is.
    return { path, runId: null }
  }
}

/** The run id the most recent pass to record a fact wrote, or null. Total: unreadable is "none". */
export function readLatestRunId(stateDir: string): string | null {
  return readLatestPointer(stateDir)?.runId ?? null
}

/**
 * Point `latest` at a pass, naming the ledger it resolves to.
 *
 * Takes the one `PassPaths` rather than an id and a path, so the two halves are structurally
 * incapable of disagreeing. Written from the pass's OWN identity: filled from a ledger's contents
 * instead, a copied file would point `latest` at a run id whose ledger is elsewhere, and the resume
 * it advertises would start empty and re-scaffold both repositories.
 */
export function writeLatestPointer(paths: PassPaths): void {
  writeFileSync(
    latestPointerPath(paths.dir),
    `${JSON.stringify({ runId: paths.runId, ledger: paths.ledgerPath }, null, 2)}\n`,
    'utf8',
  )
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    // silent-catch-ok: a pass may have written only one of the two files; an absent one has no time.
    return 0
  }
}
