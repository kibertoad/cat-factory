import type {
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  PlatformAlertEvent,
} from '@cat-factory/kernel'
import { PLATFORM_ALERT_EVENTS } from '@cat-factory/kernel'
import { platformAlertEventSchema, platformAlertReasonSchema } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { WebhookPlatformAlertSink } from './WebhookPlatformAlertSink.js'

// The platform-alert sink shares the delivery core with its two siblings, so retry / signature /
// SSRF behaviour is pinned once over there. What is unique here is the part an on-call
// integration's correctness rests on: the opt-in subscription rule, and the DEDUPE KEY, which has
// to collapse a retry of one transition while keeping an escalation and a second incident apart.

function repoWith(
  ...records: readonly (NotificationWebhookRecord | null)[]
): NotificationWebhookRepository {
  const present = records.filter((record): record is NotificationWebhookRecord => record !== null)
  return {
    get: async (_workspaceId, id) => present.find((record) => record.id === id) ?? null,
    list: async () => present,
    put: async () => {},
    delete: async () => {},
  }
}

const cipher = {
  encrypt: async (plaintext: string) => `sealed:${plaintext}`,
  decrypt: async (envelope: string) => envelope.replace(/^sealed:/, ''),
}
const clock = { now: () => 1_700_000_000_000 }

function webhook(overrides: Partial<NotificationWebhookRecord> = {}): NotificationWebhookRecord {
  return {
    workspaceId: 'ws1',
    id: 'default',
    name: 'Default',
    url: 'https://example.test/hook',
    types: [],
    runEvents: [],
    alertEvents: ['platform_health.firing', 'platform_health.resolved'],
    enabled: true,
    secretSealed: null,
    updatedAt: 1,
    ...overrides,
  }
}

function event(overrides: Partial<PlatformAlertEvent> = {}): PlatformAlertEvent {
  return {
    event: 'platform_health.firing',
    cardId: 'ntf_1',
    transition: 1,
    accountId: 'acc_1',
    window: '1h',
    conditions: [{ reason: 'failure_rate_high', value: 0.42, threshold: 0.25 }],
    occurredAt: 1_700_000_000_000,
    failingRuns: [
      { executionId: 'exec_9', blockId: 'blk_9', failureKind: 'agent', createdAt: 1_699_999_000 },
    ],
    failedTotal: 23,
    ...overrides,
  }
}

/** A fetch stub that records every call and replays a queued sequence of responses. */
function fetchStub(statuses: (number | 'throw')[]) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  let i = 0
  const impl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string }
    calls.push({ url: String(url), headers: request.headers, body: request.body })
    const next = statuses[Math.min(i, statuses.length - 1)]
    i += 1
    if (next === 'throw') throw new Error('network down')
    return new Response(null, { status: next })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function sink(
  record: NotificationWebhookRecord | null,
  statuses: (number | 'throw')[] = [200],
): {
  sink: WebhookPlatformAlertSink
  calls: ReturnType<typeof fetchStub>['calls']
  errors: unknown[]
} {
  const { impl, calls } = fetchStub(statuses)
  const errors: unknown[] = []
  return {
    sink: new WebhookPlatformAlertSink({
      notificationWebhookRepository: repoWith(record),
      secretCipher: cipher,
      clock,
      fetchImpl: impl,
      // Skip the real backoff so a retry case doesn't spend wall-clock in the test.
      sleep: async () => {},
      onError: (error) => errors.push(error),
    }),
    calls,
    errors,
  }
}

/** The parsed body of the nth delivery. */
function bodyOf(calls: ReturnType<typeof fetchStub>['calls'], index = 0) {
  return JSON.parse(calls[index]!.body) as {
    deliveryId: string
    sentAt: number
    workspaceId: string
    event: string
    alert: {
      accountId: string
      window: string
      conditions: { reason: string; value: number; threshold: number; kind?: string }[]
      occurredAt: number
      failingRuns: { executionId: string }[]
      failedTotal: number | null
    }
  }
}

describe('platform-alert event vocabulary', () => {
  it('keeps the kernel list and the wire picklist in step', () => {
    // Two declarations of one vocabulary: kernel's (what the sweep mints and the stored filter
    // decodes against) and the contract's (what a receiver is promised). A member added to one
    // alone is silently undeliverable or silently unparseable, and nothing else would fail.
    expect([...platformAlertEventSchema.options].sort()).toEqual([...PLATFORM_ALERT_EVENTS].sort())
  })

  it('passes an alert reason through verbatim rather than narrowing it', async () => {
    // The wire condition's `reason` is deliberately a plain string. This pins WHY: the reason
    // vocabulary grows additively, and a deployment one release ahead of its receiver must still
    // page it. A sink that filtered against today's picklist would drop exactly the new condition
    // it is alerting about — the failure mode a receiver could never diagnose.
    const unknownToThisPicklist = 'quota_exhausted'
    expect(platformAlertReasonSchema.options).not.toContain(unknownToThisPicklist)
    const { sink: s, calls } = sink(webhook())
    await s.platformHealthChanged(
      'ws1',
      event({ conditions: [{ reason: unknownToThisPicklist, value: 3, threshold: 1 }] }),
    )
    expect(bodyOf(calls).alert.conditions[0]!.reason).toBe(unknownToThisPicklist)
  })
})

describe('WebhookPlatformAlertSink', () => {
  it('delivers a firing edge with the tripped numbers and the evidence sample', async () => {
    const { sink: s, calls } = sink(webhook())
    await s.platformHealthChanged('ws1', event())

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://example.test/hook')
    const body = bodyOf(calls)
    expect(body.workspaceId).toBe('ws1')
    expect(body.event).toBe('platform_health.firing')
    expect(body.sentAt).toBe(clock.now())
    // The card carries no live numbers (its payload is its dedup identity); this delivery is an
    // edge, stored nowhere, so it carries what actually tripped — the values a pager routes on.
    expect(body.alert.conditions).toEqual([
      { reason: 'failure_rate_high', value: 0.42, threshold: 0.25 },
    ])
    // Health is aggregated per ACCOUNT; the id is how a receiver collapses the per-workspace
    // fan-out of one condition into one incident.
    expect(body.alert.accountId).toBe('acc_1')
    expect(body.alert.window).toBe('1h')
    expect(body.alert.failingRuns.map((run) => run.executionId)).toEqual(['exec_9'])
    expect(body.alert.failedTotal).toBe(23)
  })

  it('carries the failure kind of a kind-scoped condition, and omits it elsewhere', async () => {
    // Every per-kind rule fires under ONE reason code, so the kind is the only thing telling a
    // receiver which rule tripped. It also has to be absent, not empty, on the deployment-wide
    // conditions: a `kind` on a backlog alert would name a failure kind that had nothing to do
    // with it.
    const { sink: s, calls } = sink(webhook())
    await s.platformHealthChanged(
      'ws1',
      event({
        conditions: [
          { reason: 'backlog_high', value: 60, threshold: 50 },
          { reason: 'failure_kind_rate_high', kind: 'evicted', value: 0.25, threshold: 0.1 },
        ],
      }),
    )
    const body = bodyOf(calls)
    expect(body.alert.conditions[0]).toEqual({ reason: 'backlog_high', value: 60, threshold: 50 })
    expect(body.alert.conditions[1]!.kind).toBe('evicted')
    // And the dedupe key names it, so three per-kind rules do not read as one code repeated.
    expect(body.deliveryId).toBe(
      'ntf_1:platform_health.firing:1:backlog_high,failure_kind_rate_high=evicted',
    )
  })

  it('reports an unreadable failed total as null rather than as zero', async () => {
    // "Nothing failed in this workspace" and "the platform could not read what failed" are
    // opposite facts, and a receiver sizing an incident off the number must be able to tell them
    // apart. The sample is capped, so the total is the only thing that states what was left out.
    const { sink: s, calls } = sink(webhook())
    await s.platformHealthChanged('ws1', event({ failingRuns: [], failedTotal: null }))
    expect(bodyOf(calls).alert.failedTotal).toBeNull()
  })

  it('delivers a resolved edge with no conditions', async () => {
    const { sink: s, calls } = sink(webhook())
    await s.platformHealthChanged(
      'ws1',
      event({
        event: 'platform_health.resolved',
        conditions: [],
        failingRuns: [],
        failedTotal: null,
      }),
    )
    const body = bodyOf(calls)
    expect(body.event).toBe('platform_health.resolved')
    // The absence of conditions IS the content of this edge.
    expect(body.alert.conditions).toEqual([])
    expect(body.deliveryId).toBe('ntf_1:platform_health.resolved:1')
  })

  describe('the dedupe key', () => {
    it('repeats for a re-delivery of one transition, even from a second sweeper', async () => {
      // Same incident, same transition, delivered twice: the case that decides the key's shape.
      // Sweepers are only guarded against overlap WITHIN a process, so two nodes of one
      // deployment can observe a transition together and will stamp DIFFERENT `occurredAt`s for
      // it. Both derive the ordinal from the same open card, so the key still collapses them.
      // Hashing the body would not, since `sentAt` is re-stamped too.
      let tick = 1_700_000_000_000
      const { impl, calls } = fetchStub([200])
      const s = new WebhookPlatformAlertSink({
        notificationWebhookRepository: repoWith(webhook()),
        secretCipher: cipher,
        clock: { now: () => tick },
        fetchImpl: impl,
        sleep: async () => {},
      })
      await s.platformHealthChanged('ws1', event())
      tick += 120_000
      await s.platformHealthChanged('ws1', event({ occurredAt: tick }))

      const [first, second] = calls.map((c) => JSON.parse(c.body) as Record<string, unknown>)
      expect(second!.deliveryId).toBe(first!.deliveryId)
      expect(second!.sentAt).not.toBe(first!.sentAt)
    })

    it('changes when an open incident ESCALATES to another condition', async () => {
      // One condition becoming two re-raises the SAME card, so a key built on the card id alone
      // would land on the id of the alert it escalated from and a deduping receiver would drop
      // the page that says it got worse.
      const { sink: s, calls } = sink(webhook())
      await s.platformHealthChanged('ws1', event())
      await s.platformHealthChanged(
        'ws1',
        event({
          transition: 2,
          conditions: [
            { reason: 'backlog_high', value: 900, threshold: 500 },
            { reason: 'failure_rate_high', value: 0.42, threshold: 0.25 },
          ],
        }),
      )
      expect(bodyOf(calls, 1).deliveryId).not.toBe(bodyOf(calls, 0).deliveryId)
    })

    it('changes when an incident SUBSIDES to a condition set it already reported', async () => {
      // The case a key built on the reason set alone gets wrong, and the reason the transition
      // ordinal exists. {A} -> {A,B} -> {A} is three transitions over two distinct sets, so the
      // third edge repeats the first one's set on the same still-open card. Keyed on the set, a
      // deduping receiver would drop it and go on paging that the incident was still escalated.
      const { sink: s, calls } = sink(webhook())
      const escalated = {
        transition: 2,
        conditions: [
          { reason: 'backlog_high', value: 900, threshold: 500 },
          { reason: 'failure_rate_high', value: 0.42, threshold: 0.25 },
        ],
      }
      await s.platformHealthChanged('ws1', event())
      await s.platformHealthChanged('ws1', event(escalated))
      await s.platformHealthChanged('ws1', event({ transition: 3 }))

      const ids = calls.map((_, i) => bodyOf(calls, i).deliveryId)
      expect(new Set(ids).size).toBe(3)
      // Specifically: the subsided edge is not mistaken for the one that opened the incident,
      // even though the two are identical in card, event and conditions.
      expect(ids[2]).not.toBe(ids[0])
    })

    it('changes when a NEW incident trips the same condition again', async () => {
      // Recovered, then unhealthy again for the same reason. The card was dismissed and a fresh
      // one minted, so the new page is a new page rather than a duplicate of the old one.
      const { sink: s, calls } = sink(webhook())
      await s.platformHealthChanged('ws1', event())
      await s.platformHealthChanged('ws1', event({ cardId: 'ntf_2' }))
      expect(bodyOf(calls, 1).deliveryId).not.toBe(bodyOf(calls, 0).deliveryId)
    })
  })

  it('delivers NOTHING when the endpoint subscribes to no alert events', async () => {
    // The pre-feature default, and the one that must never drift: an endpoint registered for
    // parked decisions must not start paging an on-call rotation because a release added a family.
    const { sink: s, calls } = sink(webhook({ alertEvents: [] }))
    await s.platformHealthChanged('ws1', event())
    expect(calls).toHaveLength(0)
  })

  it('delivers only the edges the endpoint subscribed to', async () => {
    // A receiver that opens incidents from the firing edge and closes them on its own timer
    // legitimately wants only half the family.
    const { sink: s, calls } = sink(webhook({ alertEvents: ['platform_health.firing'] }))
    await s.platformHealthChanged('ws1', event({ event: 'platform_health.resolved' }))
    expect(calls).toHaveLength(0)
    await s.platformHealthChanged('ws1', event())
    expect(calls).toHaveLength(1)
  })

  it('delivers nothing when no endpoint is registered or it is disabled', async () => {
    const none = sink(null)
    await none.sink.platformHealthChanged('ws1', event())
    expect(none.calls).toHaveLength(0)

    const off = sink(webhook({ enabled: false }))
    await off.sink.platformHealthChanged('ws1', event())
    expect(off.calls).toHaveLength(0)
  })

  it('signs the delivery when the endpoint has a secret', async () => {
    const { sink: s, calls } = sink(webhook({ secretSealed: 'sealed:s3cret-value-1234' }))
    await s.platformHealthChanged('ws1', event())
    expect(Object.keys(calls[0]!.headers).some((h) => h.includes('signature'))).toBe(true)
  })

  it('never throws out of platformHealthChanged — a dead receiver reports through onError', async () => {
    // The most important best-effort site of the three: the sweep that noticed the deployment is
    // unhealthy must not be stopped by the pager endpoint being down too.
    const { sink: s, errors } = sink(webhook(), [500])
    await expect(s.platformHealthChanged('ws1', event())).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
