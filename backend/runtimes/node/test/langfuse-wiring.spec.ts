import { describe, expect, it } from 'vitest'
import { LangfuseTraceSink } from '@cat-factory/observability-langfuse'
import { inlineInstrumentFromEnv } from '../src/modelProvider.js'

// Guards the per-facade WIRING of the inline Langfuse feeder — the part that can drift
// from the Worker even though the feeder itself (InstrumentedModelProvider) is shared
// runtime-neutral code. The cross-runtime conformance suite cannot cover this: it drives
// runs through the deterministic FakeAgentExecutor, which bypasses both the LLM proxy
// (the proxied feeder) and the model provider (the inline feeder), so no real generation
// is ever produced for a sink to capture. So each facade asserts its own wiring instead:
// with Langfuse configured the facade MUST build an instrument carrying its sink; without
// it, no instrument at all (so `wrapResolverWithInstrumentation` is a pass-through and the
// inline path behaves exactly as before). The Worker builds its own instrument inline in
// `container.ts` (unexported, so unreachable from a test without booting a container); what
// both facades share is the WRAP, and that the instrument then reaches every resolved model —
// including one a facade wrap substituted — is pinned in `inline-call-metrics-wiring.spec.ts`
// and `local/src/harnessInline.test.ts`.

const LANGFUSE_ENV = {
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
}

const bodiesEnabled = () => Promise.resolve(true)

describe('Node facade: inline Langfuse instrumentation wiring', () => {
  it('builds an instrument carrying the Langfuse sink when both keys are set', () => {
    const instrument = inlineInstrumentFromEnv(LANGFUSE_ENV as NodeJS.ProcessEnv, bodiesEnabled)
    expect(instrument?.traceSink).toBeInstanceOf(LangfuseTraceSink)
  })

  it('builds no instrument when Langfuse is off', () => {
    expect(inlineInstrumentFromEnv({} as NodeJS.ProcessEnv, bodiesEnabled)).toBeUndefined()
  })

  it('builds none when only one key is set (half-configured ⇒ off)', () => {
    const env = {
      LANGFUSE_ENABLED: 'true',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
    } as NodeJS.ProcessEnv
    expect(inlineInstrumentFromEnv(env, bodiesEnabled)).toBeUndefined()
  })

  it('carries the deployment-wide LLM_RECORD_PROMPTS switch onto the instrument', () => {
    const off = { ...LANGFUSE_ENV, LLM_RECORD_PROMPTS: 'false' } as NodeJS.ProcessEnv
    expect(inlineInstrumentFromEnv(off, bodiesEnabled)?.recordPrompts).toBe(false)
    expect(
      inlineInstrumentFromEnv(LANGFUSE_ENV as NodeJS.ProcessEnv, bodiesEnabled)?.recordPrompts,
    ).toBe(true)
  })
})
