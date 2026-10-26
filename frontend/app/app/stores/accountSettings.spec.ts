import { describe, it, expect, vi } from 'vitest'
import { AccountConfigNotLoadedError, useAccountSettingsStore } from '~/stores/accountSettings'
import type { AccountSettingsView, UpdateAccountSettingsInput } from '~/types/accountSettings'

/**
 * A save sends a `config` that REPLACES the stored one, and the Team-tab panels each patch one
 * key of it. So the store must only ever merge onto the current config of the SAME account:
 * merging onto nothing deletes the sibling settings, and merging onto another account's config
 * copies them over.
 */
function view(config: AccountSettingsView['config']): AccountSettingsView {
  return { config } as AccountSettingsView
}

function stubApi(reads: Record<string, Array<AccountSettingsView | 'failing'>>) {
  const api = {
    getAccountSettings: vi.fn((accountId: string) => {
      const next = reads[accountId]!.shift()!
      return next === 'failing' ? Promise.reject(new Error('read failed')) : Promise.resolve(next)
    }),
    updateAccountSettings: vi.fn((_accountId: string, input: UpdateAccountSettingsInput) =>
      Promise.resolve(view(input.config ?? {})),
    ),
  }
  vi.stubGlobal('useApi', () => api)
  return api
}

describe('accountSettings store', () => {
  it('merges a patch onto the loaded config of the same account', async () => {
    const api = stubApi({ a1: [view({ allowInitiatorPat: false })] })
    const store = useAccountSettingsStore()
    await store.load('a1')

    await store.saveConfigPatch('a1', { modelPolicy: undefined })

    expect(api.updateAccountSettings).toHaveBeenCalledWith('a1', {
      config: { allowInitiatorPat: false, modelPolicy: undefined },
    })
  })

  it('refuses a patch when the load failed', async () => {
    const api = stubApi({ a1: ['failing'] })
    const store = useAccountSettingsStore()
    await expect(store.load('a1')).rejects.toThrow('read failed')

    expect(store.isLoadedFor('a1')).toBe(false)
    await expect(store.saveConfigPatch('a1', {})).rejects.toBeInstanceOf(
      AccountConfigNotLoadedError,
    )
    expect(api.updateAccountSettings).not.toHaveBeenCalled()
  })

  it('drops the earlier view when a reload fails', async () => {
    stubApi({ a1: [view({ allowInitiatorPat: false }), 'failing'] })
    const store = useAccountSettingsStore()
    await store.load('a1')
    await expect(store.load('a1')).rejects.toThrow('read failed')

    expect(store.view).toBeNull()
    expect(store.isLoadedFor('a1')).toBe(false)
  })

  it("refuses to patch one account with another account's config", async () => {
    const api = stubApi({ a1: [view({ allowInitiatorPat: false })] })
    const store = useAccountSettingsStore()
    await store.load('a1')

    expect(store.isLoadedFor('a2')).toBe(false)
    await expect(store.saveConfigPatch('a2', {})).rejects.toBeInstanceOf(
      AccountConfigNotLoadedError,
    )
    expect(api.updateAccountSettings).not.toHaveBeenCalled()
  })

  it('sends one read for loads of the same account that overlap', async () => {
    const api = stubApi({ a1: [view({})] })
    const store = useAccountSettingsStore()

    await Promise.all([store.load('a1'), store.load('a1'), store.load('a1')])

    expect(api.getAccountSettings).toHaveBeenCalledTimes(1)
    expect(store.loading).toBe(false)
  })

  it('keeps the view of the account loaded last when an earlier read answers late', async () => {
    let answerA1: (v: AccountSettingsView) => void = () => {}
    const api = {
      getAccountSettings: vi.fn((accountId: string) =>
        accountId === 'a1'
          ? new Promise<AccountSettingsView>((resolve) => (answerA1 = resolve))
          : Promise.resolve(view({ allowInitiatorPat: false })),
      ),
    }
    vi.stubGlobal('useApi', () => api)
    const store = useAccountSettingsStore()

    const first = store.load('a1')
    await store.load('a2')
    answerA1(view({}))
    await first

    expect(store.isLoadedFor('a2')).toBe(true)
    expect(store.view?.config).toEqual({ allowInitiatorPat: false })
  })
})
