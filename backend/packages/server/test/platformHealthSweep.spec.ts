import type { PlatformObservability, PlatformObservabilityWindow } from '@cat-factory/contracts'
import type { Workspace } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ServerContainer } from '../src/http/env.js'
import { sweepPlatformHealth } from '../src/runtime/platformHealth.js'

// Drives the runtime-neutral sweep over a minimal fake container: only the fields it reads
// (config.platformAlerts, workspaceService.list, platformObservability.summarize,
// notifications.service.raise/clearByType) are present, cast to ServerContainer.

function workspace(id: string, accountId: string | null): Workspace {
  return { id, name: id, description: null, createdAt: 0, accountId }
}

const HEALTHY: PlatformObservability = {
  window: '1h',
  generatedAt: 0,
  since: 0,
  outcomes: {
    total: 10,
    done: 10,
    failed: 0,
    running: 0,
    blocked: 0,
    paused: 0,
    other: 0,
    successRate: 1,
  },
  trend: { bucketMs: 300_000, points: [] },
  failures: [],
  live: { running: 0, blocked: 0, paused: 0, pending: 0 },
  durations: {
    count: 10,
    avgMs: 100,
    minMs: 50,
    maxMs: 200,
    p50Ms: 100,
    p90Ms: 150,
    p99Ms: 180,
  },
}

const UNHEALTHY: PlatformObservability = {
  ...HEALTHY,
  outcomes: { ...HEALTHY.outcomes, done: 2, failed: 8, successRate: 0.2 },
}

interface RaiseCall {
  workspaceId: string
  reasons: unknown
}

function makeContainer(opts: {
  workspaces: Workspace[]
  summaries: Record<string, PlatformObservability>
  enabled?: boolean
  hasObservability?: boolean
  hasNotifications?: boolean
  /** Workspaces that already hold an open card (drives the batched `listOpenByType`). Defaults
   * to "every workspace has one", so a healthy workspace is probed for clearing as before. */
  openCardWorkspaces?: string[]
}) {
  const raises: RaiseCall[] = []
  const clears: string[] = []
  const listByTypeCalls: string[][] = []
  const container = {
    config: {
      platformAlerts: {
        enabled: opts.enabled ?? true,
        window: '1h' as PlatformObservabilityWindow,
        intervalMs: 60_000,
        thresholds: {
          minRuns: 5,
          maxFailureRate: 0.5,
          maxP99DurationMs: 60 * 60_000,
          maxBacklog: 50,
        },
      },
    },
    workspaceService: { list: async () => opts.workspaces },
    platformObservability:
      opts.hasObservability === false
        ? undefined
        : { summarize: async (accountId: string) => opts.summaries[accountId] ?? HEALTHY },
    notifications:
      opts.hasNotifications === false
        ? undefined
        : {
            service: {
              listOpenByType: async (workspaceIds: string[]) => {
                listByTypeCalls.push(workspaceIds)
                const held = opts.openCardWorkspaces ?? workspaceIds
                return new Map(workspaceIds.filter((id) => held.includes(id)).map((id) => [id, {}]))
              },
              raise: async (
                workspaceId: string,
                input: { payload?: { platformAlerts?: unknown } },
              ) => {
                raises.push({ workspaceId, reasons: input.payload?.platformAlerts })
                return {}
              },
              clearByType: async (workspaceId: string) => {
                clears.push(workspaceId)
                return {} // a non-null "cleared" card
              },
            },
          },
  } as unknown as ServerContainer
  return { container, raises, clears, listByTypeCalls }
}

describe('sweepPlatformHealth', () => {
  it('raises one card per workspace in an unhealthy account, carrying the sorted reasons', async () => {
    const { container, raises, clears } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1'), workspace('ws-2', 'acc-1')],
      summaries: { 'acc-1': UNHEALTHY },
    })
    const result = await sweepPlatformHealth(container)
    expect(result).toEqual({ raised: 2, cleared: 0 })
    expect(raises.map((r) => r.workspaceId).sort()).toEqual(['ws-1', 'ws-2'])
    expect(raises[0]!.reasons).toEqual(['failure_rate_high'])
    expect(clears).toEqual([])
  })

  it('clears the card in a healthy account and never raises', async () => {
    const { container, raises, clears } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': HEALTHY },
    })
    const result = await sweepPlatformHealth(container)
    expect(result).toEqual({ raised: 0, cleared: 1 })
    expect(raises).toEqual([])
    expect(clears).toEqual(['ws-1'])
  })

  it('skips the clear point-read for a healthy workspace that holds no card (batched dedup)', async () => {
    const { container, clears, listByTypeCalls } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1'), workspace('ws-2', 'acc-1')],
      summaries: { 'acc-1': HEALTHY },
      openCardWorkspaces: ['ws-2'], // only ws-2 has an open card to clear
    })
    const result = await sweepPlatformHealth(container)
    // ws-1 has no card → never probed; only ws-2 is cleared.
    expect(result).toEqual({ raised: 0, cleared: 1 })
    expect(clears).toEqual(['ws-2'])
    // The open-card set is learned in ONE batched read over all workspaces, not per workspace.
    expect(listByTypeCalls).toEqual([['ws-1', 'ws-2']])
  })

  it('summarizes each account once, fanning the verdict to its workspaces', async () => {
    let summarizeCalls = 0
    const { container } = makeContainer({
      workspaces: [
        workspace('ws-1', 'acc-1'),
        workspace('ws-2', 'acc-1'),
        workspace('ws-legacy', null), // null-account board is skipped
        workspace('ws-3', 'acc-2'),
      ],
      summaries: { 'acc-1': UNHEALTHY, 'acc-2': HEALTHY },
    })
    // Wrap summarize to count calls.
    const obs = (
      container as unknown as {
        platformObservability: { summarize: (a: string) => Promise<PlatformObservability> }
      }
    ).platformObservability
    const inner = obs.summarize
    obs.summarize = async (accountId: string) => {
      summarizeCalls += 1
      return inner(accountId)
    }
    const result = await sweepPlatformHealth(container)
    expect(summarizeCalls).toBe(2) // once per account, not per workspace
    expect(result).toEqual({ raised: 2, cleared: 1 })
  })

  it('is a no-op when alerting is off or a dependency is unwired', async () => {
    for (const opts of [
      { enabled: false },
      { hasObservability: false },
      { hasNotifications: false },
    ]) {
      const { container, raises, clears } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1')],
        summaries: { 'acc-1': UNHEALTHY },
        ...opts,
      })
      const result = await sweepPlatformHealth(container)
      expect(result).toEqual({ raised: 0, cleared: 0 })
      expect(raises).toEqual([])
      expect(clears).toEqual([])
    }
  })

  it('isolates a per-account failure, still processing the others', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-bad'), workspace('ws-2', 'acc-good')],
      summaries: { 'acc-good': UNHEALTHY },
    })
    const obs = (
      container as unknown as {
        platformObservability: { summarize: (a: string) => Promise<PlatformObservability> }
      }
    ).platformObservability
    const inner = obs.summarize
    obs.summarize = async (accountId: string) => {
      if (accountId === 'acc-bad') throw new Error('boom')
      return inner(accountId)
    }
    const warnings: unknown[] = []
    const result = await sweepPlatformHealth(container, { warn: (o) => warnings.push(o) })
    expect(result).toEqual({ raised: 1, cleared: 0 })
    expect(raises.map((r) => r.workspaceId)).toEqual(['ws-2'])
    expect(warnings).toHaveLength(1)
  })
})
