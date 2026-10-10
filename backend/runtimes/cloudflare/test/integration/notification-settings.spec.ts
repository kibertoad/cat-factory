import { defineNotificationSettingsSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1NotificationSettingsRepository } from '../../src/infrastructure/repositories/D1NotificationSettingsRepository'

// Cross-runtime parity for the notification manager's routing store against the Worker's real D1
// store inside workerd. The Node service runs the identical suite over Postgres, so the two
// dialects' conflict handling and JSON round trip can't drift.

defineNotificationSettingsSuite(
  'cloudflare',
  () => new D1NotificationSettingsRepository({ db: env.DB }),
)
