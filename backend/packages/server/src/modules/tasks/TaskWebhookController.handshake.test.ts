import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type {
  TaskSourceWebhookAdapter,
  TrackerWebhookDelivery,
  TrackerWebhookEvent,
  TrackerWebhookHandshake,
} from '@cat-factory/kernel'
import type { TasksModule } from '@cat-factory/orchestration'
import { taskWebhookController } from './TaskWebhookController.js'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// The receiver's handshake branch. The conformance suite proves every facade answers a verified
// handshake and refuses an unsigned one; what it cannot see is the receiver's side of the contract:
// the response headers, that a handshake never reaches `parse` or the queue, that the handshake is
// never asked about an unverified delivery, and that an adapter WITHOUT the member is untouched.

const ISSUE: TrackerWebhookEvent = {
  kind: 'issue',
  source: 'jira',
  externalId: 'PROJ-1',
  action: 'created',
  title: 't',
  labels: [],
  issueType: null,
  board: null,
  url: null,
}

/**
 * Mount the receiver over a container whose `jira` provider is `adapter`, recording what the
 * receiver asked of it and what it enqueued. `handleError` is mounted because the 401 is a thrown
 * `DomainError`; without it the refusal would read as a 500.
 */
function harness(adapter: (calls: string[]) => TaskSourceWebhookAdapter) {
  const calls: string[] = []
  const enqueued: TrackerWebhookEvent[] = []
  const webhook = adapter(calls)
  const tasks = {
    connectionService: {
      providerFor: () => ({ kind: 'jira', webhook }),
      getConnectionRecord: async () => ({ credentials: { webhookSecret: 's3cret' } }),
    },
  } as unknown as TasksModule

  const container = {
    tasks,
    trackerWebhook: { service: { handle: async () => undefined } },
    gateways: {
      trackerWebhook: {
        enqueueEvent: async (_workspaceId: string, event: TrackerWebhookEvent) => {
          enqueued.push(event)
          return true
        },
      },
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/webhooks', taskWebhookController())

  const deliver = (body: unknown) =>
    app.request('/webhooks/tasks/jira/ws-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  return { deliver, calls, enqueued }
}

/** An adapter that verifies `{ signed: true }` bodies and records each member it is asked. */
function recording(
  calls: string[],
  handshake?: (delivery: TrackerWebhookDelivery) => TrackerWebhookHandshake | null,
): TaskSourceWebhookAdapter {
  const read = (delivery: TrackerWebhookDelivery) =>
    JSON.parse(new TextDecoder().decode(delivery.raw)) as { signed?: boolean; challenge?: string }
  return {
    async verify(_secret, delivery) {
      calls.push('verify')
      return read(delivery).signed === true
    },
    ...(handshake
      ? {
          handshake(delivery: TrackerWebhookDelivery) {
            calls.push('handshake')
            return handshake(delivery)
          },
        }
      : {}),
    parse() {
      calls.push('parse')
      return ISSUE
    },
  }
}

const echo = (delivery: TrackerWebhookDelivery): TrackerWebhookHandshake | null => {
  const { challenge } = JSON.parse(new TextDecoder().decode(delivery.raw)) as {
    challenge?: string
  }
  return challenge ? { contentType: 'text/plain', body: challenge } : null
}

describe('task webhook receiver handshake', () => {
  it("sends the adapter's response with a 200 and never parses or enqueues the delivery", async () => {
    const { deliver, calls, enqueued } = harness((c) => recording(c, echo))

    const res = await deliver({ signed: true, challenge: 'c-123' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(await res.text()).toBe('c-123')
    expect(calls).toEqual(['verify', 'handshake'])
    expect(enqueued).toEqual([])
  })

  it('refuses an unverified delivery before the handshake is asked', async () => {
    const { deliver, calls, enqueued } = harness((c) => recording(c, echo))

    const res = await deliver({ signed: false, challenge: 'c-123' })

    expect(res.status).toBe(401)
    expect(calls).toEqual(['verify'])
    expect(enqueued).toEqual([])
  })

  it('parses and enqueues as before when the handshake returns null', async () => {
    const { deliver, calls, enqueued } = harness((c) => recording(c, echo))

    const res = await deliver({ signed: true })

    expect(res.status).toBe(202)
    expect(calls).toEqual(['verify', 'handshake', 'parse'])
    expect(enqueued).toEqual([ISSUE])
  })

  it('parses and enqueues as before when the adapter has no handshake', async () => {
    const { deliver, calls, enqueued } = harness((c) => recording(c))

    const res = await deliver({ signed: true, challenge: 'c-123' })

    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
    expect(calls).toEqual(['verify', 'parse'])
    expect(enqueued).toEqual([ISSUE])
  })
})
