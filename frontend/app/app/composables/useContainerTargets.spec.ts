import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useContainerTargets } from '~/composables/useContainerTargets'

/**
 * Where the frame-header authoring surfaces create. Two properties matter and only one of them is
 * about the happy path: the frame a surface was opened from narrows the choice to that service
 * WITHOUT removing its modules as targets, and the answer follows a live board, because the frame
 * can be deleted (by another member, over the socket) while the surface sits open.
 */
const block = (over: Partial<Block> & Pick<Block, 'id' | 'level' | 'title'>): Block =>
  ({ parentId: null, ...over }) as Block

/** A board with two services, one of which has modules, plus a task (never a container). */
function seedBoard(): void {
  useBoardStore().blocks = [
    block({ id: 'f_auth', level: 'frame', title: 'Auth' }),
    block({ id: 'm_login', level: 'module', title: 'Login', parentId: 'f_auth' }),
    block({ id: 'm_tokens', level: 'module', title: 'Tokens', parentId: 'f_auth' }),
    block({ id: 'f_billing', level: 'frame', title: 'Billing' }),
    block({ id: 't_1', level: 'task', title: 'A task', parentId: 'f_billing' }),
  ]
}

describe('useContainerTargets', () => {
  it('scopes to the opening frame and its modules, keeping the module as a target', () => {
    seedBoard()
    const { items, containerId, stated, pinned, reset } = useContainerTargets(() => 'f_auth')
    reset()
    // The button that opened this names the service, so the modules need no parent prefix.
    expect(items.value).toEqual([
      { label: 'Auth', value: 'f_auth' },
      { label: 'Login', value: 'm_login' },
      { label: 'Tokens', value: 'm_tokens' },
    ])
    expect(pinned.value?.id).toBe('f_auth')
    // A frame with modules did NOT answer frame-or-which-module, so the picker still asks,
    // preselected to the frame itself.
    expect(stated.value).toBe(false)
    expect(containerId.value).toBe('f_auth')
  })

  it('states the target rather than asking when the opening frame has no modules', () => {
    seedBoard()
    const { items, containerId, stated, reset } = useContainerTargets(() => 'f_billing')
    reset()
    expect(items.value).toEqual([{ label: 'Billing', value: 'f_billing' }])
    expect(stated.value).toBe(true)
    expect(containerId.value).toBe('f_billing')
  })

  it('offers every container on the board, parent-labelled, when opened standalone', () => {
    seedBoard()
    const { items, stated, reset } = useContainerTargets(() => null)
    reset()
    expect(items.value).toEqual([
      { label: 'Auth', value: 'f_auth' },
      { label: 'Auth › Login', value: 'm_login' },
      { label: 'Auth › Tokens', value: 'm_tokens' },
      { label: 'Billing', value: 'f_billing' },
    ])
    expect(stated.value).toBe(false)
  })

  // The finding this composable exists for: an id is not evidence the block is still there, so the
  // surface widens back to the whole board AND re-derives its selection. Leaving the selection
  // behind is the silent half: the picker renders unselected while the search under it stays scoped
  // to the deleted frame and the create lands on an id the board no longer has.
  it('widens and re-selects when the opening frame is deleted underneath it', async () => {
    seedBoard()
    const openedFrom = ref<string | null>('f_auth')
    const { items, containerId, stated, pinned } = useContainerTargets(() => openedFrom.value)
    containerId.value = 'm_login'

    const board = useBoardStore()
    board.blocks = board.blocks.filter((b) => !['f_auth', 'm_login', 'm_tokens'].includes(b.id))
    await nextTick()

    expect(pinned.value).toBeUndefined()
    expect(stated.value).toBe(false)
    expect(items.value).toEqual([{ label: 'Billing', value: 'f_billing' }])
    expect(containerId.value).toBe('f_billing')
  })

  it('keeps a still-legal selection when a sibling module is added', async () => {
    seedBoard()
    const { containerId } = useContainerTargets(() => 'f_auth')
    containerId.value = 'm_login'

    const board = useBoardStore()
    board.blocks = [
      ...board.blocks,
      block({ id: 'm_sessions', level: 'module', title: 'Sessions', parentId: 'f_auth' }),
    ]
    await nextTick()

    expect(containerId.value).toBe('m_login')
  })

  // A block id that resolves to something no task can live in is the same fact as an id that
  // resolves to nothing: the surface has no frame behind it and must not pin to one.
  it('ignores an opening id that is not a legal container', () => {
    seedBoard()
    const { pinned, items, reset, containerId } = useContainerTargets(() => 't_1')
    reset()
    expect(pinned.value).toBeUndefined()
    expect(items.value).toHaveLength(4)
    expect(containerId.value).toBe('f_auth')
  })
})
