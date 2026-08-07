// Why a per-run container went away, recorded by the container itself and read back by the
// transport when a job poll 404s. A 404 alone cannot tell an OOM apart from the platform
// reclaiming a sandbox, and the two need different recoveries: a crash that repeats is
// deterministic and should end the run, while infrastructure churn should be ridden out.
// Shared by both per-run container classes (agent + deploy) so the key, the windows and the
// attribution rule cannot drift between them.

/**
 * The reclaim causes a container can observe about itself.
 *
 * - `rollout`: a deploy drained it (exit 143). Expected churn during a release.
 * - `idle`: its own `sleepAfter` window elapsed with nothing talking to it. The container is
 *   kept warm ONLY by the driver's job polls, so this means the backend stopped polling for
 *   longer than that window: a poll-scheduling hiccup (a Workflows instance evicted and
 *   re-driven by the cron sweeper), not the workload failing. Left unrecorded it reads as a
 *   crash, and two hiccups in one step then exhaust the single crash-eviction budget and fail
 *   a healthy run (stuck-run audit F12).
 */
export type ContainerStopCause = 'rollout' | 'idle'

/** DO-storage key holding the {@link StopCauseRecord} of the most recent self-observed stop. */
export const STOP_CAUSE_KEY = 'containerStopCause'

/** What the container persists when it observes its own reclaim. */
export interface StopCauseRecord {
  cause: ContainerStopCause
  /** Epoch ms the stop was observed. */
  at: number
  /**
   * The job id this record has already been spent explaining, once one has claimed it.
   *
   * A claim rather than a delete, because the caller runs inside a RETRYING durable step. A
   * destructive read is not replay-safe: a `step.do` that reads the record and then throws (a
   * contended persist, a failed emit) re-runs with the attribution already gone and reports the
   * `crash` this whole mechanism exists to spare. Keyed by the claimant so a REPLAY of the same
   * poll re-reads the same answer, while a different job's poll finds it spent — which is the
   * "one reclaim explains exactly one eviction" rule, now stated in a way a retry cannot break.
   */
  claimedBy?: string
}

/**
 * How long after each cause a 404 poll may still be attributed to it.
 *
 * They differ because the two causes are observed at different distances from the poll that
 * finds the container gone. A rollout drain interrupts an IN-FLIGHT poll, so the very next one
 * lands seconds later. An idle reclaim happens precisely because polling stopped, so the poll
 * that discovers it arrives however long the gap outran the idle window: minutes, not seconds.
 * A window sized for the rollout case would therefore read every real idle reclaim as a crash,
 * which is the finding itself.
 *
 * The window is a BACKSTOP, not the primary bound on what a record may excuse. What actually
 * scopes it is the pair of rules around it: {@link clearStopCause} drops the record the moment a
 * new job is accepted, and {@link takeStopCause} lets exactly one job spend it. So the wide
 * `idle` window buys the poll gap it exists for without also handing the next step's crash an
 * alibi.
 */
export const ATTRIBUTION_WINDOW_MS = {
  rollout: 120_000,
  idle: 30 * 60_000,
} satisfies Record<ContainerStopCause, number>

/**
 * The message the base container class surfaces when the RUNTIME (not the workload) stopped a
 * container: a deploy draining the old version. Its own exit-code parser is keyed on the plain
 * "runtime signalled the container to exit:" form and does not recognise the rollout wording,
 * which is why that case reaches `onError` at all.
 */
export function isRolloutSignal(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  return /new version rollout|runtime signalled the container to exit/i.test(message)
}

/**
 * Whether a value read back out of DO storage is still a cause this build knows. Derived from
 * the window table's own keys rather than restated, so retiring a cause fails the build here
 * instead of leaving a member the predicate silently keeps admitting.
 */
function isContainerStopCause(value: unknown): value is ContainerStopCause {
  return typeof value === 'string' && Object.hasOwn(ATTRIBUTION_WINDOW_MS, value)
}

/**
 * The cause a stored record still justifies at `now`, or `undefined` when there is nothing to
 * attribute.
 *
 * `undefined` covers three things that all mean the same to the caller: nothing was recorded,
 * the record outlived its cause's window (the container recovered and ran on, so a later death
 * is its own), or the record names a cause this build no longer has. The last is possible
 * because the record is PERSISTED and the vocabulary is closed: a deploy that retires a member
 * leaves rows behind. All three land on the caller's existing default, reporting the eviction
 * as a `crash`, which is the honest reading of "no attribution" and the conservative one:
 * it costs a run one restart of its recovery budget, never a wrongly-extended one.
 */
export function attributeStopCause(
  record: unknown,
  now: number,
  claimant: string,
): ContainerStopCause | undefined {
  if (!record || typeof record !== 'object') return undefined
  const { cause, at, claimedBy } = record as Partial<StopCauseRecord>
  if (!isContainerStopCause(cause) || typeof at !== 'number') return undefined
  // Spent on somebody else's eviction. Only the job that claimed it may read it back, which is
  // what lets a replay be idempotent without letting one reclaim excuse two deaths.
  if (claimedBy !== undefined && claimedBy !== claimant) return undefined
  return now - at <= ATTRIBUTION_WINDOW_MS[cause] ? cause : undefined
}

/**
 * The slice of DO storage the bookkeeping below needs. Narrowed to three methods so the rules
 * can be exercised against a plain fake. The alternative is asserting them through a real
 * Durable Object, which means reaching into the container base class's private fields.
 */
export interface StopCauseStorage {
  get: (key: string) => Promise<unknown>
  put: (key: string, value: StopCauseRecord) => Promise<void>
  delete: (key: string) => Promise<unknown>
}

/** Persist what this container just observed about its own reclaim. */
export async function recordStopCause(
  storage: StopCauseStorage,
  cause: ContainerStopCause,
  now: number,
): Promise<void> {
  await storage.put(STOP_CAUSE_KEY, { cause, at: now })
}

/**
 * Forget whatever this container observed before now.
 *
 * Called when a NEW job is accepted, which is the moment the record stops being able to explain
 * anything: a stop cause accounts for the death of a container that was serving the jobs
 * outstanding when it was observed, and a job dispatched afterwards is not one of them. Without
 * this the common benign case poisons the rare dangerous one — a run parks on a human decision,
 * its container idles out with nothing running, and the `idle` marker that leaves behind is
 * still there half an hour later to excuse a genuine OOM in the NEXT step as transient churn.
 */
export async function clearStopCause(storage: StopCauseStorage): Promise<void> {
  await storage.delete(STOP_CAUSE_KEY)
}

/**
 * Read the cause explaining `claimant`'s 404 poll, CLAIMING it for that job.
 *
 * One reclaim explains exactly one job's eviction: the engine answers one by re-dispatching onto
 * a fresh container under the same DO id, so an unclaimed record would still be sitting there to
 * excuse the next death, whenever and for whatever reason it came. The claim is written rather
 * than the record deleted so a REPLAYED poll for the same job reads back the same answer (see
 * {@link StopCauseRecord.claimedBy}).
 */
export async function takeStopCause(
  storage: StopCauseStorage,
  now: number,
  claimant: string,
): Promise<ContainerStopCause | undefined> {
  const record = await storage.get(STOP_CAUSE_KEY)
  const cause = attributeStopCause(record, now, claimant)
  // Nothing to claim: either there was no record, it was spent, or it is too old to explain
  // anything. Leaving an expired record in place costs one key until the next reclaim
  // overwrites it, and rewriting it here would only re-date somebody else's observation.
  if (!cause) return undefined
  await storage.put(STOP_CAUSE_KEY, { ...(record as StopCauseRecord), claimedBy: claimant })
  return cause
}
