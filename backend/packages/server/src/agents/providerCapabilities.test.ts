import type { AppCaches, ModelFamilyPolicy } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityServices } from './providerCapabilities.js'
import { resolveWorkspaceCapabilities } from './providerCapabilities.js'

// The account-wide model-family policy has to flow from the owning account's settings into
// `ProviderCapabilities.modelPolicy` so the /models catalog + the start guard agree. This
// pins that wiring (the facades all compose this resolver), independently of the pure
// `isAllowedByFamilyPolicy` logic covered by the kernel unit tests.

const blocklist: ModelFamilyPolicy = {
  mode: 'blocklist',
  families: ['deepseek'],
  trustedProviders: [],
}

function servicesWith(
  policy: ModelFamilyPolicy | undefined,
  over: Partial<CapabilityServices> = {},
): { services: CapabilityServices; read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async () => ({ config: policy ? { modelPolicy: policy } : {} }))
  const services: CapabilityServices = {
    modelPolicySupported: true,
    workspaceAccountOf: async () => 'acc-1',
    accountSettings: { read } as unknown as CapabilityServices['accountSettings'],
    ...over,
  }
  return { services, read }
}

describe('resolveWorkspaceCapabilities — model policy', () => {
  it('surfaces a non-off account policy on the capabilities', async () => {
    const { services } = servicesWith(blocklist)
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.modelPolicy).toEqual(blocklist)
  })

  it('does not read or apply the policy when the deployment does not support it', async () => {
    const { services, read } = servicesWith(blocklist, { modelPolicySupported: false })
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.modelPolicy).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('treats an `off` policy as no restriction', async () => {
    const { services } = servicesWith({ mode: 'off', families: [], trustedProviders: [] })
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.modelPolicy).toBeUndefined()
  })

  it('omits the policy for a legacy/unscoped workspace with no owning account', async () => {
    const { services, read } = servicesWith(blocklist, { workspaceAccountOf: async () => null })
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.modelPolicy).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('degrades to no restriction when the account-settings read throws', async () => {
    const read = vi.fn(async () => {
      throw new Error('account settings unavailable (mothership RPC allow-list)')
    })
    const services: CapabilityServices = {
      modelPolicySupported: true,
      workspaceAccountOf: async () => 'acc-1',
      accountSettings: { read } as unknown as CapabilityServices['accountSettings'],
    }
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.modelPolicy).toBeUndefined()
  })

  it('reads through the account-policy cache (keyed + grouped by account id)', async () => {
    const { services, read } = servicesWith(blocklist)
    const get = vi.fn(async (_key: string, _group: string, load: () => Promise<unknown>) => load())
    services.caches = { accountModelPolicy: { get } } as unknown as AppCaches
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.modelPolicy).toEqual(blocklist)
    expect(get).toHaveBeenCalledWith('acc-1', 'acc-1', expect.any(Function))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('serves a cached policy without re-reading account settings', async () => {
    const { services, read } = servicesWith(blocklist)
    const get = vi.fn(async () => ({ policy: blocklist }))
    services.caches = { accountModelPolicy: { get } } as unknown as AppCaches
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.modelPolicy).toEqual(blocklist)
    expect(read).not.toHaveBeenCalled()
  })
})

// A vendor NATIVE local execution serves from the host's own `claude`/`codex` login has no
// credential in either store, so a resolver that consulted only those two called it unconfigured
// on the very machine that could run it — while the personal-credential gate, reading the same
// allow-list, had already decided it needs no unlock. These pin the two halves to one answer.
describe('resolveWorkspaceCapabilities — ambient native vendors', () => {
  const stores = {
    subscriptions: {
      hasToken: async () => false,
    } as unknown as CapabilityServices['subscriptions'],
    personalSubscriptions: {
      has: async () => false,
      list: async () => [],
    } as unknown as CapabilityServices['personalSubscriptions'],
  }

  it('admits an allow-listed native vendor with no token and no user', async () => {
    const caps = await resolveWorkspaceCapabilities(
      { ...stores, nativeAmbientAuth: ['claude-code'] },
      'ws-1',
    )
    expect([...caps.subscriptionVendors]).toEqual(['claude'])
  })

  it('does not consult either credential store for one', async () => {
    const hasToken = vi.fn(async () => false)
    const has = vi.fn(async () => false)
    const caps = await resolveWorkspaceCapabilities(
      {
        subscriptions: { hasToken } as unknown as CapabilityServices['subscriptions'],
        personalSubscriptions: { has } as unknown as CapabilityServices['personalSubscriptions'],
        nativeAmbientAuth: ['claude-code', 'codex'],
      },
      'ws-1',
      'usr-1',
    )
    expect(caps.subscriptionVendors.has('claude')).toBe(true)
    expect(caps.subscriptionVendors.has('codex')).toBe(true)
    // Both were asked about the vendors the allow-list does NOT serve, and about neither of the
    // two it does: an ambient vendor is usable whatever the stores answer.
    for (const vendor of ['claude', 'codex']) {
      expect(hasToken).not.toHaveBeenCalledWith('ws-1', vendor)
      expect(has).not.toHaveBeenCalledWith('usr-1', vendor)
    }
  })

  it('leaves a vendor that merely REUSES the claude-code harness to its own credential', async () => {
    // GLM carries its own `baseUrl`, which ambient auth would drop — so it leases normally and is
    // NOT admitted by the allow-list. Same rule `isAmbientNativeVendor` states for the executor.
    const caps = await resolveWorkspaceCapabilities(
      { ...stores, nativeAmbientAuth: ['claude-code'] },
      'ws-1',
    )
    expect(caps.subscriptionVendors.has('glm')).toBe(false)
  })

  it('admits nothing when native mode is off (every other facade)', async () => {
    const caps = await resolveWorkspaceCapabilities({ ...stores }, 'ws-1')
    expect([...caps.subscriptionVendors]).toEqual([])
  })
})
