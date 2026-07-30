import { afterEach, describe, expect, it } from 'vitest'
import { InstrumentedModelProvider, vendorConcurrencyLimiterFromEnv } from '@cat-factory/agents'
import { CompositeTraceSink, type LlmTraceSink } from '@cat-factory/kernel'
import { NodeOtelTraceSink } from '@cat-factory/observability-otel/node'
import { LangfuseTraceSink } from '@cat-factory/observability-langfuse'
import { wrapResolverWithTelemetry } from '@cat-factory/server'
import { createNodeModelProviderResolver, inlineInstrumentFromEnv } from '../src/modelProvider.js'

// Guards the per-facade WIRING of the inline OpenTelemetry (and Langfuse) feeder — the
// part that can drift from the Worker even though the feeder itself
// (InstrumentedModelProvider) is shared runtime-neutral code. The cross-runtime
// conformance suite cannot cover it (it bypasses the model provider via the fake
// executor), so each facade asserts its own wiring. Mirrors `langfuse-wiring.spec.ts`,
// and additionally pins that BOTH sinks compose into a CompositeTraceSink when enabled,
// and that a caller-supplied instrument is the one used (one shared SDK exporter).

const OTEL_ENV = {
  OTEL_ENABLED: 'true',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318',
}
const LANGFUSE_ENV = {
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
}
const scope = { workspaceId: 'ws_test' }
const bodiesEnabled = () => Promise.resolve(true)

/** Reach the (private) trace sink an instrumented provider was wrapped with. */
function sinkOf(provider: unknown): LlmTraceSink {
  return (provider as { traceSink: LlmTraceSink }).traceSink
}

/** No vendor capped, so the limiter is a pass-through and the instrumentation is what shows. */
const noCaps = vendorConcurrencyLimiterFromEnv(() => '0')

/** Compose exactly as a facade does: base resolver, then the telemetry wraps on top. */
function resolverFor(env: NodeJS.ProcessEnv) {
  const instrument = inlineInstrumentFromEnv(env, bodiesEnabled)
  return wrapResolverWithTelemetry(createNodeModelProviderResolver(env, undefined), {
    ...(instrument ? { instrument } : {}),
    limiter: noCaps,
  })
}

// SDK sinks own background exporters; shut them down after each test so no timers leak.
const cleanup: { shutdown?: () => Promise<void> }[] = []
function track(sink: LlmTraceSink): LlmTraceSink {
  if (sink instanceof NodeOtelTraceSink) cleanup.push(sink)
  if (sink instanceof CompositeTraceSink) {
    for (const inner of (sink as unknown as { sinks: LlmTraceSink[] }).sinks) {
      if (inner instanceof NodeOtelTraceSink) cleanup.push(inner)
    }
  }
  return sink
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((s) => s.shutdown?.()))
})

describe('Node facade: inline OpenTelemetry instrumentation wiring', () => {
  it('wraps the per-scope provider when OTel is enabled with an endpoint', async () => {
    const provider = await resolverFor(OTEL_ENV as NodeJS.ProcessEnv).forScope(scope)
    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
    expect(track(sinkOf(provider))).toBeInstanceOf(NodeOtelTraceSink)
  })

  it('leaves the provider unwrapped when OTel is off', async () => {
    const provider = await resolverFor({} as NodeJS.ProcessEnv).forScope(scope)
    expect(provider).not.toBeInstanceOf(InstrumentedModelProvider)
  })

  it('stays unwrapped when enabled without an endpoint (half-configured ⇒ off)', async () => {
    const provider = await resolverFor({ OTEL_ENABLED: 'true' } as NodeJS.ProcessEnv).forScope(
      scope,
    )
    expect(provider).not.toBeInstanceOf(InstrumentedModelProvider)
  })

  it('composes a CompositeTraceSink when BOTH Langfuse and OTel are enabled', async () => {
    const env = { ...LANGFUSE_ENV, ...OTEL_ENV } as NodeJS.ProcessEnv
    const provider = await resolverFor(env).forScope(scope)
    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
    const sink = track(sinkOf(provider))
    expect(sink).toBeInstanceOf(CompositeTraceSink)
    const inner = (sink as unknown as { sinks: LlmTraceSink[] }).sinks
    expect(inner.some((s) => s instanceof LangfuseTraceSink)).toBe(true)
    expect(inner.some((s) => s instanceof NodeOtelTraceSink)).toBe(true)
  })

  it('uses a caller-supplied instrument instead of the env (one shared sink)', async () => {
    // The container passes ONE pre-built sink so the SDK exporter isn't duplicated across
    // wiring sites; the wrap must instrument with THAT instance, not a fresh env-built one.
    const shared = track(
      new NodeOtelTraceSink({ endpoint: 'http://collector.test:4318', serviceName: 'shared' }),
    )
    // Env has OTel OFF — proving the sink came from the passed instrument, not the env.
    const resolver = wrapResolverWithTelemetry(
      createNodeModelProviderResolver({} as NodeJS.ProcessEnv, undefined),
      {
        instrument: {
          traceSink: shared,
          recordPrompts: true,
          workspaceBodiesEnabled: bodiesEnabled,
        },
        limiter: noCaps,
      },
    )
    const provider = await resolver.forScope(scope)
    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
    expect(sinkOf(provider)).toBe(shared)
  })
})
