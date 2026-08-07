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
// what a human reads (the title and body). The parked decision itself, with its `approvalId` and
// its quorum tally, is re-read from `/runs/:runId/decisions` at answer time, because between the
// delivery and the answer the run may have moved on entirely.

import type { NotificationType } from '@cat-factory/sdk'
import type { ApprovalCard } from '../state'

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
 * The card types that mean "a run is parked and a person has to answer".
 *
 * Deliberately a SMALL list rather than "anything with a runId": `pipeline_complete` and
 * `ci_failed` also carry one and are reports, not questions. Raising an approval card for a report
 * trains people to dismiss cards, which is how a real one gets missed. A deployment that registers
 * its own gate and wants its card here adds the type; that is an edit to this constant, in review,
 * rather than a behaviour that widens on its own.
 *
 * It is typed against the SDK's own `NotificationType`, so a type this deployment retires fails
 * the build here rather than becoming a card that silently stops arriving. It is also the list
 * `enroll()` SUBSCRIBES to, so what a Gatekeeper asks for and what it can act on are one value.
 */
export const PARKED_DECISION_CARD_TYPES: readonly NotificationType[] = [
  'requirement_review',
  'clarity_review',
  'decision_required',
  'fork_decision_pending',
  'judge_review',
  'merge_review',
  'human_test_ready',
  'visual_confirmation_ready',
  'pr_review_ready',
  'followup_pending',
]

/**
 * Whether a delivered card type is one this Gatekeeper raises an approval for.
 *
 * Takes a plain `string` because the wire vocabulary grows additively: a deployment one release
 * ahead of this package delivers a type the SDK's union has never heard of, and narrowing the
 * ARGUMENT would make that a type error at the one place that must instead answer "no, not one of
 * mine" and pass the delivery through.
 */
export function isParkedDecisionCardType(type: string): boolean {
  return (PARKED_DECISION_CARD_TYPES as readonly string[]).includes(type)
}

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

/** What a delivery asks the approval inbox to do. */
export type CardEffect =
  | { kind: 'open'; card: ApprovalCard }
  | { kind: 'supersede'; cardId: string }
  | { kind: 'none' }

/**
 * Decide the inbox effect of a delivery.
 *
 * A card is keyed on the NOTIFICATION id rather than the delivery id, because the platform
 * re-delivers the same card as it resolves (`ntf_123-open` then `ntf_123-acted`) and those two
 * deliveries are one question with an answer, not two questions. Dedupe still runs on the delivery
 * id upstream of this: the two ids do different jobs and collapsing them would either drop the
 * resolution or re-raise the card.
 */
export function cardEffectOf(delivery: Delivery): CardEffect {
  if (delivery.family !== 'notification') return { kind: 'none' }
  const { notification, runId } = delivery
  if (!isParkedDecisionCardType(notification.type)) return { kind: 'none' }

  if (notification.status !== 'open') return { kind: 'supersede', cardId: notification.id }
  if (runId === null) return { kind: 'none' }

  return {
    kind: 'open',
    card: {
      cardId: notification.id,
      runId,
      taskId: delivery.taskId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      raisedAt: delivery.sentAt,
      resolvedAt: null,
      resolution: null,
    },
  }
}
