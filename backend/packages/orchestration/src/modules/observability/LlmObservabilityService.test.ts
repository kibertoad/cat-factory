import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import type {
  Clock,
  IdGenerator,
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
  LlmGenerationEvent,
  LlmPromptChainTip,
  LlmTraceSink,
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
  async listByExecution(
    workspaceId: string,
    executionId: string,
    limit?: number,
    agentKind?: string,
  ): Promise<LlmCallMetric[]> {
    const rows = this.recorded
      .filter(
        (m) =>
          m.workspaceId === workspaceId &&
          m.executionId === executionId &&
          (agentKind == null || m.agentKind === agentKind),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    return limit == null ? rows : rows.slice(0, limit)
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
    reasoningText: '',
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

/** Captures generation events fanned out to the external trace sink. */
class CaptureSink implements LlmTraceSink {
  events: LlmGenerationEvent[] = []
  recordGeneration(event: LlmGenerationEvent): void {
    this.events.push(event)
  }
}

describe('LlmObservabilityService trace-sink fan-out', () => {
  it('emits one generation per recorded call with the FULL prompt and the timing split', async () => {
    const repo = new MemoryRepo()
    const sink = new CaptureSink()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
      traceSink: sink,
    })

    await service.record(
      input({
        promptText: '[{"role":"user"}]',
        responseText: 'done',
        totalMs: 250,
        upstreamMs: 200,
      }),
    )

    expect(sink.events).toHaveLength(1)
    const e = sink.events[0]!
    expect(e.executionId).toBe('exec')
    expect(e.agentKind).toBe('coder')
    expect(e.provider).toBe('workers-ai')
    // The sink gets the FULL prompt, not the stored delta.
    expect(e.input).toBe('[{"role":"user"}]')
    expect(e.output).toBe('done')
    // startedAt is endedAt minus the upstream slice (createdAt=1700, upstreamMs=200).
    expect(e.endedAt).toBe(1700)
    expect(e.startedAt).toBe(1500)
    expect(e.totalTokens).toBe(150)
  })

  it('omits prompt/response bodies when recordPrompts is false', async () => {
    const repo = new MemoryRepo()
    const sink = new CaptureSink()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
      recordPrompts: false,
      traceSink: sink,
    })

    await service.record(input({ promptText: '[{"role":"user"}]', responseText: 'secret' }))

    const e = sink.events[0]!
    expect(e.input).toBe('')
    expect(e.output).toBe('')
    // Numeric telemetry still flows.
    expect(e.promptTokens).toBe(100)
    expect(e.completionTokens).toBe(50)
  })

  it('still records locally when the sink throws (observability never breaks the proxy)', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
      traceSink: {
        recordGeneration() {
          throw new Error('sink down')
        },
      },
    })

    await expect(service.record(input())).resolves.toBeUndefined()
    expect(repo.recorded).toHaveLength(1)
  })
})

/** A settings repo returning a fixed storeAgentContext value for every workspace. */
function settingsRepo(storeAgentContext: boolean) {
  return {
    async get() {
      return {
        ...DEFAULT_WORKSPACE_SETTINGS,
        storeAgentContext,
      }
    },
    async upsert() {},
  }
}

describe('LlmObservabilityService secret redaction', () => {
  it('scrubs credential shapes from the stored + fanned-out prompt/response/reasoning', async () => {
    const repo = new MemoryRepo()
    const sink = new CaptureSink()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
      traceSink: sink,
    })

    await service.record(
      input({
        promptText: 'clone https://x-access-token:ghp_abcdefghijklmnopqrstuvwx1234@github.com/o/r',
        responseText: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwx',
        reasoningText: 'the key is AKIAIOSFODNN7EXAMPLE',
      }),
    )

    const m = repo.recorded[0]!
    expect(m.promptText).not.toContain('ghp_abcdefghijklmnopqrstuvwx1234')
    expect(m.promptText).toContain('[REDACTED]')
    expect(m.responseText).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(m.reasoningText).not.toContain('AKIAIOSFODNN7EXAMPLE')
    // The external trace sink receives the redacted text too.
    const e = sink.events[0]!
    expect(e.input).not.toContain('ghp_abcdefghijklmnopqrstuvwx1234')
    expect(e.output).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })
})

describe('LlmObservabilityService storeAgentContext gating', () => {
  it('records bodies when the workspace has storeAgentContext on', async () => {
    const repo = new MemoryRepo()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
      workspaceSettingsRepository: settingsRepo(true),
    })
    await service.record(input({ promptText: '[{"role":"user"}]', responseText: 'hello' }))
    expect(repo.recorded[0]!.responseText).toBe('hello')
  })

  it('drops prompt/response bodies (but keeps numeric telemetry) when the workspace opted out', async () => {
    const repo = new MemoryRepo()
    const sink = new CaptureSink()
    const service = new LlmObservabilityService({
      llmCallMetricRepository: repo,
      idGenerator,
      clock,
      traceSink: sink,
      workspaceSettingsRepository: settingsRepo(false),
    })
    await service.record(input({ promptText: '[{"role":"user"}]', responseText: 'secret' }))

    const m = repo.recorded[0]!
    expect(m.promptText).toBe('')
    expect(m.responseText).toBe('')
    expect(m.promptTokens).toBe(100) // numeric telemetry still recorded
    expect(sink.events[0]!.input).toBe('')
    expect(sink.events[0]!.output).toBe('')
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
