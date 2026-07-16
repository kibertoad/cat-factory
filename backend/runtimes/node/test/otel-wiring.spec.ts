import { afterEach, describe, expect, it } from 'vitest'
import { InstrumentedModelProvider } from '@cat-factory/agents'
import { CompositeTraceSink, type LlmTraceSink } from '@cat-factory/kernel'
import { NodeOtelTraceSink } from '@cat-factory/observability-otel/node'
import { LangfuseTraceSink } from '@cat-factory/observability-langfuse'
import { createNodeModelProviderResolver } from '../src/modelProvider.js'

// Guards the per-facade WIRING of the inline OpenTelemetry (and Langfuse) feeder — the
// part that can drift from the Worker even though the feeder itself
// (InstrumentedModelProvider) is shared runtime-neutral code. The cross-runtime
// conformance suite cannot cover it (it bypasses the model provider via the fake
// executor), so each facade asserts its own wiring. Mirrors `langfuse-wiring.spec.ts`,
// and additionally pins that BOTH sinks compose into a CompositeTraceSink when enabled.

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

/** Reach the (private) trace sink the resolver instrumented the provider with. */
function sinkOf(provider: unknown): LlmTraceSink {
  return (provider as { traceSink: LlmTraceSink }).traceSink
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
    const resolver = createNodeModelProviderResolver(OTEL_ENV as NodeJS.ProcessEnv, undefined)
    const provider = await resolver.forScope(scope)
    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
    expect(track(sinkOf(provider))).toBeInstanceOf(NodeOtelTraceSink)
  })

  it('leaves the provider unwrapped when OTel is off', async () => {
    const resolver = createNodeModelProviderResolver({} as NodeJS.ProcessEnv, undefined)
    expect(await resolver.forScope(scope)).not.toBeInstanceOf(InstrumentedModelProvider)
  })

  it('stays unwrapped when enabled without an endpoint (half-configured ⇒ off)', async () => {
    const resolver = createNodeModelProviderResolver(
      { OTEL_ENABLED: 'true' } as NodeJS.ProcessEnv,
      undefined,
    )
    expect(await resolver.forScope(scope)).not.toBeInstanceOf(InstrumentedModelProvider)
  })

  it('composes a CompositeTraceSink when BOTH Langfuse and OTel are enabled', async () => {
    const resolver = createNodeModelProviderResolver(
      { ...LANGFUSE_ENV, ...OTEL_ENV } as NodeJS.ProcessEnv,
      undefined,
    )
    const provider = await resolver.forScope(scope)
    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
    const sink = track(sinkOf(provider))
    expect(sink).toBeInstanceOf(CompositeTraceSink)
    const inner = (sink as unknown as { sinks: LlmTraceSink[] }).sinks
    expect(inner.some((s) => s instanceof LangfuseTraceSink)).toBe(true)
    expect(inner.some((s) => s instanceof NodeOtelTraceSink)).toBe(true)
  })

  it('reuses a provided instrument instead of building its own (one shared sink)', async () => {
    // The container passes ONE pre-built sink so the SDK exporter isn't duplicated across
    // wiring sites; the resolver must instrument with THAT instance, not a fresh env-built one.
    const shared = track(
      new NodeOtelTraceSink({ endpoint: 'http://collector.test:4318', serviceName: 'shared' }),
    )
    const resolver = createNodeModelProviderResolver(
      // Env has OTel OFF — proving the sink came from the passed instrument, not the env.
      {} as NodeJS.ProcessEnv,
      undefined,
      undefined,
      { traceSink: shared, recordPrompts: true },
    )
    const provider = await resolver.forScope(scope)
    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
    expect(sinkOf(provider)).toBe(shared)
  })
})
