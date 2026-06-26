import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import type { LlmGenerationEvent } from '@cat-factory/kernel'
import { LangfuseTraceSink } from './index.js'

// The sink POSTs to Langfuse's ingestion API over the global `fetch`. We intercept that real
// fetch with undici's MockAgent (the same engine that backs Node's fetch) rather than injecting
// a hand-stubbed `fetchImpl`, so the test exercises the actual fetch → Response path the sink
// uses in production. `disableNetConnect` makes any un-mocked request fail loudly.
const CLOUD = 'https://cloud.langfuse.com'
const INGEST = '/api/public/ingestion'

let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
})

afterEach(async () => {
  setGlobalDispatcher(previousDispatcher)
  await agent.close()
})

interface BatchEvent {
  type: string
  body: Record<string, unknown>
}
interface CapturedIngestion {
  /** The request path (full, incl. any query) — asserts baseUrl normalisation. */
  path: string
  headers: Record<string, string>
  batch: BatchEvent[]
}

/** Intercept the next ingestion POST to `origin` and capture its request for assertions. */
function captureIngestion(origin: string): () => CapturedIngestion {
  let captured: CapturedIngestion | undefined
  agent
    .get(origin)
    .intercept({ path: INGEST, method: 'POST' })
    .reply(200, (opts) => {
      captured = {
        path: String(opts.path),
        headers: opts.headers as Record<string, string>,
        batch: JSON.parse(String(opts.body)).batch as BatchEvent[],
      }
      return ''
    })
  return () => {
    if (!captured) throw new Error('ingestion endpoint was not called')
    return captured
  }
}

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

describe('LangfuseTraceSink', () => {
  it('posts a trace + generation to the ingestion endpoint with Basic auth', async () => {
    const captured = captureIngestion('https://lf.example.com')
    const sink = new LangfuseTraceSink({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lf.example.com/',
    })

    await sink.recordGeneration(baseEvent())

    const req = captured()
    // Trailing slash on baseUrl is normalised (an un-normalised `//api/...` path would not
    // match the interceptor and the disabled net connection would throw instead).
    expect(req.path).toBe(INGEST)
    expect(req.headers.authorization).toBe(`Basic ${btoa('pk:sk')}`)

    const trace = req.batch.find((e) => e.type === 'trace-create')!
    const gen = req.batch.find((e) => e.type === 'generation-create')!
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
    const captured = captureIngestion(CLOUD)
    const sink = new LangfuseTraceSink({ publicKey: 'pk', secretKey: 'sk' })

    await sink.recordGeneration(baseEvent({ input: '', output: '' }))

    const gen = captured().batch.find((e) => e.type === 'generation-create')!
    expect(gen.body.input).toBeUndefined()
    expect(gen.body.output).toBeUndefined()
    // Usage/timing/metadata are still present.
    expect(gen.body.usage).toMatchObject({ input: 100, output: 40 })
  })

  it('marks failed calls as ERROR with a status message and a standalone trace when no run', async () => {
    const captured = captureIngestion(CLOUD)
    const sink = new LangfuseTraceSink({ publicKey: 'pk', secretKey: 'sk' })

    await sink.recordGeneration(
      baseEvent({ executionId: null, ok: false, errorMessage: 'boom', finishReason: null }),
    )

    const gen = captured().batch.find((e) => e.type === 'generation-create')!
    expect(gen.body.level).toBe('ERROR')
    expect(gen.body.statusMessage).toBe('boom')
    // No execution → a fresh standalone trace id (a uuid), not null.
    expect(typeof gen.body.traceId).toBe('string')
    expect(gen.body.traceId).not.toBe('null')
  })

  it('never throws when the ingestion request fails', async () => {
    agent
      .get(CLOUD)
      .intercept({ path: INGEST, method: 'POST' })
      .replyWithError(new Error('network down'))
    const warn = vi.fn()
    const sink = new LangfuseTraceSink({ publicKey: 'pk', secretKey: 'sk', logger: { warn } })

    await expect(sink.recordGeneration(baseEvent())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('emits one span-create per tool span under the run trace, skipping when no run', async () => {
    const captured = captureIngestion(CLOUD)
    const sink = new LangfuseTraceSink({ publicKey: 'pk', secretKey: 'sk' })

    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: 'exec1', agentKind: 'coder' }, [
      { tool: 'edit_file', startedAt: 1, endedAt: 2, ok: true },
      { tool: 'run_command', startedAt: 3, endedAt: 4, ok: false },
    ])
    // No execution id ⇒ nothing is sent (the interceptor stays unused, so only one POST lands).
    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: null, agentKind: 'coder' }, [
      { tool: 'x', startedAt: 1, endedAt: 2, ok: true },
    ])

    const batch = captured().batch
    expect(batch).toHaveLength(2)
    expect(batch.every((e) => e.type === 'span-create')).toBe(true)
    expect(batch[1]!.body.level).toBe('ERROR')
  })
})
