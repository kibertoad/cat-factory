import { inject, onBeforeUnmount, onMounted, provide, type InjectionKey, type Ref } from 'vue'
import { createWakeGate } from '~/utils/boardWakeGate'

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
 *    are outside the filter, so a driver cannot pulse itself awake forever. These wakes are
 *    RATE-LIMITED (see `boardWakeGate`): a live board re-renders its cards on every execution
 *    event, and admitting each one kept the measuring loops from ever parking on exactly the
 *    board where measuring costs the most. The gesture and camera signals below are admitted
 *    unthrottled, so nothing the user is actually moving waits on an interval.
 *  - a `ResizeObserver` on the canvas, plus window `resize`: layout changes with no mutation.
 *  - pointer, wheel and scroll gestures, listened for on the WINDOW: the user moving something.
 *
 * What it does NOT catch is a reflow with no mutation and no gesture, such as a late-loading
 * image or font resizing a card. Those settle on the next pulse of any kind.
 */
export type BoardActivity = {
  /** Subscribe to the pulse. Returns the unsubscribe. */
  subscribe: (onPulse: () => void) => () => void
  /** Fire the pulse from a signal the observers above cannot see. */
  pulse: () => void
  /**
   * Where the pointer last was over the canvas (viewport coordinates), or null once it left.
   *
   * Owned here because the pulse already listens for the same gestures: a driver that wants the
   * position registered a SECOND `pointermove` listener on the same element to learn what this
   * one had just seen. Read inside a measurement pass, never subscribed to.
   */
  pointer: () => { x: number; y: number } | null
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

  // Renders reach the pulse through the gate; everything the user is moving goes straight to it.
  const renderWakes = createWakeGate({
    wake: pulse,
    // `window.setTimeout` rather than the bare global: the DOM overload returns the numeric
    // handle the gate's scheduler is typed on, where Node's returns a `Timeout` object.
    scheduler: {
      schedule: (run, delayMs) => window.setTimeout(run, delayMs),
      cancel: (handle) => window.clearTimeout(handle),
    },
  })

  let pointer: { x: number; y: number } | null = null

  /**
   * Track the pointer and pulse, in that order, off the SAME listener.
   *
   * `pointerleave` does not bubble, but a CAPTURE-phase listener sees one fired at any element
   * below it, and the pointer moving from a card onto the canvas around it is exactly that
   * event. So only the canvas's OWN leave clears the position; treating a descendant's as "the
   * pointer is gone" would collapse the hovered card the moment the pointer crossed one of its
   * inner elements. That check is on the TARGET, so it reads the same from the window as it did
   * from the canvas.
   */
  const onGesture = (event: Event) => {
    if (event.type === 'pointerleave') {
      if (event.target === container.value) pointer = null
    } else if (event.type === 'pointermove' || event.type === 'pointerdown') {
      const { clientX, clientY } = event as PointerEvent
      pointer = { x: clientX, y: clientY }
    }
    pulse()
  }

  const activity: BoardActivity = {
    subscribe(onPulse) {
      subscribers.add(onPulse)
      return () => subscribers.delete(onPulse)
    },
    pulse,
    pointer: () => pointer,
  }
  provide(boardActivityKey, activity)

  const mutations = new MutationObserver(renderWakes.request)
  const resizes = new ResizeObserver(pulse)
  // `scroll` does not bubble, so it is caught in the capture phase; the gestures are
  // passive listeners because the pulse never wants to cancel one.
  //
  // They are bound to the WINDOW rather than to the canvas, because a drag does not end at the
  // canvas's edge: `useBlockDrag` tracks the pointer on the window precisely so a card keeps
  // following it, and the toolbar region and the inspector are SIBLINGS painted over the canvas,
  // not descendants of it. Bound to the canvas, a drag whose cursor crossed one of them stopped
  // delivering the gesture that keeps the measuring loops awake, and the arrows fell back to the
  // rate-limited mutation wake for as long as the cursor was over it: a visible lag in the one
  // interaction this pulse exists to keep smooth. Capture on the window sees every one of those
  // events wherever it is dispatched, so nothing else about the handler changes.
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
    for (const type of gestures) window.addEventListener(type, onGesture, gestureOptions)
    window.addEventListener('resize', pulse)
  })

  onBeforeUnmount(() => {
    mutations.disconnect()
    resizes.disconnect()
    renderWakes.cancel()
    for (const type of gestures) window.removeEventListener(type, onGesture, gestureOptions)
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
