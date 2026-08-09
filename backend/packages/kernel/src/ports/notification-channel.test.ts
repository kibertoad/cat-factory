import { describe, expect, it } from 'vitest'
import { RoutedNotificationChannel, isAlertingDelivery } from './notification-channel.js'
import type {
  NotificationChannel,
  NotificationDeliveryReason,
  NotificationRouter,
} from './notification-channel.js'
import { NOTIFICATION_DELIVERY_REASONS } from './notification-channel.js'
import type { Notification } from '../domain/types.js'

// The gate a facade wraps each routed channel in. What matters is the third case: a settings
// read that fails must not silently become "deliver everything" (a mailshot) or "deliver
// nothing" (the parked run nobody hears about) — it falls back to the shipped default and
// says so.

const card: Notification = {
  id: 'ntf-1',
  type: 'merge_review',
  status: 'open',
  severity: 'normal',
  blockId: 'blk-1',
  executionId: null,
  title: 'Ready to merge',
  body: '',
  payload: null,
  createdAt: 0,
  resolvedAt: null,
}

function recorder(): { channel: NotificationChannel; delivered: string[] } {
  const delivered: string[] = []
  return {
    delivered,
    channel: {
      async deliver(_workspaceId, notification, reason) {
        delivered.push(`${notification.id}:${reason}`)
      },
    },
  }
}

const router = (isRouted: NotificationRouter['isRouted']): NotificationRouter => ({ isRouted })

describe('RoutedNotificationChannel', () => {
  it('delivers when the workspace routes the type to this channel', async () => {
    const inner = recorder()
    const gated = new RoutedNotificationChannel(
      'email',
      router(async () => true),
      inner.channel,
    )

    await gated.deliver('ws-1', card, 'raised')

    expect(inner.delivered).toEqual(['ntf-1:raised'])
  })

  it('delivers nothing when the workspace muted it', async () => {
    const inner = recorder()
    const gated = new RoutedNotificationChannel(
      'email',
      router(async () => false),
      inner.channel,
    )

    await gated.deliver('ws-1', card, 'raised')

    expect(inner.delivered).toEqual([])
  })

  it('falls back to the SHIPPED DEFAULT and reports when the routing read fails', async () => {
    const errors: unknown[] = []
    const failing = router(async () => {
      throw new Error('settings store unreachable')
    })

    const mailed = recorder()
    // `merge_review` is high-impact: email defaults ON, so an unreadable setting still reaches
    // the human rather than the outage costing them the notification.
    await new RoutedNotificationChannel('email', failing, mailed.channel, (error) =>
      errors.push(error),
    ).deliver('ws-1', card, 'raised')
    expect(mailed.delivered).toEqual(['ntf-1:raised'])

    const muted = recorder()
    // …and a type email does NOT default to stays unsent, so the same outage cannot turn into
    // a mailshot of everything.
    await new RoutedNotificationChannel('email', failing, muted.channel, (error) =>
      errors.push(error),
    ).deliver('ws-1', { ...card, type: 'requirement_review' }, 'raised')
    expect(muted.delivered).toEqual([])

    expect(errors).toHaveLength(2)
  })

  it('passes the channel it gates to the router, not the notification type alone', async () => {
    const asked: string[] = []
    const inner = recorder()
    const gated = new RoutedNotificationChannel(
      'in_app',
      router(async (_ws, _type, channel) => {
        asked.push(channel)
        return true
      }),
      inner.channel,
    )

    await gated.deliver('ws-1', card, 'raised')

    expect(asked).toEqual(['in_app'])
  })

  // The gate covers the ALERT, never the correction. A muted type still has its card persisted
  // and rendered from the next snapshot, so a board holding one has to be told when it settles
  // or escalates: withholding that is how an already-dismissed decision keeps rendering as
  // actionable. It is also what keeps the escalation sweep's loop free of a read per card.
  it.each(NOTIFICATION_DELIVERY_REASONS.filter((r) => !isAlertingDelivery(r)))(
    'delivers a %s card without consulting the router, even on a muted type',
    async (reason) => {
      let asked = 0
      const inner = recorder()
      const gated = new RoutedNotificationChannel(
        'in_app',
        router(async () => {
          asked++
          return false
        }),
        inner.channel,
      )

      await gated.deliver('ws-1', { ...card, status: 'dismissed' }, reason)

      expect(inner.delivered).toEqual([`ntf-1:${reason}`])
      expect(asked).toBe(0)
    },
  )

  it('is the ONE place the alert-vs-state split is decided', () => {
    // Pinned as a relation over the vocabulary rather than a hand-copied list: a new edge has to
    // be classified here, and the transports read the answer instead of restating it.
    const classified = NOTIFICATION_DELIVERY_REASONS.map(
      (reason: NotificationDeliveryReason) => [reason, isAlertingDelivery(reason)] as const,
    )
    expect(classified).toEqual([
      ['raised', true],
      ['refreshed', false],
      ['settled', false],
    ])
  })
})
