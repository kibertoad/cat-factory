import { describe, expect, it } from 'vitest'
import { cardEffectOf, readDelivery } from '../src/webhook/delivery'

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

describe('cardEffectOf', () => {
  it('opens a card for a parked-decision type', () => {
    const effect = cardEffectOf(readDelivery(notification())!)
    expect(effect).toMatchObject({ kind: 'open', card: { cardId: 'ntf_1', runId: 'exec_9' } })
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

  it('raises nothing for the run and alert families', () => {
    const run = readDelivery({ deliveryId: 'exec_9:run.failed', event: 'run.failed', run: {} })!
    expect(cardEffectOf(run)).toEqual({ kind: 'none' })
  })
})
