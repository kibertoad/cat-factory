import { describe, expect, it } from 'vitest'
import {
  HIGH_IMPACT_NOTIFICATION_TYPES,
  decodeNotificationRoutingMatrix,
  defaultNotificationRoute,
  isNotificationRouted,
  resolveNotificationRouting,
} from './notification-routing.js'
import { notificationTypeSchema } from './notifications.js'

// The routing rule the ENGINE acts on and the settings UI renders. They read the same
// functions, so what these pin is the contract between them: an absent cell is the shipped
// default (never a `false` nobody chose), and a row this build cannot fully read costs only
// the cells it cannot read.

describe('defaultNotificationRoute', () => {
  it('pushes every type in-app, so the shipped behaviour is unchanged', () => {
    for (const type of notificationTypeSchema.options) {
      expect(defaultNotificationRoute(type, 'in_app')).toBe(true)
    }
  })

  it('mails exactly the high-impact set and nothing else', () => {
    const mailed = notificationTypeSchema.options.filter((type) =>
      defaultNotificationRoute(type, 'email'),
    )
    // Derived from the same list the rule reads, so adding a high-impact type does not fail
    // this test while pinning that nothing ELSE starts mailing by default.
    expect([...mailed].sort()).toEqual([...HIGH_IMPACT_NOTIFICATION_TYPES].sort())
  })
})

describe('isNotificationRouted', () => {
  it('falls back to the default for a workspace that configured nothing', () => {
    expect(isNotificationRouted(null, 'merge_review', 'email')).toBe(true)
    expect(isNotificationRouted({}, 'requirement_review', 'email')).toBe(false)
  })

  it('honours an override in both directions', () => {
    const matrix = { requirement_review: { email: true }, merge_review: { email: false } }
    expect(isNotificationRouted(matrix, 'requirement_review', 'email')).toBe(true)
    expect(isNotificationRouted(matrix, 'merge_review', 'email')).toBe(false)
  })

  it('leaves the channels a type did not override on their own defaults', () => {
    // The cell is per (type, channel): muting email must not also mute the in-app push.
    expect(resolveNotificationRouting({ merge_review: { email: false } }, 'merge_review')).toEqual({
      in_app: true,
      email: false,
    })
  })
})

describe('decodeNotificationRoutingMatrix', () => {
  it('keeps the cells it understands and drops only the ones it does not', () => {
    const decoded = decodeNotificationRoutingMatrix({
      merge_review: { email: false },
      // A type retired since the row was written, and a channel this build no longer routes.
      some_retired_type: { email: false },
      ci_failed: { email: false, carrier_pigeon: true },
    })

    expect(isNotificationRouted(decoded, 'merge_review', 'email')).toBe(false)
    expect(isNotificationRouted(decoded, 'ci_failed', 'email')).toBe(false)
    // The unreadable cells cost themselves; every other override survives.
    expect(Object.keys(decoded).sort()).toEqual(['ci_failed', 'merge_review'])
  })

  it('reads a value that is not a matrix as no overrides at all', () => {
    expect(decodeNotificationRoutingMatrix(null)).toEqual({})
    expect(decodeNotificationRoutingMatrix('nonsense')).toEqual({})
    expect(decodeNotificationRoutingMatrix({ merge_review: 'yes' })).toEqual({})
  })
})
