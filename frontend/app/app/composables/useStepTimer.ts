import { ref, computed, onMounted, onUnmounted, watchEffect } from 'vue'
import type { Ref } from 'vue'
import type { PipelineStep } from '~/types/execution'

/**
 * Whether a step is actively executing: it has started, hasn't finished, isn't
 * parked on a human (`pausedAt`), and the run itself hasn't failed. A step in any
 * of those states is not ticking — no spinner, no counting-up clock.
 */
export function stepIsRunning(step: PipelineStep | null, runFailed: boolean): boolean {
  return !!step?.startedAt && !step?.finishedAt && step?.pausedAt == null && !runFailed
}

/**
 * Elapsed/total execution time in ms for a step at wall-clock `nowMs`, or null until
 * the step has started. The clock freezes once the step stops working: at its finish,
 * else at the run's failure time once the run has failed, else at the moment it parked
 * on a human (`pausedAt`). Otherwise it is live, counting up to `nowMs`.
 */
export function stepDurationMs(
  step: PipelineStep | null,
  nowMs: number,
  runFailed: boolean,
  failureAt: number | null | undefined,
): number | null {
  if (step?.startedAt == null) return null
  const end =
    step.finishedAt ?? (runFailed ? (failureAt ?? step.startedAt) : (step.pausedAt ?? nowMs))
  return Math.max(0, end - step.startedAt)
}

/** Human-friendly elapsed label for a step at `nowMs`, or null until it has started. */
export function stepDurationLabel(
  step: PipelineStep | null,
  nowMs: number,
  runFailed: boolean,
  failureAt: number | null | undefined,
): string | null {
  const ms = stepDurationMs(step, nowMs, runFailed, failureAt)
  return ms == null ? null : formatDuration(ms)
}

/**
 * Milliseconds since the container agent's last observed sign of life (`lastActivityAt`, the
 * harness liveness heartbeat), at wall-clock `nowMs` — or null when the step has none (a
 * non-container step, one not yet polled, or an older harness image). Clamped at 0 so minor
 * container/server clock skew never renders a negative "active in the future" value. This is the
 * LIVENESS clock (time since the agent last did anything), distinct from {@link stepDurationMs}'s
 * ELAPSED clock (total time the step has been running) — a long, quiet phase keeps the elapsed
 * clock climbing while this stays small, which is exactly how a genuinely-active-but-quiet run is
 * told apart from a wedged one.
 */
export function stepActivityAgoMs(step: PipelineStep | null, nowMs: number): number | null {
  if (step?.lastActivityAt == null) return null
  return Math.max(0, nowMs - step.lastActivityAt)
}

/**
 * One wall-clock ticker per interval, shared by every caller and running only while at least one
 * of them WANTS it. Keyed by interval because the surfaces genuinely differ (a 1s elapsed clock,
 * the outcome card's 30s one) and two intervals cannot share a timer.
 *
 * Both halves were per-caller before, and both cost: `useStepTimer` creates a tick per invocation
 * against its own one-interval intent, so N mounted `StepRunMeta`s meant N independent 1s timers;
 * and the timer ran for the component's whole mounted lifetime whether or not anything was
 * running, so a board of finished runs woke the main thread once a second to recompute labels that
 * are frozen by definition.
 */
const tickers = new Map<
  number,
  { now: Ref<number>; users: number; timer?: ReturnType<typeof setInterval> }
>()

function tickerFor(intervalMs: number) {
  let ticker = tickers.get(intervalMs)
  if (!ticker) {
    ticker = { now: ref(0), users: 0 }
    tickers.set(intervalMs, ticker)
  }
  return ticker
}

function acquireTicker(intervalMs: number) {
  const ticker = tickerFor(intervalMs)
  if (++ticker.users === 1) {
    // Stamp on the way in: a caller that subscribes between ticks must not read the stale
    // value the last one left behind (or the 0 of a ticker nothing has ever run).
    ticker.now.value = Date.now()
    ticker.timer = setInterval(() => (ticker.now.value = Date.now()), intervalMs)
  }
  return ticker.now
}

function releaseTicker(intervalMs: number) {
  const ticker = tickers.get(intervalMs)
  if (!ticker || ticker.users === 0) return
  if (--ticker.users === 0) {
    clearInterval(ticker.timer)
    ticker.timer = undefined
  }
}

/**
 * A shared wall-clock tick for surfaces that render live durations (the pipeline timeline, the
 * inspector run list, a step's elapsed clock). Reads `0` until something is subscribed, so the
 * first paint never reads a stale time.
 *
 * `active` gates the SUBSCRIPTION: pass it when the surface only needs a clock some of the time
 * (a step's timer needs one exactly while the step runs), and the shared timer stops as soon as
 * the last interested caller stops asking. Omitted means "for as long as this component is
 * mounted", which is what a surface rendering many steps at once wants.
 */
export function useNowTick(intervalMs = 1000, active?: () => boolean) {
  const now = tickerFor(intervalMs).now
  let subscribed = false
  function want(on: boolean) {
    if (on === subscribed) return
    subscribed = on
    if (on) acquireTicker(intervalMs)
    else releaseTicker(intervalMs)
  }
  onMounted(() => {
    if (active) watchEffect(() => want(active()))
    else want(true)
  })
  onUnmounted(() => want(false))
  return now
}

/**
 * Live elapsed-time clock for a single pipeline step. A 1s tick drives the
 * counting-up duration while the step is actively running; the clock freezes at
 * the step's finish, the run's failure time, or the moment it parked on a human
 * (`pausedAt`) so a mid-flight step (no `finishedAt`) doesn't tick up forever.
 */
export function useStepTimer(opts: {
  step: () => PipelineStep | null
  runFailed: () => boolean
  failureAt: () => number | null | undefined
}) {
  // A step that is finished, failed, or parked on a human is not actively
  // executing — no ticking clock or spinner. `pausedAt` is the "waiting on input" freeze.
  const isRunning = computed(() => stepIsRunning(opts.step(), opts.runFailed()))

  // Subscribe to the SHARED 1s clock, and only while this step is actually running: every value
  // below freezes at the step's own end stamp otherwise, so a tick would recompute nothing.
  const nowTick = useNowTick(1000, () => isRunning.value)

  /** Elapsed/total execution time in ms — null until the step has started. */
  const durationMs = computed(() =>
    stepDurationMs(opts.step(), nowTick.value, opts.runFailed(), opts.failureAt()),
  )

  const durationLabel = computed(() =>
    durationMs.value == null ? null : formatDuration(durationMs.value),
  )

  // Time since the agent's last sign of life (the liveness heartbeat), ticking only while the
  // step is actively running — a finished/parked/failed step isn't "active", so it reads null.
  const activityAgoMs = computed(() =>
    isRunning.value ? stepActivityAgoMs(opts.step(), nowTick.value) : null,
  )
  const activityAgoLabel = computed(() =>
    activityAgoMs.value == null ? null : formatDuration(activityAgoMs.value),
  )

  return { isRunning, durationMs, durationLabel, activityAgoMs, activityAgoLabel }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`
  const h = Math.floor(m / 60)
  const min = m % 60
  return min ? `${h}h ${min}m` : `${h}h`
}
