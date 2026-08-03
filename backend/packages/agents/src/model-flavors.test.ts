import { describe, expect, it } from 'vitest'
import { modelFlavorSchema } from '@cat-factory/contracts'
import {
  DEFAULT_PROVIDER_PREFERENCE,
  MODEL_CATALOG,
  MODEL_FLAVORS,
  contextWindowFor,
  effectiveCatalog,
  isModelUsable,
  resolveBedrockModelId,
  resolveModelRef,
  type ProviderCapabilities,
  type SelectableModel,
} from '@cat-factory/kernel'

// The flavour vocabulary + the preference-driven resolver. Exercised here rather than in
// kernel (which has no vitest runner) for the same reason as `inline-model-resolution.test.ts`.

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  directProviders: new Set(),
  subscriptionVendors: new Set(),
  cloudflareEnabled: false,
  ...over,
})

/** A catalog entry that declares a bedrock flavour, so these assertions track the real catalog. */
const bedrockEntry = (): SelectableModel => {
  const model = MODEL_CATALOG.find((m) => m.bedrock)
  expect(model, 'the catalog must carry at least one bedrock flavour').toBeDefined()
  return model!
}

describe('the flavour vocabulary', () => {
  it('is exactly the wire picklist', () => {
    // `satisfies` already pins MODEL_FLAVORS ⊆ ModelFlavor at compile time. This is the other
    // direction, which no typecheck can see: a flavour contracts gained but the tuple lacks
    // would never be TRIED, because the resolver walks the tuple rather than the union.
    expect([...MODEL_FLAVORS].sort()).toEqual([...modelFlavorSchema.options].sort())
  })

  it('is the default preference, in full and without repeats', () => {
    // A missing entry is a route nothing ever resolves to; a duplicated one silently shifts
    // what a later preference edit is layered onto.
    expect(DEFAULT_PROVIDER_PREFERENCE).toEqual(MODEL_FLAVORS)
    expect(new Set(DEFAULT_PROVIDER_PREFERENCE).size).toBe(MODEL_FLAVORS.length)
  })

  it('prefers a first-party route over the aggregator that resells it', () => {
    const order = (f: string) => DEFAULT_PROVIDER_PREFERENCE.indexOf(f as never)
    expect(order('direct')).toBeLessThan(order('bedrock'))
    expect(order('bedrock')).toBeLessThan(order('openrouter'))
    // Cloudflare stays the always-available floor, below every route a key/account unlocks.
    expect(order('openrouter')).toBeLessThan(order('cloudflare'))
  })
})

describe('resolveBedrockModelId', () => {
  it('matches an unprefixed allow-list entry and returns it verbatim', () => {
    const c = caps({ bedrockModels: new Set(['anthropic.claude-opus-4-8']) })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBe('anthropic.claude-opus-4-8')
  })

  it('matches through a geo/global inference prefix, whichever Region the account is in', () => {
    for (const prefix of ['us.', 'eu.', 'jp.', 'au.', 'global.', 'apac.']) {
      const listed = `${prefix}anthropic.claude-opus-4-8`
      const c = caps({ bedrockModels: new Set([listed]) })
      // The OPERATOR's id comes back, not the catalog base: it is what their Region can call.
      expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBe(listed)
    }
  })

  it('lets the operator choose between two profiles for one model by ordering the list', () => {
    const regionalFirst = caps({
      bedrockModels: new Set(['us.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8']),
    })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', regionalFirst)).toBe(
      'us.anthropic.claude-opus-4-8',
    )
    const globalFirst = caps({
      bedrockModels: new Set(['global.anthropic.claude-opus-4-8', 'us.anthropic.claude-opus-4-8']),
    })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', globalFirst)).toBe(
      'global.anthropic.claude-opus-4-8',
    )
  })

  it('does not match a DIFFERENT model that merely shares a suffix boundary', () => {
    const c = caps({ bedrockModels: new Set(['anthropic.claude-opus-4-8-lite']) })
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', c)).toBeUndefined()
  })

  it('is undefined when the account listed nothing: the allow-list IS the enablement', () => {
    expect(resolveBedrockModelId('anthropic.claude-opus-4-8', caps())).toBeUndefined()
    expect(
      resolveBedrockModelId('anthropic.claude-opus-4-8', caps({ bedrockModels: new Set() })),
    ).toBeUndefined()
  })
})

describe('bedrock as a resolvable flavour', () => {
  it('is usable exactly when the allow-list carries the model', () => {
    const model = bedrockEntry()
    expect(isModelUsable(model.id, caps())).toBe(false)
    const enabled = caps({ bedrockModels: new Set([`eu.${model.bedrock!.baseModelId}`]) })
    expect(isModelUsable(model.id, enabled)).toBe(true)
  })

  it('resolves to the Region-correct id the operator listed, not the catalog base', () => {
    const model = bedrockEntry()
    const listed = `eu.${model.bedrock!.baseModelId}`
    const ref = resolveModelRef(model.id, caps({ bedrockModels: new Set([listed]) }))
    expect(ref).toMatchObject({ provider: 'bedrock', model: listed })
  })

  it('beats the gateway and the Cloudflare floor', () => {
    const model = MODEL_CATALOG.find((m) => m.bedrock && m.cloudflare)
    expect(model, 'a bedrock flavour on a cloudflare-backed entry pins this').toBeDefined()
    // Cloudflare is on AND an OpenRouter key is present, yet Bedrock still wins: it is a
    // first-party route, and the gateway resells what it serves.
    const overBoth = caps({
      bedrockModels: new Set([model!.bedrock!.baseModelId]),
      cloudflareEnabled: true,
      directProviders: new Set(['openrouter']),
    })
    expect(resolveModelRef(model!.id, overBoth)?.provider).toBe('bedrock')
  })

  it('loses to a configured direct key on any entry carrying both routes', () => {
    // The catalog holds no bedrock+direct entry today (Bedrock lags every vendor the platform
    // has a direct key for), so this loop is currently EMPTY, deliberately rather than
    // silently: the tuple-order test above pins direct > bedrock regardless, and this becomes
    // the behavioural proof the moment such an entry lands.
    for (const model of MODEL_CATALOG.filter((m) => m.bedrock && m.direct)) {
      const withDirect = caps({
        bedrockModels: new Set([model.bedrock!.baseModelId]),
        directProviders: new Set([model.direct!.ref.provider]),
      })
      expect(resolveModelRef(model.id, withDirect)?.provider).toBe(model.direct!.ref.provider)
    }
  })

  it('still yields a displayable ref when Bedrock is unconfigured, flagged unavailable', () => {
    // A bedrock-ONLY entry must not make the resolver throw on the deployments (most of them)
    // that have no Bedrock: the picker needs a row to render as "not configured".
    const bedrockOnly = MODEL_CATALOG.filter(
      (m) => m.bedrock && !m.cloudflare && !m.direct && !m.openrouter && !m.subscription,
    )
    expect(bedrockOnly.length).toBeGreaterThan(0)
    const catalog = effectiveCatalog(caps())
    for (const model of bedrockOnly) {
      const option = catalog.find((o) => o.id === model.id)!
      expect(option.flavor).toBe('bedrock')
      expect(option.providerLabel).toBe('AWS Bedrock')
      // The BASE id, because there is no allow-list entry to prefer over it.
      expect(option.model).toBe(model.bedrock!.baseModelId)
      expect(option.available).toBe(false)
    }
  })

  it('resolves every catalog id under a Bedrock-enabled deployment', () => {
    const all = caps({
      bedrockModels: new Set(
        MODEL_CATALOG.flatMap((m) => (m.bedrock ? [m.bedrock.baseModelId] : [])),
      ),
    })
    for (const model of MODEL_CATALOG) expect(resolveModelRef(model.id, all)).toBeDefined()
  })
})

describe('contextWindowFor on a Bedrock ref', () => {
  it('finds the declared window through the operator prefix the catalog cannot know', () => {
    const model = MODEL_CATALOG.find((m) => m.bedrock?.contextTokens)
    expect(model, 'at least one bedrock flavour should declare a window').toBeDefined()
    const { baseModelId, contextTokens } = model!.bedrock!
    expect(contextWindowFor({ provider: 'bedrock', model: baseModelId })).toBe(contextTokens)
    // The ref a run actually carries is the PREFIXED id, so an exact-key lookup would miss and
    // the LLM proxy would stop capping the requested output for this model.
    expect(contextWindowFor({ provider: 'bedrock', model: `eu.${baseModelId}` })).toBe(
      contextTokens,
    )
  })

  it('is undefined for a Bedrock id the catalog does not carry', () => {
    expect(contextWindowFor({ provider: 'bedrock', model: 'amazon.nova-nope' })).toBeUndefined()
  })
})
