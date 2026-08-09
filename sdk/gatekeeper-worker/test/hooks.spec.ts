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
import {
  applyPushOutcome,
  HOOK_TOPICS,
  OS_EXPORTS,
  pushToHook,
  ResourceCore,
  type DeliveryApplication,
  type HookPushTarget,
  type HookRecord,
} from '../src/index.js'
import type {
  AccountEntrypoint,
  HookController,
  HookDescription,
  HookInitiator,
  HookTargetMetadata,
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
  /**
   * Run while the push is in flight, which is the window this whole design turns on.
   *
   * A push awaits a call into the workspace, and a non-storage await opens the durable object's
   * input gate, so anything the workspace does here is delivered BEFORE the outcome is recorded.
   * That is not a contrivance: it is the ordinary case of a person disabling a gadget while a
   * delivery is being pushed to it.
   */
  duringPush: (() => Promise<void>) | undefined

  async startHook(): Promise<{ callback: unknown; approvalQueue: TestAuthorizer }> {
    this.starts += 1
    await this.duringPush?.()
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

/** Bind one hook on an already-bound resource, and enable it the way the workspace does. */
async function bindAndEnable(
  resource: ResourceCore,
  topic: 'approval_card' | 'run_event',
  target: HookTargetMetadata,
) {
  const queue = new RecordingQueue()
  const session = (await resource.startSession(queue)) as Session

  await session[HOOK_TOPICS[topic].sessionMethod]!(new TestCallback())
  const initiator = new TestInitiator()
  const controller = queue.hooks[0]!.controller as HookController
  await controller.enable(initiator, target)
  enabled.push(controller)

  return { session, queue, initiator, controller }
}

/** Bind a hook the way an agent does, and enable it the way the workspace does. */
async function boundAndEnabled(topic: 'approval_card' | 'run_event' = 'approval_card') {
  const { resource, accountId } = await connectResource()
  return { resource, accountId, ...(await bindAndEnable(resource, topic, TARGET)) }
}

/** Where a hook's deliveries land, and therefore what identifies its registration. */
const TARGET: HookTargetMetadata = { workspaceId: 'ws_os_1' }

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
    expect(hooks[0]!.target.workspaceId).toBe(TARGET.workspaceId)
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

  it('names the cause when the workspace does not take the binding', async () => {
    const { resource } = await connectResource()
    // What an approval queue that predates hooks does over RPC, verbatim: a stub answers every
    // property, so `typeof queue.bindHook` reads `function` for a method the far side does not
    // implement, and the structural check ahead of the call cannot see it. Left unwrapped, the
    // agent got this raw and had nothing to act on.
    const queue = new RecordingQueue()
    queue.bindHook = async () => {
      throw new TypeError('The RPC receiver does not implement "bindHook".')
    }
    const session = (await resource.startSession(queue)) as Session

    await expect(session.approvals_subscribe!(new TestCallback())).rejects.toThrow(
      /did not take the approvals_subscribe\(\) binding \(TypeError: .*bindHook/,
    )
    // Both halves matter: the cause is the only thing that separates a workspace with no hooks
    // from a person who declined, and the fallback is what the agent does next either way.
    await expect(session.approvals_subscribe!(new TestCallback())).rejects.toThrow(
      /approvals_list\(\)/,
    )
  })

  it('re-arms the same registration when a gadget binds again, rather than adding a second', async () => {
    const { resource, accountId, initiator } = await boundAndEnabled()
    const state = env.STATE.get(env.STATE.idFromName(DEPLOYMENT))
    const card = sampleCard('ntf_rearm')
    const applied = await state.applyDelivery('dlv_rearm', { kind: 'open', card }, Date.now())
    await state.dispatchHooks(pushesOf(applied), Date.now())
    expect(initiator.callback.cards).toHaveLength(1)

    // What a workspace does when it notices a hook has gone quiet: bind again and enable the new
    // controller. The bind mints a fresh hook id, so a registration keyed on that id left the dead
    // one behind forever, never live and counting a miss against every later delivery.
    await bindAndEnable(resource, 'approval_card', TARGET)

    const hooks = await state.listHooks(accountId)
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.live).toBe(true)
    // Re-arming is not a fresh start: `deliveries` and `missed` are the history a workspace was
    // reading when it decided to re-arm, so zeroing them would erase the evidence at the moment it
    // is being acted on.
    expect(hooks[0]!.deliveries).toBe(1)
  })

  it('keeps a second gadget on the same account as its own registration', async () => {
    const { resource, accountId } = await boundAndEnabled()

    await bindAndEnable(resource, 'approval_card', { workspaceId: 'ws_os_1', gadgetId: 7 })

    // Two places for one topic's deliveries to land is two registrations. Only re-binding from the
    // SAME place is the same hook coming back.
    const hooks = await env.STATE.get(env.STATE.idFromName(DEPLOYMENT)).listHooks(accountId)
    expect(hooks).toHaveLength(2)
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

    const applied = await state.applyDelivery('dlv_hook_1', { kind: 'open', card }, Date.now())
    const report = await state.dispatchHooks(pushesOf(applied), Date.now())

    expect(report).toMatchObject({ delivered: 1, stale: 0, failed: 0 })
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
    const applied = await state.applyDelivery('dlv_run_2', event, Date.now())
    const report = await state.dispatchHooks(pushesOf(applied), Date.now())

    expect(report).toMatchObject({ delivered: 1 })
    expect(initiator.callback.runs).toEqual([{ runId: 'run_2', event: 'run.started' }])
    expect(initiator.callback.cards).toEqual([])
  })

  it('tells a card hook that a terminal run settled its cards, not only the run hook', async () => {
    const { resource, accountId } = await connectResource()
    const cards = await bindAndEnable(resource, 'approval_card', TARGET)
    const runs = await bindAndEnable(resource, 'run_event', TARGET)
    const state = env.STATE.get(env.STATE.idFromName(DEPLOYMENT))
    const card: ApprovalCard = { ...sampleCard('ntf_settled'), runId: 'run_settled' }
    await state.applyDelivery('dlv_settled_open', { kind: 'open', card }, Date.now())

    const applied = await state.applyDelivery(
      'dlv_settled_end',
      {
        kind: 'run-event',
        state: { runId: 'run_settled', event: 'run.completed', terminal: true, run: {} },
      },
      Date.now(),
    )
    await state.dispatchHooks(pushesOf(applied), Date.now())

    // The run event settles the run's open cards, so a gadget subscribed to CARDS has to hear
    // about it: told only about the run, it goes on rendering a decision nobody can answer, which
    // is exactly what the topic's own published description says it will not do.
    expect(runs.initiator.callback.runs).toEqual([{ runId: 'run_settled', event: 'run.completed' }])
    expect(cards.initiator.callback.cards.map((pushed) => pushed.resolution)).toEqual([
      'run_run.completed',
    ])
    expect(await state.listHooks(accountId)).toHaveLength(2)
  })

  it('counts a delivery the workspace refused as a failure, and keeps the registration', async () => {
    const { initiator, accountId } = await boundAndEnabled()
    initiator.authorizer.refuse = true
    const state = env.STATE.get(env.STATE.idFromName(DEPLOYMENT))
    const card = sampleCard('ntf_hook_refused')

    const applied = await state.applyDelivery(
      'dlv_hook_refused',
      { kind: 'open', card },
      Date.now(),
    )
    const report = await state.dispatchHooks(pushesOf(applied), Date.now())

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

describe('a write that lands while a push is in flight', () => {
  it('does not resurrect a registration the workspace withdrew mid-push', async () => {
    const { accountId, initiator, controller } = await boundAndEnabled()
    const state = env.STATE.get(env.STATE.idFromName(DEPLOYMENT))
    // Delivered while the durable object is awaiting `startHook`, which is a call OUT of the
    // object and therefore a moment its input gate is open. Reading the record before the push and
    // writing that copy back afterwards undid this disable: the row came back permanently not
    // live, counting a miss against every later delivery, with nothing anywhere recording that a
    // person had withdrawn it.
    initiator.duringPush = async () => {
      await controller.disable()
      enabled.length = 0
    }
    const card = sampleCard('ntf_withdrawn')

    const applied = await state.applyDelivery('dlv_withdrawn', { kind: 'open', card }, Date.now())
    const report = await state.dispatchHooks(pushesOf(applied), Date.now())

    // The push itself still completed, and is reported as what it was. What must not survive it is
    // the row.
    expect(report).toMatchObject({ delivered: 1 })
    expect(await state.listHooks(accountId)).toEqual([])
  })
})

describe('a registration whose live half is gone', () => {
  it('counts the miss on the record rather than passing over it', async () => {
    const record = hookRecord({ deliveries: 3, lastDeliveryAt: 2 })

    const pushed = await pushToHook(
      { topic: 'approval_card', card: sampleCard() },
      record,
      undefined,
    )

    // The one number that must never be inferred from silence: a workspace reads it to discover
    // that its hook stopped receiving without anybody deciding it should.
    expect(pushed.outcome).toBe('stale')
    const folded = applyPushOutcome(record, pushed, 10)
    expect(folded.missed).toBe(1)
    expect(folded.deliveries).toBe(3)
  })

  it('folds the outcome onto the record as it stands, never onto the one it was described from', () => {
    const described = hookRecord({ deliveries: 3, missed: 0 })
    // What a concurrent delivery left behind while this push was awaiting the workspace. Folding
    // onto `described` would silently discard it, which is the whole reason the push reports an
    // outcome instead of handing back a modified copy.
    const moved = { ...described, deliveries: 4, missed: 1 }

    const folded = applyPushOutcome(moved, { outcome: 'delivered' }, 99)

    expect(folded).toMatchObject({ deliveries: 5, missed: 1, lastDeliveryAt: 99, lastError: null })
  })

  it('reports a callback with no method for the topic as a failure, never as a delivery', async () => {
    const record = hookRecord({ hookId: 'hook_2' })
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
    )

    expect(pushed.outcome).toBe('failed')
    expect(applyPushOutcome(record, pushed, 10).lastError).toContain('onApprovalCard')
  })
})

describe('the delivery receiver', () => {
  it('reports what it dispatched, and never a count of what it has not pushed yet', async () => {
    const response = await deliver(parkedCard('run_receipt_1', 'ntf_receipt_1'))

    expect(response.status).toBe(202)
    // The acknowledgement does not wait on the fan-out, so what it can honestly carry is what the
    // delivery produced. A `delivered: 0` here would be a zero standing in for a number nobody
    // has, and indistinguishable from a push every hook refused; the counts live on each
    // registration, where `hooks_bound()` publishes them.
    expect(await response.json()).toMatchObject({
      handled: 'accepted',
      hooks: { pushes: 1, topics: ['approval_card'] },
    })
  })
})

/** A registration as `enable` would have written it, before any delivery has moved its counters. */
function hookRecord(overrides: Partial<HookRecord> = {}): HookRecord {
  return {
    hookId: 'hook_1',
    topic: 'approval_card',
    accountId: 'acct_1',
    tier: 'workspace',
    deployment: DEPLOYMENT,
    target: TARGET,
    enabledAt: 1,
    deliveries: 0,
    missed: 0,
    failures: 0,
    lastDeliveryAt: null,
    lastError: null,
    ...overrides,
  }
}

/** What a committed delivery left to push, which is the dispatcher's whole input. */
function pushesOf(applied: DeliveryApplication): HookPushTarget[] {
  if (!applied.applied) throw new Error('the delivery was deduped, so it left nothing to push')
  return applied.pushes
}

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
