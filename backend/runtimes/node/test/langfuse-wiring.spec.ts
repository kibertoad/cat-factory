import { describe, expect, it } from 'vitest'
import { InstrumentedModelProvider } from '@cat-factory/agents'
import { createNodeModelProvider } from '../src/modelProvider.js'

// Guards the per-facade WIRING of the inline Langfuse feeder — the part that can drift
// from the Worker even though the feeder itself (InstrumentedModelProvider) is shared
// runtime-neutral code. The cross-runtime conformance suite cannot cover this: it drives
// runs through the deterministic FakeAgentExecutor, which bypasses both the LLM proxy
// (the proxied feeder) and the model provider (the inline feeder), so no real generation
// is ever produced for a sink to capture. So each facade asserts its own wiring instead:
// with Langfuse configured the model provider every inline caller resolves through MUST
// be the instrumented wrapper; without it, the bare provider (no behaviour change). The
// Worker's symmetric assertion lives in its own suite.

const LANGFUSE_ENV = {
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
}

describe('Node facade: inline Langfuse instrumentation wiring', () => {
  it('wraps the model provider when Langfuse is enabled with both keys', () => {
    const provider = createNodeModelProvider(LANGFUSE_ENV as NodeJS.ProcessEnv)
    expect(provider).toBeInstanceOf(InstrumentedModelProvider)
  })

  it('leaves the provider unwrapped when Langfuse is off', () => {
    expect(createNodeModelProvider({} as NodeJS.ProcessEnv)).not.toBeInstanceOf(
      InstrumentedModelProvider,
    )
  })

  it('stays unwrapped when only one key is set (half-configured ⇒ off)', () => {
    const provider = createNodeModelProvider({
      LANGFUSE_ENABLED: 'true',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
    } as NodeJS.ProcessEnv)
    expect(provider).not.toBeInstanceOf(InstrumentedModelProvider)
  })
})
