import { ref, computed, onMounted, onUnmounted } from 'vue'
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
 * A shared 1s wall-clock tick for surfaces that render many steps' live durations
 * at once (the pipeline timeline, the inspector run list). One interval drives every
 * step's elapsed label instead of a per-step timer. Stays `0` until mounted so the
 * first paint never reads a stale time.
 */
export function useNowTick(intervalMs = 1000) {
  const now = ref(0)
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    now.value = Date.now()
    timer = setInterval(() => (now.value = Date.now()), intervalMs)
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })
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
  const nowTick = useNowTick()

  // A step that is finished, failed, or parked on a human is not actively
  // executing — no ticking clock or spinner. `pausedAt` is the "waiting on input" freeze.
  const isRunning = computed(() => stepIsRunning(opts.step(), opts.runFailed()))

  /** Elapsed/total execution time in ms — null until the step has started. */
  const durationMs = computed(() =>
    stepDurationMs(opts.step(), nowTick.value, opts.runFailed(), opts.failureAt()),
  )

  const durationLabel = computed(() =>
    durationMs.value == null ? null : formatDuration(durationMs.value),
  )

  return { isRunning, durationMs, durationLabel }
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
