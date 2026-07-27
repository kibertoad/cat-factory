import { defineReviewQuestionPostSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1ReviewQuestionPostRepository } from '../../src/infrastructure/repositories/D1ReviewQuestionPostRepository'

// Cross-runtime parity for the question-writeback idempotency markers against the Worker's real
// D1 repository inside workerd. The Node service runs the identical suite over its own Postgres,
// so the atomic claim — expressed as SQLite `ON CONFLICT … DO UPDATE … WHERE … RETURNING` here and
// as Drizzle's `setWhere` there — can't drift into double-posting on one store.
defineReviewQuestionPostSuite(
  'cloudflare',
  () => new D1ReviewQuestionPostRepository({ db: env.DB }),
)
