import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { createRecordingLogger, type LlmGenerationEvent } from '@cat-factory/kernel'
import { createLangfuseSink } from './index.js'

// The sink is the OTLP exporter pointed at Langfuse, so what this package decides is exactly three
// things: WHERE it posts, WHAT it authenticates with, and which signals Langfuse takes. How a
// generation maps onto a span is the exporter's own contract and is asserted in its package.
//
// The real fetch is intercepted with undici's MockAgent (the engine behind Node's fetch) rather
// than a hand-stubbed `fetchImpl`, so the test exercises the actual fetch → Response path.
// `disableNetConnect` makes any un-mocked request fail loudly, which is what turns "posts nothing
// to /v1/metrics" into an assertion rather than an absence nobody checked.
const CLOUD = 'https://cloud.langfuse.com'
const TRACES = '/api/public/otel/v1/traces'

let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  // Node's built-in `fetch` binds to its OWN bundled undici, which ignores a dispatcher set on
  // the userland `undici` package, so the MockAgent above would be silently bypassed and the sink
  // would hit the REAL Langfuse endpoint. Route the SUT's `fetch` through userland undici's fetch,
  // which honours the dispatcher we set.
  vi.stubGlobal('fetch', undiciFetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  setGlobalDispatcher(previousDispatcher)
  await agent.close()
})

interface CapturedExport {
  path: string
  headers: Record<string, string>
  spans: Record<string, unknown>[]
}

/** Intercept the next OTLP trace POST to `origin` and capture it for assertions. */
function captureTraces(origin: string): () => CapturedExport {
  let captured: CapturedExport | undefined
  agent
    .get(origin)
    .intercept({ path: TRACES, method: 'POST' })
    .reply(200, (opts) => {
      const payload = JSON.parse(String(opts.body)) as {
        resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[]
      }
      captured = {
        path: String(opts.path),
        headers: opts.headers as Record<string, string>,
        spans: payload.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
      }
      return ''
    })
  return () => {
    if (!captured) throw new Error('the OTLP trace endpoint was not called')
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
    cacheReadTokens: 900,
    cacheWriteTokens: 40,
    completionTokens: 40,
    totalTokens: 1_080,
    finishReason: 'stop',
    ok: true,
    errorMessage: null,
    input: '[{"role":"user","content":"hi"}]',
    output: 'hello',
    ...overrides,
  }
}

describe('createLangfuseSink', () => {
  it('exports a generation to Langfuse OTLP trace path with Basic auth', async () => {
    const captured = captureTraces('https://lf.example.com')
    const sink = createLangfuseSink({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lf.example.com/',
    })

    await sink.recordGeneration(baseEvent())

    const req = captured()
    // A trailing slash on baseUrl is normalised: an un-normalised `//api/...` path would miss the
    // interceptor and the disabled net connection would throw instead.
    expect(req.path).toBe(TRACES)
    expect(req.headers.authorization).toBe(`Basic ${btoa('pk:sk')}`)
    // Without this header v4 ingests up to ten minutes late, which reads as data loss to whoever
    // is watching a run finish.
    expect(req.headers['x-langfuse-ingestion-version']).toBe('4')
    expect(req.spans).toHaveLength(1)
  })

  it('posts no metrics, because Langfuse implements the traces signal only', async () => {
    const captured = captureTraces(CLOUD)
    const sink = createLangfuseSink({ publicKey: 'pk', secretKey: 'sk' })

    await sink.recordGeneration(baseEvent())

    // `disableNetConnect` is the assertion: a `/v1/metrics` POST has no interceptor, so it would
    // reject rather than pass unnoticed. Langfuse would answer it 404 once per generation.
    expect(captured().spans).toHaveLength(1)
  })

  it('never throws when the export fails', async () => {
    agent.get(CLOUD).intercept({ path: TRACES, method: 'POST' }).replyWithError(new Error('down'))
    const logger = createRecordingLogger()
    const sink = createLangfuseSink({ publicKey: 'pk', secretKey: 'sk', logger })

    await expect(sink.recordGeneration(baseEvent())).resolves.toBeUndefined()
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('exports tool spans under the run, and skips a dispatch with no run to hang them on', async () => {
    const captured = captureTraces(CLOUD)
    const sink = createLangfuseSink({ publicKey: 'pk', secretKey: 'sk' })

    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: 'exec1', agentKind: 'coder' }, [
      { tool: 'edit_file', startedAt: 1, endedAt: 2, ok: true },
      { tool: 'run_command', startedAt: 3, endedAt: 4, ok: false },
    ])
    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: null, agentKind: 'coder' }, [
      { tool: 'x', startedAt: 1, endedAt: 2, ok: true },
    ])

    // One POST, two spans: the second call had no run to parent them to, and the unused
    // interceptor plus the disabled net connection are what say it sent nothing.
    expect(captured().spans).toHaveLength(2)
  })
})
