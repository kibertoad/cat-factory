import { defineSkillLibrarySuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleAccountSkillRepository } from '../src/repositories/skills.js'
import { DrizzleSkillSourceRepository } from '../src/repositories/skills.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the repo-sourced Claude Skills library against the Node
// facade's real Drizzle/Postgres repositories. The Cloudflare Worker runs the identical
// suite over its D1 tables, so the two stores can't drift. CI provides Postgres via
// `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineSkillLibrarySuite('node', () => ({
    skillSources: new DrizzleSkillSourceRepository(db),
    accountSkills: new DrizzleAccountSkillRepository(db),
  }))
} else {
  describe.skip('[node] skill library (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
