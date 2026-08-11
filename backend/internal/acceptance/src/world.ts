// The LEDGER: what previous specs in this acceptance run already built.
//
// Why a file rather than module state: one full pass costs real model spend and the better part
// of an afternoon, and the specs form a chain (03 files a bug against the feature 02 shipped
// into the repositories 01 scaffolded). A crash in 03 must not mean re-scaffolding two
// repositories and re-shipping a feature. So each spec RECORDS what it created and each spec
// starts by asking whether its own output already exists; a re-run against the same
// `ACCEPTANCE_RUN_ID` resumes at the first unfinished step.
//
// It is deliberately a dumb append-of-facts, not a state machine. The authority on what exists
// is the deployment, and every spec re-reads it (the ledger holds ids, never statuses); the
// ledger's only job is to remember which ids to re-read.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where a pass keeps its ledger and journal. Relative paths resolve against the package. */
export function resolveStateDir(stateDir: string): string {
  return isAbsolute(stateDir) ? stateDir : join(packageRoot, stateDir)
}

/**
 * The pointer to the most recent pass that CREATED something, so `ACCEPTANCE_RUN_ID=latest` and
 * the status script have something to resolve. Rewritten on every ledger patch.
 *
 * A pointer rather than a default: resuming stays an EXPLICIT act. A suite that silently picked
 * up the previous pass would turn "run the acceptance suite" into "continue whatever half-built
 * thing is lying around", and the ledger's whole value is that a resume is something an operator
 * chose after reading why the last one stopped.
 *
 * Written on the first FACT rather than when a pass opens its ledger. The two differ for exactly
 * the pass that creates nothing, and that pass is the common one: a fresh attempt refused by a
 * prerequisite. Pointed at on OPEN, it overwrote the pointer to the half-built pass whose leftover
 * services are why the refusal fired, so the `ACCEPTANCE_RUN_ID=latest` the refusal itself prints
 * resolved to an empty ledger and the pass holding the work became reachable only by an id nobody
 * had written down. A pass that died mid-run is unaffected: it recorded its task before starting it.
 */
const LATEST_POINTER = 'latest.json'

/** One repository the suite adopted, and the board service frame backed by it. */
export type ServiceRecord = {
  /** The board block id of the service frame, which `/api/v1` addresses as a `serviceId`. */
  blockId: string
  /** The same frame as `/api/v1` names it. Identical value; both spellings appear in the specs. */
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
   * decision is indistinguishable afterwards from one that never had to be made. Spec 03 asserts
   * on it, so a resumed pass that adopts a finished run would otherwise report the human-gate
   * path as never exercised when it was exercised yesterday.
   */
  answeredKinds: readonly string[]
}

/**
 * The issue spec 04 filed on the provider, as the reporter.
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
   * Spec 01's two scaffold runs, one per service.
   *
   * Ordinary `pl_build` runs like spec 02's, so they resume the same way rather than through a
   * bootstrap job id: a pass interrupted mid-scaffold re-attaches to the live run. Recorded
   * separately from `featureBackend`/`featureFrontend` because they are separate pull requests
   * against the same repository, and adopting one for the other would skip a whole phase.
   */
  scaffoldBackend: RunRecord | null
  scaffoldFrontend: RunRecord | null
  /**
   * Spec 02, per service. Two records rather than one because the planted mismatch has two halves
   * and spec 02 asserts the ephemeral-environment evidence of EACH: collapsing them would make
   * the second run's report unreadable, which is the one that carries the frontend's environment.
   */
  featureBackend: RunRecord | null
  featureFrontend: RunRecord | null
  /** Spec 03: the bug report filed against the shipped feature. */
  bugfix: RunRecord | null
  /** Spec 04: the issue filed on the provider, before any of it reached the platform. */
  intakeIssue: IssueRecord | null
  /** Spec 04: the run that delivered that issue, filed as a task linked to it. */
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
 * **Resolved ONCE per pass, in the main process** (`acceptance/globalSetup.ts`), and handed to the
 * workers. Never called from a spec: vitest gives every spec FILE its own module graph, so a minted
 * id is per file, and the id is the KEY to the ledger the files pass facts through. Called there,
 * five specs opened five ledgers a second apart, spec 02 could not read the services spec 01 had
 * just adopted, and the pass left five journals for `status` to pick one of.
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
    const latest = readLatestRunId(resolveStateDir(stateDir))
    if (latest) return latest
    throw new Error(
      `ACCEPTANCE_RUN_ID=latest, but ${join(resolveStateDir(stateDir), LATEST_POINTER)} names no ` +
        `previous pass. Name a run id explicitly, or unset ACCEPTANCE_RUN_ID to start a new pass ` +
        `(which scaffolds two repositories and spends real money).`,
    )
  }
  // Seconds granularity, no separators: it names this pass's ledger and journal files, so it has
  // to be safe in a filename on every platform an operator runs this from.
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/**
 * The run id a worker was handed, or a refusal naming who was supposed to hand it over.
 *
 * A spec may not resolve one for itself (see `resolveRunId`), and the failure of doing so is
 * invisible: every file works, each against a ledger of its own, and the pass fails four specs later
 * with "the ledger has no 'backend'". So the absence is a REFUSAL rather than a fallback to minting
 * one, which is exactly the shape that regressed.
 */
export function requirePassRunId(injected: string | undefined): string {
  const runId = injected?.trim()
  if (runId) return runId
  throw new Error(
    `This spec was not handed the pass's run id. It comes from acceptance/globalSetup.ts, which ` +
      `resolves it once in the main process and provides it to every worker: check that ` +
      `vitest.acceptance.config.ts still names that hook in 'globalSetup'. It is deliberately not ` +
      `minted here, because vitest gives each spec file its own module graph and a per-file run id ` +
      `is a per-file ledger, which no other spec can read.`,
  )
}

/**
 * The run ids of OTHER passes whose ledgers name any of these services.
 *
 * What turns "a leftover frame is in the way" into an instruction: the pass to resume is a run id,
 * and the only place that mapping exists is the ledgers on disk. Without it a refusal can only offer
 * `latest`, which is the wrong pass as soon as anything ran after the one holding the work.
 *
 * Sorted, which orders them chronologically for a minted id (a timestamp) and arbitrarily for a
 * hand-named one; a caller names every match rather than picking one, so the order is presentation.
 */
export function findPassesNaming(
  stateDir: string,
  serviceIds: readonly string[],
  exclude: string,
): readonly string[] {
  const wanted = new Set(serviceIds)
  if (wanted.size === 0) return []
  const dir = resolveStateDir(stateDir)
  let entries: readonly string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // silent-catch-ok: no state directory is the normal state before any pass has recorded a fact.
    return []
  }
  return entries
    .filter((name) => name !== LATEST_POINTER && name.endsWith('.json'))
    .flatMap((name) => {
      const world = readWorld(join(dir, name))
      return world && world.runId !== exclude ? [world] : []
    })
    .filter((world) =>
      [world.backend, world.frontend].some((service) => service && wanted.has(service.serviceId)),
    )
    .map((world) => world.runId)
    .sort()
}

/** The run id the most recent pass recorded, or null. Total: an unreadable pointer is "none". */
export function readLatestRunId(stateDir: string): string | null {
  let raw: string
  try {
    raw = readFileSync(join(stateDir, LATEST_POINTER), 'utf8')
  } catch {
    // silent-catch-ok: no pointer is the normal state before any pass has run.
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const runId = (parsed as { runId?: unknown } | null)?.runId
    return typeof runId === 'string' && runId.length > 0 ? runId : null
  } catch {
    // silent-catch-ok: a malformed pointer is discarded, exactly as a malformed ledger is.
    return null
  }
}

export class WorldStore {
  readonly #path: string
  readonly #dir: string
  #world: World

  constructor(stateDir: string, runId: string) {
    this.#dir = resolveStateDir(stateDir)
    this.#path = join(this.#dir, `${runId}.json`)
    mkdirSync(this.#dir, { recursive: true })
    this.#world = readWorld(this.#path) ?? emptyWorld(runId)
  }

  get path(): string {
    return this.#path
  }

  get dir(): string {
    return this.#dir
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
    writeFileSync(this.#path, `${JSON.stringify(this.#world, null, 2)}\n`, 'utf8')
    // The pointer rides every patch rather than the first one: there is no first-write flag to keep
    // right across the several processes that open one pass's ledger, and re-stating a pointer to
    // the pass that is writing anyway costs one small synchronous write per fact recorded.
    writeFileSync(
      join(this.#dir, LATEST_POINTER),
      `${JSON.stringify({ runId: this.#world.runId, ledger: this.#path }, null, 2)}\n`,
      'utf8',
    )
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
        `The ledger has no '${String(key)}' for run ${this.#world.runId}. The spec that records ` +
          `it has not passed yet. Run the suite from the start, or set ACCEPTANCE_RUN_ID to a ` +
          `pass that got further. Ledger: ${this.#path}`,
      )
    }
    return value as NonNullable<World[K]>
  }
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

/** Narrow parsed JSON to a `World`, or null. Total, so a hand-edited ledger cannot crash a spec. */
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
