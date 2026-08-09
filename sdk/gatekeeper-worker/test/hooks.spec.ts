// Hooks, driven through the seams a workspace actually uses.
//
// Three of the four legs are the real thing in real workerd: the session's bind hands the queue a
// controller resolved from the Worker's OWN exports, that controller is called over RPC the way
// the workspace would call it, and the durable object holds the initiator it was handed and pushes
// through it. The fourth leg, a delivery arriving on `/webhook` in a LATER invocation and being
// pushed then, is the one no hermetic suite here can pin: what it turns on is whether a stub
// survives the isolate that handed it over, which is a runtime property and belongs to the nightly
// leg against a real workspace. What this file pins instead is that the receiver ASKS (the 202
// reports the topic it dispatched) and that a registration with no live half counts the miss.

import { createExecutionContext, env } from 'cloudflare:test'
import { RpcTarget } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_TOPICS, OS_EXPORTS, pushToHook, ResourceCore, type HookRecord } from '../src/index.js'
import type {
  AccountEntrypoint,
  HookController,
  HookDescription,
  HookInitiator,
  ObservationDescription,
  VendorEntrypoint,
} from '../src/os/protocol.js'
import type { ApprovalCard } from '../src/state.js'
import { deliver, parkedCard } from './deliveries.js'
import { FIXTURE_POLICY } from './fixture-policy.js'

const DEPLOYMENT = 'https://cat-factory.example.com'

function exportsOfWorker(): Record<string, unknown> {
  return (createExecutionContext() as unknown as { exports: Record<string, unknown> }).exports
}

function vendor(): VendorEntrypoint {
  const factory = exportsOfWorker()[OS_EXPORTS.vendor] as (options: {
    props: unknown
  }) => VendorEntrypoint
  return factory({ props: {} })
}

/** The queue the workspace hands over, recording what it is asked to hold. */
class RecordingQueue {
  observations: ObservationDescription[] = []
  hooks: { controller: unknown; callback: unknown; description: HookDescription }[] = []

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description)
  }

  async submitAction(): Promise<void> {}

  async bindHook(
    controller: unknown,
    callback: unknown,
    description: HookDescription,
  ): Promise<void> {
    this.hooks.push({ controller, callback, description })
  }
}

/**
 * The workspace's end of an enabled hook.
 *
 * An `RpcTarget` rather than a plain object because this crosses a real RPC boundary: the
 * controller is one of this Worker's own entrypoints, and only an RpcTarget can be passed to one.
 * That is also what makes the spec worth having, since it is the same constraint a workspace is
 * under.
 */
class TestCallback extends RpcTarget {
  readonly cards: ApprovalCard[] = []
  readonly runs: { runId: string; event: string }[] = []
  /** Set to make the workspace's own side fail, the way a broken gadget would. */
  fail = false

  async onApprovalCard(card: ApprovalCard): Promise<void> {
    if (this.fail) throw new Error('the gadget is gone')
    this.cards.push(card)
  }

  async onRunEvent(state: { runId: string; event: string }): Promise<void> {
    this.runs.push({ runId: state.runId, event: state.event })
  }
}

class TestAuthorizer extends RpcTarget {
  readonly observations: ObservationDescription[] = []
  refuse = false

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description)
    if (this.refuse) throw new Error('the workspace refused this delivery')
  }
}

/** What `enable` hands over: a source of a FRESH callback per delivery. */
class TestInitiator extends RpcTarget implements HookInitiator {
  starts = 0
  readonly callback = new TestCallback()
  readonly authorizer = new TestAuthorizer()

  async startHook(): Promise<{ callback: unknown; approvalQueue: TestAuthorizer }> {
    this.starts += 1
    return { callback: this.callback, approvalQueue: this.authorizer }
  }
}

type Session = Record<string, (...args: unknown[]) => Promise<unknown>> & Disposable

/** A resource bound for a fresh account, as the workspace binds one. */
async function connectResource(): Promise<{ resource: ResourceCore; accountId: string }> {
  const account = (await vendor().createAccount()) as AccountEntrypoint
  const { uniqueName } = await account.describe()
  const accountId = uniqueName ?? ''
  await account.getGatekeeperClassFor(`${DEPLOYMENT}/w/ws_1`)
  return {
    resource: new ResourceCore(env, FIXTURE_POLICY, { accountId }, { exports: exportsOfWorker() }),
    accountId,
  }
}

/**
 * Every controller a spec enabled, disabled after it.
 *
 * The durable object is ONE per paired deployment and the suite shares it, so a registration left
 * behind is pushed to by the next spec's delivery, through an initiator whose isolate has moved
 * on. That reads as a failure count nobody asked for, which is exactly the signal these specs are
 * asserting on.
 */
const enabled: HookController[] = []

afterEach(async () => {
  while (enabled.length > 0) await enabled.pop()!.disable()
})

/** Bind a hook the way an agent does, and enable it the way the workspace does. */
async function boundAndEnabled(topic: 'approval_card' | 'run_event' = 'approval_card') {
  const { resource, accountId } = await connectResource()
  const queue = new RecordingQueue()
  const session = (await resource.startSession(queue)) as Session
  const callbackStub = new TestCallback()

  await session[HOOK_TOPICS[topic].sessionMethod]!(callbackStub)
  const bound = queue.hooks[0]!
  const initiator = new TestInitiator()
  const controller = bound.controller as HookController
  await controller.enable(initiator, { workspaceId: 'ws_os_1' })
  enabled.push(controller)

  return { resource, session, queue, accountId, initiator, controller }
}

describe('binding a hook', () => {
  it('hands the workspace a controller and a description, and stores nothing yet', async () => {
    const { resource, accountId } = await connectResource()
    const queue = new RecordingQueue()
    const session = (await resource.startSession(queue)) as Session

    await session.approvals_subscribe!(new TestCallback())

    expect(queue.hooks).toHaveLength(1)
    expect(queue.hooks[0]!.description.title).toContain(DEPLOYMENT)
    // Nothing is recorded until the workspace enables it. A row written at bind time would be a
    // registration for a hook nobody approved, and the contract says so in as many words.
    expect(await env.STATE.get(env.STATE.idFromName(DEPLOYMENT)).listHooks(accountId)).toEqual([])
  })

  it('records the registration once the workspace enables it, and not before', async () => {
    const { accountId } = await boundAndEnabled()

    const hooks = await env.STATE.get(env.STATE.idFromName(DEPLOYMENT)).listHooks(accountId)
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.topic).toBe('approval_card')
    expect(hooks[0]!.live).toBe(true)
    expect(hooks[0]!.target.workspaceId).toBe('ws_os_1')
  })

  it('publishes what a bound hook has taken and missed, for this account only', async () => {
    const { session, accountId } = await boundAndEnabled()
    const other = await connectResource()

    const mine = (await session.hooks_bound!()) as { hookId: string; accountId: string }[]
    expect(mine).toHaveLength(1)
    expect(mine[0]!.accountId).toBe(accountId)

    // One account's gadget bindings are not another's to enumerate, and both accounts share the
    // one durable object.
    const theirs = (await ((await other.resource.startSession(new RecordingQueue())) as Session)
      .hooks_bound!()) as unknown[]
    expect(theirs).toEqual([])
  })

  it('forgets the registration permanently when the workspace disables it', async () => {
    const { controller, accountId } = await boundAndEnabled()

    await controller.disable()
    enabled.length = 0

    expect(await env.STATE.get(env.STATE.idFromName(DEPLOYMENT)).listHooks(accountId)).toEqual([])
  })
})

describe('pushing to a bound hook', () => {
  it('asks for a fresh callback, authorizes the delivery, and then delivers', async () => {
    const { initiator, accountId } = await boundAndEnabled()
    const state = env.STATE.get(env.STATE.idFromName(DEPLOYMENT))
    const card: ApprovalCard = {
      cardId: 'ntf_hook_1',
      runId: 'run_hook_1',
      taskId: 'blk_4',
      type: 'decision_required',
      disposition: 'decision',
      title: 'A run is waiting',
      body: 'The step finished and needs an answer.',
      raisedAt: 1,
      resolvedAt: null,
      resolution: null,
    }

    await state.applyDelivery('dlv_hook_1', { kind: 'open', card }, Date.now())
    const report = await state.dispatchHooks({ kind: 'open', card }, Date.now())

    expect(report).toMatchObject({ topic: 'approval_card', delivered: 1, stale: 0, failed: 0 })
    // The order the contract asks for, and the reason it matters: a workspace that has withdrawn
    // this person's access refuses here, and nothing reaches the callback.
    expect(initiator.starts).toBe(1)
    expect(initiator.authorizer.observations).toHaveLength(1)
    expect(initiator.callback.cards.map((delivered) => delivered.cardId)).toEqual(['ntf_hook_1'])

    const hooks = await state.listHooks(accountId)
    expect(hooks[0]).toMatchObject({ deliveries: 1, missed: 0, failures: 0 })
  })

  it('pushes nothing to a hook bound for another topic', async () => {
    const { initiator } = await boundAndEnabled('run_event')
    const state = env.STATE.get(env.STATE.idFromName(DEPLOYMENT))

    const event = {
      kind: 'run-event' as const,
      state: { runId: 'run_2', event: 'run.started', terminal: false, run: {} },
    }
    await state.applyDelivery('dlv_run_2', event, Date.now())
    const report = await state.dispatchHooks(event, Date.now())

    expect(report).toMatchObject({ topic: 'run_event', delivered: 1 })
    expect(initiator.callback.runs).toEqual([{ runId: 'run_2', event: 'run.started' }])
    expect(initiator.callback.cards).toEqual([])
  })

  it('counts a delivery the workspace refused as a failure, and keeps the registration', async () => {
    const { initiator, accountId } = await boundAndEnabled()
    initiator.authorizer.refuse = true
    const state = env.STATE.get(env.STATE.idFromName(DEPLOYMENT))
    const card = sampleCard('ntf_hook_refused')

    await state.applyDelivery('dlv_hook_refused', { kind: 'open', card }, Date.now())
    const report = await state.dispatchHooks({ kind: 'open', card }, Date.now())

    expect(report).toMatchObject({ delivered: 0, failed: 1 })
    expect(initiator.callback.cards).toEqual([])
    // A refused push is a fact about this delivery, not a reason to forget the hook: the next one
    // may well be authorized, and dropping the registration would need the workspace to bind again
    // without anyone having decided that.
    const hooks = await state.listHooks(accountId)
    expect(hooks[0]).toMatchObject({ failures: 1, live: true })
    expect(hooks[0]!.lastError).toContain('refused this delivery')
  })
})

describe('a registration whose live half is gone', () => {
  it('counts the miss on the record rather than passing over it', async () => {
    const record: HookRecord = {
      hookId: 'hook_1',
      topic: 'approval_card',
      accountId: 'acct_1',
      tier: 'workspace',
      deployment: DEPLOYMENT,
      target: { workspaceId: 'ws_os_1' },
      enabledAt: 1,
      deliveries: 3,
      missed: 0,
      failures: 0,
      lastDeliveryAt: 2,
      lastError: null,
    }

    const pushed = await pushToHook(
      { topic: 'approval_card', card: sampleCard() },
      record,
      undefined,
      10,
    )

    // The one number that must never be inferred from silence: a workspace reads it to discover
    // that its hook stopped receiving without anybody deciding it should.
    expect(pushed.outcome).toBe('stale')
    expect(pushed.record.missed).toBe(1)
    expect(pushed.record.deliveries).toBe(3)
  })

  it('reports a callback with no method for the topic as a failure, never as a delivery', async () => {
    const record: HookRecord = {
      hookId: 'hook_2',
      topic: 'approval_card',
      accountId: 'acct_1',
      tier: 'workspace',
      deployment: DEPLOYMENT,
      target: { workspaceId: 'ws_os_1' },
      enabledAt: 1,
      deliveries: 0,
      missed: 0,
      failures: 0,
      lastDeliveryAt: null,
      lastError: null,
    }
    const initiator = {
      startHook: async () => ({
        callback: {},
        approvalQueue: { authorizeObservation: async () => {} },
      }),
    }

    const pushed = await pushToHook(
      { topic: 'approval_card', card: sampleCard() },
      record,
      initiator,
      10,
    )

    expect(pushed.outcome).toBe('failed')
    expect(pushed.record.lastError).toContain('onApprovalCard')
  })
})

describe('the delivery receiver', () => {
  it('reports what pushing the delivery did, on the delivery the platform can log', async () => {
    const response = await deliver(parkedCard('run_receipt_1', 'ntf_receipt_1'))

    expect(response.status).toBe(202)
    // With nothing bound this is all zeroes, and that is the point: a receiver that reported
    // nothing would leave "was it pushed" to be answered by comparing an inbox against a gadget.
    expect(await response.json()).toMatchObject({
      handled: 'accepted',
      hooks: { topic: 'approval_card', delivered: 0, stale: 0, failed: 0 },
    })
  })
})

/** A card as a delivery would have written it. */
function sampleCard(cardId = 'ntf_sample'): ApprovalCard {
  return {
    cardId,
    runId: `run_${cardId}`,
    taskId: 'blk_4',
    type: 'decision_required',
    disposition: 'decision',
    title: 'A run is waiting',
    body: 'The step finished and needs an answer.',
    raisedAt: 1,
    resolvedAt: null,
    resolution: null,
  }
}
