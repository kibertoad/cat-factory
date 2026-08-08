import { describe, expect, it } from 'vitest'
import { RoutedNotificationChannel } from './notification-channel.js'
import type { NotificationChannel, NotificationRouter } from './notification-channel.js'
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
      async deliver(_workspaceId, notification) {
        delivered.push(notification.id)
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

    await gated.deliver('ws-1', card)

    expect(inner.delivered).toEqual(['ntf-1'])
  })

  it('delivers nothing when the workspace muted it', async () => {
    const inner = recorder()
    const gated = new RoutedNotificationChannel(
      'email',
      router(async () => false),
      inner.channel,
    )

    await gated.deliver('ws-1', card)

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
    ).deliver('ws-1', card)
    expect(mailed.delivered).toEqual(['ntf-1'])

    const muted = recorder()
    // …and a type email does NOT default to stays unsent, so the same outage cannot turn into
    // a mailshot of everything.
    await new RoutedNotificationChannel('email', failing, muted.channel, (error) =>
      errors.push(error),
    ).deliver('ws-1', { ...card, type: 'requirement_review' })
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

    await gated.deliver('ws-1', card)

    expect(asked).toEqual(['in_app'])
  })
})
