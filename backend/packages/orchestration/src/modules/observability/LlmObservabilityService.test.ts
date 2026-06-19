import { describe, expect, it } from 'vitest'
import type {
  Clock,
  IdGenerator,
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
} from '@cat-factory/kernel'
import {
  LlmObservabilityService,
  MAX_BODY_CHARS,
  type RecordLlmCallInput,
} from './LlmObservabilityService.js'

/** A minimal in-memory repo capturing recorded metrics. */
class MemoryRepo implements LlmCallMetricRepository {
  recorded: LlmCallMetric[] = []
  async record(metric: LlmCallMetric): Promise<void> {
    this.recorded.push(metric)
  }
  async listByExecution(workspaceId: string, executionId: string): Promise<LlmCallMetric[]> {
    return this.recorded
      .filter((m) => m.workspaceId === workspaceId && m.executionId === executionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }
  async summarizeByExecution(): Promise<LlmCallMetricSummary[]> {
    return []
  }
  async deleteOlderThan(): Promise<number> {
    return 0
  }
}

const idGenerator: IdGenerator = { next: (p) => `${p}_1` }
const clock: Clock = { now: () => 1700 }

function input(overrides: Partial<RecordLlmCallInput> = {}): RecordLlmCallInput {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    streaming: false,
    messageCount: 1,
    toolCount: 0,
    requestMaxTokens: 1000,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    finishReason: 'stop',
    totalMs: 250,
    upstreamMs: 200,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    responseText: 'ok',
    ...overrides,
  }
}

describe('LlmObservabilityService.record', () => {
  it('assigns an id + timestamp and derives the transport overhead', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
    })
    await service.record(input({ totalMs: 250, upstreamMs: 200 }))

    expect(repo.recorded).toHaveLength(1)
    const m = repo.recorded[0]!
    expect(m.id).toBe('llm_1')
    expect(m.createdAt).toBe(1700)
    expect(m.overheadMs).toBe(50) // totalMs - upstreamMs
  })

  it('bounds oversized bodies so a pathological call still records', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
    })
    const huge = 'x'.repeat(MAX_BODY_CHARS + 5000)
    await service.record(input({ promptText: huge, responseText: huge }))
    const m = repo.recorded[0]!
    expect(m.promptText.length).toBeLessThan(huge.length)
    expect(m.promptText).toContain('[truncated')
    expect(m.responseText).toContain('[truncated')
  })

  it('never derives a negative overhead', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
    })
    // Streaming flush timing can momentarily make upstream exceed the proxy total.
    await service.record(input({ totalMs: 100, upstreamMs: 140 }))
    expect(repo.recorded[0]!.overheadMs).toBe(0)
  })
})

describe('LlmObservabilityService.exportForExecution', () => {
  it('builds an export stamped with the service clock', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
    })
    await service.record(input())
    const out = await service.exportForExecution('ws', 'exec')
    expect(out.executionId).toBe('exec')
    expect(out.generatedAt).toBe(1700)
    expect(out.totals.calls).toBe(1)
  })
})
