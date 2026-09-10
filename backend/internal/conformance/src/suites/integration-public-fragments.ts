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

export function definePublicFragmentConformance(harness: ConformanceHarness): void {
  describe('public API: best-practice standards', () => {
    it('serves the merged catalog with each tier named, and no guidance body', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      // `read` deliberately: it is the floor the contract declares, and it sits BELOW the `write`
      // that names a standard on a create. A facade gating the list higher would publish a field
      // whose vocabulary the key filling it cannot read.
      const read = await mintPublicApiKey(app, workspace.id, 'read', 'fragments')

      const seeded = await app.call('POST', `/workspaces/${workspace.id}/prompt-fragments`, {
        id: 'org.security-review',
        title: 'Security review',
        summary: 'What a change touching auth must satisfy.',
        body: 'SECRET-GUIDANCE-BODY',
      })
      expect(seeded.status).toBe(201)

      const listed = await app.call<{ fragments: PublicPromptFragment[] }>(
        'GET',
        '/api/v1/prompt-fragments',
        undefined,
        read,
      )
      expect(listed.status).toBe(200)
      // A RELATION over a population this test does not own: the shipped catalog gains members
      // over time, so a count would fail on every ordinary addition while saying nothing about
      // what broke. What must hold whatever it contains is that the board's OWN row merged in
      // beside the built-ins, on its own tier.
      const own = listed.body.fragments.find((f) => f.fragmentId === 'org.security-review')
      expect(own).toMatchObject({ tier: 'workspace', title: 'Security review' })
      expect(listed.body.fragments.some((f) => f.tier === 'builtin')).toBe(true)
      // The projection's whole point, asserted on the SERIALISED response rather than on the
      // parsed shape: a facade handing the catalog rows straight back would publish an org's
      // authored guidance to a `read` key, and the declared type would not have changed.
      expect(JSON.stringify(listed.body)).not.toContain('SECRET-GUIDANCE-BODY')
      for (const fragment of listed.body.fragments) {
        expect(Object.keys(fragment)).not.toContain('body')
        expect(fragment.summary).not.toBe('')
      }
    })

    it('pins a listed standard on a review task, and reads back the union it froze', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'fragments')
      const seeded = await app.call('POST', `/workspaces/${workspace.id}/prompt-fragments`, {
        id: 'org.pr-checklist',
        title: 'PR checklist',
        summary: 'What every pull request is judged against here.',
        body: 'CHECKLIST',
      })
      expect(seeded.status).toBe(201)
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

    it('accepts every id the list serves, so discovery and creation cannot disagree', async () => {
      // The join, and the assertion neither endpoint can make on its own. Derived from the same
      // source the code reads rather than pinned to a literal: whatever the merged catalog holds
      // on this facade, a create naming all of it is admitted.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'fragments')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Everything')}/tasks`

      const listed = await app.call<{ fragments: PublicPromptFragment[] }>(
        'GET',
        '/api/v1/prompt-fragments',
        undefined,
        admin,
      )
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
    })
  })
}
