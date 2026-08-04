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

/** {@link UNHEALTHY} plus a slow tail, so the firing set ESCALATES to two conditions. */
const UNHEALTHY_ESCALATED: PlatformObservability = {
  ...UNHEALTHY,
  durations: { ...UNHEALTHY.durations, p99Ms: DEFAULT_PLATFORM_ALERT_THRESHOLDS.maxP99DurationMs },
}

/** `createdAt` on a card the fake starts with open, distinct from anything a pass mints. */
const SEEDED_CARD_CREATED_AT = 100
/** Base `createdAt` for a card a pass mints fresh. */
const MINTED_CARD_CREATED_AT = 1_000
/** `resolvedAt` the fake stamps when a card is cleared. */
const CLEARED_AT = 2_000

/** Distinct sweep-pass observation times, so an edge's `occurredAt` names the pass it came from. */
const PASS_1_AT = 5_000
const PASS_2_AT = 6_000

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
  /** The per-kind half of the stored identity on those cards. */
  openCardFailureKinds?: string[]
  /** Deployment thresholds, when a test needs something other than the shipped defaults. */
  thresholds?: typeof DEFAULT_PLATFORM_ALERT_THRESHOLDS
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
  // The open `platform_health` card per workspace, modelled STATEFULLY because the sweep's whole
  // dedup story rides on how the real `NotificationService` treats one: a block-less card
  // de-dupes on (workspace, type), so a re-raise REUSES the open row's id and PRESERVES its
  // `createdAt` rather than minting either afresh. A fake that mints both per call is strictly
  // more permissive than production, and it hides the two things most worth pinning here: that
  // an escalation keeps the incident's id, and that the outbound edge must therefore not read
  // its transition time off the card.
  const open = new Map<string, { id: string; createdAt: number; payload?: unknown }>()
  for (const ws of opts.workspaces) {
    if (opts.openCardWorkspaces && !opts.openCardWorkspaces.includes(ws.id)) continue
    open.set(ws.id, {
      id: `ntf_seed_${ws.id}`,
      createdAt: SEEDED_CARD_CREATED_AT,
      ...(opts.openCardReasons
        ? {
            payload: {
              platformAlerts: opts.openCardReasons,
              ...(opts.openCardFailureKinds
                ? { platformAlertFailureKinds: opts.openCardFailureKinds }
                : {}),
            },
          }
        : {}),
    })
  }
  const summaries = { ...opts.summaries }
  const container = {
    config: {
      platformAlerts: {
        enabled: opts.enabled ?? true,
        window: '1h' as PlatformAlertWindow,
        intervalMs: 60_000,
        thresholds: opts.thresholds ?? DEFAULT_PLATFORM_ALERT_THRESHOLDS,
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
            summarize: async (accountId: string) => summaries[accountId] ?? HEALTHY,
            failingRuns: async () => opts.failingRuns ?? [],
          },
    notifications:
      opts.hasNotifications === false
        ? undefined
        : {
            service: {
              listOpenByType: async (workspaceIds: string[]) => {
                listByTypeCalls.push(workspaceIds)
                return new Map(
                  workspaceIds.flatMap((id) => {
                    const card = open.get(id)
                    return card ? [[id, card] as const] : []
                  }),
                )
              },
              raise: async (workspaceId: string, input: { payload?: Record<string, unknown> }) => {
                raises.push({
                  workspaceId,
                  reasons: input.payload?.platformAlerts,
                  payload: input.payload,
                })
                // Real `raise` semantics: reuse the open row's id AND its `createdAt`, minting
                // both only when nothing is open for this (workspace, type).
                const existing = open.get(workspaceId)
                if (!existing) cardSeq += 1
                const card = {
                  id: existing?.id ?? `ntf_${cardSeq}`,
                  createdAt: existing?.createdAt ?? MINTED_CARD_CREATED_AT + cardSeq,
                  payload: input.payload,
                }
                open.set(workspaceId, card)
                return card
              },
              clearByType: async (workspaceId: string) => {
                clears.push(workspaceId)
                const existing = open.get(workspaceId)
                // Null when nothing was open, meaning "no recovery happened here", which stops
                // the sweep announcing a resolved edge for a workspace that never fired.
                if (!existing) return null
                open.delete(workspaceId)
                return { ...existing, resolvedAt: CLEARED_AT }
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
  /** Re-point an account's projection, so a test can drive successive passes over changing health. */
  const setSummary = (accountId: string, summary: PlatformObservability) => {
    summaries[accountId] = summary
  }
  return { container, raises, clears, listByTypeCalls, alerts, setSummary }
}

describe('sweepPlatformHealth', () => {
  it('raises one card per workspace in an unhealthy account, carrying the sorted reasons', async () => {
    const { container, raises, clears } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1'), workspace('ws-2', 'acc-1')],
      summaries: { 'acc-1': UNHEALTHY },
    })
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
      const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    await sweepPlatformHealth(container, PASS_1_AT)
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
    await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT)
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
    const result = await sweepPlatformHealth(container, PASS_1_AT, logger)
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
      await sweepPlatformHealth(container, PASS_1_AT)

      // One edge per workspace: health is evaluated per ACCOUNT but endpoints are registered per
      // workspace, so the account id is what lets a receiver collapse the fan-out.
      expect(alerts.map((a) => a.workspaceId).sort()).toEqual(['ws-1', 'ws-2'])
      const first = alerts.find((a) => a.workspaceId === 'ws-1')!.event
      expect(first.event).toBe('platform_health.firing')
      expect(first.accountId).toBe('acc-1')
      expect(first.window).toBe('1h')
      // The edge's incident identity is the card the sweep just wrote, whether that card was
      // already open (as here) or freshly minted.
      expect(first.cardId).toBe('ntf_seed_ws-1')
      // The transition time is the PASS's, never the card's `createdAt`. See the escalation
      // test below for why the two must not be conflated.
      expect(first.occurredAt).toBe(PASS_1_AT)
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

    it('keeps the incident id but MOVES the transition time when an alert escalates', async () => {
      // Two passes over one open incident, which is the case the design turns on and the one a
      // single-pass test cannot see. The card is the incident's identity, so `raise` reuses its
      // id AND preserves its `createdAt` when the firing set grows from one condition to two.
      // That makes `createdAt` the moment the incident OPENED, not the moment it got worse,
      // so the edge must take its `occurredAt` from the pass instead, or an escalation would
      // report a transition time from before the escalation happened and a receiver ordering
      // edges (or aging the incident) would be reading the wrong number with no way to tell.
      const { container, alerts, setSummary } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1')],
        summaries: { 'acc-1': UNHEALTHY },
        openCardWorkspaces: [], // start clean, so the first pass mints the incident
      })

      await sweepPlatformHealth(container, PASS_1_AT)
      setSummary('acc-1', UNHEALTHY_ESCALATED)
      await sweepPlatformHealth(container, PASS_2_AT)

      expect(alerts).toHaveLength(2)
      const [firing, escalated] = alerts.map((a) => a.event)
      // One incident, so one id across both edges: a receiver correlates them by it.
      expect(escalated!.cardId).toBe(firing!.cardId)
      expect(firing!.conditions.map((c) => c.reason)).toEqual(['failure_rate_high'])
      expect(escalated!.conditions.map((c) => c.reason)).toEqual([
        'duration_p99_high',
        'failure_rate_high',
      ])
      // The two edges are distinguishable in TIME...
      expect(firing!.occurredAt).toBe(PASS_1_AT)
      expect(escalated!.occurredAt).toBe(PASS_2_AT)
      // ...and neither reports the card's own `createdAt`, which is what both would have said.
      expect(escalated!.occurredAt).not.toBe(MINTED_CARD_CREATED_AT + 1)
      // The transition ORDINAL is what the receiver's dedupe key uses, since `occurredAt` is a
      // per-process clock read and two nodes can observe one transition (see below).
      expect(firing!.transition).toBe(1)
      expect(escalated!.transition).toBe(2)
    })

    it('gives two sweepers racing on one transition the SAME ordinal', async () => {
      // `preventOverrun` only stops a sweeper stacking its OWN passes; nothing elects a leader
      // across a multi-node deployment, so two nodes can observe one transition. They read the
      // same open card, so the ordinal they derive from it agrees and a receiver collapses their
      // two deliveries into one page. A clock read would differ per process and page twice.
      const { container, alerts } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1')],
        summaries: { 'acc-1': UNHEALTHY },
        openCardWorkspaces: [],
      })

      // Both passes see the same prior state, because neither has committed when the other reads
      // modelled here by running them concurrently against the one shared fake.
      await Promise.all([
        sweepPlatformHealth(container, PASS_1_AT),
        sweepPlatformHealth(container, PASS_2_AT),
      ])

      expect(alerts).toHaveLength(2)
      const [a, b] = alerts.map((entry) => entry.event)
      expect(a!.cardId).toBe(b!.cardId)
      expect(a!.transition).toBe(b!.transition)
      // ...which is exactly the disagreement the ordinal exists to survive.
      expect(a!.occurredAt).not.toBe(b!.occurredAt)
    })

    it('announces a resolved edge when the account recovers', async () => {
      const { container, alerts } = makeContainer({
        workspaces: [workspace('ws-1', 'acc-1')],
        summaries: { 'acc-1': HEALTHY },
      })
      await sweepPlatformHealth(container, PASS_1_AT)
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
      await sweepPlatformHealth(container, PASS_1_AT)
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
      const result = await sweepPlatformHealth(container, PASS_1_AT, logger)
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
      expect(await sweepPlatformHealth(container, PASS_1_AT)).toEqual({ raised: 1, cleared: 0 })
      expect(raises).toHaveLength(1)
    })
  })
})

describe('sweepPlatformHealth: per-failure-kind rules', () => {
  /** A deployment that pages when evictions pass 10% of the window's failures. */
  const EVICTION_RULE = {
    ...DEFAULT_PLATFORM_ALERT_THRESHOLDS,
    failureKindRules: [{ kind: 'evicted', maxShare: 0.1 }],
  }
  /** {@link UNHEALTHY}'s 8 failures, split so evictions are 25% and nothing is dominant. */
  const withFailures = (failures: { kind: string; count: number }[]): PlatformObservability => ({
    ...UNHEALTHY,
    failures,
  })
  const EVICTING = withFailures([
    { kind: 'agent', count: 4 },
    { kind: 'job_failed', count: 2 },
    { kind: 'evicted', count: 2 },
  ])
  const TIMING_OUT = withFailures([
    { kind: 'agent', count: 4 },
    { kind: 'job_failed', count: 2 },
    { kind: 'timeout', count: 2 },
  ])

  it('carries the firing kinds on the card beside the reasons', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': EVICTING },
      thresholds: EVICTION_RULE,
    })
    await sweepPlatformHealth(container, PASS_1_AT)
    expect(raises[0]!.reasons).toEqual(['failure_kind_rate_high', 'failure_rate_high'])
    expect(raises[0]!.payload?.platformAlertFailureKinds).toEqual(['evicted'])
  })

  it('re-raises when the firing KIND changes under an unchanged reason set', async () => {
    // The regression this exists for: evictions subsiding while timeouts cross the same rule
    // is one reason code before and after, so a card compared on reasons alone would go on
    // naming the incident that ended.
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: {
        'acc-1': TIMING_OUT,
      },
      thresholds: {
        ...DEFAULT_PLATFORM_ALERT_THRESHOLDS,
        failureKindRules: [
          { kind: 'evicted', maxShare: 0.1 },
          { kind: 'timeout', maxShare: 0.1 },
        ],
      },
      openCardReasons: ['failure_kind_rate_high', 'failure_rate_high'],
      openCardFailureKinds: ['evicted'],
    })
    const result = await sweepPlatformHealth(container, PASS_1_AT)
    expect(result).toEqual({ raised: 1, cleared: 0 })
    expect(raises[0]!.payload?.platformAlertFailureKinds).toEqual(['timeout'])
  })

  it('does not re-raise while the same kind keeps firing', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': EVICTING },
      thresholds: EVICTION_RULE,
      openCardReasons: ['failure_kind_rate_high', 'failure_rate_high'],
      openCardFailureKinds: ['evicted'],
    })
    expect(await sweepPlatformHealth(container, PASS_1_AT)).toEqual({ raised: 0, cleared: 0 })
    expect(raises).toEqual([])
  })

  it('leaves a card raised before any kind fired comparing equal', async () => {
    // The field is omitted rather than sent empty when nothing is kind-scoped, so a card from
    // before this shipped must not read as a changed firing set on the next pass.
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': UNHEALTHY },
      openCardReasons: ['failure_rate_high'],
    })
    expect(await sweepPlatformHealth(container, PASS_1_AT)).toEqual({ raised: 0, cleared: 0 })
    expect(raises).toEqual([])
  })

  it('names the kind on the outbound condition, which a receiver routes on', async () => {
    const { container, alerts } = makeContainer({
      workspaces: [workspace('ws-1', 'acc-1')],
      summaries: { 'acc-1': EVICTING },
      thresholds: EVICTION_RULE,
    })
    await sweepPlatformHealth(container, PASS_1_AT)
    expect(alerts[0]!.event.conditions).toContainEqual({
      reason: 'failure_kind_rate_high',
      kind: 'evicted',
      value: 0.25,
      threshold: 0.1,
    })
  })
})
