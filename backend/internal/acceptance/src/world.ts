// WHAT this suite's ledger holds: the services it adopted, the runs it drove, the issue it filed.
//
// The mechanics are the kit's (`LedgerStore`: the synchronous write, the copied-file refusal, the
// `latest` pointer, the "has this pass created anything" rule). What cannot be the kit's is the
// SHAPE, and that is this file: the facts one pass records are the ones its own scenarios chain
// through, and a kit that enumerated them would be describing this suite rather than serving any.
//
// It is deliberately a dumb append-of-facts, not a state machine. The authority on what exists is
// the deployment, and every scenario re-reads it (the ledger holds ids, never statuses); the
// ledger's only job is to remember which ids to re-read.

import {
  findPassesNaming as findPassesNamingIds,
  type LedgerFacts,
  type LedgerSlot,
  LedgerStore,
  readLedger,
  recordsFacts as ledgerRecordsFacts,
  type RunRecord,
} from '@cat-factory/acceptance-kit'
import { ACCEPTANCE_IDENTITY } from './identity.ts'

export type { RunRecord }

/**
 * One OTHER pass on disk, and which of the asked-about SERVICES its ledger names.
 *
 * The kit answers in ids, because ids are all it can know about; this suite names them for what they
 * are, since the refusal that prints them is about two service frames a fresh pass trips over.
 */
export type PassOwnership = {
  runId: string
  serviceIds: readonly string[]
}

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

export type World = LedgerFacts & {
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
 * Every slot a ledger holds, classified, EXHAUSTIVE over `World` by construction.
 *
 * The `satisfies` is the point: a field added to `World` fails to compile until it is named here,
 * so the classification cannot silently acquire a third state ("we never decided"). Scanning the
 * whole object instead read every non-null value as a created thing, which is right for today's
 * ledger and wrong the moment one carries something that is not one: a `startedAt` or a `notes`
 * would compile, pass every test, and from then on report EVERY pass (including a fresh attempt a
 * prerequisite refused before anything existed) as having created something.
 *
 * Exported for `test/world.test.ts`, which asserts the RELATION this table states (`created` counts,
 * `bookkeeping` does not) rather than a copy of today's membership. Read off `World`'s own keys, that
 * test could only say "every slot counts", which is the very reading the `bookkeeping` member exists to
 * make representable: the first correctly-classified one would have failed it.
 */
export const LEDGER_SLOTS = {
  backend: 'created',
  frontend: 'created',
  scaffoldBackend: 'created',
  scaffoldFrontend: 'created',
  featureBackend: 'created',
  featureFrontend: 'created',
  bugfix: 'created',
  intakeIssue: 'created',
  issueDelivery: 'created',
} satisfies Record<Exclude<keyof World, 'runId'>, LedgerSlot>

/** Whether this pass has recorded a FACT: anything at all on the deployment or the provider. */
export function recordsFacts(world: World): boolean {
  return ledgerRecordsFacts(world, LEDGER_SLOTS)
}

/**
 * The OTHER passes whose ledgers name any of these SERVICES, and which ones each holds.
 *
 * The kit walks the state directory and applies the identity rule; what this suite supplies is
 * which of its own ids are the ones being asked about, which is the two service frames: they are
 * the leftovers a fresh pass trips over, and the ledgers on disk are the only map from one of them
 * back to the run id worth resuming.
 */
export function findPassesNaming(
  stateDir: string,
  serviceIds: readonly string[],
  exclude: string,
): readonly PassOwnership[] {
  return findPassesNamingIds<World>({
    stateDir,
    ids: serviceIds,
    exclude,
    coerce: coerceWorld,
    holds: (world) =>
      [world.backend, world.frontend].flatMap((service) => (service ? [service.serviceId] : [])),
  }).map((pass) => ({ runId: pass.runId, serviceIds: pass.ids }))
}

/** This pass's ledger, with the two things no kit can supply: what an empty one is, and how to read one. */
export class WorldStore extends LedgerStore<World> {
  constructor(stateDir: string, runId: string) {
    super({
      stateDir,
      runId,
      empty: emptyWorld,
      coerce: coerceWorld,
      // Named so a record read too early says how a pass that got further is resumed, in this
      // suite's own variable rather than in the abstract.
      identity: ACCEPTANCE_IDENTITY,
    })
  }
}

/** Read a ledger, treating an unreadable or malformed one as ABSENT. */
export function readWorld(path: string): World | null {
  return readLedger(path, coerceWorld)
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
