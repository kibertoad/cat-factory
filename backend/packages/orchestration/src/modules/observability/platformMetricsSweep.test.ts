import { describe, expect, it, vi } from 'vitest'
import type { PlatformObservability, PlatformObservabilityWindow } from '@cat-factory/contracts'
import {
  type PlatformMetricsSink,
  distinctAccountIds,
  sweepPlatformMetrics,
} from './platformMetricsSweep.js'

function snapshot(window: PlatformObservabilityWindow, accountTag: number): PlatformObservability {
  return {
    window,
    generatedAt: 1_000 + accountTag,
    since: 0,
    outcomes: {
      total: 1,
      done: 1,
      failed: 0,
      running: 0,
      blocked: 0,
      paused: 0,
      other: 0,
      successRate: 1,
    },
    trend: { bucketMs: 1_000, points: [] },
    failures: [],
    live: { running: 0, blocked: 0, paused: 0, pending: 0 },
    durations: {
      count: 0,
      avgMs: null,
      minMs: null,
      maxMs: null,
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
    },
  }
}

function recordingSink(): { sink: PlatformMetricsSink; calls: { accountId: string }[] } {
  const calls: { accountId: string }[] = []
  return {
    calls,
    sink: {
      export: async (_snapshot, dims) => {
        calls.push(dims)
      },
    },
  }
}

describe('distinctAccountIds', () => {
  it('dedups account ids, preserves first-seen order, and drops legacy null-account boards', () => {
    expect(
      distinctAccountIds([
        { accountId: 'a' },
        { accountId: 'b' },
        { accountId: 'a' },
        { accountId: null },
        { accountId: 'c' },
      ]),
    ).toEqual(['a', 'b', 'c'])
  })

  it('is empty when no workspace is account-scoped', () => {
    expect(distinctAccountIds([{ accountId: null }, { accountId: null }])).toEqual([])
  })
})

describe('sweepPlatformMetrics', () => {
  it('summarizes and exports every account over the configured window', async () => {
    const { sink, calls } = recordingSink()
    const summarize = vi.fn(async (accountId: string, window: PlatformObservabilityWindow) =>
      snapshot(window, accountId === 'a' ? 1 : 2),
    )

    const exported = await sweepPlatformMetrics({
      listAccountIds: async () => ['a', 'b'],
      summarize,
      sink,
      window: '24h',
    })

    expect(exported).toBe(2)
    expect(calls.map((c) => c.accountId)).toEqual(['a', 'b'])
    expect(summarize).toHaveBeenCalledWith('a', '24h')
    expect(summarize).toHaveBeenCalledWith('b', '24h')
  })

  it('is best-effort per account: one failure does not abort the others', async () => {
    const { sink, calls } = recordingSink()
    const warn = vi.fn()
    const exported = await sweepPlatformMetrics({
      listAccountIds: async () => ['ok1', 'boom', 'ok2'],
      summarize: async (accountId, window) => {
        if (accountId === 'boom') throw new Error('summarize failed')
        return snapshot(window, 1)
      },
      sink,
      window: '1h',
      logger: { warn },
    })

    expect(exported).toBe(2)
    expect(calls.map((c) => c.accountId)).toEqual(['ok1', 'ok2'])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('returns 0 and logs when the account list itself fails', async () => {
    const { sink, calls } = recordingSink()
    const warn = vi.fn()
    const exported = await sweepPlatformMetrics({
      listAccountIds: async () => {
        throw new Error('db down')
      },
      summarize: async (_a, w) => snapshot(w, 1),
      sink,
      window: '1h',
      logger: { warn },
    })

    expect(exported).toBe(0)
    expect(calls).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('surfaces a sink failure as a skipped account, not a thrown sweep', async () => {
    const warn = vi.fn()
    const failingSink: PlatformMetricsSink = {
      export: async () => {
        throw new Error('collector down')
      },
    }
    const exported = await sweepPlatformMetrics({
      listAccountIds: async () => ['a'],
      summarize: async (_a, w) => snapshot(w, 1),
      sink: failingSink,
      window: '1h',
      logger: { warn },
    })

    expect(exported).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
  })
})
