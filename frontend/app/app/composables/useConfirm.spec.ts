import { beforeEach, describe, expect, it } from 'vitest'
import { useConfirm } from '~/composables/useConfirm'

// The confirm singleton's state lives at module scope so every caller and the one mounted
// `<ConfirmDialog />` share ONE request queue. That is also why each test starts by cancelling
// whatever the previous one left pending.
describe('useConfirm', () => {
  beforeEach(() => {
    useConfirm().cancel()
  })

  it('opens on request and resolves the choice the user made', async () => {
    const { open, current, confirm, accept } = useConfirm()

    const pending = confirm({ title: 'Delete it?' })
    expect(open.value).toBe(true)
    expect(current.value?.title).toBe('Delete it?')

    accept()
    await expect(pending).resolves.toBe(true)
    expect(open.value).toBe(false)
  })

  // The dismissal path (backdrop, Escape, unmount): the dialog is CONTROLLED, so settling the
  // promise without writing `open` left it on screen with no resolver behind it — a dialog whose
  // buttons resolve nothing, on what is now the primary dismissal path of eleven result windows.
  it('closes the dialog as well as settling the promise when it is dismissed', async () => {
    const { open, confirm, dismissed } = useConfirm()

    const pending = confirm({ title: 'Discard your changes?' })
    dismissed()

    await expect(pending).resolves.toBe(false)
    expect(open.value).toBe(false)
  })

  // A second dismissal with nothing pending must stay a no-op rather than closing a request that
  // arrived in between.
  it('leaves a fresh request alone when a stale dismissal arrives', async () => {
    const { open, confirm, dismissed, accept } = useConfirm()

    dismissed()
    const pending = confirm({ title: 'Remove the pipeline?' })
    expect(open.value).toBe(true)

    accept()
    await expect(pending).resolves.toBe(true)
  })

  // Load-bearing for every surface that can raise two confirms: the superseded awaiter resolves
  // `false`, so its caller treats the choice as declined rather than hanging forever.
  it('settles a superseded request false instead of leaving it pending', async () => {
    const { confirm, accept } = useConfirm()

    const first = confirm({ title: 'Delete A?' })
    const second = confirm({ title: 'Delete B?' })

    await expect(first).resolves.toBe(false)
    accept()
    await expect(second).resolves.toBe(true)
  })
})
