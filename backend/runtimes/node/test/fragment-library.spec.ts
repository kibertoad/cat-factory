import { defineFragmentLibrarySuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import {
  DrizzleFragmentSourceRepository,
  DrizzlePromptFragmentRepository,
} from '../src/repositories/fragments.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the repo-sourced prompt-fragment library against the Node facade's
// real Drizzle/Postgres repositories. The Cloudflare Worker runs the identical suite over its D1
// tables, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineFragmentLibrarySuite('node', () => ({
    sources: new DrizzleFragmentSourceRepository(db),
    fragments: new DrizzlePromptFragmentRepository(db),
  }))
} else {
  describe.skip('[node] fragment library (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
