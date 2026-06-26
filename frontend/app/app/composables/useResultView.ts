/**
 * Shared contract for a dedicated result-view window (the `resultView` seam — see
 * `~/utils/catalog`, `StepResultViewHost.vue`). Every such window resolves the same state
 * from `ui.resultView`, closes the same way, and (when it loads data) must fetch on open.
 *
 * `StepResultViewHost` mounts each window FRESH every time it opens, so a per-window
 * `watch` would have to be `immediate` to fetch on the initial mount — easy to forget, and
 * forgetting it makes the window show an empty state for whichever navigation route didn't
 * happen to warm a cache first. Centralising the contract here means a window can't drift:
 * declare an `onOpen` loader and it fires immediately on mount AND on any later block switch,
 * regardless of how the window was opened.
 *
 * A synchronous window (one that reads its data straight off the execution step, like the
 * test report) simply omits `onOpen`.
 */
export function useResultView(viewId: string, opts?: { onOpen?: (blockId: string) => void }) {
  const ui = useUiStore()

  const open = computed(() => ui.resultView?.view === viewId)
  // Null whenever this window isn't the active view, so a stale id from another window's
  // open can never leak into this one.
  const blockId = computed(() => (open.value ? ui.resultView!.blockId : null))
  const instanceId = computed(() => (open.value ? ui.resultView!.instanceId : null))
  const stepIndex = computed(() => (open.value ? ui.resultView!.stepIndex : null))
  // Set only for the brainstorm window (its two stages share one view id).
  const stage = computed(() => (open.value ? (ui.resultView!.stage ?? null) : null))

  function close() {
    ui.closeResultView()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open.value) close()
  }
  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

  // The load-on-open contract: fire immediately on mount and on any later block switch.
  if (opts?.onOpen) {
    watch(
      blockId,
      (id) => {
        if (id) opts.onOpen!(id)
      },
      { immediate: true },
    )
  }

  return { open, blockId, instanceId, stepIndex, stage, close }
}
