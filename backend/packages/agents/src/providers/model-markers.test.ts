import type { LanguageModel } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { MODEL_CATALOG, subscriptionVendorForRef } from '@cat-factory/kernel'
import type { ModelProvider, ModelRef, SubscriptionVendor } from '@cat-factory/kernel'
import { InstrumentedModelProvider, type WorkspaceBodiesGate } from './instrumented.js'
import { LimitedModelProvider, VendorConcurrencyLimiter } from './limited.js'
import { wrapModelPreservingMarkers } from './model-markers.js'
import { reportsOwnLlmCalls } from './cli-inline.js'
import { usageAttributionOf } from './usage-attribution.js'

// The wraps a resolved model passes through on the way to its reader, and the property that
// makes a marker mean anything: it survives them. `wrapLanguageModel` returns a FRESH object
// carrying only the six `LanguageModelV3` members, so a marker declared beneath a decorator
// reached its reader only while every decorator between them happened to be inert.
//
// The composition test is the one that matters. Each provider is individually plausible with a
// bare wrap, and the bug only exists once they are stacked the way `wrapResolverWithTelemetry`
// stacks them: instrumentation, then the concurrency limiter, whose cap is on by DEFAULT for
// every subscription vendor.

/**
 * A ref the limiter actually caps, taken from the catalog the limiter itself reads rather than
 * spelled out here: a hand-written ref that no longer maps to a vendor makes `resolve` return
 * the model UNWRAPPED, and the composition test then passes without composing anything.
 */
const SUBSCRIPTION_REF: ModelRef = (() => {
  const entry = MODEL_CATALOG.find((model) => model.subscription)
  if (!entry?.subscription) throw new Error('no subscription model in the catalog to test with')
  return entry.subscription.ref
})()
const SUBSCRIPTION_VENDOR: SubscriptionVendor = (() => {
  const vendor = subscriptionVendorForRef(SUBSCRIPTION_REF)
  if (!vendor) throw new Error('the catalog ref no longer maps to a subscription vendor')
  return vendor
})()

/** A model that declares both markers, standing in for a `CliInlineLanguageModel`. */
function markedModel(provider = SUBSCRIPTION_REF.provider): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider,
    modelId: SUBSCRIPTION_REF.model,
    supportedUrls: {},
    reportsOwnLlmCalls: true,
    usageAttribution: { billing: 'subscription', vendor: provider },
    doGenerate: async () => ({ content: [], finishReason: 'stop', usage: {}, warnings: [] }),
    doStream: async () => ({ stream: new ReadableStream(), warnings: [] }),
  } as unknown as LanguageModelV3
}

function providerOf(model: LanguageModel): ModelProvider {
  return { resolve: () => model }
}

const allowBodies: WorkspaceBodiesGate = () => Promise.resolve(true)

describe('wrapModelPreservingMarkers', () => {
  it('carries the markers onto the wrapper', () => {
    const wrapped = wrapModelPreservingMarkers({
      model: markedModel(),
      middleware: { specificationVersion: 'v3' },
    })

    expect(usageAttributionOf(wrapped)).toEqual({
      billing: 'subscription',
      vendor: SUBSCRIPTION_REF.provider,
    })
    expect(reportsOwnLlmCalls(wrapped)).toBe(true)
  })

  it('leaves a model that declares nothing declaring nothing', () => {
    // Not `undefined` markers: a plain provider key's model must stay one that says nothing, so
    // a later reader cannot tell a wrapped one from an unwrapped one.
    const plain = { ...markedModel('openai') } as Record<string, unknown>
    delete plain.reportsOwnLlmCalls
    delete plain.usageAttribution

    const wrapped = wrapModelPreservingMarkers({
      model: plain as unknown as LanguageModelV3,
      middleware: { specificationVersion: 'v3' },
    })

    expect('usageAttribution' in wrapped).toBe(false)
    expect('reportsOwnLlmCalls' in wrapped).toBe(false)
    expect(usageAttributionOf(wrapped)).toBeUndefined()
  })

  it('still applies the middleware it was given', () => {
    // The preservation must not come at the cost of the wrap doing its job.
    let wrapped = false
    const model = wrapModelPreservingMarkers({
      model: markedModel(),
      middleware: {
        specificationVersion: 'v3',
        wrapGenerate: async ({ doGenerate }) => {
          wrapped = true
          return doGenerate()
        },
      },
    })

    return model.doGenerate({ prompt: [] } as never).then(() => expect(wrapped).toBe(true))
  })
})

describe('the composed provider wraps', () => {
  it('keeps the billing marker readable through instrumentation and the limiter', () => {
    // The exact composition `wrapResolverWithTelemetry` builds, and the exact configuration a
    // default deployment runs: the limiter caps every subscription vendor at 3 unless an
    // operator sets `LLM_SUBSCRIPTION_MAX_CONCURRENCY`, so this wrap is NOT hypothetical. Read
    // the marker off the outermost model, which is all `AiAgentExecutor` ever holds.
    const model = markedModel()
    const instrumented = new InstrumentedModelProvider({
      inner: providerOf(model),
      recordCall: async () => {},
      workspaceBodiesEnabled: allowBodies,
    })
    const limiter = new VendorConcurrencyLimiter({ [SUBSCRIPTION_VENDOR]: 3 })

    const resolved = new LimitedModelProvider(instrumented, limiter).resolve(SUBSCRIPTION_REF)

    // The limiter DID wrap, so the marker is being read off a wrapper rather than off the model
    // that declared it. Without this the assertion below passes on an untouched pass-through.
    expect(resolved).not.toBe(model)
    expect(usageAttributionOf(resolved)).toEqual({
      billing: 'subscription',
      vendor: SUBSCRIPTION_REF.provider,
    })
  })

  it('keeps it readable when the instrumentation wraps rather than stands down', () => {
    // `reportsOwnLlmCalls` is what makes the instrumentation leave a harness model alone, and it
    // is false whenever that model was built with no telemetry (a deployment with a trace sink
    // and no metric store). The billing marker must not depend on that: it answers a different
    // question, and a wrapped model is still served by the same credential.
    const model = { ...markedModel(), reportsOwnLlmCalls: false } as unknown as LanguageModelV3
    const instrumented = new InstrumentedModelProvider({
      inner: providerOf(model),
      recordCall: async () => {},
      workspaceBodiesEnabled: allowBodies,
    })

    const resolved = new LimitedModelProvider(
      instrumented,
      new VendorConcurrencyLimiter({ [SUBSCRIPTION_VENDOR]: 3 }),
    ).resolve(SUBSCRIPTION_REF)

    expect(resolved).not.toBe(model)
    expect(reportsOwnLlmCalls(resolved)).toBe(false)
    expect(usageAttributionOf(resolved)).toEqual({
      billing: 'subscription',
      vendor: SUBSCRIPTION_REF.provider,
    })
  })
})
