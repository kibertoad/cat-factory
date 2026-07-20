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
 *
 * `onClose` runs on EVERY close path — the X button, backdrop click, and the Escape key —
 * BEFORE the view is torn down, so a window with unsaved draft input (the review windows) can
 * flush it in one place instead of every caller having to remember to. It runs synchronously;
 * if it kicks off async work it must capture whatever it needs first, because `blockId`/the
 * derived state go null the moment the view closes.
 *
 * Escape-to-close is NOT owned here: every result window renders through `ResultWindowShell`
 * (slice 5 of the modular-vue adoption), whose `useModalBehavior` owns Escape via the shared
 * overlay stack (top overlay closes first, focus/scroll managed too). A listener here would
 * double-fire `close`, so it was removed once the last window converted onto the shell.
 */
/**
 * The fully-resolved view context handed to `onOpen`. Every field is already initialised by
 * the time `onOpen` fires, so a loader takes exactly what it needs from here and never reaches
 * back into the store or the composable's own return refs. That matters because `onOpen` fires
 * synchronously from the `immediate` watch below — DURING the caller's `setup`, before the
 * `const { … } = useResultView(…)` destructure has been assigned — so any callback that closed
 * over those refs would hit their temporal dead zone and throw on every open.
 */
export interface OpenResultView {
  blockId: string
  instanceId: string | null
  stepIndex: number | null
  stage: 'requirements' | 'architecture' | null
}

export function useResultView(
  viewId: string,
  opts?: { onOpen?: (view: OpenResultView) => void; onClose?: () => void },
) {
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
    if (open.value) opts?.onClose?.()
    ui.closeResultView()
  }

  // The load-on-open contract: fire immediately on mount and on any later block switch. The
  // callback receives the fully-resolved context (see OpenResultView) rather than the return
  // refs, which aren't assigned yet at the initial synchronous fire.
  if (opts?.onOpen) {
    watch(
      blockId,
      (id) => {
        if (id)
          opts.onOpen!({
            blockId: id,
            instanceId: instanceId.value,
            stepIndex: stepIndex.value,
            stage: stage.value,
          })
      },
      { immediate: true },
    )
  }

  return { open, blockId, instanceId, stepIndex, stage, close }
}
