// PUSHING what the inbox already holds: the approval cards and run transitions a workspace would
// otherwise have to ask for.
//
// Nothing here is a new source of truth, and that is the whole design. A delivery arrives on the
// webhook, is verified, deduped and written to durable state, and only THEN is anything pushed:
// `approvals_list()` and `runs_watched()` go on answering the same question for a workspace that
// never bound a hook, and for one whose hook missed an event. So a hook is an accelerator over a
// projection, never the projection itself, and every failure mode below is safe in exactly that
// way: what a hook loses, a read still has.
//
// The lifecycle is the published contract's, and each step exists for a reason worth keeping:
//
//   1. A session calls `approvals_subscribe(callback)`. We mint a hook id, build a CONTROLLER of
//      our own, and hand both the controller and the callback to `queue.bindHook`. We store
//      NOTHING: the workspace may still have to ask a person, and a gatekeeper that wrote a row
//      here would be holding registrations for hooks nobody ever approved.
//   2. The workspace approves and calls `enable(initiator, target)` on that controller. NOW there
//      is state: the durable record, plus the initiator held live.
//   3. Each event calls `initiator.startHook()` for a FRESH callback and the queue that governs
//      it, authorizes the delivery as the observation it is, and delivers.
//   4. `disable()` removes both halves. The contract asks for a permanent clean-up and means it.
//
// THE CALLBACK IS NEVER STORED, at any point. It is a parameter stub, so the runtime disposes it
// when the call it arrived on returns; storing one would leave a registration that looks live and
// throws on the first delivery, months after the mistake.
//
// THE INITIATOR IS HELD IN MEMORY, and that is a real limit rather than an oversight. A stub is a
// reference into another Worker and there is no way to write one to storage, so a Durable Object
// that is evicted between two deliveries keeps the record and loses the live half. That is why
// every record COUNTS its missed deliveries and why `hooks_bound()` publishes the count beside
// `live`: a workspace can see that its hook went quiet, and reconcile from the projection that
// never did. A silent stop would be the one failure this design cannot tolerate, because a
// workspace has no way to tell it from a deployment where nothing happened.
//
// So RE-BINDING IS THE DOCUMENTED REMEDY, and a registration is therefore keyed on where its
// deliveries land rather than on the id one bind minted (`registrationKey`). Re-arming a hook is
// the same registration coming back, not a second one beside the first.

import type { ApprovalCard, RunState } from '../state.js'
import { describeError } from '../errors.js'
import { fenced } from '../markdown.js'
import type {
  HookDescription,
  HookInitiator,
  HookTargetMetadata,
  ObservationDescription,
} from './protocol.js'

/** What a workspace can be pushed. */
export type HookTopic = 'approval_card' | 'run_event'

/** What one topic is called, delivered as, and described as. */
interface TopicDefinition {
  /** The method a session binds it through, and the name the refusals use. */
  sessionMethod: string
  /** The method called on the workspace's callback object. */
  callbackMethod: string
  /** One line the approver reads when the workspace asks whether to enable the hook. */
  title: string
  /** What enabling it means, in what it will push and what it will not. */
  description: string
}

/**
 * The two topics, as an exhaustive `Record`, so a third one cannot be half-added.
 *
 * A topic is a delivery FAMILY this Gatekeeper already receives and projects, never a new
 * subscription upstream: what the platform sends is decided by `enroll()`, and a hook that pushed
 * something the webhook does not carry would be a promise no delivery could keep.
 */
export const HOOK_TOPICS = {
  approval_card: {
    sessionMethod: 'approvals_subscribe',
    callbackMethod: 'onApprovalCard',
    title: 'Push cat-factory approval cards as they are raised',
    description:
      'Each time the paired cat-factory deployment reports that a run has parked on a human ' +
      'decision, or that a card it raised has been settled elsewhere, the card is pushed to this ' +
      'callback. It carries exactly what `approvals_list()` answers with, which stays available ' +
      'and stays authoritative: a delivery missed while this hook was not live is still readable ' +
      'there.',
  },
  run_event: {
    sessionMethod: 'runs_subscribe',
    callbackMethod: 'onRunEvent',
    title: 'Push cat-factory run lifecycle transitions',
    description:
      'Each time the paired cat-factory deployment reports that a run has started, completed or ' +
      'failed, the run’s latest state is pushed to this callback. It carries exactly what ' +
      '`runs_watched()` answers with, which stays available and stays authoritative.',
  },
} as const satisfies Record<HookTopic, TopicDefinition>

/** Every topic, for a caller that has to cover all of them. */
export const HOOK_TOPIC_NAMES = Object.keys(HOOK_TOPICS) as HookTopic[]

/** What a hook's controller is imbued with when a session binds it. */
export interface HookControllerProps {
  hookId: string
  topic: HookTopic
  /** The account whose session bound it. A session reads back only its own account's hooks. */
  accountId: string
  /** The policy tier that account resolved to, for the delivery's own description. */
  tier: string
  /** The paired deployment, so the record can describe a delivery without resolving config. */
  deployment: string
}

/** One enabled hook, as it is stored. Written on `enable`, deleted on `disable`. */
export interface HookRecord extends HookControllerProps {
  /** The workspace the hook was enabled from, and the gadget within it where there is one. */
  target: HookTargetMetadata
  enabledAt: number
  /** Deliveries this hook has taken. */
  deliveries: number
  /**
   * Deliveries that found no live initiator, so nothing was pushed.
   *
   * The one number that must never be inferred from silence: it is what tells a workspace that
   * its hook stopped receiving without anybody deciding it should.
   */
  missed: number
  /** Deliveries the workspace's own side refused or failed. */
  failures: number
  lastDeliveryAt: number | null
  /** The most recent failure, kept so a reader has something to act on beyond a count. */
  lastError: string | null
}

/**
 * What IDENTIFIES a registration in storage: the place its deliveries land.
 *
 * Not the hook id, which is the wrong key for the one lifecycle a workspace is documented to run.
 * The live half of a registration cannot be stored, so a durable object evicted between two
 * deliveries keeps the record and loses the stub, and the remedy is to bind again. A bind mints a
 * FRESH hook id, so a hook-id-keyed row made every one of those cycles a new row: the dead
 * registration stayed forever, never live, counting a `missed` against every delivery for the rest
 * of the deployment's life, and no reader could tell it from a hook that had genuinely gone quiet.
 *
 * Keying on the target makes re-binding what it reads as: the same registration, re-armed. The row
 * is replaced, its counters carry forward (the `missed` count is the evidence the workspace acted
 * on, so re-arming must not erase it), and the set of rows stays bounded by the gadgets a
 * workspace actually runs rather than by how many times one was re-armed.
 *
 * The account comes first and is never the caller's to assert, so no target a workspace names can
 * collide with another account's row; the remaining parts are escaped so a separator inside one of
 * them cannot make two different targets share a key.
 */
export function registrationKey(record: {
  accountId: string
  topic: HookTopic
  target: HookTargetMetadata
}): string {
  return [
    record.accountId,
    record.topic,
    record.target.workspaceId,
    record.target.gadgetId === undefined ? '' : String(record.target.gadgetId),
  ]
    .map((part) => encodeURIComponent(part))
    .join(':')
}

/**
 * One hook as a session reads it back, which is the record PLUS the fact it cannot store.
 *
 * `live` is computed at read time from whether the initiator is still held, never persisted: a
 * stored flag would say "live" from before the eviction that made it false, which is the one
 * reading that must not be available.
 */
export interface HookRegistration extends HookRecord {
  live: boolean
}

/**
 * What one fan-out did, summed over every push it made.
 *
 * It carries no topic: a change can produce payloads for more than one (a terminal run event
 * settles the run's open cards as it records the transition), and one number per outcome across
 * all of them is what a caller acts on. WHICH topics were dispatched is the receiver's to report,
 * because it is knowable before any push is made.
 */
export interface HookDispatchReport {
  delivered: number
  /** Registrations whose live half was lost, so nothing was pushed and the record counted it. */
  stale: number
  failed: number
}

/** What a topic pushes, as the callback receives it. */
export type HookPayload =
  | { topic: 'approval_card'; card: ApprovalCard }
  | { topic: 'run_event'; state: RunState }

/**
 * One thing a committed write left to push, named by its id rather than carried whole.
 *
 * The fan-out runs in the durable object and the write is reported out of it, so what crosses that
 * boundary is a list of ids and the dispatcher reads each row back. Two reasons, and the second is
 * the one that decides it. A `RunState` carries the run projection verbatim as an open record,
 * which a Durable Object stub's serialization type will not carry (the same constraint
 * `runs_watched()` annotates around), so a payload cannot make the trip. And re-reading is the
 * more correct half anyway: a card that has been answered between the commit and the push is
 * pushed as it now stands, rather than as the delivery left it.
 */
export type HookPushTarget =
  | { topic: 'approval_card'; cardId: string }
  | { topic: 'run_event'; runId: string }

/** What the approver is asked when a workspace binds a hook. */
export function describeHook(
  topic: HookTopic,
  subject: { accountId: string; tier: string; deployment: string },
): HookDescription {
  const definition = HOOK_TOPICS[topic]
  return {
    title: `${definition.title} (${subject.deployment})`,
    description:
      `${definition.description}\n\nDeliveries are made for account \`${subject.accountId}\` at ` +
      `policy tier \`${subject.tier}\`, and each one is authorized as an observation before it ` +
      'is pushed.',
  }
}

/**
 * What the queue is asked before ONE delivery is pushed.
 *
 * A hook delivery is an observation and is authorized as one, which the contract asks for and
 * which is also the only reading that holds: the bytes are a card the paired deployment raised,
 * and that they arrived here over a webhook rather than over a read is an implementation detail of
 * how they got here. The refusal path is what makes it matter: a workspace that has withdrawn a
 * person's access can stop the push without this Gatekeeper having to be told.
 */
export function describeHookDelivery(
  payload: HookPayload,
  record: HookRecord,
): ObservationDescription {
  const subject =
    payload.topic === 'approval_card'
      ? `The approval card \`${payload.card.cardId}\` raised for run \`${payload.card.runId}\`, ` +
        `titled:\n\n${fenced(payload.card.title, '')}`
      : `Run \`${payload.state.runId}\` reported \`${payload.state.event}\`.`
  return {
    title: `${HOOK_TOPICS[payload.topic].title} (${record.deployment})`,
    description:
      `${subject}\n\nPushed to a hook this workspace enabled for account ` +
      `\`${record.accountId}\` at policy tier \`${record.tier}\`, from the record of what the ` +
      `paired deployment at ${record.deployment} delivered.`,
  }
}

/** The live half of a registration: the workspace's initiator, held past the call it arrived on. */
export type HookRegistry = Map<string, HookInitiator>

/**
 * Take a reference to a stub that outlives the call it arrived on.
 *
 * The same loan rule `holdQueue` documents, arriving on the other parameter the contract hands
 * over: the runtime disposes a parameter stub when the method returns, and an initiator kept for
 * the next delivery is used long after that. The optional call is the in-process case, where the
 * "stub" is an ordinary object with nothing to duplicate.
 */
export function holdInitiator(initiator: HookInitiator): HookInitiator {
  const stub = initiator as Partial<{ dup: () => HookInitiator }>
  return typeof stub.dup === 'function' ? stub.dup() : initiator
}

/** Give back a held reference. Paired with {@link holdInitiator} and kept beside it. */
export function releaseInitiator(initiator: HookInitiator): void {
  ;(initiator as Partial<Disposable>)[Symbol.dispose]?.()
}

/**
 * What one push did, SEPARATE from the record it will be counted on.
 *
 * The split is the whole safety property of the fan-out. A push awaits a call into another Worker,
 * which is not a storage operation, so the durable object's input gate is open across it and the
 * record read before the push is a snapshot that may be stale by the time it resolves: a
 * concurrent `disable` may have removed the registration, and a concurrent delivery may have moved
 * the very counters this one is about to bump. Reporting the outcome and folding it onto whatever
 * is stored AFTERWARDS is what keeps both of those true, where writing back a modified snapshot
 * resurrected the withdrawn registration and lost the sibling's increments.
 */
export type HookPushOutcome =
  | { outcome: 'delivered' }
  /** The registration's live half was lost, so there was nothing to push through. */
  | { outcome: 'stale' }
  | { outcome: 'failed'; error: string }

/**
 * How long one workspace has to take one push before it is counted as a failure.
 *
 * A hook delivery is a call into somebody else's Worker, and the failure this bounds is the one
 * with no natural end: a workspace that accepts the connection and never answers. Unbounded, one
 * such hook holds the fan-out (and, on the receiver, the invocation carrying it) until the runtime
 * kills it, and the counter update that would have SAID so never lands, so the registration reads
 * as one nothing was ever pushed to.
 */
const PUSH_TIMEOUT_MS = 10_000

/**
 * Push one payload to one enabled hook, and report what that did.
 *
 * Every outcome is a REPORT rather than a throw, because the caller is a fan-out on behalf of a
 * delivery whose record has already committed: a workspace that refuses, breaks or hangs costs a
 * notification, and must never cost the acknowledgement the platform's retry is protecting.
 */
export async function pushToHook(
  payload: HookPayload,
  record: HookRecord,
  initiator: HookInitiator | undefined,
): Promise<HookPushOutcome> {
  if (initiator === undefined) return { outcome: 'stale' }
  try {
    await withDeadline(deliverThrough(initiator, payload, record), PUSH_TIMEOUT_MS)
    return { outcome: 'delivered' }
  } catch (error) {
    return { outcome: 'failed', error: describeError(error) }
  }
}

/**
 * Fold one push's outcome onto the record as it stands NOW.
 *
 * Pure, and takes the current record rather than the one the push was described from, so a caller
 * can re-read between the two. `lastError` is cleared by a delivery on purpose: it is what a
 * reader acts on beside `failures`, and a stale one beside a hook that has since recovered points
 * at a fix nobody needs to make.
 */
export function applyPushOutcome(
  record: HookRecord,
  result: HookPushOutcome,
  now: number,
): HookRecord {
  if (result.outcome === 'stale') return { ...record, missed: record.missed + 1 }
  if (result.outcome === 'failed') {
    return { ...record, failures: record.failures + 1, lastError: result.error }
  }
  return { ...record, deliveries: record.deliveries + 1, lastDeliveryAt: now, lastError: null }
}

/** One delivery, through a callback minted for it and released with it. */
async function deliverThrough(
  initiator: HookInitiator,
  payload: HookPayload,
  record: HookRecord,
): Promise<void> {
  const started = await initiator.startHook()
  try {
    await started.approvalQueue.authorizeObservation(describeHookDelivery(payload, record))
    await callBack(started.callback, payload)
  } finally {
    releaseStarted(started)
  }
}

/**
 * Give up on a push that never answers, and say that is what happened.
 *
 * The timer is cleared on both paths: a Worker invocation stays alive while one is outstanding, so
 * leaving them behind would hold every delivery's invocation open for the timeout even when every
 * push answered at once.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The workspace did not answer this hook delivery within ${timeoutMs}ms, so it was ` +
              'counted as a failure rather than waited on.',
          ),
        ),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Call the topic's method on the workspace's callback.
 *
 * A callback with no such method is a FAILURE that says so, rather than a push that quietly does
 * nothing: the workspace implements the interface this package publishes in the session types, and
 * a mismatch between the two is exactly the thing a count of failures should make visible.
 */
async function callBack(callback: unknown, payload: HookPayload): Promise<void> {
  const method = HOOK_TOPICS[payload.topic].callbackMethod
  if (callback === null || callback === undefined) {
    throw new Error('This hook was started with no callback, so nothing could be delivered to it.')
  }
  const target = callback as Record<string, ((event: unknown) => Promise<void>) | undefined>
  // Two things about a stub decide the shape of these three lines, and both read as pedantry until
  // they bite. A stub answers EVERY property, so the absent-method check can only catch a plain
  // object (which is the in-process case, and the one where a helpful message is worth having);
  // for a real callback the missing method surfaces from the far side, as it should. And the
  // invocation is DIRECT rather than through `Function.prototype.call`, because `deliver.call(…)`
  // on a stub asks the far side for an operation named `onApprovalCard.call`.
  if (target[method] === undefined) {
    throw new Error(
      `The callback this hook was started with has no ${method}() method, so nothing could be ` +
        'delivered to it.',
    )
  }
  await target[method]!(payload.topic === 'approval_card' ? payload.card : payload.state)
}

/** Release both stubs one `startHook()` handed over. Neither outlives the delivery. */
function releaseStarted(started: { callback: unknown; approvalQueue: unknown }): void {
  ;(started.callback as Partial<Disposable>)?.[Symbol.dispose]?.()
  ;(started.approvalQueue as Partial<Disposable>)?.[Symbol.dispose]?.()
}
