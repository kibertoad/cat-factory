import { defineTrackerCommentIngestSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1TrackerCommentIngestRepository } from '../../src/infrastructure/repositories/D1TrackerCommentIngestRepository'

// Cross-runtime parity for the inbound tracker-comment ingest markers against the Worker's real D1
// repository inside workerd. The Node service runs the identical suite over its own Postgres, so
// the atomic claim — expressed as SQLite `ON CONFLICT … DO UPDATE … WHERE … RETURNING` here and as
// Drizzle's `setWhere` there — can't drift into applying a reporter's answer twice on one store.
defineTrackerCommentIngestSuite(
  'cloudflare',
  () => new D1TrackerCommentIngestRepository({ db: env.DB }),
)
