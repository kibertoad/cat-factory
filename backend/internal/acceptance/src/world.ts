// The LEDGER: what previous scenarios in this acceptance run already built.
//
// Why a file rather than module state: one full pass costs real model spend and the better part
// of an afternoon, and the scenarios form a chain (03 files a bug against the feature 02 shipped
// into the repositories 01 scaffolded). A crash in 03 must not mean re-scaffolding two
// repositories and re-shipping a feature. So each one RECORDS what it created and each one
// starts by asking whether its own output already exists; a re-run against the same
// `ACCEPTANCE_RUN_ID` resumes at the first unfinished step.
//
// It is deliberately a dumb append-of-facts, not a state machine. The authority on what exists
// is the deployment, and every scenario re-reads it (the ledger holds ids, never statuses); the
// ledger's only job is to remember which ids to re-read.
//
// This file owns what a ledger SAYS. Where it lives, what else a pass leaves beside it and which
// passes a state directory holds are `passFiles.ts`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import {
  latestPointerPath,
  listPasses,
  type PassPaths,
  passPaths,
  readLatestRunId,
  writeLatestPointer,
} from './passFiles.ts'

/** One repository the suite adopted, and the board service frame backed by it. */
export type ServiceRecord = {
  /** The board block id of the service frame, which `/api/v1` addresses as a `serviceId`. */
  blockId: string
  /** The same frame as `/api/v1` names it. Identical value; both spellings appear in the scenarios. */
  serviceId: string
  /**
   * `owner/name`, as `GET /api/v1/repos` reports the adopted repository.
   *
   * There is no URL beside it, deliberately. Neither the repository list nor the service read
   * publishes one, and deriving `https://github.com/owner/name` here would hard-code the provider
   * this platform is explicitly neutral about (CLAUDE.md, "never re-hardcode GitHub"). A field that
   * could only ever hold null is worse than its absence.
   */
  repoName: string
}

/** One pipeline run the suite started, keyed by the task that owns it. */
export type RunRecord = {
  taskId: string
  runId: string | null
  pullRequestUrl: string | null
  /**
   * The decision kinds this suite answered on the run, accumulated across attempts.
   *
   * The one entry here that is not an id, and the exception is deliberate: every other field
   * names something the DEPLOYMENT can be re-asked about, but "the suite answered a
   * `clarity-review` gate over /api/v1" is a fact about what the suite DID, and a settled
   * decision is indistinguishable afterwards from one that never had to be made. Scenario 03 asserts
   * on it, so a resumed pass that adopts a finished run would otherwise report the human-gate
   * path as never exercised when it was exercised yesterday.
   */
  answeredKinds: readonly string[]
}

/**
 * The issue scenario 04 filed on the provider, as the reporter.
 *
 * The one thing a pass creates that is NOT on the deployment, which is why it is recorded with its
 * whole address rather than an id: nothing in `/api/v1` can hand it back, so a resumed pass that
 * lost this record would file a SECOND issue and deliver that instead, leaving the first open
 * forever with the platform's own comment on it.
 *
 * `provider` rides along because it decides which client can read the issue back (`vcsIssues.ts`),
 * and a workspace whose connection moved provider mid-pass must not be asked for a GitHub issue on
 * a GitLab host.
 */
export type IssueRecord = {
  provider: string
  owner: string
  repo: string
  number: number
  /** The canonical web URL: what was filed, and the `ticket.ref` the task was linked through. */
  url: string
}

export type World = {
  /** Groups everything one pass created, and names its ledger. */
  runId: string
  backend: ServiceRecord | null
  frontend: ServiceRecord | null
  /**
   * Scenario 01's two scaffold runs, one per service.
   *
   * Ordinary `pl_build` runs like scenario 02's, so they resume the same way rather than through a
   * bootstrap job id: a pass interrupted mid-scaffold re-attaches to the live run. Recorded
   * separately from `featureBackend`/`featureFrontend` because they are separate pull requests
   * against the same repository, and adopting one for the other would skip a whole phase.
   */
  scaffoldBackend: RunRecord | null
  scaffoldFrontend: RunRecord | null
  /**
   * Scenario 02, per service. Two records rather than one because the planted mismatch has two halves
   * and scenario 02 asserts the ephemeral-environment evidence of EACH: collapsing them would make
   * the second run's report unreadable, which is the one that carries the frontend's environment.
   */
  featureBackend: RunRecord | null
  featureFrontend: RunRecord | null
  /** Scenario 03: the bug report filed against the shipped feature. */
  bugfix: RunRecord | null
  /** Scenario 04: the issue filed on the provider, before any of it reached the platform. */
  intakeIssue: IssueRecord | null
  /** Scenario 04: the run that delivered that issue, filed as a task linked to it. */
  issueDelivery: RunRecord | null
}

export function emptyWorld(runId: string): World {
  return {
    runId,
    backend: null,
    frontend: null,
    scaffoldBackend: null,
    scaffoldFrontend: null,
    featureBackend: null,
    featureFrontend: null,
    bugfix: null,
    intakeIssue: null,
    issueDelivery: null,
  }
}

/**
 * The run id for this pass: `ACCEPTANCE_RUN_ID` when set, else a fresh one.
 *
 * **Resolved ONCE per pass**, by `src/runAcceptance.ts` before a scenario exists, and handed to
 * `buildHarness`. Never called from a scenario: it is the KEY to the ledger the scenarios pass facts
 * through, so a pass has exactly one or it has none. Under vitest that was a `globalSetup` hook
 * feeding an RPC channel, because a spec file was a module graph of its own and an id minted in one
 * was an id per FILE: five scenarios opened five ledgers a second apart, 02 could not read the
 * services 01 had just adopted, and the pass left five journals for `status` to pick one of.
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
): string {
  const pinned = env.ACCEPTANCE_RUN_ID?.trim()
  if (pinned && pinned !== 'latest') return pinned
  if (pinned === 'latest') {
    const latest = readLatestRunId(stateDir)
    if (latest) return latest
    throw new Error(
      `ACCEPTANCE_RUN_ID=latest, but ${latestPointerPath(stateDir)} names no ` +
        `previous pass. Name a run id explicitly, or unset ACCEPTANCE_RUN_ID to start a new pass ` +
        `(which scaffolds two repositories and spends real money).`,
    )
  }
  // Seconds granularity, no separators: it names this pass's ledger and journal files, so it has
  // to be safe in a filename on every platform an operator runs this from.
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/** One OTHER pass on disk, and which of the asked-about services its ledger names. */
export type PassOwnership = {
  runId: string
  /** The subset of the asked-about ids this pass holds, in the order they were asked about. */
  serviceIds: readonly string[]
}

/**
 * The OTHER passes whose ledgers name any of these services, and which ones each holds.
 *
 * What turns "a leftover frame is in the way" into an instruction: the pass to resume is a run id,
 * and the only place that mapping exists is the ledgers on disk. Without it a refusal can only offer
 * `latest`, which is the wrong pass as soon as anything ran after the one holding the work.
 *
 * Per-pass rather than a flat list of ids, because leftovers routinely span TWO passes and no single
 * resume continues both. Told only that "A and B name it", a remedy can suggest resuming one, which
 * leaves the other's service in the way and earns the same refusal on the next attempt. Told WHICH
 * service each holds, it can say what resuming one leaves behind.
 *
 * Sorted by run id, which orders them chronologically for a minted id (a timestamp) and arbitrarily
 * for a hand-named one; a caller names every match rather than picking one, so the order is
 * presentation.
 */
export function findPassesNaming(
  stateDir: string,
  serviceIds: readonly string[],
  exclude: string,
): readonly PassOwnership[] {
  if (serviceIds.length === 0) return []
  return listPasses(stateDir)
    .filter((pass) => pass.runId !== exclude)
    .flatMap((pass) => {
      const world = readWorld(pass.ledgerPath)
      // A pass's identity is its FILE NAME, and `WorldStore` refuses a ledger that disagrees. One
      // that does is therefore not a resume target: offering its stated id would name a pass whose
      // own ledger is elsewhere or gone, and the resume would start empty.
      if (!world || world.runId !== pass.runId) return []
      const ledgerIds = new Set(
        [world.backend, world.frontend].flatMap((service) => (service ? [service.serviceId] : [])),
      )
      const held = [...new Set(serviceIds)].filter((wanted) => ledgerIds.has(wanted))
      return held.length > 0 ? [{ runId: pass.runId, serviceIds: held }] : []
    })
}

export class WorldStore {
  readonly #paths: PassPaths
  #world: World

  /**
   * Open this pass's ledger, or refuse when the file on disk belongs to a different pass.
   *
   * The pass's identity is the one passed in here: it names the file, the pointer this store writes
   * and every message it raises. A ledger's own `runId` field is a copy of it, so a disagreement can
   * only come from a file that was copied or renamed, and NEITHER answer to it is safe to guess.
   * Adopting the contents files this pass's work under records another pass created; discarding them
   * overwrites a ledger somebody may be the last copy of.
   */
  constructor(stateDir: string, runId: string) {
    this.#paths = passPaths(stateDir, runId)
    mkdirSync(this.#paths.dir, { recursive: true })
    const stored = readWorld(this.#paths.ledgerPath)
    if (stored && stored.runId !== runId) {
      throw new Error(
        `The ledger at ${this.#paths.ledgerPath} says it belongs to pass '${stored.runId}', not ` +
          `'${runId}'. A pass is identified by its FILE NAME, so this one was copied or renamed. ` +
          `Rename it back to '${stored.runId}.json' and resume that pass, or move it aside to let ` +
          `'${runId}' start clean.`,
      )
    }
    this.#world = stored ?? emptyWorld(runId)
  }

  get path(): string {
    return this.#paths.ledgerPath
  }

  get dir(): string {
    return this.#paths.dir
  }

  get value(): World {
    return this.#world
  }

  /**
   * Merge a fact in and persist immediately.
   *
   * Written synchronously and in full on every patch: the process this is protecting against is
   * one that dies mid-run, and a batched or deferred write is precisely the one that loses the id
   * of the pull request nobody can now find.
   */
  patch(patch: Partial<World>): World {
    this.#world = { ...this.#world, ...patch }
    writeFileSync(this.#paths.ledgerPath, `${JSON.stringify(this.#world, null, 2)}\n`, 'utf8')
    // The pointer rides every patch rather than the first one: there is no first-write flag to keep
    // right across the several processes that open one pass's ledger, and re-stating a pointer to
    // the pass that is writing anyway costs one small synchronous write per fact recorded. It is
    // written from this store's OWN identity, never from what the ledger says (see the constructor).
    writeLatestPointer(this.#paths)
    return this.#world
  }

  /**
   * Patch ONE record, chosen at runtime.
   *
   * Exists so a caller holding a key in a variable (the two feature runs are the same code with
   * different ledger slots) does not have to widen its own patch to do it. The cast is contained
   * here and the signature is what makes it sound: `K` ties the key to the value's type, which a
   * computed-key object literal cannot express on its own.
   */
  set<K extends keyof World>(key: K, value: World[K]): World {
    return this.patch({ [key]: value } as Partial<World>)
  }

  /** Read a required record, failing with what to re-run rather than a null dereference. */
  require<K extends keyof World>(key: K): NonNullable<World[K]> {
    const value = this.#world[key]
    if (value === null || value === undefined) {
      throw new Error(
        `The ledger has no '${String(key)}' for run ${this.#paths.runId}. The scenario that records ` +
          `it has not passed yet. Run the suite from the start, or set ACCEPTANCE_RUN_ID to a ` +
          `pass that got further. Ledger: ${this.#paths.ledgerPath}`,
      )
    }
    return value as NonNullable<World[K]>
  }
}

/**
 * Whether this pass has recorded a FACT: anything at all on the deployment or the provider.
 *
 * The one rule behind two answers that must never disagree. `status` uses it to decide whether the
 * pass it is reporting on is the one worth resuming, and the pass itself uses it to decide what its
 * closing words may claim: "everything it created is still there to inspect" is instructions for an
 * operator whose run is half-finished, and a lie to the far commoner one whose attempt a prerequisite
 * refused before anything was created. It is also the rule the `latest` pointer follows, which is why
 * a refused attempt never claims it.
 *
 * Over every record rather than a named subset, so a ledger slot added later counts with no second
 * edit: the alternative is a new kind of work that a pass can create and then report as nothing.
 */
export function recordsFacts(world: World): boolean {
  return Object.entries(world).some(([key, value]) => key !== 'runId' && value !== null)
}

/**
 * Read a ledger, treating an unreadable or malformed one as ABSENT.
 *
 * A ledger is a cache of ids, so the cost of ignoring a corrupt one is a fresh pass rather than
 * wrong state, and refusing to start because a JSON file has a stray byte would be the worse
 * failure. It is separated out (and exported) so `test/world.test.ts` can pin that choice.
 */
export function readWorld(path: string): World | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // silent-catch-ok: an absent ledger is the normal first-run state, not a condition to report.
    return null
  }
  try {
    return coerceWorld(JSON.parse(raw))
  } catch {
    // silent-catch-ok: a malformed ledger is discarded by design (see the doc comment above).
    return null
  }
}

/** Narrow parsed JSON to a `World`, or null. Total, so a hand-edited ledger cannot crash a scenario. */
export function coerceWorld(value: unknown): World | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.runId !== 'string' || record.runId.length === 0) return null
  return {
    runId: record.runId,
    backend: coerceService(record.backend),
    frontend: coerceService(record.frontend),
    scaffoldBackend: coerceRun(record.scaffoldBackend),
    scaffoldFrontend: coerceRun(record.scaffoldFrontend),
    featureBackend: coerceRun(record.featureBackend),
    featureFrontend: coerceRun(record.featureFrontend),
    bugfix: coerceRun(record.bugfix),
    intakeIssue: coerceIssue(record.intakeIssue),
    issueDelivery: coerceRun(record.issueDelivery),
  }
}

function coerceIssue(value: unknown): IssueRecord | null {
  const record = asRecord(value)
  if (!record) return null
  const { provider, owner, repo, number, url } = record
  if (
    typeof provider !== 'string' ||
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof number !== 'number' ||
    typeof url !== 'string'
  ) {
    return null
  }
  return { provider, owner, repo, number, url }
}

function coerceService(value: unknown): ServiceRecord | null {
  const record = asRecord(value)
  if (!record) return null
  const { blockId, serviceId, repoName } = record
  if (
    typeof blockId !== 'string' ||
    typeof serviceId !== 'string' ||
    typeof repoName !== 'string'
  ) {
    return null
  }
  return { blockId, serviceId, repoName }
}

function coerceRun(value: unknown): RunRecord | null {
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.taskId !== 'string') return null
  return {
    taskId: record.taskId,
    runId: typeof record.runId === 'string' ? record.runId : null,
    pullRequestUrl: typeof record.pullRequestUrl === 'string' ? record.pullRequestUrl : null,
    answeredKinds: Array.isArray(record.answeredKinds)
      ? record.answeredKinds.filter((kind): kind is string => typeof kind === 'string')
      : [],
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
