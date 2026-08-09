import { describe, expect, it } from 'vitest'
import {
  cardEffectOf,
  dispositionOf,
  PARKED_DECISION_CARD_TYPES,
  readDelivery,
  SUBSCRIBED_CARD_TYPES,
} from '../src/webhook/delivery.js'

function notification(
  overrides: { notification?: Record<string, unknown> } & Record<string, unknown> = {},
): Record<string, unknown> {
  const { notification: card, ...envelope } = overrides
  return {
    deliveryId: 'ntf_1-open',
    sentAt: 1_800_000_000_000,
    workspaceId: 'ws_1',
    runId: 'exec_9',
    taskId: 'blk_4',
    ...envelope,
    notification: {
      id: 'ntf_1',
      type: 'merge_review',
      status: 'open',
      title: 'Ready to merge',
      body: 'The merger scored the change.',
      ...card,
    },
  }
}

describe('readDelivery', () => {
  it('tells the three families apart by shape', () => {
    expect(readDelivery(notification())?.family).toBe('notification')
    expect(
      readDelivery({ deliveryId: 'exec_9:run.completed', event: 'run.completed', run: {} })?.family,
    ).toBe('run')
    expect(
      readDelivery({ deliveryId: 'ntf_7:platform_health.firing:2', event: 'x', alert: {} })?.family,
    ).toBe('alert')
  })

  // The wire vocabulary grows additively, so a family or a type this package has never heard of is
  // something to pass through, never a parse failure: 400ing an unknown shape would page an
  // operator for a platform upgrade.
  it('passes an unrecognised family through rather than refusing it', () => {
    expect(readDelivery({ deliveryId: 'd_1', somethingNew: {} })?.family).toBe('unrecognised')
  })

  // The one envelope that genuinely cannot be admitted: dedupe keys on the id, so a delivery
  // without one cannot be handled safely even as unrecognised.
  it('refuses an envelope with no deliveryId', () => {
    expect(readDelivery({ sentAt: 1 })).toBeNull()
    expect(readDelivery('not an object')).toBeNull()
  })
})

// What `enroll()` asks the platform for and what the inbox raises a card for must be ONE value.
// Two lists would arrive as either a type acted on but not subscribed (a card that never appears)
// or a type subscribed with nothing behind it (a card nobody can do anything with), and both fail
// silently.
describe('what the subscription asks for', () => {
  it('subscribes to exactly the types the inbox dispositions', () => {
    expect(new Set(SUBSCRIBED_CARD_TYPES)).toEqual(new Set(Object.keys(PARKED_DECISION_CARD_TYPES)))
    for (const type of SUBSCRIBED_CARD_TYPES) expect(dispositionOf(type)).not.toBeNull()
  })
})

describe('cardEffectOf', () => {
  it('opens a card for a parked-decision type', () => {
    const effect = cardEffectOf(
      readDelivery(notification({ notification: { type: 'judge_review' } }))!,
    )
    expect(effect).toMatchObject({
      kind: 'open',
      card: { cardId: 'ntf_1', runId: 'exec_9', disposition: 'decision' },
    })
  })

  // The distinction that used to be missing. `merge_review` is settled by a real MERGE
  // (`notifications_act`), which no tier here grants: the merge policy wants a person the platform
  // can name. Raising it as an answerable approval is a card whose first answer attempt comes back
  // `stale`, which reads to whoever opened it exactly like a run that moved on.
  it('stamps a card the API cannot settle as a notice rather than a decision', () => {
    expect(dispositionOf('merge_review')).toBe('notice')
    expect(dispositionOf('judge_review')).toBe('decision')
    expect(dispositionOf('pipeline_complete')).toBeNull()

    const effect = cardEffectOf(readDelivery(notification())!)
    expect(effect).toMatchObject({ kind: 'open', card: { disposition: 'notice' } })
  })

  // `pipeline_complete` and `ci_failed` carry a runId too and are REPORTS. Raising an approval for
  // a report trains people to dismiss cards, which is how a real one gets missed.
  it('raises nothing for a card type that is a report', () => {
    const effect = cardEffectOf(
      readDelivery(notification({ notification: { type: 'pipeline_complete' } }))!,
    )
    expect(effect).toEqual({ kind: 'none' })
  })

  // The platform re-delivers the same card as it resolves. The card is keyed on the NOTIFICATION
  // id for exactly this: keyed on the delivery id, the resolution would open a second card.
  it('supersedes the same card when the platform resolves it', () => {
    const resolved = notification({
      deliveryId: 'ntf_1-acted',
      notification: { status: 'acted' },
    })
    expect(cardEffectOf(readDelivery(resolved)!)).toEqual({ kind: 'supersede', cardId: 'ntf_1' })
  })

  it('raises nothing for a parked-decision card with no run to answer on', () => {
    expect(cardEffectOf(readDelivery(notification({ runId: null }))!)).toEqual({ kind: 'none' })
  })

  // The lifecycle leg. These deliveries used to be subscribed, verified, deduped and dropped, so
  // the comment promising a status Gadget could avoid polling described nothing. They land as a
  // record, and a terminal one settles the run's open cards so an inbox never holds a question
  // about a run that has ended.
  it('records a run lifecycle event, marking the terminal ones', () => {
    const started = readDelivery({
      deliveryId: 'exec_9:run.started',
      event: 'run.started',
      run: { id: 'exec_9', status: 'running' },
    })!
    expect(cardEffectOf(started)).toMatchObject({
      kind: 'run-event',
      state: { runId: 'exec_9', event: 'run.started', terminal: false },
    })

    const failed = readDelivery({
      deliveryId: 'exec_9:run.failed',
      event: 'run.failed',
      run: { id: 'exec_9', status: 'failed' },
    })!
    expect(cardEffectOf(failed)).toMatchObject({ state: { terminal: true } })
  })

  // A run projection with no id is nothing this Gatekeeper can key on, and guessing a key would
  // mean a status read answering about a run nobody asked about.
  it('records nothing for a run delivery it cannot key', () => {
    const run = readDelivery({ deliveryId: 'd_1', event: 'run.failed', run: {} })!
    expect(cardEffectOf(run)).toEqual({ kind: 'none' })
  })

  it('raises nothing for the alert family', () => {
    const alert = readDelivery({ deliveryId: 'a_1', event: 'platform_health.firing', alert: {} })!
    expect(cardEffectOf(alert)).toEqual({ kind: 'none' })
  })
})
