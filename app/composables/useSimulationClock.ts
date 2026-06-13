import { useIntervalFn } from '@vueuse/core'

/** Drives the agent simulation by polling the backend's tick endpoint. Mount
 * once (e.g. on the board page). Each tick advances every running pipeline on
 * the server; honours the UI play/pause toggle and skips when idle. */
export function useSimulationClock(intervalMs = 850) {
  const execution = useExecutionStore()
  const ui = useUiStore()
  const workspace = useWorkspaceStore()

  // Guard against overlapping ticks if a round-trip outlasts the interval.
  let inFlight = false

  const { pause, resume, isActive } = useIntervalFn(async () => {
    if (!ui.simRunning || !workspace.ready || inFlight) return
    // Nothing to advance until a human resolves a decision (which refreshes).
    if (!execution.instances.some((e) => e.status === 'running')) return
    inFlight = true
    try {
      await execution.tick()
    } catch (e) {
      console.error('simulation tick failed', e)
    } finally {
      inFlight = false
    }
  }, intervalMs)

  return { pause, resume, isActive }
}
