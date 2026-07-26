import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { initiativeSchema } from './initiative.js'

// SEC-10: the tracker-folder `slug` feeds `initiativeDocDir(slug)` = `docs/initiatives/<slug>`
// and the JSON/tracker/version paths committed via `RepoFiles`. It must stay a plain lower-kebab
// token so it can't reshape a committed path (a `/` or `..` segment). The server's `initiativeSlug`
// generator already guarantees this; the contract now enforces it too.
describe('initiativeSchema.slug (SEC-10)', () => {
  const base = {
    id: 'i1',
    blockId: 'b1',
    title: 'My Initiative',
    status: 'planning' as const,
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
  }

  it('accepts a lower-kebab slug', () => {
    expect(() => v.parse(initiativeSchema, { ...base, slug: 'my-initiative-2' })).not.toThrow()
  })

  it.each(['../evil', 'a/b', 'Up-Case', 'has space', 'has.dot', '-leading', ''])(
    'rejects a non-kebab slug %j',
    (slug) => {
      expect(() => v.parse(initiativeSchema, { ...base, slug })).toThrow()
    },
  )
})
