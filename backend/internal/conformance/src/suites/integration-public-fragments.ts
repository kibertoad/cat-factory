import type { PublicPromptFragment, PublicTask } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'
import { mintPublicApiKey } from './shared.js'

// Cross-runtime conformance for the public BEST-PRACTICE-STANDARD surface:
// `GET /api/v1/prompt-fragments` and the `fragmentIds` a task may name at creation.
//
// What belongs here rather than in a unit test is the join a unit test structurally cannot see:
// the list and the create read the SAME merged tenant catalog out of each facade's own store, so
// an id this API offers has to be one it also accepts. A facade whose library resolved a different
// tier set on one of the two paths would answer a 200 and a 422 about the same standard, and the
// symptom is a caller that cannot pin the standard it was just told its board holds.
//
// Every assertion below is over a population this suite SEEDS, or is a relation over one it does
// not. The shipped catalog and whatever a deployment registers on top of it are neither this
// suite's to count nor its to require: a deployment that ships no built-in standards at all is a
// supported configuration (`fragmentLibrary.enabled` gates the whole module), so a test demanding
// a non-empty built-in pool would turn its conformance run red for a fact about the deployment
// rather than about this surface.

/** A service to file tasks under, failing HERE if the create did rather than at the first pin. */
async function createService(
  app: ConformanceApp,
  admin: Record<string, string>,
  title: string,
): Promise<string> {
  const service = await app.call<{ serviceId: string }>(
    'POST',
    '/api/v1/services',
    { title },
    admin,
  )
  expect(service.status).toBe(201)
  return service.body.serviceId
}

/** Seed a workspace-tier standard, failing HERE rather than at whatever later read misses it. */
async function seedStandard(
  app: ConformanceApp,
  workspaceId: string,
  fragment: { id: string; title: string; summary: string; body: string },
): Promise<void> {
  const seeded = await app.call('POST', `/workspaces/${workspaceId}/prompt-fragments`, fragment)
  expect(seeded.status).toBe(201)
}

export function definePublicFragmentConformance(harness: ConformanceHarness): void {
  describe('public API: best-practice standards', () => {
    it('serves the merged catalog with each tier named, and no guidance body', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      // `write` deliberately: it is the floor the contract declares, and it is the SAME scope that
      // names a standard on a create. A facade gating the list higher would publish a field whose
      // vocabulary the key filling it cannot read; one gating it lower would serve an imported
      // standard's body-derived summary to a read-only key.
      const write = await mintPublicApiKey(app, workspace.id, 'write', 'fragments')

      await seedStandard(app, workspace.id, {
        id: 'org.security-review',
        title: 'Security review',
        summary: 'What a change touching auth must satisfy.',
        body: 'SECRET-GUIDANCE-BODY',
      })

      const listed = await app.call<{
        fragments: PublicPromptFragment[]
        nextCursor: string | null
      }>('GET', '/api/v1/prompt-fragments', undefined, write)
      expect(listed.status).toBe(200)
      // A RELATION over a population this test does not own: the shipped catalog gains members
      // over time, so a count would fail on every ordinary addition while saying nothing about
      // what broke. What must hold whatever it contains is that the board's OWN row merged in
      // beside whatever else the deployment resolves, on its own tier.
      const own = listed.body.fragments.find((f) => f.fragmentId === 'org.security-review')
      expect(own).toMatchObject({ tier: 'workspace', title: 'Security review' })
      expect(own?.summary).toBe('What a change touching auth must satisfy.')
      // The projection's whole point, asserted on the SERIALISED response rather than on the
      // parsed shape: a facade handing the catalog rows straight back would publish an org's
      // authored guidance to any key that can list, and the declared type would not have changed.
      expect(JSON.stringify(listed.body)).not.toContain('SECRET-GUIDANCE-BODY')
      for (const fragment of listed.body.fragments) {
        expect(Object.keys(fragment)).not.toContain('body')
      }
      // Ordering is by the id, which is what makes the keyset cursor sound. Asserted as a relation
      // over whatever the facade merged, since the ids themselves are not this suite's to know.
      const ids = listed.body.fragments.map((f) => f.fragmentId)
      expect(ids).toEqual([...ids].sort())
    })

    it('pages the catalog by id, and a cursor past the end is an empty last page', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const write = await mintPublicApiKey(app, workspace.id, 'write', 'fragments')
      // Three ids this suite OWNS, chosen to sort adjacently so a page of one walks them in turn
      // whatever else the deployment's own catalog holds.
      for (const suffix of ['a', 'b', 'c']) {
        await seedStandard(app, workspace.id, {
          id: `zz.paged-${suffix}`,
          title: `Paged ${suffix}`,
          summary: `Standard ${suffix}.`,
          body: `BODY ${suffix}`,
        })
      }

      const first = await app.call<{
        fragments: PublicPromptFragment[]
        nextCursor: string | null
      }>('GET', '/api/v1/prompt-fragments?limit=1', undefined, write)
      expect(first.status).toBe(200)
      expect(first.body.fragments).toHaveLength(1)
      expect(first.body.nextCursor).toBeTruthy()

      // Walk to the end one row at a time, then assert the walk saw each SEEDED standard exactly
      // once and in id order: a page that repeats or skips a row is what an unstable sort or a
      // cursor minted from something other than the sort key produces, and neither is visible to a
      // single-page assertion. The whole walk is a relation over whatever the facade merged; only
      // the three `zz.paged-*` rows are this suite's to name.
      const walked: string[] = []
      let cursor: string | null = first.body.nextCursor
      walked.push(...first.body.fragments.map((f) => f.fragmentId))
      // Bounded by the ceiling one page may return, which is also the most pages a catalog reached
      // one row at a time can need before this suite would rather fail than hang.
      for (let guard = 0; guard < 1000 && cursor; guard++) {
        const next = await app.call<{
          fragments: PublicPromptFragment[]
          nextCursor: string | null
        }>(
          'GET',
          `/api/v1/prompt-fragments?limit=1&cursor=${encodeURIComponent(cursor)}`,
          undefined,
          write,
        )
        walked.push(...next.body.fragments.map((f) => f.fragmentId))
        cursor = next.body.nextCursor
      }
      expect(cursor).toBeNull()
      expect(walked.filter((id) => id.startsWith('zz.paged-'))).toEqual([
        'zz.paged-a',
        'zz.paged-b',
        'zz.paged-c',
      ])
      expect(new Set(walked).size).toBe(walked.length)

      // A malformed cursor is a 400, never a silent page 1: a client paging on a corrupted cursor
      // would otherwise loop over the first page forever without ever seeing an error.
      const malformed = await app.call(
        'GET',
        '/api/v1/prompt-fragments?cursor=not-a-cursor%21',
        undefined,
        write,
      )
      expect(malformed.status).toBe(400)
    })

    it('pins a listed standard on a task, and reads back the union it froze', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'fragments')
      await seedStandard(app, workspace.id, {
        id: 'org.pr-checklist',
        title: 'PR checklist',
        summary: 'What every pull request is judged against here.',
        body: 'CHECKLIST',
      })
      const tasks = `/api/v1/services/${await createService(app, admin, 'Standards')}/tasks`

      const created = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Review the auth change', fragmentIds: ['org.pr-checklist'] },
        admin,
      )
      expect(created.status).toBe(201)
      // Both halves, for the reason the preset suite asserts both: a 201 alone would pass on a
      // route that accepted the list and dropped it, which is a review folding nothing and
      // reading afterwards exactly like a review nobody asked to be judged against anything.
      expect(created.body.fragmentIds).toEqual(['org.pr-checklist'])
      const reread = await app.call<PublicTask>(
        'GET',
        `/api/v1/tasks/${created.body.taskId}`,
        undefined,
        admin,
      )
      expect(reread.body.fragmentIds).toEqual(['org.pr-checklist'])

      // What a task holds is the UNION the creation froze, never an echo of the caller's list.
      // With no service standards to inherit and no defaults for this type, a create that named
      // none comes back empty, which is what makes the pinned case above readable as a pin.
      const unpinned = await app.call<PublicTask>('POST', tasks, { title: 'Nothing pinned' }, admin)
      expect(unpinned.body.fragmentIds).toEqual([])

      // A repeated id is one standard, so the frozen set carries it once. The request cap counts
      // distinct ids for the same reason.
      const repeated = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Said twice', fragmentIds: ['org.pr-checklist', 'org.pr-checklist'] },
        admin,
      )
      expect(repeated.body.fragmentIds).toEqual(['org.pr-checklist'])
    })

    it('clears the inherited standards on an empty array, and keeps the task type its own', async () => {
      // The distinction the contract turns on and a caller cannot see from the request: `[]`
      // clears what the SERVICE passed down, and the chosen task type's own defaults still apply
      // on top. `document` is the built-in type that has any, so it is the only one that can tell
      // "cleared the inheritance" apart from "held to nothing".
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'fragments')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Docs')}/tasks`

      const listed = await app.call<{ fragments: PublicPromptFragment[] }>(
        'GET',
        '/api/v1/prompt-fragments',
        undefined,
        admin,
      )
      const documentDefaults = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Write the runbook', taskType: 'document', fragmentIds: [] },
        admin,
      )
      expect(documentDefaults.status).toBe(201)
      // Derived from what this facade actually resolves rather than pinned to the shipped ids: what
      // must hold is that a `document` task cleared to nothing still carries the type's defaults,
      // and that every id it carries is one the catalog serves.
      const served = new Set(listed.body.fragments.map((f) => f.fragmentId))
      expect(documentDefaults.body.fragmentIds.length).toBeGreaterThan(0)
      for (const id of documentDefaults.body.fragmentIds) expect(served.has(id)).toBe(true)

      // The same type with nothing cleared: `[]` may not ADD anything, so the two sets match.
      const inherited = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Write the other runbook', taskType: 'document' },
        admin,
      )
      expect([...inherited.body.fragmentIds].sort()).toEqual(
        [...documentDefaults.body.fragmentIds].sort(),
      )
    })

    it('refuses an unknown standard, naming every one that missed, before the board changes', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'fragments')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Typos')}/tasks`

      const refused = await app.call<{
        error: { details?: { reason?: string; fragmentIds?: string[] } }
      }>('POST', tasks, { title: 'Ghost', fragmentIds: ['org.nope', 'org.also-nope'] }, admin)
      expect(refused.status).toBe(422)
      expect(refused.body.error.details?.reason).toBe('prompt_fragment_not_found')
      // EVERY id that missed, not the first: a caller assembling a selection from configuration
      // fixes them all in one round trip, or discovers them one deploy at a time.
      expect(refused.body.error.details?.fragmentIds).toEqual(['org.nope', 'org.also-nope'])

      // The ordering rule the route is built on (`taskCreation.ts`): everything refusable is
      // refused before the write. A partial creation would be invisible to the caller, which got
      // an error, and permanent on the board.
      const listed = await app.call<{ tasks: PublicTask[] }>('GET', tasks, undefined, admin)
      expect(listed.body.tasks).toHaveLength(0)
    })

    it('answers the container 404 before the standards 422', async () => {
      // Which refusal a caller READS when both apply. Every other check on the route presumes a
      // service that exists, so a `422 prompt_fragment_not_found` here would tell an integrator
      // its `serviceId` was fine and send it to fix the wrong end of a two-part typo.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'fragments')

      const refused = await app.call(
        'POST',
        '/api/v1/services/blk_no_such_service/tasks',
        { title: 'Ghost', fragmentIds: ['org.nope'] },
        admin,
      )
      expect(refused.status).toBe(404)
    })

    it('accepts every id the list serves, so discovery and creation cannot disagree', async () => {
      // The join, and the assertion neither endpoint can make on its own. Derived from the same
      // source the code reads rather than pinned to a literal: whatever the merged catalog holds
      // on this facade, a create naming all of it is admitted.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'fragments')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Everything')}/tasks`
      // Seeded so the population is never empty whatever the deployment ships. One page is at most
      // `MAX_TASK_FRAGMENTS` rows, so a page always fits in one create.
      const longId = `org.${'deeply-nested-guideline-'.repeat(6)}end`
      await seedStandard(app, workspace.id, {
        id: longId,
        title: 'A standard with a long id',
        summary: 'Named from a deep path.',
        body: 'LONG',
      })

      const listed = await app.call<{
        fragments: PublicPromptFragment[]
        nextCursor: string | null
      }>('GET', '/api/v1/prompt-fragments', undefined, admin)
      const everything = listed.body.fragments.map((fragment) => fragment.fragmentId)
      expect(everything.length).toBeGreaterThan(0)

      const created = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Held to everything', fragmentIds: everything },
        admin,
      )
      expect(created.status).toBe(201)
      expect([...created.body.fragmentIds].sort()).toEqual([...everything].sort())

      // The LENGTH half of the same join, asserted on the seeded id directly so it does not depend
      // on which page that id lands on. A sourced standard's id is `src:<sourceId>:<slugified
      // path>`, so the ids this catalog publishes run well past what a cap invented at the create
      // door would guess at, and the failure of a disagreement is a generic length `422` rather
      // than the `prompt_fragment_not_found` a caller could act on.
      const long = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Held to the long one', fragmentIds: [longId] },
        admin,
      )
      expect(long.status).toBe(201)
      expect(long.body.fragmentIds).toEqual([longId])
    })
  })
}
