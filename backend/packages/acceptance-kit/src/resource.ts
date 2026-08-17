// RESOURCES a pass provisions for itself: the record-before-you-can-observe discipline `resume.ts`
// gives RUNS, applied to a thing that costs money until somebody deletes it.
//
// `resume.ts` records a task id at creation and a run id at start because re-filing a run wastes an
// afternoon. A resource needs the same discipline for a worse reason. A suite covering its own
// environment backend stands up REAL infrastructure (a namespace, a preview Worker, a VM behind a
// balancer), and the two things a teardown takes (the provider's own id, and whatever the
// provision captured alongside it) **can be re-derived from nothing**: not from the deployment, which never
// saw this call, and not from the repository, which does not know a pass ran. So a process killed
// between `provision()` returning and the first status poll leaks a machine that nothing on disk can
// name. That is strictly worse than a re-filed run, which at least announces itself.
//
// Three properties, and they are `resume.ts`'s three read against a resource rather than a run:
//
//   - **The record is written on the line after the provision**, before the resource can be observed
//     at all. The window a crash lands in IS the provision.
//   - **A resumed pass ADOPTS, it does not re-provision.** Even where a provider's create is
//     idempotent per request (so re-requesting would converge), re-provisioning loses the captured
//     `fields`, which are the half no second call answers.
//   - **A release is recorded when the PROVIDER agrees the resource is gone**, never when the delete
//     was accepted. A teardown call that returned 202 and did nothing is the shape of every leak
//     this module exists to prevent, and a ledger that believed it is a ledger that stops naming the
//     thing still running.
//
// What is NOT here is any knowledge of a backend. A resource is an id plus an opaque field bag, and
// the provision, the teardown and the confirmation are the suite's own three functions.

import type { Journal } from './journal.js'
import { describeThrown } from './operatorText.js'

/**
 * One external resource, as its LEDGER remembers it.
 *
 * `fields` is opaque on purpose: it is whatever the provision captured that a teardown needs and
 * nothing else holds (a Kargo ref, a namespace name, a deployment id, the region it landed in). The
 * kit never reads it, so a suite is free to put its whole provision response there rather than
 * guessing today which member tomorrow's teardown will want.
 *
 * `releasedAt` is a stamp rather than a boolean and rather than the record being DELETED, because
 * "released" and "never provisioned" take the same action and answer different questions: a scenario
 * asserting the environment came down needs the first, and only a record that survives its own
 * teardown can state it.
 */
export type ResourceRecord<Fields> = {
  /** The provider's own id. The ONE thing that can tear this resource down. */
  externalId: string
  /** What the provision captured that the teardown needs and nothing can re-derive. */
  fields: Fields
  /** Epoch ms at which the PROVIDER confirmed it gone; null while it may still be standing. */
  releasedAt: number | null
}

export type AcquireOptions<Fields> = {
  /** What a previous pass recorded for this resource, if anything. */
  existing: ResourceRecord<Fields> | null
  /** Stand the resource up. Called only when there is nothing to adopt. */
  provision: () => Promise<{ externalId: string; fields: Fields }>
  /**
   * Persist the record. Called on the line after the provision returns, and expected to write
   * through to the ledger SYNCHRONOUSLY: this callback is the only thing standing between an
   * interrupted pass and a resource nothing can name.
   */
  onRecord: (record: ResourceRecord<Fields>) => void
  /** Human label for the resource, used in every message. */
  label: string
  journal: Journal
}

export type AcquireResult<Fields> = {
  record: ResourceRecord<Fields>
  /** Whether this call stood the resource up, as against adopting one a previous pass left. */
  provisioned: boolean
}

/**
 * Adopt what a previous pass provisioned, or provision and record it before anything can observe it.
 *
 * The three states a resumed pass can find:
 *
 *   1. **Nothing recorded.** Provision, record, return.
 *   2. **A record whose resource was RELEASED.** It is gone and the ledger says so, so provisioning
 *      again is the only honest action: adopting a released record would hand a scenario an id whose
 *      resource no longer answers, which reads as a provider outage.
 *   3. **A live record.** Adopt it. `fields` come back exactly as the provision captured them, which
 *      is the whole reason a resumed pass may not simply re-request.
 *
 * The provision is NOT probed here. What a caller does next is ask the provider for status (and
 * every such wait states its last observation), so a probe in here would be that read done twice
 * and a `ready` gate this module has no business owning.
 */
export async function acquire<Fields>(
  options: AcquireOptions<Fields>,
): Promise<AcquireResult<Fields>> {
  const { existing, journal, label, onRecord } = options
  if (existing && existing.releasedAt === null) {
    journal.say(
      'milestone',
      `adopting the '${label}' a previous pass provisioned (${existing.externalId})`,
    )
    return { record: existing, provisioned: false }
  }
  if (existing) {
    // `say` like both of its siblings, and for the reason `say` exists: this is the ONE line that
    // explains why a resumed pass did not adopt what its ledger names, and filed without being
    // printed it leaves an operator watching a fresh id appear with nothing saying what became of
    // the old one.
    journal.say(
      'milestone',
      `the ledger's '${label}' (${existing.externalId}) was released, so a fresh one is provisioned`,
    )
  }
  const { externalId, fields } = await options.provision()
  const record: ResourceRecord<Fields> = { externalId, fields, releasedAt: null }
  // Recorded BEFORE anything reads its status. Everything this module is for is in the ordering of
  // these two lines: a process killed between them leaves a resource billing against an account
  // with nothing anywhere that can name it.
  onRecord(record)
  journal.say('milestone', `provisioned '${label}' as ${externalId}`)
  return { record, provisioned: true }
}

/** How a release ended. Three states because each takes a DIFFERENT action from the operator. */
export type ReleaseStatus =
  /** The provider agrees it is gone. The only outcome that may be recorded as released. */
  | 'released'
  /** The teardown was accepted and the provider will not yet say it is gone. */
  | 'unconfirmed'
  /** The teardown itself failed. The resource is standing and nothing has been asked of it. */
  | 'failed'

export type ReleaseResult<Fields> = {
  status: ReleaseStatus
  record: ResourceRecord<Fields>
  /** One line naming the resource and what happened, for an operator who has to act on it. */
  detail: string
}

export type ReleaseOptions<Fields> = {
  record: ResourceRecord<Fields>
  /** Ask the provider to remove it. Both arguments a teardown takes ride the record. */
  teardown: (record: ResourceRecord<Fields>) => Promise<void>
  /**
   * Ask the PROVIDER whether it is gone, answering true only when it says so.
   *
   * Where a backend deletes asynchronously this is the caller's poll, budget and all, because how
   * long a reclaim may take is a fact about that backend and not one this module could pick. A
   * `confirm` that throws counts as "would not say", never as "gone": the whole point of separating
   * it from `teardown` is that an accepted delete is not evidence of a completed one.
   */
  confirm: (record: ResourceRecord<Fields>) => Promise<boolean>
  /** Persist the released record. Called ONLY on a confirmed reclaim. */
  onRecord: (record: ResourceRecord<Fields>) => void
  label: string
  journal: Journal
  now?: () => number
}

/**
 * Tear one resource down and record it as released only where the provider AGREES.
 *
 * Neither leg throws out of here. A reclaim is run from two places that both have something more
 * valuable to say than this failure (a scenario asserting on the teardown, and the pass epilogue
 * reporting on everything at once), and a throw would replace one of those with a stack. What comes
 * back instead is a verdict the caller can assert on or print, carrying the id, because the id is
 * what an operator needs to finish the job by hand.
 */
export async function release<Fields>(
  options: ReleaseOptions<Fields>,
): Promise<ReleaseResult<Fields>> {
  const { journal, label, record } = options
  const now = options.now ?? (() => Date.now())
  if (record.releasedAt !== null) {
    return {
      status: 'released',
      record,
      detail: `'${label}' (${record.externalId}) was already released`,
    }
  }
  try {
    await options.teardown(record)
  } catch (error) {
    const detail = `'${label}' (${record.externalId}) could NOT be torn down: ${describeThrown(error)}`
    journal.say('failure', detail)
    return { status: 'failed', record, detail }
  }
  if (!(await confirmed(options))) {
    const detail =
      `'${label}' (${record.externalId}) accepted the teardown and the provider will not yet ` +
      `confirm it is gone`
    journal.say('observation', detail)
    return { status: 'unconfirmed', record, detail }
  }
  // The ONE write, and it is here rather than beside the teardown above for the whole reason this
  // module exists: an accepted delete is not a completed one.
  const released: ResourceRecord<Fields> = { ...record, releasedAt: now() }
  options.onRecord(released)
  const detail = `'${label}' (${record.externalId}) was torn down and the provider confirms it is gone`
  journal.say('milestone', detail)
  return { status: 'released', record: released, detail }
}

/**
 * The provider's answer, with a THROWN confirmation read as "would not say".
 *
 * Not as "gone", which is the one reading that turns a provider outage into a ledger that has
 * forgotten a running machine, and not as a failure of the teardown, which was accepted.
 */
async function confirmed<Fields>(options: ReleaseOptions<Fields>): Promise<boolean> {
  try {
    return await options.confirm(options.record)
  } catch {
    return false
  }
}

export type ReclaimAllOptions<Fields> = {
  /** Everything the ledger still names, released or not. */
  records: readonly ResourceRecord<Fields>[]
  /** What each one is called, for the lines this answers. */
  labelOf: (record: ResourceRecord<Fields>, index: number) => string
  teardown: (record: ResourceRecord<Fields>) => Promise<void>
  confirm: (record: ResourceRecord<Fields>) => Promise<boolean>
  onRecord: (record: ResourceRecord<Fields>) => void
  journal: Journal
  now?: () => number
  /**
   * What to tell an operator holding a resource this pass could not reclaim, e.g. "remove them from
   * the Kargo dashboard". Only a suite knows where its own provider's console is.
   */
  remedy?: string
}

export type ReclaimAllResult<Fields> = {
  results: readonly ReleaseResult<Fields>[]
  /** What the pass says on its way out: nothing at all when everything came down. */
  lines: readonly string[]
}

/**
 * Release everything the ledger still names, and answer the lines a pass prints on the way out.
 *
 * Built for `PassOptions.onSettled` (`pass.ts`), which is the seam that puts them INSIDE the closing
 * words rather than after them. Sequential rather than concurrent: these are delete calls against one
 * provider, the count is small by construction, and a readable top-to-bottom report is worth more
 * here than the seconds concurrency would save.
 *
 * **A clean reclaim says nothing.** Every line this answers names something an operator has to act
 * on, so a pass with nothing standing adds nothing to its own closing words. The counts are in the
 * journal either way.
 */
export async function reclaimAll<Fields>(
  options: ReclaimAllOptions<Fields>,
): Promise<ReclaimAllResult<Fields>> {
  const results: ReleaseResult<Fields>[] = []
  for (const [index, record] of options.records.entries()) {
    if (record.releasedAt !== null) continue
    results.push(
      await release({
        record,
        label: options.labelOf(record, index),
        teardown: options.teardown,
        confirm: options.confirm,
        onRecord: options.onRecord,
        journal: options.journal,
        ...(options.now ? { now: options.now } : {}),
      }),
    )
  }
  return { results, lines: standingLines(results, options.remedy) }
}

/**
 * What is still standing, named one per line with its id.
 *
 * The id and not a count, because a count is a fact an operator cannot act on: the provider's own
 * id is the only handle a console search takes, and it is the value this whole module exists to have
 * kept. `unconfirmed` rides the same list as `failed` deliberately: from outside they are the same
 * obligation (go and look), and separating them would suggest one of the two needs no checking.
 */
function standingLines<Fields>(
  results: readonly ReleaseResult<Fields>[],
  remedy: string | undefined,
): readonly string[] {
  const standing = results.filter((result) => result.status !== 'released')
  if (standing.length === 0) return []
  return [
    `${standing.length} resource(s) this pass provisioned may STILL BE RUNNING:`,
    ...standing.map((result) => `  ${result.detail}`),
    ...(remedy ? [`  ${remedy}`] : []),
  ]
}
