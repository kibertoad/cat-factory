import type {
  Notification,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  WEBHOOK_SIGNATURE_HEADERS,
  WebhookNotificationChannel,
} from './WebhookNotificationChannel.js'

// The webhook channel is best-effort by contract (a receiver outage must never break the
// notification lifecycle), which makes its failure handling easy to get subtly wrong — a swallowed
// error that also swallows the retry, or a retry loop that hammers a receiver rejecting the
// payload. These pin the behaviour that matters: the default type filter, the signature, the
// retry-on-5xx / give-up-on-4xx split, and that nothing ever throws out of `deliver`.

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'ntf_1',
    type: 'requirement_review',
    status: 'open',
    severity: 'normal',
    blockId: 'task_login',
    executionId: 'exec_1',
    title: 'Requirements need answers',
    body: 'Three findings are open.',
    payload: null,
    createdAt: 1,
    resolvedAt: null,
    ...overrides,
  }
}

function repoWith(
  ...records: readonly (NotificationWebhookRecord | null)[]
): NotificationWebhookRepository {
  const present = records.filter((record): record is NotificationWebhookRecord => record !== null)
  return {
    get: async (_workspaceId, id) => present.find((record) => record.id === id) ?? null,
    list: async () => present,
    put: async () => 'stored' as const,
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
    alertEvents: [],
    enabled: true,
    secretSealed: null,
    updatedAt: 1,
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

function channel(
  record: NotificationWebhookRecord | null,
  statuses: (number | 'throw')[] = [200],
): {
  channel: WebhookNotificationChannel
  calls: ReturnType<typeof fetchStub>['calls']
  errors: unknown[]
} {
  const { impl, calls } = fetchStub(statuses)
  const errors: unknown[] = []
  return {
    channel: new WebhookNotificationChannel({
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

describe('WebhookNotificationChannel', () => {
  it('delivers a parking notification and lifts the run/task ids onto the envelope', async () => {
    const { channel: ch, calls } = channel(webhook())
    await ch.deliver('ws1', notification())

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://example.test/hook')
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>
    expect(body.workspaceId).toBe('ws1')
    // Lifted out of the notification so a receiver can route without unpacking the card.
    expect(body.runId).toBe('exec_1')
    expect(body.taskId).toBe('task_login')
    expect(body.deliveryId).toBe('ntf_1-open')
    expect(body.sentAt).toBe(clock.now())
  })

  it('signs the delivery over `<timestamp>.<body>` when a secret is configured', async () => {
    const { channel: ch, calls } = channel(webhook({ secretSealed: 'sealed:s3cret-value-1234' }))
    await ch.deliver('ws1', notification())

    const headers = calls[0]!.headers
    expect(headers[WEBHOOK_SIGNATURE_HEADERS.timestamp]).toBe(String(clock.now()))
    const signature = headers[WEBHOOK_SIGNATURE_HEADERS.signature]!
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/)

    // Recompute independently: the MAC must cover the timestamp AND the body, so a replayed
    // capture can't have its timestamp rewritten to defeat a receiver's freshness window.
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('s3cret-value-1234'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${clock.now()}.${calls[0]!.body}`),
    )
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(signature).toBe(`v1=${hex}`)
  })

  it('sends no signature headers when the workspace registered no secret', async () => {
    const { channel: ch, calls } = channel(webhook())
    await ch.deliver('ws1', notification())
    expect(calls[0]!.headers[WEBHOOK_SIGNATURE_HEADERS.signature]).toBeUndefined()
  })

  it('applies the default type filter when none is configured', async () => {
    // An empty filter means "the defaults" (the parking + actionable-tail types), NOT everything —
    // registering an endpoint must not fire-hose every operator card at it.
    const parking = channel(webhook())
    await parking.channel.deliver('ws1', notification({ type: 'requirement_review' }))
    expect(parking.calls).toHaveLength(1)

    const operator = channel(webhook())
    await operator.channel.deliver('ws1', notification({ type: 'platform_health' }))
    expect(operator.calls).toHaveLength(0)
  })

  it('honours an explicit type filter and skips a disabled endpoint', async () => {
    const filtered = channel(webhook({ types: ['merge_review'] }))
    await filtered.channel.deliver('ws1', notification({ type: 'requirement_review' }))
    expect(filtered.calls).toHaveLength(0)

    const disabled = channel(webhook({ enabled: false }))
    await disabled.channel.deliver('ws1', notification())
    expect(disabled.calls).toHaveLength(0)
  })

  it('is a no-op when the workspace registered no endpoint', async () => {
    const { channel: ch, calls, errors } = channel(null)
    await ch.deliver('ws1', notification())
    expect(calls).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  it('retries a transient failure and stops once a delivery succeeds', async () => {
    const { channel: ch, calls, errors } = channel(webhook(), [500, 'throw', 200])
    await ch.deliver('ws1', notification())
    expect(calls).toHaveLength(3)
    expect(errors).toHaveLength(0)
  })

  it('gives up immediately on a 4xx rather than hammering a rejecting receiver', async () => {
    // A 4xx is the receiver saying "this request is wrong" (bad secret, rejected shape, revoked
    // endpoint). Retrying cannot fix it and only multiplies load — so exactly one attempt, and the
    // failure is reported through the error hook rather than vanishing.
    const { channel: ch, calls, errors } = channel(webhook(), [403])
    await ch.deliver('ws1', notification())
    expect(calls).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })

  it('never throws out of deliver, even when every attempt fails', async () => {
    // Best-effort by contract: the notification row is already persisted, so a receiver outage
    // must not break the state transition that raised it.
    const { channel: ch, calls, errors } = channel(webhook(), [500])
    await expect(ch.deliver('ws1', notification())).resolves.toBeUndefined()
    expect(calls).toHaveLength(3)
    expect(errors).toHaveLength(1)
  })

  describe('SSRF guard', () => {
    it('refuses to deliver to a private/internal endpoint', async () => {
      // A row can hold an internal URL even though the write boundary rejects one: an endpoint
      // registered before the guard existed, or a hostname that has since resolved inward. The
      // delivery path is the last line, so it must refuse rather than POST the signed body.
      for (const url of [
        'https://169.254.169.254/latest/meta-data/',
        'https://10.0.0.5/hook',
        'https://localhost/hook',
      ]) {
        const { channel: ch, calls, errors } = channel(webhook({ url }))
        await ch.deliver('ws1', notification())
        expect(calls, url).toHaveLength(0)
        expect(errors, url).toHaveLength(1)
      }
    })

    it('re-validates every redirect hop, so a public endpoint cannot bounce to an internal one', async () => {
      // The whole reason delivery goes through `safeFetch`. Validating only the stored URL vouches
      // for the FIRST hop; a receiver is free to 302 the delivery — body, signature headers and
      // all — at the cloud-metadata endpoint, and a plain `fetch` would follow it.
      const seen: string[] = []
      const impl = (async (url: unknown) => {
        seen.push(String(url))
        if (seen.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://169.254.169.254/latest/meta-data/' },
          })
        }
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch

      const errors: unknown[] = []
      const ch = new WebhookNotificationChannel({
        notificationWebhookRepository: repoWith(webhook()),
        secretCipher: cipher,
        clock,
        fetchImpl: impl,
        sleep: async () => {},
        onError: (error) => errors.push(error),
      })
      await ch.deliver('ws1', notification())

      // The first hop went out; the internal target never did, and the block is not retried
      // (re-walking the same chain reaches the same rejected host).
      expect(seen).toEqual(['https://example.test/hook'])
      expect(errors).toHaveLength(1)
    })

    it('allows an internal endpoint when the deployment widened its own policy', async () => {
      // The escape hatch a developer running a local receiver needs. Scoped to the webhook's own
      // config slice, so widening it cannot widen the runner-pool or environment guard.
      const { impl, calls } = fetchStub([200])
      const ch = new WebhookNotificationChannel({
        notificationWebhookRepository: repoWith(webhook({ url: 'http://localhost:9000/hook' })),
        secretCipher: cipher,
        clock,
        fetchImpl: impl,
        sleep: async () => {},
        urlSafetyPolicy: { schemes: ['https', 'http'], allowHosts: ['localhost'] },
      })
      await ch.deliver('ws1', notification())
      expect(calls).toHaveLength(1)
    })
  })

  it('stops retrying once the total delivery budget is spent', async () => {
    // `NotificationService.raise` AWAITS the channel fan-out, so this budget is latency added to
    // the engine step that parks a run. Three 5s attempts plus backoff would let a dead receiver
    // add ~15.8s to a park; the ceiling is a wall-clock deadline, not an attempt count.
    let now = 1_700_000_000_000
    const { impl, calls } = fetchStub([500])
    const errors: unknown[] = []
    const ch = new WebhookNotificationChannel({
      notificationWebhookRepository: repoWith(webhook()),
      secretCipher: cipher,
      // Each attempt "takes" 4s of wall clock, so the second exhausts the 6s budget and there is
      // no third — where a plain attempt counter would have run all three.
      clock: {
        now: () => {
          const value = now
          now += 4000
          return value
        },
      },
      fetchImpl: impl,
      sleep: async () => {},
      onError: (error) => errors.push(error),
    })
    await ch.deliver('ws1', notification())
    expect(calls.length).toBeLessThan(3)
    expect(errors).toHaveLength(1)
  })
})
