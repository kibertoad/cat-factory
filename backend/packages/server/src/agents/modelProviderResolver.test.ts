import { describe, expect, it } from 'vitest'
import {
  InstrumentedModelProvider,
  LimitedModelProvider,
  VendorConcurrencyLimiter,
} from '@cat-factory/agents'
import type {
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  ModelScope,
} from '@cat-factory/kernel'
import { type InlineInstrumentation, wrapResolverWithTelemetry } from './modelProviderResolver.js'

// `wrapResolverWithTelemetry` exists ONLY to own an order, so this suite asserts the order and
// nothing else. The two wraps it composes are AI-SDK middlewares around a RESOLVED model, so each
// sees exactly what the wrap beneath it returned — and one facade wrap SUBSTITUTES that model
// instead of delegating (local mode's subscription-inline harness answers a subscription harness
// ref with its own `CliInlineLanguageModel`). Instrumenting beneath that wrap is what made every
// inline step on a host `claude`/`codex` login record zero calls while the same step on a metered
// API model recorded fine.
//
// The check is STRUCTURAL — who wraps whom — because that is the property, and because a
// structural assertion needs no generation to drive and so cannot rot at an SDK spec bump. The
// behavioural half (a substituted call actually landing in `llm_call_metrics`, through this same
// composer) is `runtimes/local/src/harnessInline.test.ts`, which is where a substituting wrap
// really exists.

/** A subscription ref, so the limiter actually engages rather than passing through. */
const CLAUDE_SUB: ModelRef = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  harness: 'claude-code',
}

/**
 * Stands in for a resolved model; nothing here drives a generation. Typed off the port rather
 * than off `ai` directly — the SDK is not a dependency of this package.
 */
type ResolvedModel = ReturnType<ModelProvider['resolve']>
const BASE_MODEL = { id: 'base' } as unknown as ResolvedModel
const SUBSTITUTE_MODEL = { id: 'substitute' } as unknown as ResolvedModel

const baseResolver: ModelProviderResolver = {
  forScope: () => Promise.resolve({ resolve: () => BASE_MODEL }),
}

/**
 * The shape of the local facade's wrap: for a subscription harness ref it answers with its OWN
 * model rather than delegating, which is exactly why it must sit BENEATH the instrumentation.
 */
function substitutingWrap(inner: ModelProviderResolver): ModelProviderResolver {
  return {
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      const provider = await inner.forScope(scope)
      return {
        resolve: (ref: ModelRef) =>
          ref.harness === 'claude-code' ? SUBSTITUTE_MODEL : provider.resolve(ref),
      }
    },
  }
}

const instrument: InlineInstrumentation = {
  recordCall: () => Promise.resolve(),
  recordPrompts: true,
  workspaceBodiesEnabled: () => Promise.resolve(true),
}

/** A limiter that caps something, so it is not the `isEmpty` pass-through. */
const capping = new VendorConcurrencyLimiter({ claude: 1 })
/** A limiter that caps nothing — the shape a deployment with no configured caps gets. */
const passThrough = new VendorConcurrencyLimiter({})

/** Reach a wrapper's (private) inner provider. Its position IS the invariant under test. */
function innerOf(provider: unknown): unknown {
  return (provider as { inner: unknown }).inner
}

const scope: ModelScope = { workspaceId: 'ws_1' }

describe('wrapResolverWithTelemetry', () => {
  it('composes facade wrap → instrumentation → limiter, in that order', async () => {
    // The whole point. Read outside-in: the limiter is outermost (so a queue wait is never
    // counted as generation time), the instrumentation is inside it, and the facade's own
    // substituting wrap is beneath BOTH — so the model it substitutes is still observed.
    const provider = await wrapResolverWithTelemetry(substitutingWrap(baseResolver), {
      instrument,
      limiter: capping,
    }).forScope(scope)

    expect(provider).toBeInstanceOf(LimitedModelProvider)
    const instrumented = innerOf(provider)
    expect(instrumented).toBeInstanceOf(InstrumentedModelProvider)
    // Reversed, this is where the bug lived: the instrumentation's inner would be the BASE
    // provider and the substituted model would never pass through it.
    expect((innerOf(instrumented) as ModelProvider).resolve(CLAUDE_SUB)).toBe(SUBSTITUTE_MODEL)
  })

  it('still instruments when the limiter caps nothing', async () => {
    // A pass-through limiter returns its inner resolver unchanged, so the instrumentation must
    // be what the caller ends up with — not silently dropped along with the limiter.
    const provider = await wrapResolverWithTelemetry(substitutingWrap(baseResolver), {
      instrument,
      limiter: passThrough,
    }).forScope(scope)

    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
  })

  it('still caps when nothing is instrumented', async () => {
    // The two wraps are independent: a deployment retaining no metrics and configuring no sink
    // keeps its concurrency cap.
    const provider = await wrapResolverWithTelemetry(baseResolver, { limiter: capping }).forScope(
      scope,
    )

    expect(provider).toBeInstanceOf(LimitedModelProvider)
    expect(innerOf(provider)).not.toBeInstanceOf(InstrumentedModelProvider)
  })

  it('adds no middleware at all when neither is wired', async () => {
    const provider = await wrapResolverWithTelemetry(baseResolver, {
      limiter: passThrough,
    }).forScope(scope)

    expect(provider).not.toBeInstanceOf(LimitedModelProvider)
    expect(provider).not.toBeInstanceOf(InstrumentedModelProvider)
    expect(provider.resolve(CLAUDE_SUB)).toBe(BASE_MODEL)
  })
})
