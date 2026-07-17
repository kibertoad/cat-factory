import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformObservability } from '@cat-factory/contracts'
import type { Clock, Workspace } from '@cat-factory/kernel'
import type { ServerContainer } from '@cat-factory/server'
import { startPlatformHealthSweeper } from '../src/platformHealth.js'

// Guards the Node WIRING of the platform-health alert sweep (the Node side of the
// runtime-symmetric sweep). The evaluation logic + the sweep composition are unit-tested in
// their own packages; this proves `startPlatformHealthSweeper` gates on `PLATFORM_ALERTS` and,
// when enabled, actually drives the sweep (raising a card for an unhealthy account).

const UNHEALTHY: PlatformObservability = {
  window: '1h',
  generatedAt: 0,
  since: 0,
  outcomes: {
    total: 10,
    done: 2,
    failed: 8,
    running: 0,
    blocked: 0,
    paused: 0,
    other: 0,
    successRate: 0.2,
  },
  trend: { bucketMs: 300_000, points: [] },
  failures: [],
  live: { running: 0, blocked: 0, paused: 0, pending: 0 },
  durations: { count: 10, avgMs: 1, minMs: 1, maxMs: 1, p50Ms: 1, p90Ms: 1, p99Ms: 1 },
}

const clock: Clock = { now: () => 0 }
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

function container(enabled: boolean, raises: string[]): ServerContainer {
  return {
    config: {
      platformAlerts: {
        enabled,
        window: '1h',
        intervalMs: 60_000,
        thresholds: {
          minRuns: 5,
          maxFailureRate: 0.5,
          maxP99DurationMs: 3_600_000,
          maxBacklog: 50,
        },
      },
    },
    workspaceService: { list: async () => [{ id: 'ws-1', accountId: 'acc-1' } as Workspace] },
    platformObservability: { summarize: async () => UNHEALTHY },
    notifications: {
      service: {
        raise: async (workspaceId: string) => {
          raises.push(workspaceId)
          return {}
        },
        clearByType: async () => null,
      },
    },
  } as unknown as ServerContainer
}

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

describe('Node facade: platform-health sweep wiring', () => {
  it('raises a card for an unhealthy account when enabled', async () => {
    const raises: string[] = []
    stops.push(startPlatformHealthSweeper(container(true, raises), clock, log))
    await vi.waitFor(() => expect(raises).toContain('ws-1'))
  })

  it('is a no-op (no timer, no sweep) when PLATFORM_ALERTS is off', async () => {
    const raises: string[] = []
    stops.push(startPlatformHealthSweeper(container(false, raises), clock, log))
    await new Promise((r) => setTimeout(r, 50))
    expect(raises).toEqual([])
  })
})
