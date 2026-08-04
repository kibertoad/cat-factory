import { DEFAULT_PLATFORM_ALERT_THRESHOLDS } from '@cat-factory/orchestration'
import type {
  PlatformAlertSettings,
  PlatformAlertWindow,
  PlatformObservability,
} from '@cat-factory/contracts'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { PlatformAlertEvent, Workspace } from '@cat-factory/kernel'
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
  source: 'runs',
  rolledUpThrough: null,
  gates: [],
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
  payload?: Record<string, unknown>
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
  /** The reason set stored on those open cards, if any; drives the state-change dedup. */
  openCardReasons?: string[]
  /** The account's stored alert overrides, layered over the deployment defaults. */
  accountSettings?: PlatformAlertSettings
  /** Failing runs the deep-link sample resolves to, keyed by workspace. */
  failingRuns?: {
    workspaceId: string
    executionId: string
    blockId: string | null
    failureKind: string
    createdAt: number
    workspaceFailedTotal: number
  }[]
  /** Whether the outbound on-call sink is wired (a facade with no encryption key has none). */
  hasAlertSink?: boolean
  /** Make the sink throw, to pin that a broken sink cannot abort the pass. */
  alertSinkThrows?: boolean
}) {
  const raises: RaiseCall[] = []
  const clears: string[] = []
  const listByTypeCalls: string[][] = []
  const alerts: { workspaceId: string; event: PlatformAlertEvent }[] = []
  let cardSeq = 0
  const container = {
    config: {
      platformAlerts: {
        enabled: opts.enabled ?? true,
        window: '1h' as PlatformAlertWindow,
        intervalMs: 60_000,
        thresholds: DEFAULT_PLATFORM_ALERT_THRESHOLDS,
      },
    },
    workspaceService: { list: async () => opts.workspaces },
    accountSettings: opts.accountSettings
      ? {
          service: {
            resolve: async () => ({ config: { platformAlerts: opts.accountSettings } }),
          },
        }
      : undefined,
    platformObservability:
      opts.hasObservability === false
        ? undefined
        : {
            summarize: async (accountId: string) => opts.summaries[accountId] ?? HEALTHY,
            failingRuns: async () => opts.failingRuns ?? [],
          },
    notifications:
      opts.hasNotifications === false
        ? undefined
        : {
            service: {
              listOpenByType: async (workspaceIds: string[]) => {
                listByTypeCalls.push(workspaceIds)
                const held = opts.openCardWorkspaces ?? workspaceIds
                const card = opts.openCardReasons
                  ? { payload: { platformAlerts: opts.openCardReasons } }
                  : {}
                return new Map(
                  workspaceIds.filter((id) => held.includes(id)).map((id) => [id, card]),
                )
              },
              raise: async (workspaceId: string, input: { payload?: Record<string, unknown> }) => {
                raises.push({
                  workspaceId,
                  reasons: input.payload?.platformAlerts,
                  payload: input.payload,
                })
                cardSeq += 1
                return { id: `ntf_${cardSeq}`, createdAt: 1_000 + cardSeq }
              },
              clearByType: async (workspaceId: string) => {
                clears.push(workspaceId)
                cardSeq += 1
                // A non-null "cleared" card: the sweep reads its id as the resolved edge's
                // incident identity, and null would mean there was nothing open to clear.
                return { id: `ntf_${cardSeq}`, createdAt: 500, resolvedAt: 2_000 + cardSeq }
              },
            },
          },
    platformAlertSink:
      opts.hasAlertSink === false
        ? undefined
        : {
            platformHealthChanged: async (workspaceId: string, event: PlatformAlertEvent) => {
              alerts.push({ workspaceId, event })
              if (opts.alertSinkThrows) throw new Error('receiver exploded')
            },
          },
  } as unknown as ServerContainer
  return { container, raises, clears, listByTypeCalls, alerts }
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

  it('does not re-raise while the firing set is unchanged', async () => {
    // The card's identity IS the reason set, so a persistently-unhealthy deployment must not
    // rewrite the row (or re-toast the inbox) on every pass.
    const { container, raises, clears } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': UNHEALTHY },
      openCardReasons: ['failure_rate_high'],
    })
    const result = await sweepPlatformHealth(container)
    expect(result).toEqual({ raised: 0, cleared: 0 })
    expect(raises).toEqual([])
    expect(clears).toEqual([])
  })

  it('re-raises when a second condition joins the firing set', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: {
        'acc-1': {
          ...UNHEALTHY,
          live: { running: 60, blocked: 0, paused: 0, pending: 0 },
        },
      },
      openCardReasons: ['failure_rate_high'],
    })
    const result = await sweepPlatformHealth(container)
    expect(result).toEqual({ raised: 1, cleared: 0 })
    expect(raises[0]!.reasons).toEqual(['backlog_high', 'failure_rate_high'])
  })

  it('deep-links the card to the failing runs in its OWN workspace, and says what it capped', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1'), workspace('ws-2', 'acc-1')],
      summaries: { 'acc-1': UNHEALTHY },
      failingRuns: [
        {
          workspaceId: 'ws-1',
          executionId: 'run-a',
          blockId: 'blk-a',
          failureKind: 'agent',
          createdAt: 5,
          workspaceFailedTotal: 23,
        },
        {
          workspaceId: 'ws-2',
          executionId: 'run-b',
          blockId: null,
          failureKind: 'evicted',
          createdAt: 6,
          workspaceFailedTotal: 4,
        },
      ],
    })
    await sweepPlatformHealth(container)
    const first = raises.find((r) => r.workspaceId === 'ws-1')!
    expect(first.payload?.platformFailingRuns).toEqual([
      { executionId: 'run-a', blockId: 'blk-a', failureKind: 'agent', createdAt: 5 },
    ])
    // The cap reports the denominator it is a sample of, so the card can say "1 of 23".
    expect(first.payload?.platformFailedTotal).toBe(23)
    // A card never links into another workspace's runs.
    const second = raises.find((r) => r.workspaceId === 'ws-2')!
    expect(second.payload?.platformFailingRuns).toEqual([
      { executionId: 'run-b', blockId: null, failureKind: 'evicted', createdAt: 6 },
    ])
  })

  it('omits the run links entirely for a condition with no failing runs behind it', async () => {
    // A backlog alert has no failure to point at, and an EMPTY list would render as "no
    // failures found" rather than "this alert is not about failures".
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: {
        'acc-1': { ...HEALTHY, live: { running: 60, blocked: 0, paused: 0, pending: 0 } },
      },
      failingRuns: [
        {
          workspaceId: 'ws-1',
          executionId: 'run-a',
          blockId: null,
          failureKind: 'agent',
          createdAt: 1,
          workspaceFailedTotal: 1,
        },
      ],
    })
    await sweepPlatformHealth(container)
    expect(raises[0]!.reasons).toEqual(['backlog_high'])
    expect(raises[0]!.payload?.platformFailingRuns).toBeUndefined()
    expect(raises[0]!.payload?.platformFailedTotal).toBeUndefined()
  })

  it('evaluates an account against its own stored thresholds', async () => {
    // The deployment default would fire at a 50% failure rate; this account raised its ceiling.
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': UNHEALTHY }, // 80% failure rate
      accountSettings: { thresholds: { maxFailureRate: 0.9 } },
    })
    const result = await sweepPlatformHealth(container)
    expect(result).toEqual({ raised: 0, cleared: 1 })
    expect(raises).toEqual([])
  })

  it('mutes an account that switched its alerts off, without touching its open card', async () => {
    // A muted account is SKIPPED, not "healthy": clearing its card would silently resolve an
    // alert the operator only asked to stop being told about again.
    const { container, raises, clears } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': UNHEALTHY },
      accountSettings: { enabled: false },
    })
    const result = await sweepPlatformHealth(container)
    expect(result).toEqual({ raised: 0, cleared: 0 })
    expect(raises).toEqual([])
    expect(clears).toEqual([])
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
    const logger = createRecordingLogger()
    const result = await sweepPlatformHealth(container, logger)
    expect(result).toEqual({ raised: 1, cleared: 0 })
    expect(raises.map((r) => r.workspaceId)).toEqual(['ws-2'])
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  describe('the outbound on-call push', () => {
    it('announces a firing edge beside the card, carrying the tripped numbers', async () => {
      const { container, alerts } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1'), workspace('ws-2', 'acc-1')],
        summaries: { 'acc-1': UNHEALTHY },
        failingRuns: [
          {
            workspaceId: 'ws-1',
            executionId: 'exec_1',
            blockId: 'blk_1',
            failureKind: 'agent',
            createdAt: 5,
            workspaceFailedTotal: 8,
          },
        ],
      })
      await sweepPlatformHealth(container)

      // One edge per workspace: health is evaluated per ACCOUNT but endpoints are registered per
      // workspace, so the account id is what lets a receiver collapse the fan-out.
      expect(alerts.map((a) => a.workspaceId).sort()).toEqual(['ws-1', 'ws-2'])
      const first = alerts.find((a) => a.workspaceId === 'ws-1')!.event
      expect(first.event).toBe('platform_health.firing')
      expect(first.accountId).toBe('acc-1')
      expect(first.window).toBe('1h')
      expect(first.cardId).toBe('ntf_1')
      // The card carries reasons only (its payload is its dedup identity); the edge carries the
      // observed value and the threshold it crossed, which is what a pager routes on.
      expect(first.conditions).toEqual([
        {
          reason: 'failure_rate_high',
          value: 0.8,
          threshold: DEFAULT_PLATFORM_ALERT_THRESHOLDS.maxFailureRate,
        },
      ])
      expect(first.failingRuns.map((r) => r.executionId)).toEqual(['exec_1'])
      expect(first.failedTotal).toBe(8)
      // The other workspace's edge names no runs — the sample is workspace-scoped, and an alert
      // reaching one workspace must never name another's runs.
      const second = alerts.find((a) => a.workspaceId === 'ws-2')!.event
      expect(second.failingRuns).toEqual([])
      // ...and says NULL rather than 0, because "nothing failed here" is not what was observed.
      expect(second.failedTotal).toBeNull()
    })

    it('announces a resolved edge when the account recovers', async () => {
      const { container, alerts } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1')],
        summaries: { 'acc-1': HEALTHY },
      })
      await sweepPlatformHealth(container)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.event.event).toBe('platform_health.resolved')
      // The absence of conditions IS the content of this edge.
      expect(alerts[0]!.event.conditions).toEqual([])
      expect(alerts[0]!.event.failedTotal).toBeNull()
    })

    it('stays silent while the firing set is unchanged', async () => {
      // The state-change dedup the card already had now governs the pager too: an incident pages
      // once rather than every couple of minutes for as long as it lasts.
      const { container, alerts, raises } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1')],
        summaries: { 'acc-1': UNHEALTHY },
        openCardReasons: ['failure_rate_high'],
      })
      await sweepPlatformHealth(container)
      expect(raises).toEqual([])
      expect(alerts).toEqual([])
    })

    it('runs the card write FIRST, so a dead receiver costs the alert and not the record', async () => {
      // Ordering + isolation in one: the sink throwing (a violation of its own best-effort
      // contract) must not lose the card, abort the account's remaining workspaces, or take down
      // the sweep that noticed the deployment was unhealthy in the first place.
      const { container, raises, alerts } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1'), workspace('ws-2', 'acc-1')],
        summaries: { 'acc-1': UNHEALTHY },
        alertSinkThrows: true,
      })
      const logger = createRecordingLogger()
      const result = await sweepPlatformHealth(container, logger)
      expect(result).toEqual({ raised: 2, cleared: 0 })
      expect(raises).toHaveLength(2)
      expect(alerts).toHaveLength(2)
      // Swallowed, never silent.
      expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(2)
    })

    it('still raises the card when no endpoint feature is wired', async () => {
      // A facade with no encryption key has no webhook feature at all; the in-app alert is
      // unaffected, because the sweep's own state lives in the card rather than in the sink.
      const { container, raises } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1')],
        summaries: { 'acc-1': UNHEALTHY },
        hasAlertSink: false,
      })
      expect(await sweepPlatformHealth(container)).toEqual({ raised: 1, cleared: 0 })
      expect(raises).toHaveLength(1)
    })
  })
})
