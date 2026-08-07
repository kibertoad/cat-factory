import type {
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  RunLifecycleEvent,
} from '@cat-factory/kernel'
import { RUN_LIFECYCLE_EVENTS } from '@cat-factory/kernel'
import { runLifecycleEventSchema } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { WebhookRunLifecycleSink } from './WebhookRunLifecycleSink.js'

// The run-lifecycle sink shares the delivery core with the notification channel, so the retry /
// signature / SSRF behaviour is pinned there. What is unique here — and easy to get wrong — is the
// SUBSCRIPTION rule: `runEvents` is opt-in (empty means NONE, the opposite of the sibling `types`
// filter), because an endpoint registered before run events existed must not start receiving a new
// family. These also pin the dedupe key and that nothing ever throws out of `runTransitioned`.

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
    runEvents: ['run.started', 'run.completed', 'run.failed'],
    alertEvents: [],
    enabled: true,
    secretSealed: null,
    updatedAt: 1,
    ...overrides,
  }
}

function event(overrides: Partial<RunLifecycleEvent> = {}): RunLifecycleEvent {
  return {
    event: 'run.completed',
    runId: 'exec_1',
    taskId: 'task_login',
    taskTitle: 'Add passkey login',
    pipelineId: 'pl_full',
    pipelineName: 'Full',
    startedAt: 1_699_000_000_000,
    occurredAt: 1_700_000_000_000,
    pullRequestUrl: 'https://vcs.test/pr/7',
    failure: null,
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
  sink: WebhookRunLifecycleSink
  calls: ReturnType<typeof fetchStub>['calls']
  errors: unknown[]
} {
  const { impl, calls } = fetchStub(statuses)
  const errors: unknown[] = []
  return {
    sink: new WebhookRunLifecycleSink({
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

describe('run-lifecycle event vocabulary', () => {
  it('keeps the kernel list and the wire picklist in step', () => {
    // Two declarations of one vocabulary: kernel's (what the engine mints and the stored filter
    // decodes against) and the contract's (what a receiver is promised). A member added to one
    // alone is silently undeliverable or silently unparseable, and nothing else would fail.
    expect([...runLifecycleEventSchema.options].sort()).toEqual([...RUN_LIFECYCLE_EVENTS].sort())
  })
})

describe('WebhookRunLifecycleSink', () => {
  it('delivers a subscribed event with the run envelope and a stable dedupe id', async () => {
    const { sink: s, calls } = sink(webhook())
    await s.runTransitioned('ws1', event())

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://example.test/hook')
    const body = JSON.parse(calls[0]!.body) as {
      workspaceId: string
      event: string
      deliveryId: string
      sentAt: number
      run: Record<string, unknown>
    }
    expect(body.workspaceId).toBe('ws1')
    expect(body.event).toBe('run.completed')
    // The key a receiver dedupes on: delivery is at-least-once, and every part of a repeat that a
    // receiver routes or acts on is the same.
    expect(body.deliveryId).toBe('exec_1:run.completed')
    expect(body.sentAt).toBe(clock.now())
    expect(body.run.taskId).toBe('task_login')
    expect(body.run.pullRequestUrl).toBe('https://vcs.test/pr/7')
    expect(body.run.failure).toBeNull()
  })

  it('re-delivers one transition under the SAME id but a re-stamped sentAt', async () => {
    // The dedupe contract, stated exactly: a durable replay re-emits a settled run, and what a
    // receiver routes on is identical — but `sentAt` (and the projection's `occurredAt`) come from
    // the clock at delivery time, so the two bodies are NOT byte-identical. A receiver hashing the
    // body would process the repeat; one comparing `deliveryId` collapses it. Pinned because the
    // whole no-claim-table decision rests on the receiver being told the right key.
    let tick = 1_700_000_000_000
    const { impl, calls } = fetchStub([200])
    const s = new WebhookRunLifecycleSink({
      notificationWebhookRepository: repoWith(webhook()),
      secretCipher: cipher,
      clock: { now: () => tick },
      fetchImpl: impl,
      sleep: async () => {},
    })
    await s.runTransitioned('ws1', event())
    tick += 30_000
    await s.runTransitioned('ws1', event({ occurredAt: tick }))

    const [first, second] = calls.map((c) => JSON.parse(c.body) as Record<string, unknown>)
    expect(second!.deliveryId).toBe(first!.deliveryId)
    expect(second!.sentAt).not.toBe(first!.sentAt)
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first))
  })

  it('carries the failure record on a run.failed event', async () => {
    const { sink: s, calls } = sink(webhook())
    await s.runTransitioned(
      'ws1',
      event({
        event: 'run.failed',
        pullRequestUrl: null,
        failure: {
          kind: 'environment',
          message: 'runner unwired',
          reason: 'deploy_runner_unwired',
        },
      }),
    )

    const body = JSON.parse(calls[0]!.body) as { run: { failure: Record<string, unknown> | null } }
    expect(body.run.failure).toEqual({
      kind: 'environment',
      message: 'runner unwired',
      reason: 'deploy_runner_unwired',
    })
  })

  it('delivers NOTHING when the endpoint subscribes to no run events', async () => {
    // The pre-feature default. Unlike the notification `types` filter, an empty `runEvents` is
    // "none" — an endpoint registered for parked decisions must not start hearing about runs.
    const { sink: s, calls } = sink(webhook({ runEvents: [] }))
    await s.runTransitioned('ws1', event())
    expect(calls).toHaveLength(0)
  })

  it('delivers only the events the endpoint subscribed to', async () => {
    const { sink: s, calls } = sink(webhook({ runEvents: ['run.failed'] }))
    await s.runTransitioned('ws1', event({ event: 'run.completed' }))
    expect(calls).toHaveLength(0)
    await s.runTransitioned('ws1', event({ event: 'run.failed' }))
    expect(calls).toHaveLength(1)
  })

  it('delivers nothing when no endpoint is registered or it is disabled', async () => {
    const none = sink(null)
    await none.sink.runTransitioned('ws1', event())
    expect(none.calls).toHaveLength(0)

    const off = sink(webhook({ enabled: false }))
    await off.sink.runTransitioned('ws1', event())
    expect(off.calls).toHaveLength(0)
  })

  it('signs the delivery when the endpoint has a secret', async () => {
    const { sink: s, calls } = sink(webhook({ secretSealed: 'sealed:s3cret-value-1234' }))
    await s.runTransitioned('ws1', event())
    // The shared delivery core owns the signature scheme; what matters here is that the sink
    // hands it the sealed secret rather than delivering the run unsigned.
    expect(Object.keys(calls[0]!.headers).some((h) => h.includes('signature'))).toBe(true)
  })

  it('never throws out of runTransitioned — a dead receiver reports through onError', async () => {
    const { sink: s, errors } = sink(webhook(), [500])
    await expect(s.runTransitioned('ws1', event())).resolves.toBeUndefined()
    // Best-effort must not mean invisible: a receiver that never accepted the delivery is
    // reported once, so a broken endpoint is diagnosable rather than silently swallowed.
    expect(errors).toHaveLength(1)
  })

  it('fans out to every subscribed endpoint and skips the ones that did not subscribe', async () => {
    const calls: string[] = []
    const s = new WebhookRunLifecycleSink({
      notificationWebhookRepository: repoWith(
        webhook({ id: 'ci', url: 'https://ci.test/hook' }),
        webhook({ id: 'gatekeeper', url: 'https://gate.test/hook' }),
        webhook({ id: 'quiet', url: 'https://quiet.test/hook', runEvents: [] }),
        webhook({ id: 'off', url: 'https://off.test/hook', enabled: false }),
      ),
      secretCipher: cipher,
      clock,
      fetchImpl: (async (url: unknown) => {
        calls.push(String(url))
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
      sleep: async () => {},
    })
    await s.runTransitioned('ws1', event())
    expect(calls.sort()).toEqual(['https://ci.test/hook', 'https://gate.test/hook'])
  })

  it('lets one dead receiver fail alone, naming it, while its siblings still get the event', async () => {
    // The property the fan-out exists to hold. A shared failure path would have let a permanently
    // broken endpoint mask every sibling's health, and an un-isolated one would have cost them
    // the delivery.
    const delivered: string[] = []
    const reported: { webhookId?: string }[] = []
    const s = new WebhookRunLifecycleSink({
      notificationWebhookRepository: repoWith(
        webhook({ id: 'broken', url: 'https://broken.test/hook' }),
        webhook({ id: 'healthy', url: 'https://healthy.test/hook' }),
      ),
      secretCipher: cipher,
      clock,
      fetchImpl: (async (url: unknown) => {
        if (String(url).includes('broken')) throw new Error('network down')
        delivered.push(String(url))
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
      sleep: async () => {},
      onError: (_error, context) => reported.push(context),
    })

    await expect(s.runTransitioned('ws1', event())).resolves.toBeUndefined()
    expect(delivered).toEqual(['https://healthy.test/hook'])
    expect(reported).toEqual([
      { workspaceId: 'ws1', runId: 'exec_1', event: 'run.completed', webhookId: 'broken' },
    ])
  })
})
