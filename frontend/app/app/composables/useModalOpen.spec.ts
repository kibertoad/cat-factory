import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { onModalOpen } from './useModalOpen'

/**
 * Register `onModalOpen` with `open` already at `mountedOpen`, which is what a modal's setup does.
 * That first value is the whole point: the page mounts most panels only WHILE their flag is set,
 * so a modal's `open` is already `true` by the time its own setup runs.
 */
function register(mountedOpen: boolean) {
  const open = ref(mountedOpen)
  const ran = vi.fn()
  const scope = effectScope()
  scope.run(() => onModalOpen(open, ran))
  return { open, ran, stop: () => scope.stop() }
}

describe('onModalOpen', () => {
  it('runs on the render the panel MOUNTS on, when it mounts already open', () => {
    // The bug this exists to make unrepresentable: a change-only `watch(open)` never fires for a
    // `v-if`-mounted modal, so whatever the body seeds (a picker's default, the read that fills a
    // catalog) never happens and the panel opens with an unselected control and a dead confirm.
    const { ran, stop } = register(true)

    expect(ran).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not run for a panel that is mounted CLOSED', () => {
    // The always-mounted half of the SPA. The same call has to be correct there, or this could not
    // be the one thing every site uses and each author would be back to deciding per site.
    const { ran, stop } = register(false)

    expect(ran).not.toHaveBeenCalled()
    stop()
  })

  it('runs again on each later open, and never on a close', async () => {
    const { open, ran, stop } = register(false)

    open.value = true
    await nextTick()
    open.value = false
    await nextTick()
    open.value = true
    await nextTick()

    expect(ran).toHaveBeenCalledTimes(2)
    stop()
  })
})
