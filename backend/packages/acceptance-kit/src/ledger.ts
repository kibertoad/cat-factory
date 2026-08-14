// The LEDGER: what earlier scenarios in this pass already built.
//
// Why a file rather than module state: one full pass costs real model spend and the better part of
// an afternoon, and the scenarios form a chain (the one that files a bug is filing it against the
// feature an earlier one shipped into the repository a third one scaffolded). A crash late in that
// chain must not mean re-doing every step before it. So each scenario RECORDS what it created and
// each one starts by asking whether its own output already exists; a re-run against the same run id
// resumes at the first unfinished step.
//
// It is deliberately a dumb append-of-facts, not a state machine. The authority on what exists is
// the deployment, and every scenario re-reads it (the ledger holds ids, never statuses); the
// ledger's only job is to remember which ids to re-read.
//
// **What a ledger HOLDS is the suite's own type**, which is why this module is generic over it: the
// facts one pass records are the services it adopted, the runs it drove and the issue it filed, and
// no kit can enumerate those for a deployment testing its own agent kinds. What the kit owns is the
// part every ledger needs and every suite otherwise re-invents: the synchronous write, the identity
// rule, the `latest` pointer, and the reading of "has this pass created anything at all".
//
// This file owns what a ledger SAYS. Where it lives and which passes a state directory holds are
// `passFiles.ts`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { OperatorRefusal } from './operatorText.js'
import {
  latestPointerPath,
  listPasses,
  type PassPaths,
  passPaths,
  readLatestRunId,
  writeLatestPointer,
} from './passFiles.js'
import type { SuiteIdentity } from './suiteIdentity.js'

/**
 * The one field the kit requires of a suite's ledger: the pass it belongs to.
 *
 * A copy of the FILE NAME, which is what makes a disagreement between the two detectable at all
 * (see {@link LedgerStore}).
 */
export type LedgerFacts = {
  runId: string
}

/**
 * What each ledger slot IS, which is the question `recordsFacts` turns on.
 *
 * `created` is a thing that exists outside this process because the pass made it: a board service,
 * a run, an issue on a provider. `bookkeeping` is anything else the ledger carries about the pass
 * itself, which is evidence of nothing having been created.
 */
export type LedgerSlot = 'created' | 'bookkeeping'

/**
 * A suite's classification of its OWN ledger, exhaustive over it by construction.
 *
 * The type is the enforcement, and the whole point of naming it: a suite declares its table with
 * `satisfies LedgerSlots<Facts>` and a field added to the ledger then fails to compile until it has
 * been classified. Typed loosely (`Record<string, LedgerSlot>`) the omission is silent and lands on
 * the reading that matters least often and costs most: an unclassified `created` slot makes a pass
 * that adopted two services and opened three pull requests answer "created nothing", which is the
 * closing words telling that operator there is nothing to inspect and nothing to resume.
 *
 * `runId` is excluded because it is the pass's own name rather than something the pass created.
 */
export type LedgerSlots<Facts extends LedgerFacts> = Readonly<
  Record<Exclude<keyof Facts, 'runId'>, LedgerSlot>
>

/**
 * Whether a pass has recorded a FACT: anything at all on the deployment or on a provider.
 *
 * The one rule behind two answers that must never disagree. A status report uses it to decide
 * whether the pass it is reporting on is worth resuming, and the pass itself uses it to decide what
 * its closing words may claim: "everything it created is still there to inspect" is instructions for
 * an operator whose run is half-finished, and a lie to the far commoner one whose attempt a
 * prerequisite refused before anything was created. It is also the rule the `latest` pointer
 * follows, which is why a refused attempt never claims it.
 *
 * The CLASSIFICATION is the suite's, declared as a table over its own ledger type, because scanning
 * the whole object instead reads every non-null value as a created thing. That is right for a ledger
 * of ids and wrong the moment one carries something that is not one: a `startedAt` or a `notes`
 * would compile, pass every test, and from then on report EVERY pass (a fresh attempt a prerequisite
 * refused included) as having created something. {@link LedgerSlots} is what makes that structural
 * rather than a convention: a field added to the ledger fails to compile until it is classified.
 *
 * `!= null` rather than `!== null`: a slot a hand-edited ledger left `undefined` is an absent
 * record, and reading it as a present one is the same lie in the same direction.
 */
export function recordsFacts<Facts extends LedgerFacts>(
  facts: Facts,
  slots: LedgerSlots<Facts>,
): boolean {
  // Read as a plain table in HERE: the parameter type is what makes the caller's classification
  // exhaustive, and from inside a generic there are no known keys for TypeScript to narrow to.
  const table = slots as Readonly<Record<string, LedgerSlot>>
  return Object.keys(table).some(
    (key) => table[key] === 'created' && facts[key as keyof Facts] != null,
  )
}

/**
 * The run id for this pass: the identity's own variable when set, else a fresh one.
 *
 * **Resolved ONCE per pass**, before a scenario exists, and handed to whatever builds the harness.
 * Never called from a scenario: it is the KEY to the ledger the scenarios pass facts through, so a
 * pass has exactly one or it has none. Resolved per scenario (which is what a per-file test runner
 * forces), five scenarios open five ledgers a second apart, the second cannot read what the first
 * adopted, and the pass leaves five journals for a status report to pick one of.
 *
 * Setting it is how a re-run RESUMES rather than starting a second pass. The literal `latest`
 * resolves through the pointer the previous pass wrote, because the id an operator needs is
 * otherwise recoverable only from the stdout of the run that just died: `latest` is what makes
 * "resume the thing that broke" a command someone can type from memory at 9am.
 *
 * An absent or unreadable pointer with `latest` asked for is a REFUSAL rather than a fresh pass.
 * The two are opposite intents, and silently starting a new one would spend an afternoon of real
 * model money for an operator who asked to continue.
 */
export function resolveRunId(
  env: Readonly<Record<string, string | undefined>>,
  stateDir: string,
  identity: SuiteIdentity,
): string {
  const pinned = env[identity.runIdVariable]?.trim()
  if (pinned && pinned !== 'latest') return pinned
  if (pinned === 'latest') {
    const latest = readLatestRunId(stateDir)
    if (latest) return latest
    throw new OperatorRefusal(
      `${identity.runIdVariable}=latest, but ${latestPointerPath(stateDir)} names no previous ` +
        `pass. Name a run id explicitly, or unset ${identity.runIdVariable} to start a new pass ` +
        `(which creates real state and spends real money).`,
    )
  }
  // Seconds granularity, no separators: it names this pass's ledger and journal files, so it has
  // to be safe in a filename on every platform an operator runs this from.
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/** One OTHER pass on disk, and which of the asked-about things its ledger names. */
export type PassOwnership = {
  runId: string
  /** The subset of the asked-about ids this pass holds, in the order they were asked about. */
  ids: readonly string[]
}

/**
 * The OTHER passes whose ledgers name any of these ids, and which ones each holds.
 *
 * What turns "a leftover thing is in the way" into an instruction: the pass to resume is a run id,
 * and the only place that mapping exists is the ledgers on disk. Without it a refusal can only offer
 * `latest`, which is the wrong pass as soon as anything ran after the one holding the work.
 *
 * Per-pass rather than a flat list of ids, because leftovers routinely span TWO passes and no single
 * resume continues both. Told only that "A and B name it", a remedy can suggest resuming one, which
 * leaves the other's leftovers in the way and earns the same refusal on the next attempt. Told WHICH
 * one each holds, it can say what resuming one leaves behind.
 *
 * `holds` is the suite's: only it knows which of its ledger's ids are the ones being asked about.
 *
 * Sorted by run id, which orders them chronologically for a minted id (a timestamp) and arbitrarily
 * for a hand-named one; a caller names every match rather than picking one, so the order is
 * presentation.
 */
export function findPassesNaming<Facts extends LedgerFacts>(options: {
  stateDir: string
  ids: readonly string[]
  /** The pass asking, which is never one of the answers. */
  exclude: string
  coerce: (value: unknown) => Facts | null
  holds: (facts: Facts) => readonly string[]
}): readonly PassOwnership[] {
  const { stateDir, ids, exclude, coerce, holds } = options
  if (ids.length === 0) return []
  return listPasses(stateDir)
    .filter((pass) => pass.runId !== exclude)
    .flatMap((pass) => {
      const facts = readLedger(pass.ledgerPath, coerce)
      // A pass's identity is its FILE NAME, and `LedgerStore` refuses a ledger that disagrees. One
      // that does is therefore not a resume target: offering its stated id would name a pass whose
      // own ledger is elsewhere or gone, and the resume would start empty.
      if (!facts || facts.runId !== pass.runId) return []
      const ledgerIds = new Set(holds(facts))
      const held = [...new Set(ids)].filter((wanted) => ledgerIds.has(wanted))
      return held.length > 0 ? [{ runId: pass.runId, ids: held }] : []
    })
}

/**
 * One pass's ledger on disk: read at open, merged in fact by fact, written whole every time.
 *
 * Generic over the suite's own fact type, with the two functions no kit can supply passed in: what
 * an EMPTY ledger is, and how to narrow parsed JSON back into one.
 */
export class LedgerStore<Facts extends LedgerFacts> {
  readonly #paths: PassPaths
  #facts: Facts

  /** The suite, for the one message this store raises that offers a way forward: see `require`. */
  readonly #identity: SuiteIdentity | undefined

  /**
   * Open this pass's ledger, or refuse when the file on disk belongs to a different pass.
   *
   * The pass's identity is the one passed in here: it names the file, the pointer this store writes
   * and every message it raises. A ledger's own `runId` field is a copy of it, so a disagreement can
   * only come from a file that was copied or renamed, and NEITHER answer to it is safe to guess.
   * Adopting the contents files this pass's work under records another pass created; discarding them
   * overwrites a ledger somebody may be the last copy of.
   */
  constructor(options: {
    stateDir: string
    runId: string
    empty: (runId: string) => Facts
    coerce: (value: unknown) => Facts | null
    /** Named so a read that is too early can say how a pass that got further is resumed. */
    identity?: SuiteIdentity
  }) {
    const { stateDir, runId, empty, coerce } = options
    this.#identity = options.identity
    this.#paths = passPaths(stateDir, runId)
    mkdirSync(this.#paths.dir, { recursive: true })
    const stored = readLedger(this.#paths.ledgerPath, coerce)
    if (stored && stored.runId !== runId) {
      throw new OperatorRefusal(
        `The ledger at ${this.#paths.ledgerPath} says it belongs to pass '${stored.runId}', not ` +
          `'${runId}'. A pass is identified by its FILE NAME, so this one was copied or renamed. ` +
          `Rename it back to '${stored.runId}.json' and resume that pass, or move it aside to let ` +
          `'${runId}' start clean.`,
      )
    }
    this.#facts = stored ?? empty(runId)
  }

  get path(): string {
    return this.#paths.ledgerPath
  }

  get dir(): string {
    return this.#paths.dir
  }

  get value(): Facts {
    return this.#facts
  }

  /**
   * Merge a fact in and persist immediately.
   *
   * Written synchronously and in full on every patch: the process this is protecting against is
   * one that dies mid-run, and a batched or deferred write is precisely the one that loses the id
   * of the pull request nobody can now find.
   */
  patch(patch: Partial<Facts>): Facts {
    this.#facts = { ...this.#facts, ...patch }
    writeFileSync(this.#paths.ledgerPath, `${JSON.stringify(this.#facts, null, 2)}\n`, 'utf8')
    // The pointer rides every patch rather than the first one: there is no first-write flag to keep
    // right across the several processes that open one pass's ledger, and re-stating a pointer to
    // the pass that is writing anyway costs one small synchronous write per fact recorded. It is
    // written from this store's OWN identity, never from what the ledger says (see the constructor).
    writeLatestPointer(this.#paths)
    return this.#facts
  }

  /**
   * Patch ONE record, chosen at runtime.
   *
   * Exists so a caller holding a key in a variable (two runs that are the same code with different
   * ledger slots) does not have to widen its own patch to do it. Built by assignment rather than as
   * a computed-key literal, which is the shape TypeScript can check: a `{ [key]: value }` literal
   * widens to `{ [x: string]: … }` and needs a cast to become a `Partial<Facts>` at all.
   */
  set<K extends keyof Facts>(key: K, value: Facts[K]): Facts {
    const patch: Partial<Facts> = {}
    patch[key] = value
    return this.patch(patch)
  }

  /** Read a required record, failing with what to re-run rather than a null dereference. */
  require<K extends keyof Facts>(key: K): NonNullable<Facts[K]> {
    const value = this.#facts[key]
    if (value === null || value === undefined) {
      const resume = this.#identity
        ? `set ${this.#identity.runIdVariable} to a pass that got further`
        : 'resume a pass that got further'
      throw new Error(
        `The ledger has no '${String(key)}' for run ${this.#paths.runId}. The scenario that ` +
          `records it has not passed yet. Run the suite from the start, or ${resume}. ` +
          `Ledger: ${this.#paths.ledgerPath}`,
      )
    }
    return value as NonNullable<Facts[K]>
  }
}

/**
 * Read a ledger, treating an unreadable or malformed one as ABSENT.
 *
 * A ledger is a cache of ids, so the cost of ignoring a corrupt one is a fresh pass rather than
 * wrong state, and refusing to start because a JSON file has a stray byte would be the worse
 * failure.
 */
export function readLedger<Facts extends LedgerFacts>(
  path: string,
  coerce: (value: unknown) => Facts | null,
): Facts | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // silent-catch-ok: an absent ledger is the normal first-run state, not a condition to report.
    return null
  }
  try {
    return coerce(JSON.parse(raw))
  } catch {
    // silent-catch-ok: a malformed ledger is discarded by design (see the doc comment above).
    return null
  }
}
