import { defineNotificationSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1NotificationRepository } from '../../src/infrastructure/repositories/D1NotificationRepository'

// Cross-runtime parity for the notifications store against the Worker's real D1 repository
// inside workerd. The Node service runs the identical suite over its own Postgres, so the
// two stores — and the retention prune wired onto both facades' sweeps — can't drift.
defineNotificationSuite('cloudflare', () => new D1NotificationRepository({ db: env.DB }))
