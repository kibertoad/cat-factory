// The Gatekeeper's durable state: one object per paired workspace, holding the four things a
// stateless Worker cannot.
//
//   1. WHICH DELIVERIES HAVE BEEN SEEN. The platform's terminal run events are at-least-once and
//      a replay re-stamps `sentAt`, so two deliveries of one transition are not byte-identical
//      and only `deliveryId` collapses them. Dedupe has to be durable, and it has to be shared
//      across isolates, which is what makes it a Durable Object rather than a per-isolate Map.
//   2. THE OPEN APPROVAL CARDS. A parked run waits indefinitely, so the card outlives every
//      invocation that could have held it in memory.
//   3. THE LATEST LIFECYCLE STATE OF EACH RUN a delivery has mentioned, so a status Gadget reads
//      what happened without polling, and a card whose run has ended stops standing in an inbox
//      demanding an answer nobody can give.
//   4. THE MINTED PER-ACTOR KEYS. `POST /api/v1/keys` returns a raw secret EXACTLY ONCE; a
//      Gatekeeper that forgets it has minted one mints another on the next call and leaves a
//      trail of live credentials nobody revokes.
//   5. THE ENABLED HOOKS. A workspace enables one in a session and is pushed to from the webhook,
//      which is a different invocation entirely, so the registration cannot live in either. This
//      is also the object every delivery already wakes, which is why the fan-out runs HERE rather
//      than in the receiver: the live half of a registration is a stub, and a stub can only be
//      held where it was handed over.
//
// The dedupe marker and the effect it guards are written TOGETHER, in one multi-key `put`, which
// is the reason `applyDelivery` lives here rather than being composed from two calls in the
// Worker. Durable Object storage commits the writes of one turn atomically, and only that makes
// the pair safe: committing the marker first turns a failed card write into a `duplicate` on the
// platform's retry, so the approval never reaches the inbox and nothing reports that it did not.
//
// Custody note, because it is the reason this design is defensible at all: the provisioning key
// is a Worker SECRET and never leaves the platform's secret store, while the per-actor keys it
// mints live here, in this object's storage. Both are outside every agent's reach; what an agent
// holds is a capability whose methods are the ones policy granted. Storage is the narrowest place
// a minted secret can live and still be reusable, but it IS at rest in your account: if that is
// not acceptable for your deployment, mint per call and revoke after, at the cost of a key row
// per operation.

import { DurableObject } from 'cloudflare:workers'
import {
  holdInitiator,
  NO_HOOK_DISPATCH,
  pushToHook,
  releaseInitiator,
  type HookDispatchReport,
  type HookPayload,
  type HookRecord,
  type HookRegistration,
  type HookRegistry,
} from './os/hooks.js'
import type { HookInitiator } from './os/protocol.js'

/** A parked cat-factory decision, as the OS shows it. */
export interface ApprovalCard {
  /** The delivery that raised it. Also the id the OS answers on. */
  cardId: string
  runId: string
  taskId: string | null
  /** The notification type the platform raised (`merge_review`, `requirement_review`, …). */
  type: string
  /**
   * Whether this card can be ANSWERED from here, or only reported.
   *
   * Stamped at delivery time from the type, so an inbox can render the difference without asking
   * this Gatekeeper anything else. A `notice` is not a lesser card: it is a run waiting on a
   * person in the cat-factory app, and saying so is the whole point of separating it from a card
   * whose first answer attempt would otherwise come back `stale`.
   */
  disposition: 'decision' | 'notice'
  title: string
  body: string
  raisedAt: number
  /** Epoch ms when this Gatekeeper settled it, or null while it is open. */
  resolvedAt: number | null
  /** What settled it: an action name, or `superseded` when the platform resolved the card. */
  resolution: string | null
}

/** The last lifecycle transition a delivery reported for one run. */
export interface RunState {
  runId: string
  /** `run.started` / `run.completed` / `run.failed`, as the platform spells it. */
  event: string
  /** Whether the run has reached a terminal event. */
  terminal: boolean
  /** The run projection the delivery carried, verbatim. */
  run: Record<string, unknown>
  updatedAt: number
}

/** A minted per-actor key, as it is held here. */
export interface StoredKey {
  keyId: string
  secret: string
  mintedAt: number
}

/**
 * A claim on the right to mint one actor+scope key.
 *
 * `POST /api/v1/keys` is a real, non-idempotent side effect that returns its secret exactly once,
 * so two pipelined calls that both read "no key yet" would both mint and the loser's credential
 * would stay live upstream with nothing here recording that it exists. The claim is taken BEFORE
 * the mint, atomically, and it EXPIRES so a Worker that dies mid-mint does not wedge the actor
 * out of the Gatekeeper forever.
 */
export interface MintClaim {
  claimedAt: number
}

/** What `claimKeyMint` answers: the key that already exists, or permission to make one. */
export type MintTicket =
  | { outcome: 'existing'; key: StoredKey }
  | { outcome: 'claimed' }
  | { outcome: 'in_flight'; retryAfterMs: number }

/** What one delivery asks this object to do, decided in the Worker from the delivery's shape. */
export type DeliveryEffect =
  | { kind: 'open'; card: ApprovalCard }
  | { kind: 'supersede'; cardId: string }
  | { kind: 'run-event'; state: Omit<RunState, 'updatedAt'> }
  | { kind: 'none' }

/** What taking one delivery did to durable state. */
export type DeliveryApplication =
  | { applied: false; reason: 'duplicate' }
  | { applied: true; effect: 'opened' | 'superseded' | 'run-event' | 'none' }

const DELIVERY_PREFIX = 'delivery:'
const CARD_PREFIX = 'card:'
const KEY_PREFIX = 'key:'
const CLAIM_PREFIX = 'mint:'
const RUN_PREFIX = 'run:'
const HOOK_PREFIX = 'hook:'

/**
 * How long a `deliveryId` is remembered for dedupe purposes.
 *
 * Long enough to cover a durable replay (the platform re-drives a settled run from a sweeper, not
 * from a queue that gives up in minutes) and short enough that the object does not accumulate one
 * row per event forever. Cards are NOT pruned on this schedule: an open card is live state, and a
 * resolved one is the record of an answer this Gatekeeper gave.
 */
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** How long the record of a finished run is kept for a status Gadget to read. */
const RUN_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long a mint claim holds before another caller may take it.
 *
 * Sized against the one call it covers (`POST /api/v1/keys` behind the SDK's own retries), not
 * against a request budget: shorter and two callers mint anyway, which is the leak; longer and a
 * Worker that died mid-mint locks the actor out for that long. A caller that meets a live claim
 * is told to retry rather than served a key, because serving one would mean minting a second.
 */
const MINT_CLAIM_TTL_MS = 30_000

/** How often the prune alarm runs. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

export class GatekeeperState extends DurableObject {
  /**
   * The live half of every enabled hook: the workspace's initiator, held past the call it came on.
   *
   * IN MEMORY, and there is no version of this that is not. A stub is a reference into another
   * Worker, so it cannot be written to storage, and an object that is evicted between two
   * deliveries keeps its records and loses this map. That is why a push with no entry here is
   * COUNTED as missed on the record rather than skipped: the count is what a workspace reads to
   * discover its hook went quiet, and the projection it was pushing is still there to reconcile
   * against.
   */
  readonly #initiators: HookRegistry = new Map()

  /**
   * Take one delivery: dedupe and act, as ONE durable write.
   *
   * The marker and the effect land in a single `put`, so there is no window in which the platform
   * would see a duplicate for work that never happened. A delivery whose effect is `none` still
   * records the marker: an unrecognised family is a message this Gatekeeper HAS handled, and
   * re-deriving that on every replay would spend the platform's retry budget on it.
   */
  async applyDelivery(
    deliveryId: string,
    effect: DeliveryEffect,
    now: number,
  ): Promise<DeliveryApplication> {
    const marker = `${DELIVERY_PREFIX}${deliveryId}`
    if ((await this.ctx.storage.get<number>(marker)) !== undefined) {
      return { applied: false, reason: 'duplicate' }
    }

    const writes: Record<string, unknown> = { [marker]: now }

    if (effect.kind === 'open') {
      writes[`${CARD_PREFIX}${effect.card.cardId}`] = effect.card
    } else if (effect.kind === 'supersede') {
      const key = `${CARD_PREFIX}${effect.cardId}`
      const card = await this.ctx.storage.get<ApprovalCard>(key)
      if (card !== undefined && card.resolvedAt === null) {
        writes[key] = { ...card, resolvedAt: now, resolution: 'superseded' }
      }
    } else if (effect.kind === 'run-event') {
      writes[`${RUN_PREFIX}${effect.state.runId}`] = { ...effect.state, updatedAt: now }
      // A run that ended answers nothing more, so its open cards stop asking. Doing it here rather
      // than lazily at read time is what keeps the inbox honest for an OS that renders the list
      // without asking this Gatekeeper anything else.
      if (effect.state.terminal) {
        for (const [key, card] of await this.#openCardsFor(effect.state.runId)) {
          writes[key] = { ...card, resolvedAt: now, resolution: `run_${effect.state.event}` }
        }
      }
    }

    await this.ctx.storage.put(writes)
    await this.#ensureAlarm(now)
    return { applied: true, effect: effect.kind === 'none' ? 'none' : effectName(effect.kind) }
  }

  /** Settle a card this Gatekeeper answered. A card already settled keeps its first resolution. */
  async resolveCard(cardId: string, resolution: string, now: number): Promise<ApprovalCard | null> {
    const key = `${CARD_PREFIX}${cardId}`
    const card = await this.ctx.storage.get<ApprovalCard>(key)
    if (card === undefined || card.resolvedAt !== null) return card ?? null
    const resolved: ApprovalCard = { ...card, resolvedAt: now, resolution }
    await this.ctx.storage.put(key, resolved)
    return resolved
  }

  async getCard(cardId: string): Promise<ApprovalCard | null> {
    return (await this.ctx.storage.get<ApprovalCard>(`${CARD_PREFIX}${cardId}`)) ?? null
  }

  /** Every card, newest first. Resolved ones are included: the OS decides what it renders. */
  async listCards(): Promise<ApprovalCard[]> {
    const rows = await this.ctx.storage.list<ApprovalCard>({ prefix: CARD_PREFIX })
    return [...rows.values()].sort((a, b) => b.raisedAt - a.raisedAt)
  }

  /** The latest lifecycle state of every run a delivery has mentioned, newest first. */
  async listRunStates(): Promise<RunState[]> {
    const rows = await this.ctx.storage.list<RunState>({ prefix: RUN_PREFIX })
    return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * The workspace enabled a hook: store the registration, and hold the live half beside it.
   *
   * The counters of an existing registration SURVIVE a re-enable. A workspace re-arms a hook
   * exactly when it noticed one had gone quiet, and the number that told it so is `missed`;
   * zeroing it on the way back up would delete the evidence at the one moment it is being acted
   * on. What is replaced is the initiator, which the contract asks for by name.
   */
  async enableHook(record: HookRecord, initiator: HookInitiator): Promise<void> {
    const key = `${HOOK_PREFIX}${record.hookId}`
    const existing = await this.ctx.storage.get<HookRecord>(key)
    // The record lands FIRST, so a failure between the two halves leaves the one that reports
    // itself: a registration with no live initiator counts every delivery as missed, where a live
    // initiator with no registration is a stub nothing will ever push to and nothing can see.
    await this.ctx.storage.put(key, {
      ...record,
      deliveries: existing?.deliveries ?? record.deliveries,
      missed: existing?.missed ?? record.missed,
      failures: existing?.failures ?? record.failures,
      lastDeliveryAt: existing?.lastDeliveryAt ?? record.lastDeliveryAt,
      lastError: existing?.lastError ?? record.lastError,
    } satisfies HookRecord)
    this.#replaceInitiator(record.hookId, holdInitiator(initiator))
  }

  /** The workspace withdrew a hook: both halves go, which is the permanent clean-up asked for. */
  async disableHook(hookId: string): Promise<void> {
    this.#replaceInitiator(hookId, undefined)
    await this.ctx.storage.delete(`${HOOK_PREFIX}${hookId}`)
  }

  /**
   * The hooks enabled for one account, newest first, each with whether its live half survives.
   *
   * Scoped to the account rather than answering the object's whole set: a session reads this, and
   * one account's gadget bindings are not another's to enumerate.
   */
  async listHooks(accountId: string): Promise<HookRegistration[]> {
    const rows = await this.ctx.storage.list<HookRecord>({ prefix: HOOK_PREFIX })
    return [...rows.values()]
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => b.enabledAt - a.enabledAt)
      .map((record) => ({ ...record, live: this.#initiators.has(record.hookId) }))
  }

  /**
   * Push one applied delivery to every hook registered for its topic.
   *
   * Called AFTER `applyDelivery` has committed, never as part of it: the card is the durable
   * truth and the push is the accelerator over it, so an outbound call that hangs or refuses costs
   * a notification and never the record of what the deployment reported. Each registration is
   * pushed independently and every outcome lands on that registration's own counters, because one
   * workspace's broken gadget must not decide whether another's hook fires.
   */
  async dispatchHooks(effect: DeliveryEffect, now: number): Promise<HookDispatchReport> {
    const payload = await this.#payloadFor(effect)
    if (payload === null) return NO_HOOK_DISPATCH

    const rows = await this.ctx.storage.list<HookRecord>({ prefix: HOOK_PREFIX })
    const report: HookDispatchReport = { topic: payload.topic, delivered: 0, stale: 0, failed: 0 }
    const writes: Record<string, HookRecord> = {}
    for (const [key, record] of rows) {
      if (record.topic !== payload.topic) continue
      const pushed = await pushToHook(payload, record, this.#initiators.get(record.hookId), now)
      writes[key] = pushed.record
      if (pushed.outcome === 'delivered') report.delivered += 1
      else if (pushed.outcome === 'stale') report.stale += 1
      else report.failed += 1
    }
    if (Object.keys(writes).length > 0) await this.ctx.storage.put(writes)
    return report
  }

  /**
   * Either the actor's existing key, or an exclusive claim on minting one.
   *
   * Read-and-claim in one turn, which is the whole point: the alternative (read here, mint in the
   * Worker, write back) is a race two pipelined calls lose in the direction that leaks a live
   * credential. `in_flight` is a real third answer rather than a wait, because a Durable Object
   * that blocked on a peer's outbound HTTP call would serialise every actor behind the slowest.
   */
  async claimKeyMint(actorId: string, scope: string, now: number): Promise<MintTicket> {
    const existing = await this.ctx.storage.get<StoredKey>(keyRow(actorId, scope))
    if (existing !== undefined) return { outcome: 'existing', key: existing }

    const claimKey = `${CLAIM_PREFIX}${actorId}:${scope}`
    const claim = await this.ctx.storage.get<MintClaim>(claimKey)
    if (claim !== undefined && now - claim.claimedAt < MINT_CLAIM_TTL_MS) {
      return { outcome: 'in_flight', retryAfterMs: MINT_CLAIM_TTL_MS - (now - claim.claimedAt) }
    }

    await this.ctx.storage.put(claimKey, { claimedAt: now } satisfies MintClaim)
    return { outcome: 'claimed' }
  }

  /**
   * Record the key a claim produced, releasing the claim in the same turn.
   *
   * Both operations are ISSUED before either is awaited, so Durable Object storage commits them
   * together: a crash cannot leave the key stored with the claim still held (which would cost the
   * next caller the TTL for nothing) or the claim released with the key unstored (which would let
   * a second caller mint a duplicate).
   */
  async commitKeyMint(actorId: string, scope: string, key: StoredKey): Promise<void> {
    const stored = this.ctx.storage.put(keyRow(actorId, scope), key)
    const released = this.ctx.storage.delete(`${CLAIM_PREFIX}${actorId}:${scope}`)
    await Promise.all([stored, released])
  }

  /** Release a claim whose mint failed, so the next caller may take it without waiting out the TTL. */
  async releaseKeyMint(actorId: string, scope: string): Promise<void> {
    await this.ctx.storage.delete(`${CLAIM_PREFIX}${actorId}:${scope}`)
  }

  /**
   * Drop one stored key, so the next call mints a fresh one.
   *
   * Takes the key ID the caller was USING and drops the row only if it still holds that key. Two
   * concurrent calls can both meet a 401 on the same stale secret, and a blind delete would have
   * the second one throw away the replacement the first had just minted, which reads to a caller
   * as a Gatekeeper that mints a key per call.
   */
  async forgetKeyIfCurrent(actorId: string, scope: string, keyId: string): Promise<boolean> {
    const row = keyRow(actorId, scope)
    const stored = await this.ctx.storage.get<StoredKey>(row)
    if (stored === undefined || stored.keyId !== keyId) return false
    await this.ctx.storage.delete(row)
    return true
  }

  /** Every key minted for an actor, whatever scope it was minted at. */
  async listKeys(actorId: string): Promise<{ scope: string; key: StoredKey }[]> {
    const rows = await this.ctx.storage.list<StoredKey>({ prefix: `${KEY_PREFIX}${actorId}:` })
    return [...rows.entries()].map(([row, key]) => ({
      scope: row.slice(`${KEY_PREFIX}${actorId}:`.length),
      key,
    }))
  }

  /**
   * Forget the NAMED keys, and only those.
   *
   * Named rather than "all this actor's", which is what it used to do: the caller revokes upstream
   * first and then forgets, so forgetting a key it had not revoked would leave a live cat-factory
   * credential with no record here that it exists. That is precisely the leak the revoke order
   * exists to prevent, arriving through the other half of the pair.
   */
  async forgetKeys(actorId: string, scopes: readonly string[]): Promise<void> {
    if (scopes.length === 0) return
    await this.ctx.storage.delete(scopes.map((scope) => keyRow(actorId, scope)))
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    await this.#pruneOlderThan<number>(
      DELIVERY_PREFIX,
      DELIVERY_RETENTION_MS,
      now,
      (seenAt) => seenAt,
    )
    await this.#pruneOlderThan<RunState>(
      RUN_PREFIX,
      RUN_STATE_RETENTION_MS,
      now,
      (state) => state.updatedAt,
    )
    await this.ctx.storage.setAlarm(now + PRUNE_INTERVAL_MS)
  }

  /**
   * Install (or drop) one hook's live half, giving back the reference it replaces.
   *
   * One method for both directions because the release is the half that gets forgotten: a
   * duplicate taken on enable and overwritten on the next enable would hold the workspace's end of
   * a connection open for the object's whole lifetime, and nothing about either call site would
   * show it.
   */
  #replaceInitiator(hookId: string, initiator: HookInitiator | undefined): void {
    const previous = this.#initiators.get(hookId)
    if (previous !== undefined) releaseInitiator(previous)
    if (initiator === undefined) this.#initiators.delete(hookId)
    else this.#initiators.set(hookId, initiator)
  }

  /**
   * What a delivery pushes, read back from what the write committed.
   *
   * Read rather than taken from the effect, because a card the platform SETTLED is worth pushing
   * too and the stored row is the only place its resolution exists. `null` is the honest answer
   * for a delivery no topic covers (an alert family, an unrecognised shape): a hook that fired on
   * one would be pushing an event its callback has no method for.
   */
  async #payloadFor(effect: DeliveryEffect): Promise<HookPayload | null> {
    if (effect.kind === 'open' || effect.kind === 'supersede') {
      const cardId = effect.kind === 'open' ? effect.card.cardId : effect.cardId
      const card = await this.ctx.storage.get<ApprovalCard>(`${CARD_PREFIX}${cardId}`)
      return card === undefined ? null : { topic: 'approval_card', card }
    }
    if (effect.kind === 'run-event') {
      const state = await this.ctx.storage.get<RunState>(`${RUN_PREFIX}${effect.state.runId}`)
      return state === undefined ? null : { topic: 'run_event', state }
    }
    return null
  }

  async #openCardsFor(runId: string): Promise<[string, ApprovalCard][]> {
    const rows = await this.ctx.storage.list<ApprovalCard>({ prefix: CARD_PREFIX })
    return [...rows.entries()].filter(
      ([, card]) => card.runId === runId && card.resolvedAt === null,
    )
  }

  async #ensureAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + PRUNE_INTERVAL_MS)
    }
  }

  async #pruneOlderThan<T>(
    prefix: string,
    retentionMs: number,
    now: number,
    stampOf: (value: T) => number,
  ): Promise<void> {
    const rows = await this.ctx.storage.list<T>({ prefix })
    const stale = [...rows.entries()]
      .filter(([, value]) => now - stampOf(value) > retentionMs)
      .map(([key]) => key)
    if (stale.length > 0) await this.ctx.storage.delete(stale)
  }
}

function effectName(
  kind: 'open' | 'supersede' | 'run-event',
): 'opened' | 'superseded' | 'run-event' {
  if (kind === 'open') return 'opened'
  if (kind === 'supersede') return 'superseded'
  return 'run-event'
}

function keyRow(actorId: string, scope: string): string {
  return `${KEY_PREFIX}${actorId}:${scope}`
}
