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
export function attributeStopCause(record: unknown, now: number): ContainerStopCause | undefined {
  if (!record || typeof record !== 'object') return undefined
  const { cause, at } = record as Partial<StopCauseRecord>
  if (!isContainerStopCause(cause) || typeof at !== 'number') return undefined
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
 * Read the cause explaining a 404 poll and CONSUME it. One reclaim explains exactly one 404:
 * the engine responds by re-dispatching onto a fresh container addressed by the same DO id, so
 * a record left behind would still be sitting there to excuse the next death, whenever and for
 * whatever reason it came.
 */
export async function takeStopCause(
  storage: StopCauseStorage,
  now: number,
): Promise<ContainerStopCause | undefined> {
  const cause = attributeStopCause(await storage.get(STOP_CAUSE_KEY), now)
  await storage.delete(STOP_CAUSE_KEY)
  return cause
}
