import { describe, expect, it } from 'vitest'
import type { LlmCallMetric } from '@cat-factory/kernel'
import {
  buildLlmMetricsExport,
  classifyCall,
  isWarningFinishReason,
  outputHeadroomRatio,
  transportOverheadRatio,
} from './observability.logic.js'

function metric(overrides: Partial<LlmCallMetric> & Pick<LlmCallMetric, 'id'>): LlmCallMetric {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    createdAt: 1,
    streaming: false,
    messageCount: 2,
    toolCount: 1,
    requestMaxTokens: 1000,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    finishReason: 'stop',
    upstreamMs: 200,
    overheadMs: 50,
    totalMs: 250,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    responseText: 'ok',
    ...overrides,
  }
}

describe('classifyCall', () => {
  it('flags a failed call as an error', () => {
    expect(classifyCall({ ok: false, finishReason: null })).toBe('error')
    expect(classifyCall({ ok: false, finishReason: 'length' })).toBe('error')
  })
  it('flags a truncated or filtered (but ok) call as a warning', () => {
    expect(classifyCall({ ok: true, finishReason: 'length' })).toBe('warning')
    expect(classifyCall({ ok: true, finishReason: 'content_filter' })).toBe('warning')
  })
  it('treats a normal completion as ok', () => {
    expect(classifyCall({ ok: true, finishReason: 'stop' })).toBe('ok')
    expect(classifyCall({ ok: true, finishReason: null })).toBe('ok')
  })
})

describe('isWarningFinishReason', () => {
  it('matches only length / content_filter', () => {
    expect(isWarningFinishReason('length')).toBe(true)
    expect(isWarningFinishReason('content_filter')).toBe(true)
    expect(isWarningFinishReason('stop')).toBe(false)
    expect(isWarningFinishReason(null)).toBe(false)
  })
})

describe('outputHeadroomRatio', () => {
  it('is the peak fraction of the ceiling, capped at 1', () => {
    expect(outputHeadroomRatio(500, 1000)).toBe(0.5)
    expect(outputHeadroomRatio(1200, 1000)).toBe(1)
  })
  it('is null when the ceiling is unknown', () => {
    expect(outputHeadroomRatio(500, null)).toBeNull()
    expect(outputHeadroomRatio(500, 0)).toBeNull()
  })
})

describe('transportOverheadRatio', () => {
  it('is the overhead share of total latency', () => {
    expect(transportOverheadRatio(150, 50)).toBe(0.25)
  })
  it('is null with no timing', () => {
    expect(transportOverheadRatio(0, 0)).toBeNull()
  })
})

describe('buildLlmMetricsExport', () => {
  it('aggregates totals + per-agent insights with derived ratios', () => {
    const calls: LlmCallMetric[] = [
      metric({
        id: 'a',
        agentKind: 'coder',
        completionTokens: 50,
        requestMaxTokens: 1000,
        upstreamMs: 100,
        overheadMs: 10,
      }),
      metric({
        id: 'b',
        agentKind: 'coder',
        completionTokens: 990,
        requestMaxTokens: 1000,
        finishReason: 'length',
        upstreamMs: 300,
        overheadMs: 30,
      }),
      metric({
        id: 'c',
        agentKind: 'reviewer',
        ok: false,
        finishReason: null,
        completionTokens: 0,
        upstreamMs: 5,
        overheadMs: 5,
      }),
    ]
    const out = buildLlmMetricsExport('exec-1', calls, 12345)

    expect(out.kind).toBe('cat-factory.llm-metrics-export')
    expect(out.version).toBe(1)
    expect(out.executionId).toBe('exec-1')
    expect(out.generatedAt).toBe(12345)
    expect(out.calls).toHaveLength(3)

    expect(out.totals.calls).toBe(3)
    expect(out.totals.completionTokens).toBe(1040)
    expect(out.totals.errors).toBe(1)
    expect(out.totals.warnings).toBe(1)
    expect(out.totals.truncatedCalls).toBe(1)
    // overhead 45 / (405 upstream + 45 overhead) = 0.1
    expect(out.totals.transportOverheadRatio).toBeCloseTo(0.1, 5)

    const coder = out.insights.find((i) => i.agentKind === 'coder')!
    expect(coder.calls).toBe(2)
    expect(coder.peakCompletionTokens).toBe(990)
    expect(coder.maxOutputTokens).toBe(1000)
    expect(coder.outputHeadroomRatio).toBe(0.99)
    expect(coder.truncatedCalls).toBe(1)
    expect(coder.warnings).toBe(1)

    const reviewer = out.insights.find((i) => i.agentKind === 'reviewer')!
    expect(reviewer.errors).toBe(1)
  })

  it('reports null ratios for an empty run', () => {
    const out = buildLlmMetricsExport('exec-empty', [], 1)
    expect(out.totals.calls).toBe(0)
    expect(out.totals.transportOverheadRatio).toBeNull()
    expect(out.insights).toEqual([])
  })
})
