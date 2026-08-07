// The assembled Gatekeeper against a REAL cat-factory deployment.
//
// The suite beside this one runs the same Worker in the same runtime against a SCRIPTED origin,
// which is what makes it hermetic and is also the one thing it structurally cannot see: a fixture
// agrees with this package by construction. So a request shape the generated bindings and the SDK
// both consider correct — a decision field the projection spells differently, a notification type
// the platform retired, a mint the key surface admits on other terms — round-trips there and fails
// for the first time in somebody's production.
//
// This file closes that gap and nothing else. It drives the SAME Worker, in real workerd, with its
// outbound calls landing on a real Node deployment that `@cat-factory/sdk-smoketest` boots, seeds
// and hands over as bindings (`--only=gatekeeper`). Nothing about the Gatekeeper is substituted:
// the Durable Object, the Cap'n Web session, the delivery verifier and the SDK are the ones an
// operator deploys, and every assertion below is about what the DEPLOYMENT answered.
//
// Two things it deliberately does not cover, both stated here rather than left to be inferred:
//
//   - A DELIVERY THAT TRAVELLED. The platform refuses to register a loopback endpoint (public
//     `https` only, and rightly), so the Worker enrols a URL nothing can reach and the receiver is
//     driven with an envelope this suite signs. What rides INSIDE it is the platform's own
//     notification, read back over `/api/v1` verbatim, so the card's fields are the deployment's;
//     ours is the wrapper and the MAC, which the hermetic suite pins.
//   - THE OS SIDE. There is no Cloudflare OS here, by the same reasoning as next door: what can be
//     wrong on our side of the boundary is the Gatekeeper.
//
// Storage is isolated per test (the pool's default), so each test mints its own credentials and
// asserts on DELTAS against the deployment rather than on totals a sibling could have moved.

import { newWebSocketRpcSession } from 'capnweb'
import { env, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { dispositionOf, SUBSCRIBED_CARD_TYPES } from '../../src/index.js'

/** The Worker's own address. Only `SELF` routes to it, so the origin is arbitrary but must parse. */
const ORIGIN = 'https://gatekeeper.example.com'

/** How long a real run is given to reach its first park before the test calls it a failure. */
const PARK_TIMEOUT_MS = 90_000
const POLL_MS = 250

interface Capability {
  tier(): Promise<{ actorId: string; tier: string; keyScope: string }>
  approvals_list(): Promise<
    {
      cardId: string
      runId: string
      type: string
      disposition: string
      resolvedAt: number | null
    }[]
  >
  approvals_inspect(cardId: string): Promise<{
    parks: {
      kind: string
      actions: { action: string; granted: boolean; fields: { name: string; required: boolean }[] }[]
    }[]
    stale?: string
  }>
  approvals_answer(
    cardId: string,
    input: Record<string, unknown>,
  ): Promise<{ status: string; kind?: string; action?: string; detail?: string }>
}

/** The granted operations are named by POLICY at runtime, so they can only be an index here. */
type RemoteCapability = Capability & Record<string, (...args: unknown[]) => Promise<unknown>>

interface RemoteApi {
  connect(request: { actorId: string; label?: string }): RemoteCapability
}

const openSockets: WebSocket[] = []

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.close()
})

/**
 * Open a Cap'n Web session and name the actor, exactly as a paired OS deployment does.
 *
 * A WebSocket rather than the HTTP batch client because the test shares an isolate with the Worker:
 * `SELF` is the binding that addresses it unambiguously.
 */
async function connect(actorId: string): Promise<RemoteCapability> {
  const response = await SELF.fetch(`${ORIGIN}/rpc`, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${env.OS_SHARED_TOKEN}` },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (socket === null) throw new Error('the Worker did not upgrade the RPC request')
  socket.accept()
  openSockets.push(socket as unknown as WebSocket)
  const api = newWebSocketRpcSession(socket as unknown as WebSocket) as unknown as RemoteApi
  return api.connect({ actorId })
}

/**
 * Call one of the runtime-named operations.
 *
 * Direct, never through `Function.prototype.call`: on a Cap'n Web stub `.call` is one more property
 * in the remote path, so `method.call(...)` asks the Gatekeeper for an operation named
 * `tasks_get.call` and fails with a message that reads like a bug in this helper.
 */
function operation(
  capability: RemoteCapability,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const method = capability[name] as (input: Record<string, unknown>) => Promise<unknown>
  return method(args)
}

/** One call to the live deployment on the PROVISIONING key: what the Gatekeeper cannot show itself. */
async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${env.CAT_FACTORY_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.PROVISIONING_KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  const text = await response.text()
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : null) as T }
}

/** POST one of the Worker's admin routes, with the paired deployment's shared token. */
function admin(path: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OS_SHARED_TOKEN}` },
  })
}

/** Sign a body the way the platform's delivery core does: HMAC over `<timestamp>.<body>`. */
async function sign(rawBody: string, timestamp: number): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  )
  return {
    'content-type': 'application/json',
    'x-cat-factory-timestamp': String(timestamp),
    'x-cat-factory-signature': `v1=${[...new Uint8Array(mac)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`,
  }
}

interface LiveNotification {
  id: string
  type: string
  status: string
  executionId: string | null
  blockId: string | null
}

/** Wrap a real notification in the delivery envelope the platform's channel composes. */
async function deliver(notification: LiveNotification): Promise<Response> {
  const raw = JSON.stringify({
    // The platform's own formula, so a receiver deduping on it behaves here as it does live.
    deliveryId: `${notification.id}-${notification.status}`,
    sentAt: Date.now(),
    workspaceId: '',
    runId: notification.executionId,
    taskId: notification.blockId,
    notification,
  })
  const timestamp = Date.now()
  return SELF.fetch(`${ORIGIN}/webhook`, {
    method: 'POST',
    headers: await sign(raw, timestamp),
    body: raw,
  })
}

/** Poll until `read` answers something, or fail naming what was last seen. */
async function until<T>(
  what: string,
  read: () => Promise<T | null>,
  describeLast: () => string,
): Promise<T> {
  const deadline = Date.now() + PARK_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new Error(
    `the deployment never ${what} within ${PARK_TIMEOUT_MS}ms. Last: ${describeLast()}`,
  )
}

async function firstServiceId(capability: RemoteCapability): Promise<string> {
  const services = (await operation(capability, 'services_list')) as {
    services: { serviceId: string }[]
  }
  const serviceId = services.services[0]?.serviceId ?? ''
  expect(serviceId).not.toBe('')
  return serviceId
}

/**
 * File a task the way a requester would.
 *
 * The DESCRIPTION is not decoration. The platform runs a deterministic input gate before the first
 * dispatch, and a task carrying only a title parks on it (`description_missing`) without an agent
 * ever being asked — which is correct behaviour, and would make every run below stop on the wrong
 * park. It is also the first thing this leg found that no scripted origin could have.
 */
async function createTask(capability: RemoteCapability, title: string): Promise<string> {
  const created = (await operation(capability, 'tasks_create', {
    serviceId: await firstServiceId(capability),
    body: {
      title,
      taskType: 'feature',
      description:
        'Add a health endpoint that answers 200 with the build revision, so an operator can ' +
        'tell a deployed instance apart from the one it replaced.',
    },
  })) as { taskId: string; title: string }
  expect(created.title).toBe(title)
  return created.taskId
}

describe('enrolment', () => {
  it('registers its own named endpoint without displacing the workspace default', async () => {
    const enrolled = await admin('/admin/enroll')
    expect(enrolled.status).toBe(200)
    const registration = (await enrolled.json()) as { webhookId: string; url: string }
    expect(registration.webhookId).toBe(env.WEBHOOK_ID)

    // The vocabularies are the point of doing this against a live surface: `types` and `runEvents`
    // are validated by the deployment, so a card type this package still subscribes to after the
    // platform retired it is a 422 here rather than a subscription that silently delivers nothing.
    const stored = await api<{ webhook: { types: string[]; runEvents: string[] } | null }>(
      `/api/v1/notification-webhooks/${registration.webhookId}`,
    )
    expect(stored.status).toBe(200)
    expect(stored.body.webhook).toMatchObject({ url: registration.url, enabled: true })
    expect(new Set(stored.body.webhook?.types)).toEqual(new Set(SUBSCRIBED_CARD_TYPES))
    expect(new Set(stored.body.webhook?.runEvents)).toEqual(
      new Set(['run.started', 'run.completed', 'run.failed']),
    )

    // The whole reason slice 2 added the collection: enrolling must not steal the slot a different
    // integration is already using, which the singular resource addresses.
    const singular = await api<{ webhook: unknown }>('/api/v1/notification-webhook')
    expect(singular.body.webhook).toBeNull()

    // Re-asserted on every cron tick, so the second call must land on the same row rather than
    // spending one of the workspace's ten slots.
    expect((await admin('/admin/enroll')).status).toBe(200)
    const all = await api<{ webhooks: { id: string }[] }>('/api/v1/notification-webhooks')
    expect(all.body.webhooks.filter((row) => row.id === registration.webhookId)).toHaveLength(1)
  })
})

describe('per-actor credentials', () => {
  it('mints ONE key per actor, at the tier’s scope and stamped with their identity', async () => {
    const actorId = 'operator@example.com'
    const before = await keysFor(actorId)

    const capability = await connect(actorId)
    const first = (await operation(capability, 'me_get')) as {
      keyId: string
      scope: string
      label: string
      externalIdentity: string | null
    }

    // `/api/v1/me` describes the key the request ARRIVED on, so this is the live answer to "did the
    // call go out as the actor rather than on the Gatekeeper's own provisioning secret" — the fact
    // the scripted origin can only imitate by echoing a bearer it invented.
    expect(first.externalIdentity).toBe(actorId)
    expect(first.scope).toBe('write')
    expect(first.label).toContain(actorId)

    // The same key on the next call: the mint is claimed and cached, so a second call is not a
    // second credential the deployment now holds and this Gatekeeper has forgotten.
    const second = (await operation(capability, 'me_get')) as { keyId: string }
    expect(second.keyId).toBe(first.keyId)

    const after = await keysFor(actorId)
    expect(after.length - before.length).toBe(1)
  })

  it('drops a rejected credential and mints again, so a revocation is not an outage', async () => {
    // The documented kill switch is revoking the provisioning key, which revokes every key it
    // minted. Revoking one actor's key is the same 401 arriving at the same place, and it is the
    // one recovery path a cache without invalidation turns into a permanent outage.
    const actorId = 'observer@example.com'
    const capability = await connect(actorId)
    const before = (await operation(capability, 'me_get')) as { keyId: string }

    const revoked = await api(`/api/v1/keys/${before.keyId}`, { method: 'DELETE' })
    expect(revoked.status).toBe(204)

    const after = (await operation(capability, 'me_get')) as {
      keyId: string
      externalIdentity: string | null
    }
    expect(after.keyId).not.toBe(before.keyId)
    expect(after.externalIdentity).toBe(actorId)
  })

  it('retires an actor by revoking every key it minted for them, upstream', async () => {
    const actorId = 'observer@example.com'
    const capability = await connect(actorId)
    const minted = (await operation(capability, 'me_get')) as { keyId: string }

    const retired = await admin(`/admin/retire?actorId=${encodeURIComponent(actorId)}`)
    expect(retired.status).toBe(200)
    expect((await retired.json()) as { revoked: string[] }).toMatchObject({
      revoked: expect.arrayContaining([minted.keyId]),
    })

    // `GET /api/v1/keys` lists the LIVE keys, so the credential being gone from it is the
    // deployment's own statement that the revocation landed there rather than only here.
    expect((await keysFor(actorId)).map((key) => key.id)).not.toContain(minted.keyId)
  })
})

describe('the forwarding path', () => {
  it('runs the everyday loop through the bindings, and the write lands in the deployment', async () => {
    const capability = await connect('operator@example.com')
    expect(await capability.tier()).toMatchObject({ tier: 'operator', keyScope: 'write' })

    const title = 'Gatekeeper live smoketest'
    const taskId = await createTask(capability, title)

    const read = (await operation(capability, 'tasks_get', { taskId })) as { title: string }
    expect(read.title).toBe(title)

    await operation(capability, 'tasks_update', { taskId, body: { description: 'edited' } })

    // Read back over REST with a different credential entirely: the write reached the deployment's
    // own store rather than some state the capability alone can see.
    const overRest = await api<{ title: string; description: string | null }>(
      `/api/v1/tasks/${taskId}`,
    )
    expect(overRest.status).toBe(200)
    expect(overRest.body).toMatchObject({ title, description: 'edited' })
  })
})

describe('answering a real park', () => {
  it('raises a card from the platform’s own notification and settles the run with it', async () => {
    const capability = await connect('approver@example.com')
    const taskId = await createTask(capability, 'Gatekeeper live approval')

    const pipelines = (await operation(capability, 'pipelines_list')) as {
      pipelines: { pipelineId: string; headlessStartable: boolean }[]
    }
    const pipelineId = pipelines.pipelines.find((row) => row.headlessStartable)?.pipelineId ?? ''
    const started = (await operation(capability, 'tasks_start', {
      taskId,
      body: pipelineId.length > 0 ? { pipelineId } : {},
    })) as { runId: string | null }
    const runId = started.runId ?? ''
    expect(runId).not.toBe('')

    // The park itself, from the platform: the fake agent this deployment runs raises a real
    // agent-decision on its first step, which the projection publishes and this package answers
    // through `policy/decisions.ts`. A field that table reads by a name the projection does not
    // use fails HERE, which is the whole reason this leg exists.
    let lastList: unknown = null
    const park = await until(
      'parked on a decision this Gatekeeper models',
      async () => {
        const list = (await operation(capability, 'decisions_list', { runId })) as {
          decisions?: { kind: string }[]
        }
        lastList = list
        return (list.decisions ?? []).find((entry) => entry.kind === 'agent-decision') ?? null
      },
      () => JSON.stringify(lastList),
    )
    expect(park.kind).toBe('agent-decision')

    // The card, raised from the notification the platform ACTUALLY wrote for that park. If the
    // platform raises a type this Gatekeeper does not subscribe to, the inbox never hears about a
    // parked run at all, and the failure is otherwise invisible.
    const notifications = (await operation(capability, 'notifications_list')) as {
      notifications: LiveNotification[]
    }
    const raised = notifications.notifications.find((row) => row.executionId === runId)
    expect(raised, 'the parked run raised no notification').toBeDefined()
    expect(SUBSCRIBED_CARD_TYPES).toContain(raised?.type)
    expect(dispositionOf(raised?.type ?? '')).toBe('decision')

    const delivered = await deliver(raised as LiveNotification)
    expect(delivered.status).toBe(202)
    expect(await delivered.json()).toMatchObject({ handled: 'accepted', effect: 'opened' })

    const cards = await capability.approvals_list()
    const card = cards.find((entry) => entry.runId === runId)
    expect(card?.disposition).toBe('decision')
    const cardId = card?.cardId ?? ''

    // What the OS renders before anyone answers: the verbs this park takes, and whether this tier
    // holds the operation behind each. Both come from the LIVE decision list.
    const inspection = await capability.approvals_inspect(cardId)
    expect(inspection.stale).toBeUndefined()
    const answer = inspection.parks
      .find((entry) => entry.kind === 'agent-decision')
      ?.actions.find((action) => action.action === 'answer')
    expect(answer?.granted).toBe(true)
    expect(answer?.fields.map((field) => field.name)).toContain('choice')

    const outcome = await capability.approvals_answer(cardId, {
      action: 'answer',
      choice: 'Take the first option.',
    })
    expect(outcome).toMatchObject({ status: 'answered', kind: 'agent-decision' })

    // The run really left the park, and the card was settled with it.
    const settled = (await operation(capability, 'decisions_list', { runId })) as {
      decisions?: { kind: string }[]
    }
    expect((settled.decisions ?? []).some((entry) => entry.kind === 'agent-decision')).toBe(false)
    const resolved = (await capability.approvals_list()).find((entry) => entry.cardId === cardId)
    expect(resolved?.resolvedAt).not.toBeNull()
  })
})

/** Every LIVE key the deployment holds for one external identity (a revoked one is not listed). */
async function keysFor(externalIdentity: string): Promise<{ id: string }[]> {
  const listed = await api<{ keys: { id: string; externalIdentity: string | null }[] }>(
    '/api/v1/keys',
  )
  expect(listed.status).toBe(200)
  return listed.body.keys.filter((key) => key.externalIdentity === externalIdentity)
}
