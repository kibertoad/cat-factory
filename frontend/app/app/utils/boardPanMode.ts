/**
 * Pure decision for Vue Flow's `pan-on-drag` prop on the board canvas.
 *
 * Vue Flow's d3-zoom filter restricts panning to the mouse buttons listed in the
 * array form: a `pointerdown`/`touchstart` whose `event.button` isn't in the list is
 * rejected. A touch `touchstart` carries no `event.button` (it's `undefined`), so the
 * precise-pointer button list `[0, 2]` (left/right-drag, never middle) silently blocks
 * one-finger panning — the touchstart never matches a listed button.
 *
 * So when the surface can be touched at all we widen the prop to `true` (any pointer
 * pans the pane; pinch-zoom stays on by default), and otherwise keep the
 * precise-pointer button restriction for mouse desktops. This is split out as a pure
 * function so the headline touch-pan fix has a non-flaky unit guard — driving real
 * touch gestures through the canvas is explicitly out of scope for the e2e suite.
 *
 * @param canTouch whether any available pointer is coarse (see `useViewport().hasTouch`)
 */
export function boardPanMode(canTouch: boolean): true | number[] {
  return canTouch ? true : [0, 2]
}
