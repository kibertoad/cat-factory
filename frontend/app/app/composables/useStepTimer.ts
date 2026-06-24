import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { PipelineStep } from '~/types/execution'

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
  // A 1s tick so a still-running step's elapsed time counts up live while open.
  const nowTick = ref(0)
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    nowTick.value = Date.now()
    timer = setInterval(() => (nowTick.value = Date.now()), 1000)
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  // A step that is finished, failed, or parked on a human is not actively
  // executing — no ticking clock or spinner. `pausedAt` is the "waiting on input"
  // freeze.
  const isRunning = computed(() => {
    const s = opts.step()
    return !!s?.startedAt && !s?.finishedAt && s?.pausedAt == null && !opts.runFailed()
  })

  /** Elapsed/total execution time in ms — null until the step has started. */
  const durationMs = computed(() => {
    const s = opts.step()
    if (s?.startedAt == null) return null
    // Freeze the clock once the step stops working: at its finish, else at the
    // failure time once the run has failed, else at the moment it parked on a
    // human (`pausedAt`). Otherwise it is live, so count up to the current tick.
    const end =
      s.finishedAt ??
      (opts.runFailed() ? (opts.failureAt() ?? s.startedAt) : (s.pausedAt ?? nowTick.value))
    return Math.max(0, end - s.startedAt)
  })

  const durationLabel = computed(() =>
    durationMs.value == null ? null : formatDuration(durationMs.value),
  )

  return { isRunning, durationMs, durationLabel }
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`
  const h = Math.floor(m / 60)
  const min = m % 60
  return min ? `${h}h ${min}m` : `${h}h`
}
