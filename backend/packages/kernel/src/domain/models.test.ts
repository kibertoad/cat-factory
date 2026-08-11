import type { ModelFamilyPolicy, ModelFlavor, SubscriptionVendor } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { HarnessKind, ModelRef } from '../ports/model-provider.js'
import {
  ALL_SUBSCRIPTION_VENDORS,
  DEFAULT_PROVIDER_PREFERENCE,
  INDIVIDUAL_VENDORS,
  MODEL_FLAVORS,
  type ProviderCapabilities,
  SUBSCRIPTION_VENDORS,
  contextWindowFor,
  effectiveCatalog,
  effectiveCatalogWith,
  getSelectableModel,
  individualVendorForModelId,
  isAmbientNativeVendor,
  isIndividualVendor,
  isModelUsable,
  isModelUsableInline,
  localSelectableModels,
  nativeVendorForRef,
  openRouterSelectableModels,
  parseLocalModelId,
  parseOpenRouterModelId,
  personalCredentialVendorForModelId,
  resolveBedrockModelId,
  resolveModelRef,
  runsOnSubscriptionHarness,
  subscriptionOptionFor,
  subscriptionVendorForRef,
} from './models.js'

/** A capability set with nothing configured; each test opts into exactly what it needs. */
function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    directProviders: new Set<string>(),
    subscriptionVendors: new Set<SubscriptionVendor>(),
    cloudflareEnabled: false,
    ...over,
  }
}

const option = (id: string, c: ProviderCapabilities = caps()) => {
  const found = effectiveCatalog(c).find((o) => o.id === id)
  if (!found) throw new Error(`no catalog option for '${id}'`)
  return found
}

describe('resolveBedrockModelId', () => {
  it('returns the operator entry verbatim when it IS the catalog base id', () => {
    const c = caps({ bedrockModels: new Set(['anthropic.claude-opus-4-8']) })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBe('anthropic.claude-opus-4-8')
  })

  it('matches a geo/global inference prefix and keeps the operator prefix in the answer', () => {
    const c = caps({ bedrockModels: new Set(['eu.anthropic.claude-opus-4-8']) })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBe(
      'eu.anthropic.claude-opus-4-8',
    )
  })

  it('requires the dot before the base id, so a bare-prefix concatenation does not match', () => {
    const c = caps({ bedrockModels: new Set(['euanthropic.claude-opus-4-8']) })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBeUndefined()
  })

  it('matches on the END of the entry, not the start', () => {
    const c = caps({ bedrockModels: new Set(['anthropic.claude-opus-4-8.extra']) })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBeUndefined()
  })

  it('takes the FIRST matching entry in the operator declaration order', () => {
    const c = caps({
      bedrockModels: new Set([
        'global.anthropic.claude-opus-4-8',
        'eu.anthropic.claude-opus-4-8',
        'anthropic.claude-opus-4-8',
      ]),
    })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBe(
      'global.anthropic.claude-opus-4-8',
    )
  })

  it('is undefined when the allow-list omits the model, is empty, or is absent entirely', () => {
    expect(
      resolveBedrockModelId('anthropic.claude-opus-4-8', caps({ bedrockModels: new Set(['x.y']) })),
    ).toBeUndefined()
    expect(
      resolveBedrockModelId('anthropic.claude-opus-4-8', caps({ bedrockModels: new Set() })),
    ).toBeUndefined()
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', caps())).toBeUndefined()
  })
})

describe('contextWindowFor', () => {
  it('resolves a concrete ref the catalog declares a window for', () => {
    expect(contextWindowFor({ provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8' })).toBe(
      32_768,
    )
    expect(contextWindowFor({ provider: 'qwen', model: 'qwen3.7-max' })).toBe(1_000_000)
  })

  it('keys per REF, so one model can carry different windows on different routes', () => {
    const cloudflare = contextWindowFor({ provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' })
    const subscription = contextWindowFor({ provider: 'zai', model: 'glm-5.2' })
    expect(cloudflare).toBe(262_144)
    expect(subscription).toBe(1_000_000)
    expect(cloudflare).not.toBe(subscription)
  })

  it('resolves a bedrock ref through its catalog BASE id, prefix and all', () => {
    expect(contextWindowFor({ provider: 'bedrock', model: 'openai.gpt-oss-120b' })).toBe(131_072)
    expect(contextWindowFor({ provider: 'bedrock', model: 'eu.openai.gpt-oss-120b' })).toBe(131_072)
    expect(contextWindowFor({ provider: 'bedrock', model: 'global.openai.gpt-5.5' })).toBe(
      1_050_000,
    )
  })

  it('does not fall through to the bedrock bases for a non-bedrock provider', () => {
    expect(contextWindowFor({ provider: 'openai', model: 'openai.gpt-oss-120b' })).toBeUndefined()
  })

  it('is undefined for an unknown ref and for a bedrock base declaring no window', () => {
    expect(contextWindowFor({ provider: 'qwen', model: 'not-a-model' })).toBeUndefined()
    expect(contextWindowFor({ provider: 'bedrock', model: 'nothing.at.all' })).toBeUndefined()
    // `claude-opus-4-8` deliberately declares no Bedrock window (per-account, unverified).
    expect(
      contextWindowFor({ provider: 'bedrock', model: 'anthropic.claude-opus-4-8' }),
    ).toBeUndefined()
  })
})

describe('isModelUsable', () => {
  it('is false for an unknown, absent or empty id', () => {
    expect(isModelUsable('not-a-model', caps({ cloudflareEnabled: true }))).toBe(false)
    expect(isModelUsable(undefined, caps({ cloudflareEnabled: true }))).toBe(false)
    expect(isModelUsable(null, caps({ cloudflareEnabled: true }))).toBe(false)
    expect(isModelUsable('', caps({ cloudflareEnabled: true }))).toBe(false)
  })

  it('gates a cloudflare flavour on the opt-in Workers AI lib', () => {
    expect(isModelUsable('cloudflare-llama', caps())).toBe(false)
    expect(isModelUsable('cloudflare-llama', caps({ cloudflareEnabled: true }))).toBe(true)
  })

  it('gates a direct flavour on a key for THAT provider', () => {
    expect(isModelUsable('kimi-k3', caps({ directProviders: new Set(['qwen']) }))).toBe(false)
    expect(isModelUsable('kimi-k3', caps({ directProviders: new Set(['moonshot']) }))).toBe(true)
  })

  it('gates an openrouter flavour on the openrouter key alone, not on the enabled-slug set', () => {
    expect(isModelUsable('claude-fable', caps())).toBe(false)
    expect(isModelUsable('claude-fable', caps({ directProviders: new Set(['openrouter']) }))).toBe(
      true,
    )
  })

  it('gates a subscription flavour on a token for THAT vendor', () => {
    expect(isModelUsable('claude-sonnet', caps({ subscriptionVendors: new Set(['codex']) }))).toBe(
      false,
    )
    expect(isModelUsable('claude-sonnet', caps({ subscriptionVendors: new Set(['claude']) }))).toBe(
      true,
    )
  })

  it('gates a bedrock flavour on the model being in the allow-list', () => {
    expect(isModelUsable('claude-opus-4-8', caps())).toBe(false)
    expect(
      isModelUsable('claude-opus-4-8', caps({ bedrockModels: new Set(['openai.gpt-5.5']) })),
    ).toBe(false)
    expect(
      isModelUsable(
        'claude-opus-4-8',
        caps({ bedrockModels: new Set(['us.anthropic.claude-opus-4-8']) }),
      ),
    ).toBe(true)
  })

  describe('a local-runner model', () => {
    it('needs no pooled key, but needs THIS model enabled', () => {
      expect(isModelUsable('ollama:gemma3', caps())).toBe(false)
      expect(
        isModelUsable('ollama:gemma3', caps({ localModels: new Set(['ollama:gemma3']) })),
      ).toBe(true)
    })

    it('rejects a stale pin to a model the user later un-enabled', () => {
      expect(isModelUsable('ollama:gemma3', caps({ localModels: new Set(['ollama:qwen3']) }))).toBe(
        false,
      )
    })

    it('keys the enabled set on `<provider>:<model>`, so a runner alone does not admit it', () => {
      expect(isModelUsable('ollama:gemma3', caps({ directProviders: new Set(['ollama']) }))).toBe(
        false,
      )
    })
  })

  describe('a dynamic OpenRouter model', () => {
    const slug = 'openrouter:google/gemini-3.1-pro-preview'

    it('needs BOTH the workspace key and the slug enabled', () => {
      expect(isModelUsable(slug, caps({ openRouterModels: new Set() }))).toBe(false)
      expect(isModelUsable(slug, caps({ directProviders: new Set(['openrouter']) }))).toBe(false)
      expect(
        isModelUsable(slug, caps({ openRouterModels: new Set(['google/gemini-3.1-pro-preview']) })),
      ).toBe(false)
      expect(
        isModelUsable(
          slug,
          caps({
            directProviders: new Set(['openrouter']),
            openRouterModels: new Set(['google/gemini-3.1-pro-preview']),
          }),
        ),
      ).toBe(true)
    })

    it('rejects a stale pin to a since-disabled slug', () => {
      expect(
        isModelUsable(
          slug,
          caps({
            directProviders: new Set(['openrouter']),
            openRouterModels: new Set(['openai/gpt-5.6-sol']),
          }),
        ),
      ).toBe(false)
    })
  })
})

describe('resolveModelRef (the effective variant)', () => {
  it('is undefined for an unknown, absent or empty id', () => {
    expect(resolveModelRef('not-a-model', caps())).toBeUndefined()
    expect(resolveModelRef(undefined, caps())).toBeUndefined()
    expect(resolveModelRef(null, caps())).toBeUndefined()
    expect(resolveModelRef('', caps())).toBeUndefined()
  })

  it('prefers a USABLE route over a merely declared one', () => {
    // `qwen` declares cloudflare + direct + openrouter. With only the OpenRouter key
    // configured, the direct route is declared but unusable, so OpenRouter wins.
    expect(resolveModelRef('qwen', caps({ directProviders: new Set(['openrouter']) }))).toEqual({
      provider: 'openrouter',
      model: 'qwen/qwen3.7-max',
      contextTokens: 1_000_000,
    })
    expect(resolveModelRef('qwen', caps({ directProviders: new Set(['qwen']) }))).toEqual({
      provider: 'qwen',
      model: 'qwen3.7-max',
      contextTokens: 1_000_000,
    })
  })

  it('walks the DEFAULT preference when several routes are usable', () => {
    const all = caps({
      directProviders: new Set(['qwen', 'openrouter']),
      cloudflareEnabled: true,
    })
    expect(DEFAULT_PROVIDER_PREFERENCE.indexOf('direct')).toBeLessThan(
      DEFAULT_PROVIDER_PREFERENCE.indexOf('openrouter'),
    )
    expect(resolveModelRef('qwen', all)?.provider).toBe('qwen')
  })

  it('honours a preset preference that REORDERS the routes', () => {
    const all = (providerPreference?: readonly ModelFlavor[]) =>
      caps({
        directProviders: new Set(['qwen', 'openrouter']),
        cloudflareEnabled: true,
        ...(providerPreference ? { providerPreference } : {}),
      })
    expect(resolveModelRef('qwen', all(['cloudflare']))?.provider).toBe('workers-ai')
    expect(resolveModelRef('qwen', all(['openrouter']))?.provider).toBe('openrouter')
    // An empty preference falls back to the default order rather than filtering everything out.
    expect(resolveModelRef('qwen', all([]))?.provider).toBe('qwen')
  })

  it('reorders the DECLARED walk too, so the picker and the run agree on an unconfigured deployment', () => {
    // Nothing is configured here, so both walks fall through to DECLARED, which takes the
    // most preferred route the model names at all.
    expect(resolveModelRef('qwen', caps())?.provider).toBe('qwen')
    expect(resolveModelRef('qwen', caps({ providerPreference: ['cloudflare'] }))?.provider).toBe(
      'workers-ai',
    )
    expect(resolveModelRef('qwen', caps({ providerPreference: ['openrouter'] }))?.provider).toBe(
      'openrouter',
    )
  })

  it('falls back to the catalog BASE id for an unresolvable bedrock-only entry', () => {
    expect(resolveModelRef('claude-opus-4-8', caps())).toEqual({
      provider: 'bedrock',
      model: 'anthropic.claude-opus-4-8',
      acceptsImages: true,
    })
    expect(
      resolveModelRef(
        'claude-opus-4-8',
        caps({ bedrockModels: new Set(['us.anthropic.claude-opus-4-8']) }),
      ),
    ).toEqual({
      provider: 'bedrock',
      model: 'us.anthropic.claude-opus-4-8',
      acceptsImages: true,
    })
  })

  it('carries the bedrock window when the catalog declares one, and omits it when it does not', () => {
    expect(resolveModelRef('gpt-oss-120b', caps({ providerPreference: ['bedrock'] }))).toEqual({
      provider: 'bedrock',
      model: 'openai.gpt-oss-120b',
      contextTokens: 131_072,
    })
    expect(resolveModelRef('claude-opus-4-8', caps())).not.toHaveProperty('contextTokens')
  })

  it('carries the harness on a subscription route', () => {
    expect(resolveModelRef('claude-sonnet', caps())).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      harness: 'claude-code',
      contextTokens: 1_000_000,
      acceptsImages: true,
    })
  })

  it('resolves a dynamic local id straight to its ref, without needing capabilities', () => {
    expect(resolveModelRef('ollama:gemma3', caps())).toEqual({
      provider: 'ollama',
      model: 'gemma3',
    })
  })

  it('resolves a dynamic OpenRouter id straight to the gateway ref', () => {
    expect(resolveModelRef('openrouter:google/gemini-3.1-pro-preview', caps())).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-3.1-pro-preview',
    })
  })
})

describe('effectiveCatalog', () => {
  it('projects every catalog entry exactly once', () => {
    const ids = effectiveCatalog(caps()).map((o) => o.id)
    expect(ids).toContain('qwen')
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => getSelectableModel(id) !== undefined)).toBe(true)
  })

  it('reports the effective route, its label and its provider', () => {
    const o = option('qwen', caps({ directProviders: new Set(['qwen']) }))
    expect(o).toMatchObject({
      id: 'qwen',
      flavor: 'direct',
      provider: 'qwen',
      model: 'qwen3.7-max',
      providerLabel: 'DashScope',
      available: true,
      contextTokens: 1_000_000,
    })
    expect(o.label).toBe('Qwen3.7')
    expect(o.description).toBe(getSelectableModel('qwen')?.description)
  })

  it('labels a cloudflare and a bedrock route with their platform, not the vendor', () => {
    expect(option('cloudflare-llama').providerLabel).toBe('Cloudflare')
    expect(option('claude-opus-4-8').providerLabel).toBe('AWS Bedrock')
  })

  it('labels a subscription route with the VENDOR label and names the vendor', () => {
    const o = option('claude-sonnet')
    expect(o.providerLabel).toBe(SUBSCRIPTION_VENDORS.claude.label)
    expect(o.vendor).toBe('claude')
  })

  it('reports availability, and marks only a subscription route as quota-based', () => {
    expect(option('cloudflare-llama').available).toBe(false)
    expect(option('cloudflare-llama', caps({ cloudflareEnabled: true })).available).toBe(true)
    expect(option('claude-sonnet').quotaBased).toBe(true)
    expect(option('cloudflare-llama').quotaBased).toBeUndefined()
  })

  it('reports whether the EFFECTIVE route caches prompt prefixes', () => {
    // Workers AI does not cache; the same model's direct DashScope route does.
    expect(option('qwen', caps({ cloudflareEnabled: true })).cachesPrompts).toBe(false)
    expect(option('qwen', caps({ directProviders: new Set(['qwen']) })).cachesPrompts).toBe(true)
  })

  it('omits the window for a route the catalog declares none for', () => {
    expect(option('claude-opus-4-8')).not.toHaveProperty('contextTokens')
  })

  describe('the family policy', () => {
    const blockClaude: ModelFamilyPolicy = {
      mode: 'blocklist',
      families: ['claude'],
      trustedProviders: [],
    }

    it('flags a blocked model and withholds availability even when it is configured', () => {
      const o = option(
        'claude-sonnet',
        caps({ subscriptionVendors: new Set(['claude']), modelPolicy: blockClaude }),
      )
      expect(o.policyBlocked).toBe(true)
      expect(o.available).toBe(false)
    })

    it('leaves an unblocked model unflagged rather than flagging it false', () => {
      const o = option('cloudflare-llama', caps({ modelPolicy: blockClaude }))
      expect(o).not.toHaveProperty('policyBlocked')
    })

    it('gates on the EFFECTIVE route, so a trusted route exempts the family', () => {
      const policy: ModelFamilyPolicy = {
        mode: 'blocklist',
        families: ['claude'],
        trustedProviders: ['bedrock'],
      }
      const c = caps({
        bedrockModels: new Set(['anthropic.claude-opus-4-8']),
        subscriptionVendors: new Set(['claude']),
        modelPolicy: policy,
      })
      expect(option('claude-opus-4-8', c)).toMatchObject({ provider: 'bedrock', available: true })
      expect(option('claude-sonnet', c).policyBlocked).toBe(true)
    })
  })

  describe('the informational cost', () => {
    it('attaches the resolver answer for the effective ref and omits it when absent', () => {
      const cost = { inputPerMillion: 1, outputPerMillion: 2, currency: 'EUR' }
      const withCost = effectiveCatalog(caps(), (ref) =>
        ref.provider === 'workers-ai' ? cost : undefined,
      )
      expect(withCost.find((o) => o.id === 'cloudflare-llama')?.cost).toEqual(cost)
      expect(withCost.find((o) => o.id === 'claude-sonnet')).not.toHaveProperty('cost')
    })

    it('omits cost entirely when no resolver is supplied', () => {
      expect(option('cloudflare-llama')).not.toHaveProperty('cost')
    })
  })

  describe('a dual-mode model', () => {
    it('attaches the subscription route beside a non-subscription base', () => {
      const o = option('glm', caps({ cloudflareEnabled: true }))
      expect(o.flavor).toBe('cloudflare')
      expect(o.subscription).toEqual({
        vendor: 'glm',
        providerLabel: SUBSCRIPTION_VENDORS.glm.label,
        provider: 'zai',
        model: 'glm-5.2',
        cachesPrompts: false,
        contextTokens: 1_000_000,
      })
    })

    it('does not attach it when the subscription IS the effective route', () => {
      const o = option('glm', caps({ subscriptionVendors: new Set(['glm']) }))
      expect(o.flavor).toBe('subscription')
      expect(o.subscription).toBeUndefined()
    })

    it('leaves a model with no subscription route without the attachment', () => {
      expect(option('cloudflare-llama').subscription).toBeUndefined()
    })

    it('prices the attached subscription ref separately from the base', () => {
      const withCost = effectiveCatalog(caps({ cloudflareEnabled: true }), (ref) =>
        ref.provider === 'zai'
          ? { inputPerMillion: 9, outputPerMillion: 9, currency: 'EUR' }
          : undefined,
      )
      const o = withCost.find((m) => m.id === 'glm')
      expect(o).not.toHaveProperty('cost')
      expect(o?.subscription?.cost).toEqual({
        inputPerMillion: 9,
        outputPerMillion: 9,
        currency: 'EUR',
      })
    })
  })
})

describe('effectiveCatalogWith', () => {
  it('appends the extra models after the static catalog', () => {
    const extra = localSelectableModels([
      { provider: 'ollama', label: 'Ollama', models: [{ id: 'gemma3' }] },
    ])
    const options = effectiveCatalogWith(extra, caps({ localModels: new Set(['ollama:gemma3']) }))
    expect(options.at(-1)).toMatchObject({
      id: 'ollama:gemma3',
      flavor: 'direct',
      provider: 'ollama',
      model: 'gemma3',
      providerLabel: 'Ollama',
      available: true,
    })
    expect(options.length).toBe(effectiveCatalog(caps()).length + 1)
  })

  it('matches the bare catalog when nothing extra is supplied', () => {
    expect(effectiveCatalogWith([], caps())).toEqual(effectiveCatalog(caps()))
  })
})

describe('localSelectableModels', () => {
  it('builds one direct-flavour entry per enabled model, id-prefixed by its runner', () => {
    expect(
      localSelectableModels([
        { provider: 'ollama', label: 'Ollama', models: [{ id: 'gemma3' }, { id: 'qwen3' }] },
        { provider: 'lmstudio', label: 'LM Studio', models: [{ id: 'phi4' }] },
      ]),
    ).toEqual([
      {
        id: 'ollama:gemma3',
        label: 'gemma3',
        description: 'Local model served by Ollama.',
        direct: {
          ref: { provider: 'ollama', model: 'gemma3' },
          keyEnv: '',
          providerLabel: 'Ollama',
        },
      },
      {
        id: 'ollama:qwen3',
        label: 'qwen3',
        description: 'Local model served by Ollama.',
        direct: {
          ref: { provider: 'ollama', model: 'qwen3' },
          keyEnv: '',
          providerLabel: 'Ollama',
        },
      },
      {
        id: 'lmstudio:phi4',
        label: 'phi4',
        description: 'Local model served by LM Studio.',
        direct: {
          ref: { provider: 'lmstudio', model: 'phi4' },
          keyEnv: '',
          providerLabel: 'LM Studio',
        },
      },
    ])
  })

  it('carries a DECLARED modality onto the ref, and omits an undeclared one', () => {
    // The picker renders off these refs, so a declared local model has to state its modality the
    // way a catalog flavour does. Omission is the point of the third state: an entry that always
    // carried `acceptsImages` could only ever say yes or no, and "nobody has said" is the honest
    // answer for a model whose weights this platform has never seen.
    const [multimodal, textOnly, undeclared] = localSelectableModels([
      {
        provider: 'ollama',
        label: 'Ollama',
        models: [
          { id: 'muse-glimmer:30b', acceptsImages: true },
          { id: 'qwen3', acceptsImages: false },
          { id: 'gemma3' },
        ],
      },
    ])
    expect(multimodal?.direct?.ref.acceptsImages).toBe(true)
    expect(textOnly?.direct?.ref.acceptsImages).toBe(false)
    expect(undeclared?.direct?.ref).not.toHaveProperty('acceptsImages')
  })

  it('yields nothing for no endpoints and for an endpoint with no enabled models', () => {
    expect(localSelectableModels([])).toEqual([])
    expect(localSelectableModels([{ provider: 'ollama', label: 'Ollama', models: [] }])).toEqual([])
  })
})

describe('openRouterSelectableModels', () => {
  it('builds an openrouter-flavour entry carrying the cached window', () => {
    expect(
      openRouterSelectableModels([
        {
          id: 'google/gemini-3.1-pro-preview',
          name: 'Gemini 3.1 Pro',
          contextLength: 1_000_000,
          inputPerMillion: 1,
          outputPerMillion: 2,
        },
      ]),
    ).toEqual([
      {
        id: 'openrouter:google/gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro',
        description: 'Gemini 3.1 Pro via OpenRouter.',
        openrouter: {
          ref: {
            provider: 'openrouter',
            model: 'google/gemini-3.1-pro-preview',
            contextTokens: 1_000_000,
          },
          keyEnv: 'OPENROUTER_API_KEY',
          providerLabel: 'OpenRouter',
        },
      },
    ])
  })

  it('falls back to the slug when the metadata carries no name, and omits an absent window', () => {
    const [entry] = openRouterSelectableModels([
      { id: 'vendor/model', name: '', inputPerMillion: 1, outputPerMillion: 2 },
    ])
    expect(entry?.label).toBe('vendor/model')
    expect(entry?.description).toBe('vendor/model via OpenRouter.')
    expect(entry?.openrouter?.ref).toEqual({ provider: 'openrouter', model: 'vendor/model' })
  })

  it('yields nothing for an empty list', () => {
    expect(openRouterSelectableModels([])).toEqual([])
  })
})

describe('parseOpenRouterModelId', () => {
  it('strips the prefix and keeps the slashes inside the slug', () => {
    expect(parseOpenRouterModelId('openrouter:google/gemini-3.1-pro-preview')).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-3.1-pro-preview',
    })
  })

  it('rejects a non-OpenRouter id, the bare prefix, and an absent id', () => {
    expect(parseOpenRouterModelId('ollama:gemma3')).toBeUndefined()
    expect(parseOpenRouterModelId('openrouter')).toBeUndefined()
    expect(parseOpenRouterModelId('openrouter:')).toBeUndefined()
    expect(parseOpenRouterModelId('')).toBeUndefined()
    expect(parseOpenRouterModelId(undefined)).toBeUndefined()
    expect(parseOpenRouterModelId(null)).toBeUndefined()
  })
})

describe('parseLocalModelId', () => {
  it('splits on the FIRST colon so a model id containing colons round-trips', () => {
    expect(parseLocalModelId('ollama:qwen2.5-coder:32b')).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:32b',
    })
  })

  it('accepts every configured runner prefix and rejects an unknown one', () => {
    expect(parseLocalModelId('lmstudio:phi4')?.provider).toBe('lmstudio')
    expect(parseLocalModelId('vllm:phi4')?.provider).toBe('vllm')
    expect(parseLocalModelId('openrouter:google/gemini')).toBeUndefined()
    expect(parseLocalModelId('qwen:qwen3.7-max')).toBeUndefined()
  })

  it('rejects an id with no colon, a leading colon, or a trailing colon', () => {
    expect(parseLocalModelId('ollama')).toBeUndefined()
    expect(parseLocalModelId(':gemma3')).toBeUndefined()
    expect(parseLocalModelId('ollama:')).toBeUndefined()
    expect(parseLocalModelId('')).toBeUndefined()
    expect(parseLocalModelId(undefined)).toBeUndefined()
    expect(parseLocalModelId(null)).toBeUndefined()
  })
})

describe('subscriptionOptionFor', () => {
  it('returns the vendor and the harness-carrying ref', () => {
    expect(subscriptionOptionFor('glm')).toEqual({
      vendor: 'glm',
      ref: {
        provider: 'zai',
        model: 'glm-5.2',
        harness: 'claude-code',
        contextTokens: 1_000_000,
      },
    })
  })

  it('is undefined for a model with no subscription route, and for an unknown id', () => {
    expect(subscriptionOptionFor('cloudflare-llama')).toBeUndefined()
    expect(subscriptionOptionFor('not-a-model')).toBeUndefined()
    expect(subscriptionOptionFor(undefined)).toBeUndefined()
    expect(subscriptionOptionFor(null)).toBeUndefined()
  })
})

describe('the individual-use vendor flags', () => {
  it('flags exactly the consumer-tier vendors, and no commercial coding-plan vendor', () => {
    expect(isIndividualVendor('claude')).toBe(true)
    expect(isIndividualVendor('codex')).toBe(true)
    expect(isIndividualVendor('glm')).toBe(true)
    expect(isIndividualVendor('kimi')).toBe(false)
    expect(isIndividualVendor('deepseek')).toBe(false)
  })

  it('derives INDIVIDUAL_VENDORS from the same table rather than restating it', () => {
    expect([...INDIVIDUAL_VENDORS].sort()).toEqual(
      ALL_SUBSCRIPTION_VENDORS.filter(isIndividualVendor).sort(),
    )
    expect(INDIVIDUAL_VENDORS.length).toBeGreaterThan(0)
    expect(INDIVIDUAL_VENDORS.length).toBeLessThan(ALL_SUBSCRIPTION_VENDORS.length)
  })

  it('lists every configured vendor in ALL_SUBSCRIPTION_VENDORS', () => {
    expect([...ALL_SUBSCRIPTION_VENDORS].sort()).toEqual(Object.keys(SUBSCRIPTION_VENDORS).sort())
  })
})

describe('individualVendorForModelId', () => {
  it('names the vendor for a model on an individual-use subscription', () => {
    expect(individualVendorForModelId('claude-sonnet')).toBe('claude')
    expect(individualVendorForModelId('glm')).toBe('glm')
  })

  it('is null for a poolable vendor, a subscription-less model, and an unknown id', () => {
    expect(individualVendorForModelId('kimi')).toBeNull()
    expect(individualVendorForModelId('cloudflare-llama')).toBeNull()
    expect(individualVendorForModelId('not-a-model')).toBeNull()
    expect(individualVendorForModelId(undefined)).toBeNull()
  })
})

describe('personalCredentialVendorForModelId', () => {
  const never = () => false
  const always = () => true

  it('always requires the credential for a subscription-ONLY individual model', () => {
    expect(personalCredentialVendorForModelId('claude-sonnet', never)).toBe('claude')
    expect(personalCredentialVendorForModelId('claude-sonnet', always)).toBe('claude')
  })

  it('is per-user for a dual-mode individual model', () => {
    // `glm` carries a Cloudflare + OpenRouter base beside its subscription.
    expect(personalCredentialVendorForModelId('glm', always)).toBe('glm')
    expect(personalCredentialVendorForModelId('glm', never)).toBeNull()
  })

  it('counts an OPENROUTER base, so the pay-as-you-go route stays startable', () => {
    // `claude-opus` has no Cloudflare/direct route: OpenRouter is its only base.
    expect(personalCredentialVendorForModelId('claude-opus', never)).toBeNull()
    expect(personalCredentialVendorForModelId('claude-opus', always)).toBe('claude')
  })

  it('asks the predicate for the model’s OWN vendor', () => {
    const asked: SubscriptionVendor[] = []
    personalCredentialVendorForModelId('glm', (v) => {
      asked.push(v)
      return false
    })
    expect(asked).toEqual(['glm'])
  })

  it('is null for a poolable vendor, a subscription-less model, and an unknown id', () => {
    expect(personalCredentialVendorForModelId('kimi', always)).toBeNull()
    expect(personalCredentialVendorForModelId('cloudflare-llama', always)).toBeNull()
    expect(personalCredentialVendorForModelId('not-a-model', always)).toBeNull()
    expect(personalCredentialVendorForModelId(undefined, always)).toBeNull()
  })
})

describe('subscriptionVendorForRef', () => {
  it('resolves EVERY subscription vendor, native and base-URL-carrying alike', () => {
    expect(
      subscriptionVendorForRef({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        harness: 'claude-code',
      }),
    ).toBe('claude')
    expect(
      subscriptionVendorForRef({ provider: 'zai', model: 'glm-5.2', harness: 'claude-code' }),
    ).toBe('glm')
    expect(
      subscriptionVendorForRef({
        provider: 'moonshot',
        model: 'kimi-k2.6',
        harness: 'claude-code',
      }),
    ).toBe('kimi')
  })

  it('is undefined for a ref with no harness and for the Pi harness', () => {
    expect(subscriptionVendorForRef({ provider: 'zai', model: 'glm-5.2' })).toBeUndefined()
    expect(
      subscriptionVendorForRef({ provider: 'zai', model: 'glm-5.2', harness: 'pi' }),
    ).toBeUndefined()
  })

  it('is undefined for a harness ref the catalog declares no subscription for', () => {
    expect(
      subscriptionVendorForRef({ provider: 'zai', model: 'not-a-model', harness: 'claude-code' }),
    ).toBeUndefined()
    expect(
      subscriptionVendorForRef({
        provider: 'workers-ai',
        model: 'glm-5.2',
        harness: 'claude-code',
      }),
    ).toBeUndefined()
  })
})

describe('nativeVendorForRef', () => {
  it('resolves the two ambient-login vendors from a bare ref', () => {
    expect(nativeVendorForRef({ provider: 'openai', model: 'gpt-5.6-sol', harness: 'codex' })).toBe(
      'codex',
    )
    expect(
      nativeVendorForRef({ provider: 'anthropic', model: 'claude-opus-5', harness: 'claude-code' }),
    ).toBe('claude')
  })

  it('excludes a claude-code vendor that carries its own base URL', () => {
    expect(
      nativeVendorForRef({ provider: 'zai', model: 'glm-5.2', harness: 'claude-code' }),
    ).toBeUndefined()
    expect(
      nativeVendorForRef({ provider: 'moonshot', model: 'kimi-k2.6', harness: 'claude-code' }),
    ).toBeUndefined()
  })

  it('is undefined for a ref with no harness and for the Pi harness', () => {
    expect(nativeVendorForRef({ provider: 'anthropic', model: 'claude-opus-5' })).toBeUndefined()
    expect(
      nativeVendorForRef({ provider: 'anthropic', model: 'claude-opus-5', harness: 'pi' }),
    ).toBeUndefined()
  })

  it('agrees with the no-baseUrl predicate isAmbientNativeVendor enforces', () => {
    for (const vendor of ALL_SUBSCRIPTION_VENDORS) {
      const cfg = SUBSCRIPTION_VENDORS[vendor]
      expect(isAmbientNativeVendor([cfg.harness], vendor)).toBe(!cfg.baseUrl)
    }
  })
})

describe('isAmbientNativeVendor', () => {
  it('needs the vendor harness in the allow-list', () => {
    expect(isAmbientNativeVendor(['claude-code'], 'claude')).toBe(true)
    expect(isAmbientNativeVendor(['codex'], 'claude')).toBe(false)
    expect(isAmbientNativeVendor(['claude-code', 'codex'], 'codex')).toBe(true)
  })

  it('refuses a vendor carrying its own base URL even when its harness is allowed', () => {
    expect(isAmbientNativeVendor(['claude-code'], 'glm')).toBe(false)
    expect(isAmbientNativeVendor(['claude-code'], 'kimi')).toBe(false)
    expect(isAmbientNativeVendor(['claude-code'], 'deepseek')).toBe(false)
  })

  it('refuses everything for an absent or empty allow-list', () => {
    expect(isAmbientNativeVendor(undefined, 'claude')).toBe(false)
    expect(isAmbientNativeVendor([], 'claude')).toBe(false)
  })
})

describe('isModelUsableInline', () => {
  const runsInline = (ref: ModelRef) => ref.harness === 'claude-code'

  it('is false for a model that resolves to no ref at all', () => {
    expect(isModelUsableInline('not-a-model', caps(), runsInline)).toBe(false)
    expect(isModelUsableInline(undefined, caps(), runsInline)).toBe(false)
  })

  it('admits a usable non-subscription flavour without consulting runsInline', () => {
    let asked = false
    expect(
      isModelUsableInline('cloudflare-llama', caps({ cloudflareEnabled: true }), () => {
        asked = true
        return false
      }),
    ).toBe(true)
    expect(asked).toBe(false)
  })

  it('refuses a model whose only routes are unusable', () => {
    expect(isModelUsableInline('cloudflare-llama', caps(), runsInline)).toBe(false)
  })

  describe('a harness ref', () => {
    const subscribed = caps({ subscriptionVendors: new Set<SubscriptionVendor>(['claude']) })

    it('defers ENTIRELY to runsInline, even when the subscription token is present', () => {
      expect(isModelUsableInline('claude-sonnet', subscribed, runsInline)).toBe(true)
      expect(isModelUsableInline('claude-sonnet', subscribed, () => false)).toBe(false)
    })

    it('is false when the deployment supplies no runsInline at all', () => {
      expect(isModelUsableInline('claude-sonnet', subscribed)).toBe(false)
    })

    it('is asked about the RESOLVED ref', () => {
      const seen: ModelRef[] = []
      isModelUsableInline('claude-sonnet', subscribed, (ref) => {
        seen.push(ref)
        return true
      })
      expect(seen).toEqual([
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          harness: 'claude-code',
          contextTokens: 1_000_000,
          acceptsImages: true,
        },
      ])
    })
  })

  it('asks the ordinary usability rule for a ref that names no harness', () => {
    // A local-runner id parses straight into a harness-less ref, so the inline decision is
    // the plain one: usable because the runner serves the model, with `runsInline` never
    // consulted — the `false` it would answer is what makes that visible.
    const local = caps({ localModels: new Set(['ollama:gemma3']) })
    expect(resolveModelRef('ollama:gemma3', local)?.harness).toBeUndefined()
    expect(isModelUsableInline('ollama:gemma3', local, () => false)).toBe(true)
    expect(isModelUsableInline('ollama:gemma3', caps(), () => false)).toBe(false)
  })
})

describe('runsOnSubscriptionHarness', () => {
  // The rule `isModelUsableInline`, `subscriptionVendorForRef` and `nativeVendorForRef` all
  // turn on, two of them as its negation. Asserted on bare refs because that is the only
  // place `harness: 'pi'` is reachable: the catalog declares no Pi variant today, so a ref
  // resolved from a model id can never carry one, and a rule that only ever saw the two
  // spellings agree would let them drift apart unnoticed.
  const ref = (harness?: ModelRef['harness']): ModelRef => ({
    provider: 'anthropic',
    model: 'claude-opus-5',
    ...(harness ? { harness } : {}),
  })

  // A `Record` over the closed harness union rather than a hand-listed array: adding a
  // harness fails the BUILD here until it has picked a side, which is the whole point of
  // pinning a rule whose two spellings are negations of each other.
  const SIDE: Record<HarnessKind, boolean> = { pi: false, 'claude-code': true, codex: true }

  it('sorts every harness the vocabulary has, Pi to the metered side', () => {
    for (const [harness, subscription] of Object.entries(SIDE) as [HarnessKind, boolean][]) {
      expect(runsOnSubscriptionHarness(ref(harness))).toBe(subscription)
    }
  })

  it('is false for a ref that names no harness, Pi being the default', () => {
    expect(runsOnSubscriptionHarness(ref())).toBe(false)
  })

  it('withholds a vendor from a Pi ref that the two vendor lookups would otherwise match', () => {
    // `anthropic:claude-opus-5` IS a catalog subscription ref, so both lookups would answer
    // `claude` on the harness alone. The Pi spelling is what must stop them.
    expect(subscriptionVendorForRef(ref('claude-code'))).toBe('claude')
    expect(nativeVendorForRef(ref('claude-code'))).toBe('claude')
    expect(subscriptionVendorForRef(ref('pi'))).toBeUndefined()
    expect(nativeVendorForRef(ref('pi'))).toBeUndefined()
  })
})

describe('the flavour vocabulary', () => {
  it('is walked in a total order that names every route exactly once', () => {
    expect([...DEFAULT_PROVIDER_PREFERENCE].sort()).toEqual([...MODEL_FLAVORS].sort())
    expect(new Set(MODEL_FLAVORS).size).toBe(MODEL_FLAVORS.length)
  })

  it('resolves every catalog entry to a variant, so no entry can declare no route', () => {
    for (const opt of effectiveCatalog(caps())) {
      expect(MODEL_FLAVORS).toContain(opt.flavor)
      expect(opt.provider).not.toBe('')
      expect(opt.model).not.toBe('')
    }
  })
})

describe('getSelectableModel', () => {
  it('looks a model up by its stable id', () => {
    expect(getSelectableModel('qwen')?.label).toBe('Qwen3.7')
  })

  it('is undefined for an unknown, empty or absent id', () => {
    expect(getSelectableModel('not-a-model')).toBeUndefined()
    expect(getSelectableModel('')).toBeUndefined()
    expect(getSelectableModel(undefined)).toBeUndefined()
    expect(getSelectableModel(null)).toBeUndefined()
  })
})
