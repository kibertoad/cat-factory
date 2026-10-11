import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useActionToast } from '~/composables/useActionToast'

// `test/setup.ts` stubs `useNuxtApp().$i18n.t` as a key echo; this spec swaps in a `t` that also
// records its params, and a `useToast` whose `add` it can read back.
const add = vi.fn()
const t = vi.fn((key: string, params?: Record<string, unknown>, plural?: number) =>
  [key, params && Object.keys(params).length ? JSON.stringify(params) : '', plural ?? '']
    .filter((part) => part !== '')
    .join('|'),
)

beforeEach(() => {
  add.mockReset()
  t.mockClear()
  vi.stubGlobal('useToast', () => ({ add }))
  vi.stubGlobal('useNuxtApp', () => ({ $i18n: { t } }))
})

const lastToast = () => add.mock.calls.at(-1)?.[0]

describe('useActionToast', () => {
  it('renders every success toast the same, whatever the call site', () => {
    const toast = useActionToast()
    toast.success('a.saved')
    const first = lastToast()
    toast.success('b.connected', { params: { name: 'x' } })
    const second = lastToast()
    for (const key of ['color', 'icon', 'duration'] as const) expect(second[key]).toBe(first[key])
    expect(first.color).toBe('success')
  })

  it('auto-dismisses success and info, and keeps warning and error until closed', () => {
    const toast = useActionToast()
    toast.success('k')
    expect(lastToast().duration).toBeUndefined()
    toast.info('k')
    expect(lastToast().duration).toBeUndefined()
    toast.warning('k')
    expect(lastToast().duration).toBe(0)
    toast.error('k')
    expect(lastToast().duration).toBe(0)
  })

  it('resolves the title key with its params and plural count', () => {
    useActionToast().info('x.found', { params: { count: 3 }, plural: 3, description: 'body' })
    expect(lastToast().title).toBe('x.found|{"count":3}|3')
    expect(lastToast().description).toBe('body')
  })

  it('holds an undo toast exactly as long as the window and leads with the Undo action', () => {
    const run = vi.fn()
    const extra = { label: 'Open', onClick: vi.fn() }
    useActionToast().success('board.toast.deleted', {
      undo: { run, windowMs: 6000 },
      actions: [extra],
    })
    const shown = lastToast()
    expect(shown.duration).toBe(6000)
    expect(shown.actions).toHaveLength(2)
    expect(shown.actions[0].label).toBe('common.undo')
    shown.actions[0].onClick()
    expect(run).toHaveBeenCalledOnce()
    expect(shown.actions[1]).toBe(extra)
  })

  it('sends no empty actions array', () => {
    useActionToast().success('k')
    expect(lastToast()).not.toHaveProperty('actions')
  })
})
