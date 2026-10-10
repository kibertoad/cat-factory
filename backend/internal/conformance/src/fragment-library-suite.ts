import type {
  FragmentSourceRecord,
  FragmentSourceRepository,
  PromptFragmentRecord,
  PromptFragmentRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the repo-sourced prompt-fragment library (ADR 0006). Each facade
// persists it in its own store (D1 on Cloudflare, Postgres via Drizzle on Node), and the sibling
// repo-sourced libraries (skills, foundational services) already have a suite of this shape; this
// one closes the fragment library's gap. It drives the SOURCE round trip and the two source-keyed
// reconcile methods the sync/unlink path depends on, so a column mapped differently or a tombstone
// written with the wrong predicate fails a test instead of shipping.

export interface FragmentLibraryRepos {
  sources: FragmentSourceRepository
  fragments: PromptFragmentRepository
}

/** Assert a runtime's prompt-fragment repositories behave identically to the others. */
export function defineFragmentLibrarySuite(
  name: string,
  makeRepos: () => FragmentLibraryRepos,
): void {
  describe(`[${name}] fragment-library repository parity`, () => {
    let seq = 0
    const scope = () => {
      seq += 1
      return `${name}-ws-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    const source = (ownerId: string, id: string): FragmentSourceRecord => ({
      id,
      ownerKind: 'workspace',
      ownerId,
      repoOwner: 'acme',
      repoName: 'standards',
      gitRef: 'HEAD',
      dirPath: 'standards',
      lastSyncedCommit: null,
      lastSyncedAt: null,
      createdAt: 1_000,
      deletedAt: null,
    })

    const fragment = (
      ownerId: string,
      fragmentId: string,
      overrides: Partial<PromptFragmentRecord> = {},
    ): PromptFragmentRecord => ({
      fragmentId,
      ownerKind: 'workspace',
      ownerId,
      version: '1',
      title: fragmentId,
      category: null,
      summary: '',
      body: 'guidance',
      brief: null,
      appliesTo: null,
      tags: null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      docSource: null,
      docExternalId: null,
      docViaWorkspaceId: null,
      resolvedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      deletedAt: null,
      ...overrides,
    })

    it('round-trips a fragment source and tombstones it', async () => {
      const { sources } = makeRepos()
      const ownerId = scope()
      const id = `${ownerId}-src`
      await sources.upsert(source(ownerId, id))

      expect(await sources.get(id)).toMatchObject({
        id,
        ownerKind: 'workspace',
        ownerId,
        repoOwner: 'acme',
        repoName: 'standards',
        dirPath: 'standards',
        lastSyncedCommit: null,
      })
      expect((await sources.listByOwner('workspace', ownerId)).map((s) => s.id)).toEqual([id])

      await sources.updateSyncState(id, 'commit-sha', 4_000)
      expect(await sources.get(id)).toMatchObject({ lastSyncedCommit: 'commit-sha' })

      await sources.softDelete(id, 5_000)
      expect(await sources.listByOwner('workspace', ownerId)).toEqual([])
    })

    it('tombstones every fragment a source produced, in one write', async () => {
      const { fragments } = makeRepos()
      const ownerId = scope()
      const sourceId = `${ownerId}-src`
      await fragments.upsert(
        fragment(ownerId, `src:${sourceId}:a`, {
          sourceId,
          sourcePath: 'a.md',
          sourceSha: 'sha-a',
        }),
      )
      await fragments.upsert(
        fragment(ownerId, `src:${sourceId}:b`, {
          sourceId,
          sourcePath: 'b.md',
          sourceSha: 'sha-b',
        }),
      )
      // A second source's fragment, and a hand-authored one, must BOTH survive the retirement:
      // the predicate is the source, not the owner.
      const otherSource = `${ownerId}-other`
      await fragments.upsert(
        fragment(ownerId, `src:${otherSource}:c`, {
          sourceId: otherSource,
          sourcePath: 'c.md',
          sourceSha: 'sha-c',
        }),
      )
      await fragments.upsert(fragment(ownerId, 'hand-authored'))

      expect((await fragments.listBySource(sourceId)).map((f) => f.fragmentId).sort()).toEqual([
        `src:${sourceId}:a`,
        `src:${sourceId}:b`,
      ])

      await fragments.softDeleteBySource(sourceId, 9_000)

      expect(await fragments.listBySource(sourceId)).toEqual([])
      expect(
        (await fragments.listByOwner('workspace', ownerId)).map((f) => f.fragmentId).sort(),
      ).toEqual(['hand-authored', `src:${otherSource}:c`])
      // The retired rows carry the tombstone timestamp rather than merely dropping out of the
      // live reads: the catalog merge reads them to keep an inherited fragment suppressed.
      const withDeleted = await fragments.listByOwner('workspace', ownerId, true)
      const retired = withDeleted.filter((f) => f.sourceId === sourceId)
      expect(retired).toHaveLength(2)
      expect(retired.every((f) => f.deletedAt === 9_000)).toBe(true)
    })

    it('retires nothing when a source produced no live fragments', async () => {
      const { fragments } = makeRepos()
      const ownerId = scope()
      await fragments.upsert(fragment(ownerId, 'hand-authored'))

      await fragments.softDeleteBySource(`${ownerId}-never-synced`, 9_000)

      expect((await fragments.listByOwner('workspace', ownerId)).map((f) => f.fragmentId)).toEqual([
        'hand-authored',
      ])
    })
  })
}
