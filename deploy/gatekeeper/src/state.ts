// The Gatekeeper's durable state: one object per paired workspace, holding the three things a
// stateless Worker cannot.
//
//   1. WHICH DELIVERIES HAVE BEEN SEEN. The platform's terminal run events are at-least-once and
//      a replay re-stamps `sentAt`, so two deliveries of one transition are not byte-identical
//      and only `deliveryId` collapses them. Dedupe has to be durable, and it has to be shared
//      across isolates, which is what makes it a Durable Object rather than a per-isolate Map.
//   2. THE OPEN APPROVAL CARDS. A parked run waits indefinitely, so the card outlives every
//      invocation that could have held it in memory.
//   3. THE MINTED PER-ACTOR KEYS. `POST /api/v1/keys` returns a raw secret EXACTLY ONCE; a
//      Gatekeeper that forgets it has minted one mints another on the next call and leaves a
//      trail of live credentials nobody revokes.
//
// Custody note, because it is the reason this design is defensible at all: the provisioning key
// is a Worker SECRET and never leaves the platform's secret store, while the per-actor keys it
// mints live here, in this object's storage. Both are outside every agent's reach; what an agent
// holds is a capability whose methods are the ones policy granted. Storage is the narrowest place
// a minted secret can live and still be reusable, but it IS at rest in your account: if that is
// not acceptable for your deployment, mint per call and revoke after, at the cost of a key row
// per operation.

import { DurableObject } from 'cloudflare:workers'

/** A parked cat-factory decision, as the OS shows it. */
export interface ApprovalCard {
  /** The delivery that raised it. Also the id the OS answers on. */
  cardId: string
  runId: string
  taskId: string | null
  /** The notification type the platform raised (`merge_review`, `requirement_review`, …). */
  type: string
  title: string
  body: string
  raisedAt: number
  /** Epoch ms when this Gatekeeper settled it, or null while it is open. */
  resolvedAt: number | null
  /** What settled it: an action name, or `superseded` when the platform resolved the card. */
  resolution: string | null
}

/** A minted per-actor key, as it is held here. */
export interface StoredKey {
  keyId: string
  secret: string
  mintedAt: number
}

const DELIVERY_PREFIX = 'delivery:'
const CARD_PREFIX = 'card:'
const KEY_PREFIX = 'key:'

/**
 * How long a `deliveryId` is remembered for dedupe purposes.
 *
 * Long enough to cover a durable replay (the platform re-drives a settled run from a sweeper, not
 * from a queue that gives up in minutes) and short enough that the object does not accumulate one
 * row per event forever. Cards are NOT pruned on this schedule: an open card is live state, and a
 * resolved one is the record of an answer this Gatekeeper gave.
 */
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** How often the prune alarm runs. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

export class GatekeeperState extends DurableObject {
  /**
   * Record a delivery, answering whether it is the FIRST sight of it.
   *
   * The write happens before the caller acts on the delivery, so a duplicate can never be acted
   * on twice, and a crash between the write and the action costs the action rather than
   * duplicating it. That is the correct direction for this payload: every effect downstream of a
   * delivery is re-derivable from the API, which is the source of truth the docs point at, while
   * a double-raised approval card is a person answering the same question twice.
   */
  async recordDelivery(deliveryId: string, now: number): Promise<boolean> {
    const key = `${DELIVERY_PREFIX}${deliveryId}`
    const seen = await this.ctx.storage.get<number>(key)
    if (seen !== undefined) return false
    await this.ctx.storage.put(key, now)
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + PRUNE_INTERVAL_MS)
    }
    return true
  }

  /** Open a card, or refresh the one this delivery already raised. */
  async openCard(card: ApprovalCard): Promise<void> {
    await this.ctx.storage.put(`${CARD_PREFIX}${card.cardId}`, card)
  }

  /** Settle a card. A card that is already settled keeps its first resolution. */
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

  async getKey(actorId: string, scope: string): Promise<StoredKey | null> {
    return (await this.ctx.storage.get<StoredKey>(keyRow(actorId, scope))) ?? null
  }

  async putKey(actorId: string, scope: string, key: StoredKey): Promise<void> {
    await this.ctx.storage.put(keyRow(actorId, scope), key)
  }

  /**
   * Forget an actor's minted keys, returning their ids so the caller can revoke them upstream.
   *
   * Forgetting is deliberately the LAST step at the call site: a Gatekeeper that dropped its copy
   * and then failed to revoke would leave a live cat-factory key with no record that it exists.
   */
  async forgetKeys(actorId: string): Promise<string[]> {
    const rows = await this.ctx.storage.list<StoredKey>({ prefix: `${KEY_PREFIX}${actorId}:` })
    await this.ctx.storage.delete([...rows.keys()])
    return [...rows.values()].map((row) => row.keyId)
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    const rows = await this.ctx.storage.list<number>({ prefix: DELIVERY_PREFIX })
    const stale = [...rows.entries()]
      .filter(([, seenAt]) => now - seenAt > DELIVERY_RETENTION_MS)
      .map(([key]) => key)
    if (stale.length > 0) await this.ctx.storage.delete(stale)
    await this.ctx.storage.setAlarm(now + PRUNE_INTERVAL_MS)
  }
}

function keyRow(actorId: string, scope: string): string {
  return `${KEY_PREFIX}${actorId}:${scope}`
}
