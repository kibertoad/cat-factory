// The assembled Gatekeeper, in real workerd: a real Durable Object, real WebCrypto, real Cap'n
// Web over a real WebSocket, and the SDK's outbound calls landing on the scripted cat-factory in
// `fake-cat-factory.mjs`.
//
// The faked-OS side is a genuine Cap'n Web CLIENT rather than a Cloudflare OS deployment, which is
// what makes the protocol under test real while leaving out only the workspace UI around it.

import { SELF } from 'cloudflare:test'
import { newWebSocketRpcSession } from 'capnweb'
import { afterEach, describe, expect, it } from 'vitest'
import { deliver, parkedCard, runEvent } from './deliveries.js'

const ORIGIN = 'https://gatekeeper.example.com'
const TOKEN = 'test-os-shared-token'

/** The methods every capability carries, whatever the policy granted. */
interface CapabilityMethods {
  tier(): Promise<{ actorId: string; tier: string; keyScope: string }>
  bindings(): Promise<{ name: string; destructive: boolean; idempotent: boolean }[]>
  withheld(): Promise<{ name: string; reason: string; detail: string }[]>
  approvals_list(): Promise<
    { cardId: string; runId: string; disposition: string; resolvedAt: number | null }[]
  >
  approvals_inspect(cardId: string): Promise<{
    card: { cardId: string; disposition: string }
    parks: {
      kind: string
      actions: { action: string; granted: boolean; fields: { name: string; required: boolean }[] }[]
    }[]
    stale?: string
  }>
  approvals_answer(
    cardId: string,
    input: Record<string, unknown>,
  ): Promise<{ status: string; [key: string]: unknown }>
  runs_watched(): Promise<{ runId: string; event: string; terminal: boolean }[]>
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

function approver(api: RemoteApi): RemoteCapability {
  return api.connect({ actorId: 'approver@example.com' })
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

  // `POST /api/v1/keys` returns its secret exactly once, so two pipelined FIRST calls that both
  // read "no key yet" both mint, and the loser's credential stays live upstream with nothing here
  // recording that it exists. That is invisible from a response (the second mint answers a
  // perfectly good key), so the scripted origin counts what it was actually asked to issue.
  it('mints once for concurrent first calls by one actor', async () => {
    const capability = (await connectRpc()).connect({ actorId: 'observer@example.com' })
    await Promise.all([
      operation(capability, 'tasks_get', { taskId: 'blk_1' }),
      operation(capability, 'tasks_get', { taskId: 'blk_1' }),
      operation(capability, 'tasks_get', { taskId: 'blk_1' }),
    ])

    const mints = (await (await fetch('https://cat-factory.example.com/__mints')).json()) as Record<
      string,
      number
    >
    expect(mints['pak_read_observer@example.com']).toBe(1)
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
    expect(await first.json()).toMatchObject({ handled: 'accepted', effect: 'opened' })

    const replay = await deliver({ ...body, sentAt: Date.now() + 1 })
    expect(replay.status).toBe(202)
    expect(await replay.json()).toMatchObject({ handled: 'duplicate' })
  })

  it('takes a signed delivery of an unrecognised family without refusing it', async () => {
    const response = await deliver({ deliveryId: 'd_future', sentAt: Date.now(), somethingNew: {} })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ handled: 'accepted', effect: 'none' })
  })
})

describe('the approval inbox', () => {
  it('raises a card a granted actor can answer, and settles it', async () => {
    await deliver(parkedCard('run_pending', 'ntf_answerable'))
    const capability = approver(await connectRpc())

    const outcome = await capability.approvals_answer('ntf_answerable', { action: 'approve' })
    expect(outcome).toMatchObject({ status: 'answered', kind: 'approval-gate', action: 'approve' })
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
    const capability = approver(await connectRpc())

    const outcome = await capability.approvals_answer('ntf_quorum', { action: 'approve' })
    expect(outcome).toMatchObject({
      status: 'recorded',
      detail: '1 of 2 approvals recorded; the gate still needs the rest.',
    })

    const card = (await capability.approvals_list()).find((entry) => entry.cardId === 'ntf_quorum')
    expect(card?.resolvedAt).toBeNull()
  })

  // A gate at its rework cap does not take `approve`, and the useful refusal names the verb that
  // works, not a 409 whose remedy is in a doc.
  it('names the verb a gate at its rework cap actually takes', async () => {
    await deliver(parkedCard('run_exceeded', 'ntf_exceeded'))
    const capability = approver(await connectRpc())
    const outcome = await capability.approvals_answer('ntf_exceeded', {
      action: 'resolve-exceeded',
      choice: 'extra-round',
    })
    expect(outcome.status).toBe('answered')
    expect((outcome.decisions as { echo: { path: string; body: unknown } }).echo).toMatchObject({
      path: '/api/v1/runs/run_exceeded/decisions/approvals/ap_1/resolve-exceeded',
      body: { choice: 'extra-round' },
    })
  })

  // A card is a pointer, not the decision. Between the delivery and the answer the run can be
  // finished or held by a wait this surface cannot answer, and the run's own `unanswerable` entry
  // is what says which; reporting a bare failure would send someone to the wrong place.
  //
  // The card STAYS OPEN. A stale answer settles nothing: the run may still be parked on something
  // a person has to clear, and the platform re-delivers a card under a NEW notification id, so a
  // wrongly settled one is never re-raised and the inbox quietly loses its only pointer to it.
  it('reports a card whose run has moved on, quoting the wait, and leaves the card open', async () => {
    await deliver(parkedCard('run_stale', 'ntf_stale'))
    const capability = approver(await connectRpc())

    const outcome = await capability.approvals_answer('ntf_stale', { action: 'approve' })
    expect(outcome.status).toBe('stale')
    expect(outcome.detail).toMatch(/human_wait_gate/)

    const card = (await capability.approvals_list()).find((entry) => entry.cardId === 'ntf_stale')
    expect(card?.resolvedAt).toBeNull()
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
    const capability = approver(await connectRpc())
    await expect(capability.approvals_answer('ntf_nope', { action: 'approve' })).rejects.toThrow(
      /No approval card/,
    )
  })
})

// The half that used to be missing entirely. A run parks on THIRTEEN different things; the inbox
// subscribed to ten card types and could answer exactly one of them.
describe('answering the parks that are not approval gates', () => {
  it('drives an iterative review through its own verbs', async () => {
    await deliver(parkedCard('run_review', 'ntf_review', 'requirement_review'))
    const capability = approver(await connectRpc())

    const replied = await capability.approvals_answer('ntf_review', {
      action: 'reply',
      itemId: 'ri_1',
      reply: 'Postgres, on the existing cluster.',
    })
    // A reply is recorded and folded in by a later incorporation, so the loop still holds the run.
    expect(replied).toMatchObject({ status: 'recorded', kind: 'requirements-review' })
    expect((replied.decisions as { echo: { path: string; body: unknown } }).echo).toMatchObject({
      path: '/api/v1/runs/run_review/decisions/requirements/findings/ri_1/reply',
      body: { reply: 'Postgres, on the existing cluster.' },
    })

    const incorporated = await capability.approvals_answer('ntf_review', {
      action: 'incorporate',
    })
    expect(incorporated.status).toBe('recorded')
  })

  it('chooses an implementation fork', async () => {
    await deliver(parkedCard('run_fork', 'ntf_fork', 'fork_decision_pending'))
    const capability = approver(await connectRpc())

    const outcome = await capability.approvals_answer('ntf_fork', {
      action: 'choose',
      forkId: 'fk_2',
    })
    expect(outcome).toMatchObject({ status: 'answered', kind: 'fork' })
    expect((outcome.decisions as { echo: { path: string; body: unknown } }).echo).toMatchObject({
      path: '/api/v1/runs/run_fork/decisions/fork/choose',
      body: { forkId: 'fk_2' },
    })
  })

  // Follow-ups accrue while the step still RUNS, so the run is not blocked and a predicate keyed
  // on the run's status would report nothing to answer.
  it('answers a follow-up item on a run that is not blocked', async () => {
    await deliver(parkedCard('run_followups', 'ntf_followups', 'followup_pending'))
    const capability = approver(await connectRpc())

    const outcome = await capability.approvals_answer('ntf_followups', {
      action: 'answer',
      itemId: 'fu_1',
      answer: 'Yes, share it.',
    })
    expect((outcome.decisions as { echo: { path: string } }).echo.path).toBe(
      '/api/v1/runs/run_followups/decisions/follow-ups/items/fu_1/answer',
    )
  })

  it('refuses to guess between two parks, and answers the one it is told', async () => {
    await deliver(parkedCard('run_both', 'ntf_both'))
    const capability = approver(await connectRpc())

    await expect(capability.approvals_answer('ntf_both', { action: 'approve' })).rejects.toThrow(
      /parked on 2 decisions/,
    )
    const outcome = await capability.approvals_answer('ntf_both', {
      action: 'approve',
      kind: 'approval-gate',
    })
    // The gate settled but the follow-up triage still holds the run, so the card stays open.
    expect(outcome.status).toBe('answered')
    const card = (await capability.approvals_list()).find((entry) => entry.cardId === 'ntf_both')
    expect(card?.resolvedAt).not.toBeNull()
  })

  // A gate the SPA answered while the card sat in the inbox is PRESENT in the list and settled.
  it('does not post against a park that was already answered elsewhere', async () => {
    await deliver(parkedCard('run_settled', 'ntf_settled'))
    const capability = approver(await connectRpc())
    expect((await capability.approvals_answer('ntf_settled', { action: 'approve' })).status).toBe(
      'stale',
    )
  })

  it('says so when the deployment parks on something it does not model', async () => {
    await deliver(parkedCard('run_unknown', 'ntf_unknown'))
    const capability = approver(await connectRpc())
    const outcome = await capability.approvals_answer('ntf_unknown', { action: 'approve' })
    expect(outcome.detail).toMatch(/quantum-review/)
  })

  // The refusal that replaced an opaque 422: the platform rejects a blank `feedback` with
  // `minLength(1)` after trim, naming a field the caller never chose to send.
  it('refuses an answer missing a required field rather than forwarding a blank one', async () => {
    await deliver(parkedCard('run_pending', 'ntf_blank'))
    const capability = approver(await connectRpc())
    await expect(
      capability.approvals_answer('ntf_blank', { action: 'request-changes' }),
    ).rejects.toThrow(/needs 'feedback'/)
  })
})

describe('inspecting a card before answering it', () => {
  it('reports the live park, its verbs, and which of them this tier holds', async () => {
    await deliver(parkedCard('run_review', 'ntf_inspect', 'requirement_review'))
    const inspection = await approver(await connectRpc()).approvals_inspect('ntf_inspect')

    expect(inspection.parks).toHaveLength(1)
    const park = inspection.parks[0]!
    expect(park.kind).toBe('requirements-review')
    expect(park.actions.map((action) => action.action)).toContain('incorporate')
    expect(park.actions.every((action) => action.granted)).toBe(true)

    const reply = park.actions.find((action) => action.action === 'reply')!
    expect(reply.fields.filter((field) => field.required).map((field) => field.name)).toEqual([
      'itemId',
      'reply',
    ])
  })

  // The degrade-loudly half. A tier that holds `decisions_list` but not the settling operations
  // can SEE what the run is waiting on, and is told which verbs it cannot use, rather than
  // discovering it one refusal at a time.
  it('marks a verb this tier was not granted rather than hiding it', async () => {
    await deliver(parkedCard('run_pending', 'ntf_ungranted'))
    const observer = (await connectRpc()).connect({ actorId: 'observer@example.com' })
    const inspection = await observer.approvals_inspect('ntf_ungranted')
    const actions = inspection.parks[0]?.actions ?? []
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((action) => action.granted)).toBe(false)
  })

  it('says why nothing is answerable rather than reporting an empty list', async () => {
    await deliver(parkedCard('run_stale', 'ntf_inspect_stale'))
    const inspection = await approver(await connectRpc()).approvals_inspect('ntf_inspect_stale')
    expect(inspection.parks).toEqual([])
    expect(inspection.stale).toMatch(/human_wait_gate/)
  })

  // `merge_review` is settled by a real merge, which no tier here grants. Stamping the card says
  // so up front instead of letting the first answer attempt come back `stale`.
  it('marks a card the API cannot settle as a notice', async () => {
    await deliver(parkedCard('run_pending', 'ntf_notice', 'merge_review'))
    const cards = await approver(await connectRpc()).approvals_list()
    expect(cards.find((card) => card.cardId === 'ntf_notice')?.disposition).toBe('notice')
    expect(cards.find((card) => card.cardId === 'ntf_notice')?.resolvedAt).toBeNull()
  })
})

describe('run lifecycle', () => {
  // Without this the `run.*` subscription was verified, deduped and dropped: a status Gadget would
  // have been back to polling for a transition the platform already pushed.
  it('records what the lifecycle subscription delivers', async () => {
    await deliver(runEvent('run_watched', 'run.started'))
    const watched = await approver(await connectRpc()).runs_watched()
    expect(watched.find((state) => state.runId === 'run_watched')).toMatchObject({
      event: 'run.started',
      terminal: false,
    })
  })

  // An inbox holding a question about a run that has ENDED is a question nobody can answer, and it
  // is the shape people learn to ignore cards from.
  it('settles a run’s open cards when the run reaches a terminal event', async () => {
    await deliver(parkedCard('run_ending', 'ntf_ending'))
    const capability = approver(await connectRpc())
    expect(
      (await capability.approvals_list()).find((card) => card.cardId === 'ntf_ending')?.resolvedAt,
    ).toBeNull()

    await deliver(runEvent('run_ending', 'run.failed'))
    expect(
      (await capability.approvals_list()).find((card) => card.cardId === 'ntf_ending')?.resolvedAt,
    ).not.toBeNull()
  })
})

describe('credential lifecycle', () => {
  // The documented kill switch is revoking the provisioning key, which revokes every key it
  // minted. A cache with no invalidation answers every call after that with the same dead secret,
  // so the recovery is "wipe the Durable Object". One re-mint on a 401 is the whole fix.
  it('re-mints once when the deployment refuses a cached key', async () => {
    await deliver(parkedCard('run_rotated', 'ntf_rotated'))
    const capability = approver(await connectRpc())

    // The scripted origin 401s the first minted secret and accepts the replacement. The echo is
    // what proves the recovery actually MINTED rather than retrying the dead one: without the
    // drop-and-re-mint this rejects permanently, and with a blind retry it would 401 again.
    const outcome = await capability.approvals_answer('ntf_rotated', { action: 'approve' })
    expect(outcome.status).toBe('answered')
    expect((outcome.decisions as { echo: { authorization: string } }).echo.authorization).toBe(
      'Bearer cf_live_pak_decide_approver@example.com.reminted-secret',
    )
  })

  // Offboarding lives on the admin surface, not on a capability: it is a decision the OS makes
  // ABOUT a person, and an agent acting as one of them must not make it for the others.
  it('revokes every key minted for an actor, and refuses to be told nobody', async () => {
    await operation(
      (await connectRpc()).connect({ actorId: 'operator@example.com' }),
      'tasks_get',
      { taskId: 'blk_1' },
    )

    const retired = await SELF.fetch(`${ORIGIN}/admin/retire?actorId=operator@example.com`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(retired.status).toBe(200)
    expect(await retired.json()).toMatchObject({
      revoked: ['pak_write_operator@example.com'],
      remaining: [],
    })

    const unnamed = await SELF.fetch(`${ORIGIN}/admin/retire`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(unnamed.status).toBe(400)

    const unauthorized = await SELF.fetch(`${ORIGIN}/admin/retire?actorId=x`, { method: 'POST' })
    expect(unauthorized.status).toBe(401)
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
