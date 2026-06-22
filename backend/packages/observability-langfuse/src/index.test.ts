import { describe, expect, it, vi } from 'vitest'
import type { LlmGenerationEvent } from '@cat-factory/kernel'
import { LangfuseTraceSink } from './index.js'

function baseEvent(overrides: Partial<LlmGenerationEvent> = {}): LlmGenerationEvent {
  return {
    workspaceId: 'ws1',
    executionId: 'exec1',
    agentKind: 'coder',
    provider: 'openai',
    model: 'gpt-4o-mini',
    startedAt: 1_000,
    endedAt: 1_500,
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    finishReason: 'stop',
    ok: true,
    errorMessage: null,
    input: '[{"role":"user","content":"hi"}]',
    output: 'hello',
    ...overrides,
  }
}

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 200 }))
}

function parseBatch(fetchImpl: ReturnType<typeof okFetch>) {
  const [, init] = fetchImpl.mock.calls[0]!
  return JSON.parse(String(init!.body)).batch as Array<{
    type: string
    body: Record<string, unknown>
  }>
}

describe('LangfuseTraceSink', () => {
  it('posts a trace + generation to the ingestion endpoint with Basic auth', async () => {
    const fetchImpl = okFetch()
    const sink = new LangfuseTraceSink({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lf.example.com/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await sink.recordGeneration(baseEvent())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    // Trailing slash on baseUrl is normalised.
    expect(url).toBe('https://lf.example.com/api/public/ingestion')
    expect((init!.headers as Record<string, string>).authorization).toBe(`Basic ${btoa('pk:sk')}`)

    const batch = parseBatch(fetchImpl)
    const trace = batch.find((e) => e.type === 'trace-create')!
    const gen = batch.find((e) => e.type === 'generation-create')!
    // The run id groups every call under one trace.
    expect(trace.body.id).toBe('exec1')
    expect(gen.body.traceId).toBe('exec1')
    expect(gen.body.model).toBe('gpt-4o-mini')
    expect(gen.body.usage).toMatchObject({ input: 100, output: 40, total: 140 })
    expect(gen.body.input).toBe('[{"role":"user","content":"hi"}]')
    expect(gen.body.output).toBe('hello')
    expect(gen.body.level).toBe('DEFAULT')
  })

  it('omits prompt/response bodies when they are empty (LLM_RECORD_PROMPTS=false)', async () => {
    const fetchImpl = okFetch()
    const sink = new LangfuseTraceSink({
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await sink.recordGeneration(baseEvent({ input: '', output: '' }))

    const gen = parseBatch(fetchImpl).find((e) => e.type === 'generation-create')!
    expect(gen.body.input).toBeUndefined()
    expect(gen.body.output).toBeUndefined()
    // Usage/timing/metadata are still present.
    expect(gen.body.usage).toMatchObject({ input: 100, output: 40 })
  })

  it('marks failed calls as ERROR with a status message and a standalone trace when no run', async () => {
    const fetchImpl = okFetch()
    const sink = new LangfuseTraceSink({
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await sink.recordGeneration(
      baseEvent({ executionId: null, ok: false, errorMessage: 'boom', finishReason: null }),
    )

    const batch = parseBatch(fetchImpl)
    const gen = batch.find((e) => e.type === 'generation-create')!
    expect(gen.body.level).toBe('ERROR')
    expect(gen.body.statusMessage).toBe('boom')
    // No execution → a fresh standalone trace id (a uuid), not null.
    expect(typeof gen.body.traceId).toBe('string')
    expect(gen.body.traceId).not.toBe('null')
  })

  it('never throws when the ingestion request fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const warn = vi.fn()
    const sink = new LangfuseTraceSink({
      publicKey: 'pk',
      secretKey: 'sk',
      logger: { warn },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(sink.recordGeneration(baseEvent())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('emits one span-create per tool span under the run trace, skipping when no run', async () => {
    const fetchImpl = okFetch()
    const sink = new LangfuseTraceSink({
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: 'exec1', agentKind: 'coder' }, [
      { tool: 'edit_file', startedAt: 1, endedAt: 2, ok: true },
      { tool: 'run_command', startedAt: 3, endedAt: 4, ok: false },
    ])
    // No execution id ⇒ nothing is sent.
    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: null, agentKind: 'coder' }, [
      { tool: 'x', startedAt: 1, endedAt: 2, ok: true },
    ])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const batch = parseBatch(fetchImpl)
    expect(batch).toHaveLength(2)
    expect(batch.every((e) => e.type === 'span-create')).toBe(true)
    expect(batch[1]!.body.level).toBe('ERROR')
  })
})
