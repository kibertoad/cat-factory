import { describe, expect, it } from 'vitest'
import { InstrumentedModelProvider, vendorConcurrencyLimiterFromEnv } from '@cat-factory/agents'
import type { InlineLlmCall } from '@cat-factory/kernel'
import { type InlineInstrumentation, wrapResolverWithTelemetry } from '@cat-factory/server'
import { createNodeModelProviderResolver } from '../src/modelProvider.js'

// Guards the per-facade WIRING of the inline `llm_call_metrics` feeder — the half that can
// drift between runtimes even though the feeder itself (InstrumentedModelProvider) is shared
// runtime-neutral code, and the half the cross-runtime conformance suite cannot reach (it
// asserts the recorder → real store round trip, but bypasses the model provider entirely via
// the fake executor). Mirrors `langfuse-wiring.spec.ts` / `otel-wiring.spec.ts`, which exist
// for the same reason on the trace-sink half.
//
// The case that matters here is the one the trace-sink specs never had to consider: a
// deployment that retains metrics and wires NO external observability backend at all. That is
// the DEFAULT shape — `TELEMETRY_DB` / the `telemetry` schema are always present, Langfuse and
// OTel are both opt-in — so if `recordCall` alone failed to instrument, inline calls would stay
// invisible on almost every real deployment.
//
// What this file does NOT cover is the composition ORDER (the instrumentation must wrap a
// facade's model-substituting wrap, not sit beneath it). That order belongs to the ONE composer
// both facades go through, so it is asserted structurally beside it in
// `server/src/agents/modelProviderResolver.test.ts` and behaviourally — through a wrap that
// really substitutes — in `local/src/harnessInline.test.ts`.

const scope = { workspaceId: 'ws_test' }
/** No vendor capped, so the limiter is a pass-through and the instrumentation is what shows. */
const noCaps = vendorConcurrencyLimiterFromEnv(() => '0')
const recorderOnly = (recorded: InlineLlmCall[] = []): InlineInstrumentation => ({
  recordCall: (call: InlineLlmCall) => {
    recorded.push(call)
    return Promise.resolve()
  },
  recordPrompts: true,
  workspaceBodiesEnabled: () => Promise.resolve(true),
})

describe('Node facade: inline call-metrics instrumentation wiring', () => {
  it('instruments on the metric recorder ALONE, with no trace sink configured', async () => {
    const resolver = wrapResolverWithTelemetry(
      // Env has Langfuse and OTel OFF — proving the wrap came from the recorder.
      createNodeModelProviderResolver({} as NodeJS.ProcessEnv, undefined),
      { instrument: recorderOnly(), limiter: noCaps },
    )
    expect(await resolver.forScope(scope)).toBeInstanceOf(InstrumentedModelProvider)
  })

  it('stays transparent: a provider build failure still throws, and records nothing', async () => {
    // The wrap must not change what the underlying provider does, and must not manufacture a
    // metric row for a call that never reached a model. (What it records when a call DOES run
    // is `instrumented.test.ts`' subject — that needs a fake model, not a facade.)
    const recorded: InlineLlmCall[] = []
    const resolver = wrapResolverWithTelemetry(
      createNodeModelProviderResolver(
        { OPENAI_BASE_URL: 'http://unused.test' } as NodeJS.ProcessEnv,
        undefined,
      ),
      { instrument: recorderOnly(recorded), limiter: noCaps },
    )
    const provider = await resolver.forScope(scope)
    // No API key is configured for any direct provider in this env, so `resolve` throws. The
    // wrap must let that surface unchanged rather than swallowing or reshaping it.
    expect(() => provider.resolve({ provider: 'openai', model: 'gpt-4o' })).toThrow()
    expect(recorded).toHaveLength(0)
  })

  it('leaves the resolver untouched when nothing is wired (no middleware to pay for)', async () => {
    const resolver = wrapResolverWithTelemetry(
      createNodeModelProviderResolver({} as NodeJS.ProcessEnv, undefined),
      { limiter: noCaps },
    )
    expect(await resolver.forScope(scope)).not.toBeInstanceOf(InstrumentedModelProvider)
  })
})
