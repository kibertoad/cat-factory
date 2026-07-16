import type {
  AccountSkillRecord,
  AccountSkillRepository,
  SkillSourceRecord,
  SkillSourceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the repo-sourced Claude Skills library (docs/initiatives/
// repo-skills.md; migration 0052). Each facade persists it in its own store (D1 on
// Cloudflare, Postgres via Drizzle on Node). This suite drives the SAME upsert → get →
// list → listBySource → softDelete assertions through whichever real repositories a
// runtime hands it, so a column mapped differently (the resources JSON, the pinned
// commit, the tombstone) fails a test instead of shipping.

export interface SkillLibraryRepos {
  skillSources: SkillSourceRepository
  accountSkills: AccountSkillRepository
}

/** Assert a runtime's skill repositories behave identically to the others. */
export function defineSkillLibrarySuite(name: string, makeRepos: () => SkillLibraryRepos): void {
  describe(`[${name}] skill-library repository parity`, () => {
    let seq = 0
    const scope = () => {
      seq += 1
      return `${name}-acct-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('round-trips a skill source and lists/tombstones by account', async () => {
      const { skillSources } = makeRepos()
      const accountId = scope()
      const source: SkillSourceRecord = {
        id: `${accountId}-src`,
        accountId,
        repoOwner: 'acme',
        repoName: 'skills',
        gitRef: 'HEAD',
        dirPath: '.claude/skills',
        lastSyncedCommit: null,
        lastSyncedAt: null,
        createdAt: 1_000,
        deletedAt: null,
      }
      await skillSources.upsert(source)

      expect(await skillSources.get(source.id)).toEqual(source)
      expect(await skillSources.listByAccount(accountId)).toEqual([source])
      // Another account's sources are invisible.
      expect(await skillSources.listByAccount(scope())).toEqual([])

      await skillSources.updateSyncState(source.id, 'commit-abc', 2_000)
      const synced = await skillSources.get(source.id)
      expect(synced?.lastSyncedCommit).toBe('commit-abc')
      expect(synced?.lastSyncedAt).toBe(2_000)

      await skillSources.softDelete(source.id, 3_000)
      expect(await skillSources.listByAccount(accountId)).toEqual([])
      expect((await skillSources.get(source.id))?.deletedAt).toBe(3_000)
    })

    it('round-trips a skill (resources + pinned commit) and lists by source', async () => {
      const { accountSkills } = makeRepos()
      const accountId = scope()
      const sourceId = `${accountId}-src`
      const skill: AccountSkillRecord = {
        skillId: `src:${sourceId}:bug-triage`,
        accountId,
        name: 'Bug triage',
        description: 'Triage an incoming bug report',
        instructions: '- Reproduce\n- Classify\n- Route',
        resources: [
          { path: '.claude/skills/bug-triage/templates/report.md', sha: 'sha-r', size: 128 },
          { path: '.claude/skills/bug-triage/checklist.md', sha: 'sha-c', size: 64 },
        ],
        sourceId,
        sourcePath: '.claude/skills/bug-triage/SKILL.md',
        sourceSha: 'sha-manifest',
        pinnedCommit: 'commit-1',
        createdAt: 1_000,
        updatedAt: 1_000,
        deletedAt: null,
      }
      await accountSkills.upsert(skill)

      // The resources JSON + pinned commit + all scalar columns round-trip byte-for-byte.
      expect(await accountSkills.get(accountId, skill.skillId)).toEqual(skill)
      expect(await accountSkills.listByAccount(accountId)).toEqual([skill])
      expect(await accountSkills.listBySource(sourceId)).toEqual([skill])

      // Upsert updates in place (a resource-only change), same primary key.
      const updated: AccountSkillRecord = {
        ...skill,
        resources: [{ path: '.claude/skills/bug-triage/checklist.md', sha: 'sha-c2', size: 70 }],
        pinnedCommit: 'commit-2',
        updatedAt: 2_000,
      }
      await accountSkills.upsert(updated)
      expect(await accountSkills.get(accountId, skill.skillId)).toEqual(updated)

      // Tombstone: dropped from the default list + listBySource, visible with includeDeleted.
      await accountSkills.softDelete(accountId, skill.skillId, 3_000)
      expect(await accountSkills.listByAccount(accountId)).toEqual([])
      expect(await accountSkills.listBySource(sourceId)).toEqual([])
      const withDeleted = await accountSkills.listByAccount(accountId, true)
      expect(withDeleted).toHaveLength(1)
      expect(withDeleted[0]?.deletedAt).toBe(3_000)
    })

    it('defaults an absent resource manifest to an empty array', async () => {
      const { accountSkills } = makeRepos()
      const accountId = scope()
      const skill: AccountSkillRecord = {
        skillId: `src:${accountId}-src:no-resources`,
        accountId,
        name: 'Lean skill',
        description: 'No sibling resources',
        instructions: 'Just instructions',
        resources: [],
        sourceId: `${accountId}-src`,
        sourcePath: '.claude/skills/lean/SKILL.md',
        sourceSha: 'sha-lean',
        pinnedCommit: null,
        createdAt: 1_000,
        updatedAt: 1_000,
        deletedAt: null,
      }
      await accountSkills.upsert(skill)
      const read = await accountSkills.get(accountId, skill.skillId)
      expect(read?.resources).toEqual([])
      expect(read?.pinnedCommit).toBeNull()
    })
  })
}
