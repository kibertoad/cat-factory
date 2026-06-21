import { describe, expect, it } from 'vitest'
import type {
  Clock,
  IdGenerator,
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
  LlmPromptChainTip,
} from '@cat-factory/kernel'
import {
  LlmObservabilityService,
  MAX_BODY_CHARS,
  type RecordLlmCallInput,
} from './LlmObservabilityService.js'

/** A minimal in-memory repo capturing recorded metrics. */
class MemoryRepo implements LlmCallMetricRepository {
  recorded: LlmCallMetric[] = []
  chainTipReads = 0
  async record(metric: LlmCallMetric): Promise<void> {
    this.recorded.push(metric)
  }
  async listByExecution(workspaceId: string, executionId: string): Promise<LlmCallMetric[]> {
    return this.recorded
      .filter((m) => m.workspaceId === workspaceId && m.executionId === executionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }
  async latestChainTip(
    workspaceId: string,
    executionId: string,
    agentKind: string,
  ): Promise<LlmPromptChainTip | null> {
    this.chainTipReads++
    const chain = this.recorded
      .filter(
        (m) =>
          m.workspaceId === workspaceId &&
          m.executionId === executionId &&
          m.agentKind === agentKind,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    const tip = chain[0]
    return tip ? { messageCount: tip.messageCount, promptHash: tip.promptHash } : null
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
let seq = 0
const seqIdGenerator: IdGenerator = { next: (p) => `${p}_${++seq}` }
let nowSeq = 0
const seqClock: Clock = { now: () => 1700 + nowSeq++ }

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
    cachedPromptTokens: 0,
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

  it('stores each call as a delta against the previous one in the chain', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator: seqIdGenerator,
      clock: seqClock,
    })
    const sys = { role: 'system', content: 'you are a coder' }
    const u1 = { role: 'user', content: 'do the thing' }
    const a1 = { role: 'assistant', content: 'on it' }
    // Call 1: system + user. Call 2: + assistant + user. Call 3: + assistant.
    await service.record(input({ promptText: JSON.stringify([sys, u1]), messageCount: 2 }))
    await service.record(input({ promptText: JSON.stringify([sys, u1, a1, u1]), messageCount: 4 }))

    const stored = repo.recorded
    // First call stores the full array (nothing to chain onto).
    expect(stored[0]!.promptPrefixCount).toBe(0)
    expect(JSON.parse(stored[0]!.promptText)).toHaveLength(2)
    // Second call stores ONLY the two new messages, eliding the 2-message prefix.
    expect(stored[1]!.promptPrefixCount).toBe(2)
    expect(JSON.parse(stored[1]!.promptText)).toEqual([a1, u1])

    // The export rebuilds the full prompt from the deltas.
    const out = await service.exportForExecution('ws', 'exec')
    const exported = out.calls.sort((a, b) => a.createdAt - b.createdAt)
    expect(JSON.parse(exported[1]!.promptText)).toEqual([sys, u1, a1, u1])
    expect(exported[1]!.promptPrefixCount).toBe(0)
  })

  it('falls back to the full array when the prefix does not chain (fresh conversation)', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator: seqIdGenerator,
      clock: seqClock,
    })
    await service.record(
      input({ promptText: JSON.stringify([{ role: 'system', content: 'a' }]), messageCount: 1 }),
    )
    // A retry restarts the conversation: same length region but different content.
    await service.record(
      input({
        promptText: JSON.stringify([
          { role: 'system', content: 'b' },
          { role: 'user', content: 'x' },
        ]),
        messageCount: 2,
      }),
    )
    // The second call cannot chain onto the first (prefix mismatch) ⇒ stored full.
    expect(repo.recorded[1]!.promptPrefixCount).toBe(0)
    expect(JSON.parse(repo.recorded[1]!.promptText)).toHaveLength(2)
  })

  it('stores the prompt empty (and skips the chain-tip read) when prompt recording is off', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator: seqIdGenerator,
      clock: seqClock,
      recordPrompts: false,
    })
    const sys = { role: 'system', content: 'you are a coder' }
    const u1 = { role: 'user', content: 'do the thing' }
    await service.record(input({ promptText: JSON.stringify([sys, u1]), messageCount: 2 }))
    await service.record(
      input({ promptText: JSON.stringify([sys, u1, sys]), messageCount: 3, completionTokens: 70 }),
    )

    // Prompt body is dropped on every call — including the delta metadata.
    for (const m of repo.recorded) {
      expect(m.promptText).toBe('')
      expect(m.promptPrefixCount).toBe(0)
      expect(m.promptHash).toBe('')
    }
    // The numeric telemetry is still captured.
    expect(repo.recorded[0]!.promptTokens).toBe(100)
    expect(repo.recorded[1]!.completionTokens).toBe(70)
    expect(repo.recorded[1]!.overheadMs).toBe(50)
    // No delta chaining work is done when prompts aren't recorded.
    expect(repo.chainTipReads).toBe(0)
  })

  it('records the prompt by default (prompt recording on)', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
    })
    await service.record(input({ promptText: JSON.stringify([{ role: 'user', content: 'hi' }]) }))
    expect(repo.recorded[0]!.promptText).not.toBe('')
    expect(repo.chainTipReads).toBe(1)
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
