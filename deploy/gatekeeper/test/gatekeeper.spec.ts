// The assembled Gatekeeper, in real workerd: a real Durable Object, real WebCrypto, real Cap'n
// Web over a real WebSocket, and the SDK's outbound calls landing on the scripted cat-factory in
// `fake-cat-factory.mjs`.
//
// The faked-OS side is a genuine Cap'n Web CLIENT rather than a Cloudflare OS deployment, which is
// what makes the protocol under test real while leaving out only the workspace UI around it.

import { SELF } from 'cloudflare:test'
import { newWebSocketRpcSession } from 'capnweb'
import { afterEach, describe, expect, it } from 'vitest'

const ORIGIN = 'https://gatekeeper.example.com'
const TOKEN = 'test-os-shared-token'
const WEBHOOK_SECRET = 'test-webhook-secret-0123456789ab'

/** The methods every capability carries, whatever the policy granted. */
interface CapabilityMethods {
  tier(): Promise<{ actorId: string; tier: string; keyScope: string }>
  bindings(): Promise<{ name: string; destructive: boolean; idempotent: boolean }[]>
  withheld(): Promise<{ name: string; reason: string; detail: string }[]>
  approvals_list(): Promise<{ cardId: string; runId: string; resolvedAt: number | null }[]>
  approvals_answer(
    cardId: string,
    input: Record<string, unknown>,
  ): Promise<{ status: string; [key: string]: unknown }>
}

/**
 * A capability as the far side sees it: the methods above, plus the granted operations, which are
 * named at RUNTIME by policy and so can only be an index here. That is the shape under test, not a
 * concession: an operation the policy did not grant is not a typed method that refuses, it is
 * simply not there, which the runtime reports and the type system cannot.
 */
type RemoteCapability = CapabilityMethods & Record<string, (...args: unknown[]) => Promise<unknown>>

/**
 * Call one of the runtime-named operations.
 *
 * A helper rather than a direct index because the far side is a Cap'n Web STUB: every property
 * access answers a callable, and whether the operation exists is settled where it is dispatched,
 * on the Gatekeeper. So an absent operation is a rejection to assert on, never a local
 * `undefined` a test could mistake for one.
 *
 * It calls the method DIRECTLY rather than through `Function.prototype.call`: on a stub, `.call`
 * is one more property in the remote path, so `method.call(...)` asks the Gatekeeper for an
 * operation named `tasks_get.call` and fails with a message that reads like a client-side bug.
 */
function operation(
  capability: RemoteCapability,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const method = capability[name] as (input: Record<string, unknown>) => Promise<unknown>
  return method(args)
}

interface RemoteApi {
  connect(request: { actorId: string; label?: string }): RemoteCapability
}

const openSockets: WebSocket[] = []

/**
 * Open a Cap'n Web session against the Worker.
 *
 * A WebSocket rather than the HTTP batch client for one practical reason: the test runs INSIDE the
 * same isolate as the Worker, so a client that reached for global `fetch` would be routed to the
 * pool's outbound service (the fake cat-factory) instead of to the Worker under test. `SELF` is
 * the service binding that addresses it unambiguously.
 */
async function connectRpc(token = TOKEN): Promise<RemoteApi> {
  const response = await SELF.fetch(`${ORIGIN}/rpc`, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (socket === null) throw new Error('the Worker did not upgrade the RPC request')
  socket.accept()
  openSockets.push(socket as unknown as WebSocket)
  return newWebSocketRpcSession(socket as unknown as WebSocket) as unknown as RemoteApi
}

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.close()
})

async function sign(rawBody: string, timestamp: number): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
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

/** Deliver one webhook the way the platform would, signature and all. */
async function deliver(body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body)
  return SELF.fetch(`${ORIGIN}/webhook`, {
    method: 'POST',
    headers: await sign(raw, Date.now()),
    body: raw,
  })
}

function parkedCard(runId: string, cardId: string): Record<string, unknown> {
  return {
    deliveryId: `${cardId}-open`,
    sentAt: Date.now(),
    workspaceId: 'ws_1',
    runId,
    taskId: 'blk_4',
    notification: {
      id: cardId,
      type: 'merge_review',
      status: 'open',
      title: 'Ready to merge',
      body: 'The merger scored the change.',
    },
  }
}

describe('the RPC surface', () => {
  it('answers /health without a token and refuses /rpc without one', async () => {
    expect((await SELF.fetch(`${ORIGIN}/health`)).status).toBe(200)

    const unauthorized = await SELF.fetch(`${ORIGIN}/rpc`, { headers: { Upgrade: 'websocket' } })
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ error: { reason: 'unauthorized' } })
  })

  it('refuses an actor no tier is granted to, naming the fix', async () => {
    const api = await connectRpc()
    await expect(api.connect({ actorId: 'stranger@example.com' }).tier()).rejects.toThrow(
      /No tier is granted/,
    )
  })

  it('carries the tier the policy resolves, not one the caller asked for', async () => {
    const api = await connectRpc()
    expect(await api.connect({ actorId: 'operator@example.com' }).tier()).toMatchObject({
      tier: 'operator',
      keyScope: 'write',
    })
  })

  // The capability's methods ARE the grant. An operation policy withheld is not a method that
  // refuses; it is absent, so the refusal comes from the caller's own runtime.
  it('exposes a granted operation as a method and a withheld one not at all', async () => {
    const capability = (await connectRpc()).connect({ actorId: 'operator@example.com' })
    await expect(operation(capability, 'tasks_get', { taskId: 'blk_1' })).resolves.toBeDefined()
    await expect(
      operation(capability, 'decisions_approve_step', { runId: 'r', approvalId: 'a' }),
    ).rejects.toThrow()
  })

  it('states what it withheld, and separates policy from transport', async () => {
    const capability = (await connectRpc()).connect({ actorId: 'observer@example.com' })
    const withheld = await capability.withheld()
    const byName = new Map(withheld.map((entry) => [entry.name, entry]))
    expect(byName.get('tasks_stream')?.reason).toBe('not_relayable')
    expect(byName.get('debug_list_llm_calls')?.reason).toBe('denied_by_policy')
    expect(byName.get('tasks_create')?.reason).toBe('above_key_scope')
  })

  // The consequence annotations are what an OS deployment runs its own approval governance on,
  // with the cautious default (an unannotated mutation is destructive) already applied.
  it('annotates each granted operation with its consequence', async () => {
    const capability = (await connectRpc()).connect({ actorId: 'operator@example.com' })
    const byName = new Map((await capability.bindings()).map((entry) => [entry.name, entry]))
    expect(byName.get('tasks_get')).toMatchObject({ destructive: false, idempotent: true })
    expect(byName.get('tasks_stop')).toMatchObject({ destructive: true, idempotent: false })
  })
})

describe('per-actor credentials', () => {
  // The whole reason a Gatekeeper mints rather than shares: the call goes out on a key stamped
  // with this person's identity, so attribution and role-scoped merge policy stay real.
  it('forwards on a key minted for the calling actor, at the tier’s scope', async () => {
    const capability = (await connectRpc()).connect({ actorId: 'operator@example.com' })
    const result = (await operation(capability, 'tasks_get', { taskId: 'blk_1' })) as {
      echo: { path: string; authorization: string }
    }
    expect(result.echo.path).toBe('/api/v1/tasks/blk_1')
    expect(result.echo.authorization).toBe(
      'Bearer cf_live_pak_write_operator@example.com.minted-secret',
    )
  })

  it('gives two actors two different keys', async () => {
    const api = await connectRpc()
    const first = (await operation(api.connect({ actorId: 'operator@example.com' }), 'tasks_get', {
      taskId: 'blk_1',
    })) as { echo: { authorization: string } }
    const second = (await operation(api.connect({ actorId: 'approver@example.com' }), 'tasks_get', {
      taskId: 'blk_1',
    })) as { echo: { authorization: string } }
    expect(first.echo.authorization).not.toBe(second.echo.authorization)
  })
})

describe('taking delivery', () => {
  it('refuses an unsigned delivery and one signed with the wrong secret', async () => {
    const raw = JSON.stringify(parkedCard('run_pending', 'ntf_unsigned'))
    const unsigned = await SELF.fetch(`${ORIGIN}/webhook`, { method: 'POST', body: raw })
    expect(unsigned.status).toBe(401)
    expect(await unsigned.json()).toMatchObject({ error: { reason: 'missing_signature' } })

    const forged = await SELF.fetch(`${ORIGIN}/webhook`, {
      method: 'POST',
      headers: {
        'x-cat-factory-timestamp': String(Date.now()),
        'x-cat-factory-signature': `v1=${'0'.repeat(64)}`,
      },
      body: raw,
    })
    expect(forged.status).toBe(401)
    expect(await forged.json()).toMatchObject({ error: { reason: 'bad_signature' } })
  })

  // At-least-once terminal events with a re-stamped `sentAt`: only the id collapses them, and the
  // duplicate answers 2xx because a receiver arguing about a message it has handled would spend
  // the platform's retry budget on it.
  it('accepts a delivery once and reports the replay as a duplicate', async () => {
    const body = parkedCard('run_pending', 'ntf_dupe')
    const first = await deliver(body)
    expect(first.status).toBe(202)
    expect(await first.json()).toMatchObject({ handled: 'accepted', card: 'opened' })

    const replay = await deliver({ ...body, sentAt: Date.now() + 1 })
    expect(replay.status).toBe(202)
    expect(await replay.json()).toMatchObject({ handled: 'duplicate' })
  })

  it('takes a signed delivery of an unrecognised family without refusing it', async () => {
    const response = await deliver({ deliveryId: 'd_future', sentAt: Date.now(), somethingNew: {} })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ handled: 'accepted', card: 'none' })
  })
})

describe('the approval inbox', () => {
  it('raises a card a granted actor can answer, and settles it', async () => {
    await deliver(parkedCard('run_pending', 'ntf_answerable'))
    const capability = (await connectRpc()).connect({ actorId: 'approver@example.com' })

    const outcome = await capability.approvals_answer('ntf_answerable', { action: 'approve' })
    expect(outcome.status).toBe('answered')
    expect((outcome.decisions as { echo: { path: string } }).echo.path).toBe(
      '/api/v1/runs/run_pending/decisions/approvals/ap_1/approve',
    )

    const card = (await capability.approvals_list()).find(
      (entry) => entry.cardId === 'ntf_answerable',
    )
    expect(card?.resolvedAt).not.toBeNull()
    await expect(
      capability.approvals_answer('ntf_answerable', { action: 'approve' }),
    ).rejects.toThrow(/was settled/)
  })

  // The trap the platform documents: an approve under an unmet quorum returns 200, records a vote,
  // and leaves the run parked. Reporting that as "answered" would have a person believe a run is
  // moving when the next approver has not seen it yet.
  it('reports a recorded-but-short-of-quorum approval as such, and keeps the card open', async () => {
    await deliver(parkedCard('run_quorum', 'ntf_quorum'))
    const capability = (await connectRpc()).connect({ actorId: 'approver@example.com' })

    const outcome = await capability.approvals_answer('ntf_quorum', { action: 'approve' })
    expect(outcome).toMatchObject({
      status: 'recorded',
      recordedApprovals: 1,
      requiredApprovals: 2,
    })

    const card = (await capability.approvals_list()).find((entry) => entry.cardId === 'ntf_quorum')
    expect(card?.resolvedAt).toBeNull()
  })

  it('names the verb a gate at its rework cap actually takes', async () => {
    await deliver(parkedCard('run_exceeded', 'ntf_exceeded'))
    const capability = (await connectRpc()).connect({ actorId: 'approver@example.com' })
    await expect(
      capability.approvals_answer('ntf_exceeded', { action: 'approve' }),
    ).rejects.toThrow(/resolve-exceeded/)
  })

  // A card is a pointer, not the decision. Between the delivery and the answer the run can be
  // finished or held by a wait this surface cannot answer, and the run's own `unanswerable` entry
  // is what says which — reporting a bare failure would send someone to the wrong place.
  it('reports a card whose run has moved on, quoting the run’s own unanswerable wait', async () => {
    await deliver(parkedCard('run_stale', 'ntf_stale'))
    const capability = (await connectRpc()).connect({ actorId: 'approver@example.com' })

    const outcome = await capability.approvals_answer('ntf_stale', { action: 'approve' })
    expect(outcome.status).toBe('stale')
    expect(outcome.detail).toMatch(/human_wait_gate/)
  })

  // The approval flow gets no privilege of its own: it forwards through the SAME granted bindings,
  // so a tier that cannot approve cannot approve through the inbox either.
  it('refuses an answer from a tier that was not granted the decision operations', async () => {
    await deliver(parkedCard('run_pending', 'ntf_forbidden'))
    const capability = (await connectRpc()).connect({ actorId: 'operator@example.com' })
    await expect(
      capability.approvals_answer('ntf_forbidden', { action: 'approve' }),
    ).rejects.toThrow(/does not grant/)
  })

  it('refuses a card it never raised', async () => {
    const capability = (await connectRpc()).connect({ actorId: 'approver@example.com' })
    await expect(capability.approvals_answer('ntf_nope', { action: 'approve' })).rejects.toThrow(
      /No approval card/,
    )
  })
})

describe('enrolment', () => {
  // Idempotent by the caller-chosen id, and subscribed to exactly the card types the inbox acts
  // on: a Gatekeeper that subscribed to the platform's defaults would both miss types it handles
  // and receive ones it cannot answer.
  it('registers its own endpoint under the configured id, subscribing to what it can act on', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      webhookId: 'gatekeeper',
      url: 'https://gatekeeper.example.com/webhook',
    })
  })

  it('refuses to enroll without the shared token', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin/enroll`, { method: 'POST' })
    expect(response.status).toBe(401)
  })
})
