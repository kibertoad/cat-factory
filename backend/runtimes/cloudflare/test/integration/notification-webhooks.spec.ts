import { defineNotificationWebhookSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1NotificationWebhookRepository } from '../../src/infrastructure/repositories/D1NotificationWebhookRepository'

// Cross-runtime parity for the outbound notification-webhook store against the Worker's real D1
// repository inside workerd. The Node service runs the identical suite over its own Postgres, so
// the two stores — and the `types` JSON column both decode through the shared parser — can't drift.
defineNotificationWebhookSuite(
  'cloudflare',
  () => new D1NotificationWebhookRepository({ db: env.DB }),
)
