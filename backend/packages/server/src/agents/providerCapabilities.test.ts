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

describe('resolveWorkspaceCapabilities: locally-run models', () => {
  // The enabled-model set is what `isModelUsable` asks about a `"<provider>:<model>"` pin, so it
  // has to carry the model IDS. Each enabled model arrives as a DECLARATION object (the id plus
  // what the user declared about it), and reading the id off it is the whole assertion: keying on
  // the object instead produced `ollama:[object Object]`, which typechecks, and greys out every
  // locally-run model in the picker while refusing every run pinned to one.
  const capabilitiesFor = async () => [
    {
      provider: 'ollama' as const,
      label: 'Ollama',
      models: [{ id: 'gemma4:12b', acceptsImages: true }, { id: 'my-finetune' }],
    },
  ]

  it('keys the enabled set on the declared model id', async () => {
    const services: CapabilityServices = {
      localModelEndpoints: {
        capabilitiesFor,
      } as unknown as CapabilityServices['localModelEndpoints'],
    }
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1', 'user-1')
    expect([...(caps.localModels ?? [])]).toEqual(['ollama:gemma4:12b', 'ollama:my-finetune'])
  })

  it('reads no endpoints for an unauthenticated caller (a runner is per-user)', async () => {
    const probe = vi.fn(capabilitiesFor)
    const services: CapabilityServices = {
      localModelEndpoints: {
        capabilitiesFor: probe,
      } as unknown as CapabilityServices['localModelEndpoints'],
    }
    const caps = await resolveWorkspaceCapabilities(services, 'ws-1')
    expect(caps.localModels?.size).toBe(0)
    expect(probe).not.toHaveBeenCalled()
  })
})
