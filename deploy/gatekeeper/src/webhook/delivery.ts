// Reading one delivery, and deciding what (if anything) it means for the approval inbox.
//
// The three families share an endpoint and are told apart by SHAPE (`notification` / `run` /
// `alert`), which is what this module does first. It deliberately validates only what it reads:
// the wire contract grows additively, so a delivery carrying a family or a notification type this
// package has never heard of is a thing to pass through as unrecognised, never a parse failure.
// A Gatekeeper that 400s an unknown shape would page an operator for a platform upgrade.
//
// The card derivation is the second half, and its rule is the one from the docs: the webhook is a
// TRIGGER and the API is the truth. So a card carries only what routes an answer (the run) and
// what a human reads (the title and body). The parked decision itself, with its ids and its quorum
// tally, is re-read from `/runs/:runId/decisions` at answer time, because between the delivery and
// the answer the run may have moved on entirely.

import type { NotificationType } from '@cat-factory/sdk'
import type { ApprovalCard, DeliveryEffect } from '../state'

/** One delivery, classified. `unrecognised` is a real outcome, not an error. */
export type Delivery =
  | {
      family: 'notification'
      deliveryId: string
      sentAt: number
      runId: string | null
      taskId: string | null
      notification: DeliveredNotification
    }
  | {
      family: 'run'
      deliveryId: string
      sentAt: number
      event: string
      run: Record<string, unknown>
    }
  | {
      family: 'alert'
      deliveryId: string
      sentAt: number
      event: string
      alert: Record<string, unknown>
    }
  | { family: 'unrecognised'; deliveryId: string; sentAt: number }

/** The card fields this Gatekeeper reads. Everything else on the card stays on the platform. */
interface DeliveredNotification {
  id: string
  type: string
  status: string
  title: string
  body: string
}

/**
 * What raising a card of a given type actually offers the person who opens it.
 *
 * The distinction is load-bearing and it used to be missing. Every subscribed type raised a card
 * that looked answerable, but `merge_review` is settled by an actual MERGE (`notifications_act`),
 * which this Gatekeeper deliberately does not grant to any tier: the merge policy wants a person
 * the platform can name (ADR 0037/0039). Presenting that as an answerable approval is the reverse
 * of the error the type list was written to prevent (a card nobody can answer), and it arrived
 * anyway, as a card that reported `stale` on the first attempt.
 *
 *  - `decision`: the run parks on a `/runs/:runId/decisions` entry, which `approvals_answer`
 *    settles through the caller's own granted bindings.
 *  - `notice`: the run is waiting on something no `/api/v1` verb this Gatekeeper holds can do.
 *    The card is worth raising (somebody has to know) and is worth saying so on.
 */
export type CardDisposition = 'decision' | 'notice'

/**
 * The card types that mean "a run is parked and a person has to answer", with what answering one
 * would take.
 *
 * Deliberately a SMALL map rather than "anything with a runId": `pipeline_complete` and
 * `ci_failed` also carry one and are reports, not questions. Raising an approval card for a report
 * trains people to dismiss cards, which is how a real one gets missed. A deployment that registers
 * its own gate and wants its card here adds the type; that is an edit to this constant, in review,
 * rather than a behaviour that widens on its own.
 *
 * It is keyed by the SDK's own `NotificationType`, so a type this deployment retires fails the
 * build here rather than becoming a card that silently stops arriving. Its keys are also the list
 * `enroll()` SUBSCRIBES to, so what a Gatekeeper asks for and what it can act on are one value.
 */
export const PARKED_DECISION_CARD_TYPES: Readonly<
  Partial<Record<NotificationType, CardDisposition>>
> = {
  requirement_review: 'decision',
  clarity_review: 'decision',
  decision_required: 'decision',
  fork_decision_pending: 'decision',
  judge_review: 'decision',
  human_test_ready: 'decision',
  visual_confirmation_ready: 'decision',
  pr_review_ready: 'decision',
  followup_pending: 'decision',
  // The one notice. Settling it is a real merge through `notifications_act`, which no tier here
  // grants: a shared credential is not one of the people a merge policy named. The card says a
  // human has to finish the run in the cat-factory app.
  merge_review: 'notice',
}

/** Every type this Gatekeeper subscribes to, answerable or not. */
export const SUBSCRIBED_CARD_TYPES: readonly NotificationType[] = Object.keys(
  PARKED_DECISION_CARD_TYPES,
) as NotificationType[]

/**
 * How a delivered card type is dispositioned, or `null` for one this Gatekeeper raises nothing for.
 *
 * Takes a plain `string` because the wire vocabulary grows additively: a deployment one release
 * ahead of this package delivers a type the SDK's union has never heard of, and narrowing the
 * ARGUMENT would make that a type error at the one place that must instead answer "no, not one of
 * mine" and pass the delivery through.
 */
export function dispositionOf(type: string): CardDisposition | null {
  return (PARKED_DECISION_CARD_TYPES as Record<string, CardDisposition | undefined>)[type] ?? null
}

/** The lifecycle events a `run` delivery can carry, and whether each ends the run. */
const TERMINAL_RUN_EVENTS: ReadonlySet<string> = new Set(['run.completed', 'run.failed'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Classify a parsed delivery body.
 *
 * Returns `null` only when the envelope itself is unusable (no `deliveryId`), which is the one
 * case where nothing can be done with it at all: the id is what dedupe keys on, so a delivery
 * without one cannot be admitted safely even as unrecognised.
 */
export function readDelivery(body: unknown): Delivery | null {
  const envelope = asRecord(body)
  if (envelope === null) return null
  const deliveryId = asString(envelope.deliveryId)
  if (deliveryId === null) return null
  const sentAt = typeof envelope.sentAt === 'number' ? envelope.sentAt : 0

  const notification = asRecord(envelope.notification)
  if (notification !== null) {
    return {
      family: 'notification',
      deliveryId,
      sentAt,
      runId: asString(envelope.runId),
      taskId: asString(envelope.taskId),
      notification: {
        id: asString(notification.id) ?? deliveryId,
        type: asString(notification.type) ?? 'unknown',
        status: asString(notification.status) ?? 'open',
        title: asString(notification.title) ?? '',
        body: asString(notification.body) ?? '',
      },
    }
  }

  const event = asString(envelope.event)
  const run = asRecord(envelope.run)
  if (event !== null && run !== null) return { family: 'run', deliveryId, sentAt, event, run }

  const alert = asRecord(envelope.alert)
  if (event !== null && alert !== null) return { family: 'alert', deliveryId, sentAt, event, alert }

  return { family: 'unrecognised', deliveryId, sentAt }
}

/**
 * Decide what a delivery asks durable state to do.
 *
 * A card is keyed on the NOTIFICATION id rather than the delivery id, because the platform
 * re-delivers the same card as it resolves (`ntf_123-open` then `ntf_123-acted`) and those two
 * deliveries are one question with an answer, not two questions. Dedupe still runs on the delivery
 * id upstream of this: the two ids do different jobs and collapsing them would either drop the
 * resolution or re-raise the card.
 *
 * A `run` delivery lands as a lifecycle record rather than nothing. That leg is why the
 * subscription asks for all three run events: a status Gadget reads `runs_watched()` instead of
 * polling, and a terminal event settles the run's open cards, so an inbox never holds a question
 * about a run that has ended.
 */
export function cardEffectOf(delivery: Delivery): DeliveryEffect {
  if (delivery.family === 'run') {
    const runId = asString(delivery.run.id) ?? asString(delivery.run.runId)
    if (runId === null) return { kind: 'none' }
    return {
      kind: 'run-event',
      state: {
        runId,
        event: delivery.event,
        terminal: TERMINAL_RUN_EVENTS.has(delivery.event),
        run: delivery.run,
      },
    }
  }

  if (delivery.family !== 'notification') return { kind: 'none' }
  const { notification, runId } = delivery
  const disposition = dispositionOf(notification.type)
  if (disposition === null) return { kind: 'none' }

  if (notification.status !== 'open') return { kind: 'supersede', cardId: notification.id }
  if (runId === null) return { kind: 'none' }

  return {
    kind: 'open',
    card: {
      cardId: notification.id,
      runId,
      taskId: delivery.taskId,
      type: notification.type,
      disposition,
      title: notification.title,
      body: notification.body,
      raisedAt: delivery.sentAt,
      resolvedAt: null,
      resolution: null,
    } satisfies ApprovalCard,
  }
}
