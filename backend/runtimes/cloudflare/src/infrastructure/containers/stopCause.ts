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
import { getErrorMessage } from '@cat-factory/kernel'

export type ContainerStopCause = 'rollout' | 'idle'

/** DO-storage key holding the {@link StopCauseRecord} of the most recent self-observed stop. */
export const STOP_CAUSE_KEY = 'containerStopCause'

/**
 * What the runtime reported when the workload stopped, mirroring the container base class's
 * `StopParams`. Recorded for EVERY stop, including the ones no {@link ContainerStopCause}
 * explains, because it answers a different question: the cause decides the recovery BUDGET, the
 * exit state is the only account of the death anyone gets afterwards.
 *
 * A Cloudflare Container's stdout is delivered to the deployment's Workers logs and is not
 * readable back from inside the Durable Object, so this is the whole of the post-mortem this
 * runtime can mint. It is still the difference between "container evicted or crashed" and "exit
 * code 137", i.e. between a run nobody can diagnose and an out-of-memory kill.
 */
export interface ContainerExitState {
  code: number
  reason: 'exit' | 'runtime_signal'
}

/** What the container persists when it observes its own stop. */
export interface StopCauseRecord {
  /**
   * The infrastructure-churn cause, when the container recognised one. Absent for a stop it
   * cannot explain (a crash, an OOM kill), which is exactly the case {@link exit} exists for.
   */
  cause?: ContainerStopCause
  /** What the runtime reported about the stop, when a hook that carries it fired. */
  exit?: ContainerExitState
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
 * How long a stop this container could NOT attribute (a crash, an OOM kill) may still explain a
 * 404 poll, i.e. the window governing a record that carries only an {@link ContainerExitState}.
 *
 * The same reasoning as the `idle` window, and deliberately the same number: what separates the
 * death from the poll that discovers it is the POLL GAP, and a crash is discovered by the same
 * ~15s tick an idle reclaim is, stretched by whatever delayed the driver. Sizing this to the
 * rollout case instead would read every crash discovered after a re-drive as unexplained, which
 * is the class this record exists to explain.
 *
 * Wide is affordable here for a reason the cause windows do not share: an exit state changes no
 * verdict. It is attached to the failure `detail`, so the cost of over-attributing is a
 * misleading sentence, never a wrongly-extended recovery budget.
 */
export const EXIT_ATTRIBUTION_WINDOW_MS = 30 * 60_000

/**
 * How far apart two hook calls may be and still be treated as observations of ONE stop, i.e. the
 * bound on {@link recordStopCause}'s merge.
 *
 * The merge exists for a single reason: `onError` and `onStop` are two views of the same death,
 * fired by the runtime within moments of each other. Anything older is a DIFFERENT, earlier
 * stop, and merging onto it is not conservative, it is destructive twice over: the new
 * observation inherits the old record's `at`, so it is born already aged, and both halves then
 * fall out of their own attribution windows and explain nothing. A record that is 40 minutes old
 * would silently swallow the crash that just happened.
 *
 * Sized generously against what it models (two hooks, milliseconds apart) and far below the
 * narrowest attribution window, so it cannot be the thing that decides an attribution: what a
 * merge may do is complete an account of one stop, never date it.
 */
export const STOP_MERGE_WINDOW_MS = 60_000

/** What a container observed about its own stop, once attributed to the job that reads it. */
export interface StopObservation {
  cause?: ContainerStopCause
  exit?: ContainerExitState
}

/**
 * The message the base container class surfaces when the RUNTIME (not the workload) stopped a
 * container: a deploy draining the old version. Its own exit-code parser is keyed on the plain
 * "runtime signalled the container to exit:" form and does not recognise the rollout wording,
 * which is why that case reaches `onError` at all.
 */
export function isRolloutSignal(error: unknown): boolean {
  // The whole CHAIN, not just the outermost message: the runtime's signal arrives wrapped when it
  // crosses the container binding, and the phrase this matches is then one `.cause` down. Widening
  // where the phrase is looked for cannot lose a match (the message is a prefix of the chain text),
  // and a nested rollout signal IS a rollout signal.
  return /new version rollout|runtime signalled the container to exit/i.test(getErrorMessage(error))
}

/**
 * What a container should record about a stop the runtime just reported, or undefined when it
 * should record nothing.
 *
 * Two rules, both about what the stop MEANS rather than what it says:
 *
 * - A `runtime_signal` 143 is the rollout drain surfacing through this hook instead of (or as
 *   well as) `onError`, depending on the runtime version, so it names the same cause.
 * - A stop the container ASKED for records nothing at all. Its idle reclaim and its shutdown RPC
 *   both work by signalling the container, so the exit that comes back is this container's own
 *   request echoed at it (escalating to a SIGKILL 137 when the workload does not exit inside the
 *   grace period), not an observation of how anything died. Recorded anyway, it is read back as
 *   the container's cause of death and reported to the operator as "most often an out-of-memory
 *   kill" underneath a verdict that says the platform reclaimed an idle container. The cause the
 *   caller recorded when it decided to stop is the whole account, and it is already stored.
 */
export function observationForStop(
  params: { exitCode: number; reason: 'exit' | 'runtime_signal' },
  selfInitiated: boolean,
): StopObservation | undefined {
  if (selfInitiated) return undefined
  const rollout = params.reason === 'runtime_signal' && params.exitCode === 143
  return {
    ...(rollout ? { cause: 'rollout' as const } : {}),
    exit: { code: params.exitCode, reason: params.reason },
  }
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
 * Whether a value read back out of DO storage is an exit state this build can render.
 *
 * The `reason` union is closed and PERSISTED, so an unknown member is possible after a runtime
 * bump; it degrades to "no exit state recorded" rather than being rendered as a bare string,
 * because a reason nobody has worded says less than the exit code alone already does.
 */
function isContainerExitState(value: unknown): value is ContainerExitState {
  if (!value || typeof value !== 'object') return false
  const { code, reason } = value as Partial<ContainerExitState>
  return typeof code === 'number' && (reason === 'exit' || reason === 'runtime_signal')
}

/**
 * What a stored record still explains at `now`, or an EMPTY observation when it explains
 * nothing.
 *
 * An empty observation covers three things that all mean the same to the caller: nothing was
 * recorded, the record outlived its window (the container recovered and ran on, so a later death
 * is its own), or the record names a cause this build no longer has. The last is possible
 * because the record is PERSISTED and the vocabulary is closed: a deploy that retires a member
 * leaves rows behind. All three land on the caller's existing default, reporting the eviction
 * as a `crash`, which is the honest reading of "no attribution" and the conservative one:
 * it costs a run one restart of its recovery budget, never a wrongly-extended one.
 *
 * The two halves are attributed INDEPENDENTLY, on their own windows: a record can be too old to
 * excuse the eviction as churn while still being the only account of how the container died, and
 * dropping the exit state with the cause would throw away the diagnostic to protect a budget the
 * diagnostic never touches.
 */
export function attributeStopCause(
  record: unknown,
  now: number,
  claimant: string,
): StopObservation {
  if (!record || typeof record !== 'object') return {}
  const { cause, exit, at, claimedBy } = record as Partial<StopCauseRecord>
  if (typeof at !== 'number') return {}
  // Spent on somebody else's eviction. Only the job that claimed it may read it back, which is
  // what lets a replay be idempotent without letting one reclaim excuse two deaths.
  if (claimedBy !== undefined && claimedBy !== claimant) return {}
  const age = now - at
  return {
    ...(isContainerStopCause(cause) && age <= ATTRIBUTION_WINDOW_MS[cause] ? { cause } : {}),
    ...(isContainerExitState(exit) && age <= EXIT_ATTRIBUTION_WINDOW_MS ? { exit } : {}),
  }
}

/** Whether an observation carries anything at all (i.e. whether claiming it is worth a write). */
function isEmptyObservation(observation: StopObservation): boolean {
  return !observation.cause && !observation.exit
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

/**
 * Persist what this container just observed about its own stop, MERGING onto an unclaimed record
 * of the SAME stop rather than replacing it.
 *
 * Merging is the point. One stop reaches this container through up to two hooks carrying
 * different halves of the answer: `onError` recognises a rollout drain and knows no exit state,
 * `onStop` carries `{ exitCode, reason }` and cannot name the churn. They fire in either order
 * (and, on some runtime versions, both), so a plain overwrite means whichever landed second
 * silently discarded the other's half: either the recovery budget or the only account of the
 * death, depending on the ordering that day.
 *
 * Two records are never merged:
 *
 * - a CLAIMED one, which has already explained somebody's eviction, so anything observed after
 *   it belongs to the next one;
 * - one older than {@link STOP_MERGE_WINDOW_MS}, which is a different stop entirely. This
 *   container's records are not reliably cleared between stops (`takeStopCause` deliberately
 *   leaves an expired record in place, and only an accepted dispatch deletes one), so a stale
 *   record is the ORDINARY state of a container that idled out and was re-driven, not an edge
 *   case. Merging onto it would back-date the new observation to the old stop's `at` and age it
 *   out of its own attribution window on arrival: the crash that just happened would be
 *   recorded, read back, and dropped as too old to explain the eviction it caused.
 *
 * The kept `at` is the EARLIEST of the two observations, which within the merge window is a
 * choice between timestamps moments apart: both describe one stop, and the window measures how
 * long ago that stop happened.
 */
export async function recordStopCause(
  storage: StopCauseStorage,
  observed: StopObservation,
  now: number,
): Promise<void> {
  const mergeable = mergeableRecord(await storage.get(STOP_CAUSE_KEY), now)
  const at = mergeable ? Math.min(mergeable.at, now) : now
  const cause = observed.cause ?? mergeable?.cause
  const exit = observed.exit ?? mergeable?.exit
  await storage.put(STOP_CAUSE_KEY, {
    ...(cause ? { cause } : {}),
    ...(exit ? { exit } : {}),
    at,
  })
}

/**
 * The stored record a new observation may complete, i.e. an unclaimed one describing the same
 * stop. Anything else (absent, malformed, claimed, or from an earlier stop) is undefined, and
 * the new observation stands alone.
 */
function mergeableRecord(
  stored: unknown,
  now: number,
): (Partial<StopCauseRecord> & { at: number }) | undefined {
  if (!stored || typeof stored !== 'object') return undefined
  const record = stored as Partial<StopCauseRecord>
  if (record.claimedBy !== undefined) return undefined
  if (typeof record.at !== 'number') return undefined
  // `now - at` rather than an absolute difference: a record stamped in the FUTURE (a clock
  // adjustment between two hook calls) is one of ours moments ago, not a stale one.
  if (now - record.at > STOP_MERGE_WINDOW_MS) return undefined
  return record as Partial<StopCauseRecord> & { at: number }
}

/**
 * What an exit code IS, independent of why the container stopped.
 *
 * A bounded map rather than a `128 + n` derivation on purpose: the platform reports one number
 * and only a couple of them are worth translating, while decoding an arbitrary code into a
 * signal name would confidently mislabel an application exit code that merely happens to exceed
 * 128. An unmapped code is reported as itself.
 */
const EXIT_SIGNAL_NAMES: Record<number, string> = {
  137: 'SIGKILL',
  143: 'SIGTERM',
}

/**
 * What an exit code SUGGESTS about a death nothing else explains. Read only when no
 * {@link ContainerStopCause} was recognised, which is what makes the guess worth offering: the
 * alternative there is silence.
 *
 * Kept apart from {@link EXIT_SIGNAL_NAMES} because the two are different kinds of claim. The
 * signal name is a fact about the number; this is an inference from the absence of any other
 * account, and it is false exactly when that absence is false.
 */
const UNEXPLAINED_EXIT_NOTES: Record<number, string> = {
  // Killed outright rather than exiting. With nothing else to explain it, on this runtime that
  // is overwhelmingly the instance running out of memory, which is why it is worth saying.
  137: 'most often an out-of-memory kill or a forced stop',
  // Something asked it to stop, and whatever it was left no cause behind for us to name.
  143: 'something asked the container to stop',
}

/**
 * The one-line account of a container's stop for the eviction `detail`, or undefined when
 * nothing was recorded.
 *
 * `cause` is the account the run has ALREADY been given, and passing it is what keeps the detail
 * from arguing with the verdict beside it. The two halves are recorded independently and the
 * exit state is attached whether or not a cause was recognised, so they routinely describe one
 * event twice: an idle reclaim is performed BY the platform with a SIGKILL, so a run correctly
 * reported as "idle container reclaimed between polls" carries exit 137, and read as an
 * unexplained death that code says "most often an out-of-memory kill". The operator is then
 * holding a verdict and a detail that cannot both be true, which is worse than either alone,
 * because there is no way to tell which one to act on.
 *
 * So the interpretation is offered only where it is the only account there is. Where a cause was
 * named, the exit code is reported as the MECHANICS of that stop: still the difference between
 * "reclaimed" and "reclaimed with a SIGKILL", and never a second, competing cause of death.
 *
 * Either way it states the platform's own limit rather than leaving it to be inferred: a
 * Cloudflare Container writes its stdout to the deployment's Workers logs, and nothing inside
 * the Durable Object can read it back, so an operator who reads this and goes looking for a log
 * tail here should be told where the tail actually is.
 */
export function describeContainerExit(
  exit: ContainerExitState | undefined,
  cause?: ContainerStopCause,
): string | undefined {
  if (!exit) return undefined
  const signal = EXIT_SIGNAL_NAMES[exit.code]
  const note = cause
    ? signal
    : [signal, UNEXPLAINED_EXIT_NOTES[exit.code]].filter(Boolean).join(', ')
  const how = cause
    ? 'the runtime reported it as'
    : exit.reason === 'runtime_signal'
      ? 'the runtime signalled it to exit, with'
      : 'the workload inside it exited, with'
  return (
    `The run's container stopped while the job was running: ${how} exit code ${exit.code}` +
    `${note ? ` (${note})` : ''}. The container's own output is not readable from the Worker; ` +
    `it is in this deployment's Workers logs.`
  )
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
 * Read what explains `claimant`'s 404 poll, CLAIMING it for that job.
 *
 * One stop explains exactly one job's eviction: the engine answers one by re-dispatching onto
 * a fresh container under the same DO id, so an unclaimed record would still be sitting there to
 * excuse the next death, whenever and for whatever reason it came. The claim is written rather
 * than the record deleted so a REPLAYED poll for the same job reads back the same answer (see
 * {@link StopCauseRecord.claimedBy}).
 *
 * The claim covers the record, not one half of it: an exit state read here is spent as surely as
 * a cause is, because attaching one container's death to two runs' failures is the same lie
 * either way.
 */
export async function takeStopCause(
  storage: StopCauseStorage,
  now: number,
  claimant: string,
): Promise<StopObservation> {
  const record = await storage.get(STOP_CAUSE_KEY)
  const observation = attributeStopCause(record, now, claimant)
  // Nothing to claim: either there was no record, it was spent, or it is too old to explain
  // anything. Leaving an expired record in place costs one key until the next reclaim
  // overwrites it, and rewriting it here would only re-date somebody else's observation.
  if (isEmptyObservation(observation)) return observation
  await storage.put(STOP_CAUSE_KEY, { ...(record as StopCauseRecord), claimedBy: claimant })
  return observation
}
