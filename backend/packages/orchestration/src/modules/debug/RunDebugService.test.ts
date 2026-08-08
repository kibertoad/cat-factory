import { describe, expect, it, vi } from 'vitest'
import type {
  AgentContextSnapshotRepository,
  AgentSearchQueryRepository,
  AgentToolCall,
  AgentToolCallRepository,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  LlmCallMetricPage,
  LlmCallMetricRepository,
  ProvisioningLogRepository,
} from '@cat-factory/kernel'
import { RunDebugService } from './RunDebugService.js'

const clock: Clock = { now: () => 4_242 }

function run(id: string, createdAt: number, over: Partial<ExecutionInstance> = {}) {
  return {
    id,
    blockId: 'blk_1',
    pipelineId: 'pl_build',
    pipelineName: 'Build',
    steps: [{ agentKind: 'coder', state: 'done', progress: 1, decision: null }],
    currentStep: 0,
    status: 'done',
    createdAt,
    ...over,
  } as ExecutionInstance
}

function call(id: string, createdAt: number): LlmCallMetricPage {
  return {
    id,
    workspaceId: 'ws',
    executionId: 'exec_1',
    agentKind: 'coder',
    provider: 'openai',
    model: 'gpt',
    createdAt,
    streaming: false,
    phase: 'agent',
    turnIndex: null,
    messageCount: 1,
    toolCount: 0,
    requestMaxTokens: null,
    promptTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 1,
    totalTokens: 2,
    finishReason: 'stop',
    upstreamMs: 1,
    overheadMs: 0,
    totalMs: 1,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptPrefixCount: 0,
    prompt: { text: '', totalChars: 10 },
    response: { text: '', totalChars: 10 },
    reasoning: { text: '', totalChars: 0 },
  }
}

/** An execution repo whose `listRecent` echoes whatever the fixture supplies. */
function executionRepo(rows: ExecutionInstance[]) {
  return {
    listRecent: vi.fn(async (_ws: string, opts: { limit: number }) => rows.slice(0, opts.limit)),
    get: vi.fn(async (_ws: string, id: string) => rows.find((r) => r.id === id) ?? null),
  } as unknown as ExecutionRepository & {
    listRecent: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
  }
}

describe('RunDebugService paging', () => {
  it('asks the store for one row MORE than the page, and hides it', async () => {
    // The extra row is how "is there another page" is answered without a second COUNT — so it
    // must be requested and it must never reach the caller.
    const repo = executionRepo([run('a', 30), run('b', 20), run('c', 10)])
    const service = new RunDebugService({ executionRepository: repo, clock })

    const page = await service.listRuns('ws', { limit: 2 })

    expect(repo.listRecent).toHaveBeenCalledWith('ws', expect.objectContaining({ limit: 3 }))
    expect(page.items.map((r) => r.runId)).toEqual(['a', 'b'])
    // The cursor names the LAST RETURNED row, not the peeked one — resuming from the peeked row
    // would skip it entirely.
    expect(page.nextCursor).toEqual({ createdAt: 20, id: 'b' })
  })

  it('reports no next cursor when the page was the last one', async () => {
    const repo = executionRepo([run('a', 30), run('b', 20)])
    const service = new RunDebugService({ executionRepository: repo, clock })
    const page = await service.listRuns('ws', { limit: 5 })
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  it("passes the caller's body budget straight through to the store", async () => {
    const listPage = vi.fn(async () => [call('llm_1', 5)])
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
      llmCallMetricRepository: { listPage } as unknown as LlmCallMetricRepository,
    })

    await service.listLlmCalls('ws', 'exec_1', { limit: 10, bodyChars: 256, order: 'oldest' })

    // The slice happens IN SQL, so the budget has to survive the hop unmodified — a service that
    // clamped it here would be a second, drifting copy of the contract's ceiling.
    expect(listPage).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({
        executionId: 'exec_1',
        bodyChars: 256,
        order: 'oldest',
        limit: 11,
      }),
    )
  })

  it('passes a search term through to the store — the match happens in SQL, never here', async () => {
    const listPage = vi.fn(async () => [call('llm_1', 5)])
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
      llmCallMetricRepository: { listPage } as unknown as LlmCallMetricRepository,
    })
    await service.listLlmCalls('ws', 'exec_1', {
      limit: 10,
      bodyChars: 0,
      contains: 'Validation failed',
    })
    expect(listPage).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({ contains: 'Validation failed' }),
    )
  })

  it('windows a raw point read in SQL, but reads the row WHOLE for the messages view', async () => {
    const get = vi.fn(async (_ws: string, _id: string, body?: { chars?: number }) => ({
      ...call('llm_1', 5),
      prompt: {
        text: body?.chars === undefined ? '[{"role":"user","content":"hi"}]' : '[{"ro',
        totalChars: 31,
      },
    }))
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
      llmCallMetricRepository: { get } as unknown as LlmCallMetricRepository,
    })

    const raw = await service.getLlmCall('ws', 'llm_1', { bodyChars: 6, bodyOffset: 3 })
    // Raw: the window rides to the store so the untaken bytes never leave it.
    expect(get).toHaveBeenLastCalledWith('ws', 'llm_1', { chars: 6, offset: 3 })
    expect(raw?.prompt.offset).toBe(3)

    const parsed = await service.getLlmCall('ws', 'llm_1', { bodyChars: 50, view: 'messages' })
    // Messages: the parse needs the COMPLETE delta (a truncated JSON array parses as nothing),
    // so the store is asked for the whole row and the budgeting moves into the projection.
    expect(get).toHaveBeenLastCalledWith('ws', 'llm_1')
    expect(parsed?.promptMessages).toHaveLength(1)
    expect(parsed?.promptMessages?.[0]?.content.text).toBe('hi')
  })
})

describe('RunDebugService with unwired sinks', () => {
  it('returns empty pages instead of failing when a telemetry sink is absent', async () => {
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
    })
    await expect(
      service.listLlmCalls('ws', 'exec_1', { limit: 10, bodyChars: 0 }),
    ).resolves.toEqual({ items: [], nextCursor: null })
    await expect(service.listAgentContext('ws', 'exec_1', { limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
    await expect(service.listSearchQueries('ws', 'exec_1', { limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
    await expect(service.listProvisioningLog('ws', 'exec_1', { limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
    await expect(service.getLlmCall('ws', 'llm_1')).resolves.toBeNull()
    await expect(service.getAgentContext('ws', 'acs_1', 100)).resolves.toBeNull()
  })

  it('marks an absent sink UNAVAILABLE in the overview rather than reporting a count of zero', async () => {
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
    })
    const overview = await service.overview('ws', run('exec_1', 1))
    // "We never recorded this" and "nothing happened" need different follow-up from the caller,
    // so the two must never render identically.
    expect(overview.sinks).toEqual({
      llmCalls: { available: false, count: 0 },
      agentContext: { available: false, count: 0 },
      searchQueries: { available: false, count: 0 },
      // The tool-call sink carries no failure count of its own: it lives on the `toolCalls`
      // rollup, folded from the same aggregate this `count` comes from. So an unwired sink says
      // `available: false` here and reports a null failure RATE there, and neither reads as a
      // run whose every tool call worked.
      toolCalls: { available: false, count: 0 },
      provisioningLog: { available: false, count: 0 },
    })
    expect(overview.signals.filter((s) => s.code === 'telemetry_unavailable')).toHaveLength(5)
    expect(overview.signals.map((s) => s.code)).not.toContain('no_model_calls')
    expect(overview.generatedAt).toBe(4_242)
  })
})

describe('RunDebugService overview', () => {
  it('folds the LLM call count from the rollup instead of counting twice', async () => {
    const summarizeByExecution = vi.fn(async () => [
      {
        agentKind: 'coder',
        calls: 7,
        promptTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completionTokens: 5,
        peakCompletionTokens: 5,
        maxOutputTokens: null,
        truncatedCalls: 0,
        upstreamMs: 1,
        overheadMs: 0,
        errors: 0,
        warnings: 0,
      },
    ])
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
      llmCallMetricRepository: {
        summarizeByExecution,
      } as unknown as LlmCallMetricRepository,
      agentContextSnapshotRepository: {
        countByExecution: async () => 2,
      } as unknown as AgentContextSnapshotRepository,
      agentSearchQueryRepository: {
        countByExecution: async () => 0,
      } as unknown as AgentSearchQueryRepository,
      provisioningLogRepository: {
        countByExecution: async () => ({ total: 4, failures: 1 }),
      } as unknown as ProvisioningLogRepository,
    })

    const overview = await service.overview('ws', run('exec_1', 1))

    expect(summarizeByExecution).toHaveBeenCalledTimes(1)
    // Folded, not a second COUNT that could disagree with the breakdown beside it.
    expect(overview.sinks.llmCalls).toEqual({ available: true, count: 7 })
    expect(overview.llm.totals.calls).toBe(7)
    expect(overview.sinks.agentContext).toEqual({ available: true, count: 2 })
    expect(overview.sinks.provisioningLog).toEqual({ available: true, count: 4 })
    // The failure count rides the same aggregate pass and drives the top signal.
    expect(overview.signals[0]).toMatchObject({ code: 'provisioning_failed', count: 1 })
  })

  it('folds the tool-call count from the SAME aggregate its failure breakdown comes from', async () => {
    const summarizeByExecution = vi.fn(async () => [
      { agentKind: 'coder', tool: 'edit', calls: 6, failures: 5 },
      { agentKind: 'coder', tool: 'bash', calls: 14, failures: 0 },
    ])
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
      agentToolCallRepository: {
        summarizeByExecution,
      } as unknown as AgentToolCallRepository,
    })

    const overview = await service.overview('ws', run('exec_1', 1))

    // ONE pass over the rows: the sink count is a fold over the cells, never a second COUNT
    // that could disagree with the breakdown printed beside it.
    expect(summarizeByExecution).toHaveBeenCalledTimes(1)
    expect(overview.sinks.toolCalls).toEqual({ available: true, count: 20 })
    expect(overview.toolCalls.totals).toEqual({ calls: 20, failures: 5, failureRate: 0.25 })
    // Most-failed first, which is the row a caller opened this for.
    expect(overview.toolCalls.byTool.map((row) => row.tool)).toEqual(['edit', 'bash'])
    expect(overview.signals.map((s) => s.code)).toEqual(
      expect.arrayContaining(['tool_calls_failed', 'tool_retry_loop']),
    )
  })
})

describe('RunDebugService.listToolCalls', () => {
  function toolCallRepo() {
    const listPage = vi.fn(async () => [] as AgentToolCall[])
    const listByExecution = vi.fn(async () => [] as AgentToolCall[])
    const repo = { listPage, listByExecution } as unknown as AgentToolCallRepository
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
      agentToolCallRepository: repo,
    })
    return { service, listPage, listByExecution }
  }

  it('serves the ordered read from the store, not by re-sorting a keyset page', async () => {
    // The order is the product. A client sorting rows by `(jobId, seq)` gets it wrong in a way
    // that looks right, so the ordering has to be computed where the rows are.
    const { service, listPage, listByExecution } = toolCallRepo()

    const page = await service.listToolCalls('ws', 'exec_1', {
      limit: 20,
      order: 'trajectory',
      jobId: 'exec_1-coder',
    })

    expect(listPage).not.toHaveBeenCalled()
    expect(listByExecution).toHaveBeenCalledWith('ws', {
      executionId: 'exec_1',
      limit: 20,
      jobId: 'exec_1-coder',
    })
    // A bounded PREFIX, so there is no position to resume from — and saying so is what stops a
    // caller looping on a cursor the read never issues.
    expect(page.nextCursor).toBeNull()
  })

  it('defaults to the resumable keyset page every sibling list serves', async () => {
    const { service, listPage, listByExecution } = toolCallRepo()

    await service.listToolCalls('ws', 'exec_1', { limit: 20 })

    expect(listByExecution).not.toHaveBeenCalled()
    // One more than asked: how the shared paginator learns there IS a next page.
    expect(listPage).toHaveBeenCalledWith('ws', { executionId: 'exec_1', limit: 21 })
  })

  it('pushes the outcome filter into BOTH reads rather than filtering a page it fetched', async () => {
    // Filtering here would have already paid for the successful rows and spent the page's limit
    // on them, so a run whose failures sit behind a hundred successes would return none.
    const { service, listPage, listByExecution } = toolCallRepo()

    await service.listToolCalls('ws', 'exec_1', { limit: 20, ok: false })
    expect(listPage).toHaveBeenCalledWith('ws', { executionId: 'exec_1', limit: 21, ok: false })

    await service.listToolCalls('ws', 'exec_1', { limit: 20, order: 'trajectory', ok: false })
    expect(listByExecution).toHaveBeenCalledWith('ws', {
      executionId: 'exec_1',
      limit: 20,
      ok: false,
    })

    // `ok: true` is a real filter, and an ABSENT one asks for every call — a store handed
    // `ok: undefined` would narrow to the successes on a truthiness check.
    await service.listToolCalls('ws', 'exec_1', { limit: 20, ok: true })
    expect(listPage).toHaveBeenLastCalledWith('ws', {
      executionId: 'exec_1',
      limit: 21,
      ok: true,
    })
    await service.listToolCalls('ws', 'exec_1', { limit: 20 })
    expect(listPage).toHaveBeenLastCalledWith('ws', { executionId: 'exec_1', limit: 21 })
  })

  it('reports an unwired sink as empty rather than throwing', async () => {
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
    })
    expect(await service.listToolCalls('ws', 'exec_1', { limit: 5, order: 'trajectory' })).toEqual({
      items: [],
      nextCursor: null,
    })
  })
})

describe('RunDebugService LLM export', () => {
  /** A bundle request that reads nothing, for assertions about the bundle's own metadata. */
  const EMPTY_WINDOW = { limit: 1, order: 'oldest', bodyChars: 0 } as const

  /** A store whose rollup covers the whole run and whose page holds one row more than asked. */
  function exportRepo(callRows: number) {
    const summarizeByExecution = vi.fn(async () => [
      {
        agentKind: 'coder',
        calls: 9,
        promptTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completionTokens: 20,
        peakCompletionTokens: 20,
        maxOutputTokens: null,
        truncatedCalls: 0,
        upstreamMs: 5,
        overheadMs: 1,
        errors: 0,
        warnings: 0,
      },
    ])
    const listPage = vi.fn(async (_ws: string, opts: { limit: number }) =>
      Array.from({ length: Math.min(callRows, opts.limit) }, (_unused, index) =>
        call(`llm_${index}`, index),
      ),
    )
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
      llmCallMetricRepository: {
        summarizeByExecution,
        listPage,
      } as unknown as LlmCallMetricRepository,
      costCurrency: 'USD',
    })
    return { service, summarizeByExecution, listPage }
  }

  it('reports the WHOLE run in its rollups while the call rows are a window', async () => {
    // The property the internal export cannot offer: its numbers are folded from the rows it
    // holds, so a slice makes them a partial sum. Here the rollup is a SQL aggregate over every
    // recorded call, so a bundle a caller budgeted down to two rows still says what the run cost.
    const { service, listPage } = exportRepo(9)

    const bundle = await service.llmExport('ws', 'exec_1', {
      limit: 2,
      order: 'oldest',
      bodyChars: 0,
    })

    expect(bundle.llm.totals.calls).toBe(9)
    expect(bundle.calls).toHaveLength(2)
    expect(bundle.truncated).toBe(true)
    expect(bundle.order).toBe('oldest')
    expect(bundle.kind).toBe('cat-factory.run-llm-export')
    expect(bundle.llm.costCurrency).toBe('USD')
    // The page's own peek decides truncation, and the body budget rides to the store unmodified.
    expect(listPage).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({ limit: 3, order: 'oldest', bodyChars: 0 }),
    )
  })

  it('says a bundle is complete when the run fits inside the window', async () => {
    const { service } = exportRepo(2)
    const bundle = await service.llmExport('ws', 'exec_1', {
      limit: 50,
      order: 'newest',
      bodyChars: 512,
    })
    expect(bundle.truncated).toBe(false)
    expect(bundle.calls).toHaveLength(2)
    expect(bundle.order).toBe('newest')
  })

  it('serves an unwired telemetry sink as an EMPTY bundle that SAYS it is unwired', async () => {
    const service = new RunDebugService({
      executionRepository: executionRepo([run('exec_1', 1)]),
      clock,
    })
    const bundle = await service.llmExport('ws', 'exec_1', {
      limit: 50,
      order: 'oldest',
      bodyChars: 0,
    })
    expect(bundle.calls).toEqual([])
    expect(bundle.llm.totals.calls).toBe(0)
    expect(bundle.truncated).toBe(false)
    // A deployment that prices nothing says so rather than denominating null costs.
    expect(bundle.llm.costCurrency).toBeNull()
    // The reason the flag exists: without it this bundle is byte-identical to the one a run
    // that genuinely made no model calls produces, and its intended reader is a model asked
    // why the run went wrong. Asserted BESIDE a wired run's, since a constant `false` would
    // pass the half of this that matters least.
    expect(bundle.available).toBe(false)
    expect((await exportRepo(0).service.llmExport('ws', 'exec_1', EMPTY_WINDOW)).available).toBe(
      true,
    )
  })
})
