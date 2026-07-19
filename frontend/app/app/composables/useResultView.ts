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
 * `onClose` runs on EVERY close path — the X button, backdrop click, and the Escape key
 * handled here — BEFORE the view is torn down, so a window with unsaved draft input (the
 * review windows) can flush it in one place instead of every caller having to remember to.
 * It runs synchronously; if it kicks off async work it must capture whatever it needs first,
 * because `blockId`/the derived state go null the moment the view closes.
 *
 * `manageEscape` (default `true`) owns the global Escape-to-close listener. A window that
 * renders through `ResultWindowShell` (slice 5 of the modular-vue adoption) passes `false`:
 * the shell's `useModalBehavior` owns Escape via the shared overlay stack (so the top
 * overlay closes first, and focus/scroll are managed too), and a second listener here would
 * double-fire `close`. Un-converted windows keep the default so they still close on Escape.
 * Remove this option once every result window is on the shell (the listener moves out
 * entirely).
 */
export function useResultView(
  viewId: string,
  opts?: { onOpen?: (blockId: string) => void; onClose?: () => void; manageEscape?: boolean },
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

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open.value) close()
  }
  if (opts?.manageEscape !== false) {
    onMounted(() => window.addEventListener('keydown', onKey))
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
  }

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
