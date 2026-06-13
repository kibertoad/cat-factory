import { useIntervalFn } from '@vueuse/core'

/** Keeps the board in sync with the backend's running pipelines. Mount once
 * (e.g. on the board page). In 'tick' mode each interval advances every running
 * pipeline on the server; in 'workflow' mode runs progress durably server-side,
 * so the interval only polls the latest state. Honours the UI play/pause toggle
 * and skips when idle. */
export function useSimulationClock(intervalMs = 850) {
  const execution = useExecutionStore()
  const ui = useUiStore()
  const workspace = useWorkspaceStore()

  // Guard against overlapping requests if a round-trip outlasts the interval.
  let inFlight = false

  const { pause, resume, isActive } = useIntervalFn(async () => {
    if (!ui.simRunning || !workspace.ready || inFlight) return
    // Nothing to do until something is running (a resolved decision refreshes).
    if (!execution.instances.some((e) => e.status === 'running')) return
    inFlight = true
    try {
      // In workflow mode the server drives progress; we only poll fresh state.
      if (workspace.executionMode === 'workflow') await workspace.refresh()
      else await execution.tick()
    } catch (e) {
      console.error('simulation clock poll failed', e)
    } finally {
      inFlight = false
    }
  }, intervalMs)

  return { pause, resume, isActive }
}
