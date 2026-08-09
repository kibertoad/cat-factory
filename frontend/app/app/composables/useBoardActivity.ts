import { inject, onBeforeUnmount, onMounted, provide, type InjectionKey, type Ref } from 'vue'

/**
 * The board's shared "something may have moved" pulse.
 *
 * The two DOM-measuring drivers on the canvas (dependency edges, task expansion) cannot ask
 * the DOM "did anything change since last frame" without doing the measurement that IS the
 * cost, so each used to measure unconditionally every frame. This publishes the signals that
 * can START a visible change instead; the drivers pair it with `useSettlingRaf`, which
 * carries each wake through the animation that follows and parks once the output holds still.
 *
 * The signals are deliberately coarse. A pulse that fires when nothing moved costs a handful
 * of frames; one that fails to fire leaves a stale arrow on screen, so this errs toward
 * firing:
 *
 *  - a `MutationObserver` over the canvas subtree, watching structure plus `style` / `class`.
 *    That is every Vue-driven render change on the board, Vue Flow's own pan/zoom transform
 *    included. Attribute changes the drivers themselves write (`x1`/`y1` on the edge overlay)
 *    are outside the filter, so a driver cannot pulse itself awake forever.
 *  - a `ResizeObserver` on the canvas, plus window `resize`: layout changes with no mutation.
 *  - pointer, wheel and scroll gestures on the canvas: the user moving something.
 *
 * What it does NOT catch is a reflow with no mutation and no gesture, such as a late-loading
 * image or font resizing a card. Those settle on the next pulse of any kind.
 */
export type BoardActivity = {
  /** Subscribe to the pulse. Returns the unsubscribe. */
  subscribe: (onPulse: () => void) => () => void
  /** Fire the pulse from a signal the observers above cannot see. */
  pulse: () => void
}

const boardActivityKey: InjectionKey<BoardActivity> = Symbol('boardActivity')

/**
 * Installs the signal sources on the board canvas element and provides the pulse to the
 * canvas's descendants. Returns it too, because a component cannot inject what it provides.
 */
export function provideBoardActivity(container: Ref<HTMLElement | null>): BoardActivity {
  const subscribers = new Set<() => void>()
  const pulse = () => {
    for (const onPulse of subscribers) onPulse()
  }

  const activity: BoardActivity = {
    subscribe(onPulse) {
      subscribers.add(onPulse)
      return () => subscribers.delete(onPulse)
    },
    pulse,
  }
  provide(boardActivityKey, activity)

  const mutations = new MutationObserver(pulse)
  const resizes = new ResizeObserver(pulse)
  // `scroll` does not bubble, so it is caught in the capture phase; the gestures are
  // passive listeners because the pulse never wants to cancel one.
  const gestures = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointerleave',
    'wheel',
    'scroll',
  ] as const
  const gestureOptions = { capture: true, passive: true }

  onMounted(() => {
    // The canvas binds this ref to its own root, so by mount it is always set; the narrowing is
    // for the nullable template-ref type rather than a case that happens.
    const el = container.value
    if (!el) return
    mutations.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    resizes.observe(el)
    for (const type of gestures) el.addEventListener(type, pulse, gestureOptions)
    window.addEventListener('resize', pulse)
  })

  onBeforeUnmount(() => {
    mutations.disconnect()
    resizes.disconnect()
    const el = container.value
    for (const type of gestures) el?.removeEventListener(type, pulse, gestureOptions)
    window.removeEventListener('resize', pulse)
    subscribers.clear()
  })

  return activity
}

/** Keeps `onPulse` subscribed to a pulse the caller already holds, for the component's lifetime. */
export function onBoardActivity(activity: BoardActivity, onPulse: () => void): void {
  onBeforeUnmount(activity.subscribe(onPulse))
}

/**
 * The same, for a descendant of the canvas that reads the pulse by injection. Throws when used
 * outside the board canvas: a driver that silently subscribed to nothing would measure once and
 * then freeze, which reads as a layout bug rather than the wiring one it is. The canvas itself
 * cannot inject what it provides, so it passes the returned pulse to `onBoardActivity` instead.
 */
export function useBoardActivity(onPulse: () => void): void {
  const activity = inject(boardActivityKey, null)
  if (!activity) throw new Error('useBoardActivity() requires a board canvas ancestor')
  onBoardActivity(activity, onPulse)
}
