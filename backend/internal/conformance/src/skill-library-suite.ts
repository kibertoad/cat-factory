import type {
  AccountSkillRecord,
  AccountSkillRepository,
  GitHubInstallation,
  GitHubInstallationRepository,
  SkillSourceRecord,
  SkillSourceRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the repo-sourced Claude Skills library (ADR 0024; migration
// 0052). Each facade persists it in its own store (D1 on Cloudflare, Postgres via Drizzle on Node). This suite drives the SAME
// upsert → get → list → listBySource → softDelete assertions through whichever real repositories
// a runtime hands it, so a column mapped differently (the resources JSON, the pinned commit, the
// tombstone) fails a test instead of shipping — plus the account-tier installation lookup the
// library's sync and run path resolve their GitHub credential through.

export interface SkillLibraryRepos {
  skillSources: SkillSourceRepository
  accountSkills: AccountSkillRepository
  /**
   * The installation store the account-tier resolution reads. Part of THIS suite because
   * `listActiveForAccount` exists for the repo-sourced libraries: it is what the source sync and
   * the run path's resource fetch resolve their GitHub credential through, and the two runtimes
   * express its "direct binding OR one of the account's boards" narrowing in different SQL.
   */
  installations: GitHubInstallationRepository
  /** Needed to give the account a board, the second half of that narrowing. */
  workspaces: WorkspaceRepository
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

    it('looks sources up by repo across accounts, excluding tombstones (webhook fan-out)', async () => {
      const { skillSources } = makeRepos()
      const owner = `org-${scope()}`
      const repo = 'shared-skills'
      // Two accounts link the SAME repo; a push fan-out must find both.
      const accountA = scope()
      const accountB = scope()
      const base = {
        repoOwner: owner,
        repoName: repo,
        gitRef: 'HEAD',
        dirPath: '.claude/skills',
        lastSyncedCommit: null,
        lastSyncedAt: null,
        createdAt: 1_000,
        deletedAt: null,
      }
      const srcA: SkillSourceRecord = { ...base, id: `${accountA}-src`, accountId: accountA }
      const srcB: SkillSourceRecord = { ...base, id: `${accountB}-src`, accountId: accountB }
      // A different repo under the same owner must NOT match.
      const srcOther: SkillSourceRecord = {
        ...base,
        id: `${accountA}-other`,
        accountId: accountA,
        repoName: 'unrelated',
      }
      await skillSources.upsert(srcA)
      await skillSources.upsert(srcB)
      await skillSources.upsert(srcOther)

      const found = await skillSources.listByRepo(owner, repo)
      expect(found.map((s) => s.id).sort()).toEqual([srcA.id, srcB.id].sort())

      // A tombstoned source drops out of the lookup.
      await skillSources.softDelete(srcA.id, 4_000)
      expect((await skillSources.listByRepo(owner, repo)).map((s) => s.id)).toEqual([srcB.id])

      // An unlinked repo returns nothing.
      expect(await skillSources.listByRepo(owner, 'never-linked')).toEqual([])
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

    it('tombstones an entire source in one batch write (unlink)', async () => {
      const { accountSkills } = makeRepos()
      const accountId = scope()
      const sourceId = `${accountId}-src`
      const base = {
        accountId,
        name: 'S',
        description: 'd',
        instructions: 'i',
        resources: [],
        sourceId,
        sourcePath: '.claude/skills/x/SKILL.md',
        sourceSha: 'sha',
        pinnedCommit: null,
        createdAt: 1_000,
        updatedAt: 1_000,
        deletedAt: null,
      } satisfies Omit<AccountSkillRecord, 'skillId'>
      await accountSkills.upsert({ ...base, skillId: `src:${sourceId}:a` })
      await accountSkills.upsert({ ...base, skillId: `src:${sourceId}:b` })
      // A skill from a different source must be untouched.
      const otherSource = `${accountId}-other`
      await accountSkills.upsert({
        ...base,
        skillId: `src:${otherSource}:c`,
        sourceId: otherSource,
      })

      await accountSkills.softDeleteBySource(sourceId, 5_000)
      expect(await accountSkills.listBySource(sourceId)).toEqual([])
      const live = await accountSkills.listByAccount(accountId)
      expect(live.map((s) => s.skillId)).toEqual([`src:${otherSource}:c`])
      // Both retired rows carry the tombstone timestamp.
      const withDeleted = await accountSkills.listByAccount(accountId, true)
      const retired = withDeleted.filter((s) => s.sourceId === sourceId)
      expect(retired).toHaveLength(2)
      expect(retired.every((s) => s.deletedAt === 5_000)).toBe(true)
    })

    it('lists the installations an account can read repos through, and only those', async () => {
      const { installations, workspaces } = makeRepos()
      const accountId = scope()
      const foreignAccount = scope()
      let nextId = Math.floor(Math.random() * 1e6) * 100

      const board = async (id: string, owner: string | null): Promise<Workspace> => {
        const row: Workspace = {
          id,
          name: id,
          description: null,
          createdAt: 1_000,
          accountId: owner,
        }
        await workspaces.create(row, null, owner)
        return row
      }
      // `github_installations.workspace_id` is UNIQUE (one connection per board, tombstones
      // included), so an unbound row gets its own throwaway board id rather than a shared one.
      const install = async (overrides: Partial<GitHubInstallation>): Promise<number> => {
        nextId += 1
        const record: GitHubInstallation = {
          installationId: nextId,
          workspaceId: `${accountId}-ws-unbound-${nextId}`,
          accountId: null,
          accountLogin: 'octo',
          targetType: 'User',
          appId: null,
          provider: 'github',
          cachedToken: null,
          tokenExpiresAt: null,
          accessToken: null,
          createdAt: nextId,
          deletedAt: null,
          ...overrides,
        }
        await installations.upsert(record)
        return record.installationId
      }

      const mine = await board(`${accountId}-ws`, accountId)
      const theirs = await board(`${foreignAccount}-ws`, foreignAccount)
      // Bound to the account directly.
      const direct = await install({ accountId })
      // Bound only to one of the account's boards — the per-workspace PAT connect, whose row
      // carries a null (or foreign) `accountId`, which is why the board leg exists at all.
      const viaBoard = await install({ workspaceId: mine.id })
      // Neither: another tenant's board, and another tenant's account.
      await install({ workspaceId: theirs.id })
      await install({ accountId: foreignAccount })
      // A tombstoned row of the account's own must not come back.
      const retired = await install({ accountId })
      await installations.softDelete(retired, 9_000)

      const reachable = await installations.listActiveForAccount(accountId)
      // Oldest-first by (createdAt, installationId), so both runtimes pick the same row.
      expect(reachable.map((i) => i.installationId)).toEqual([direct, viaBoard])
      // An account with nothing bound to it or its boards resolves to nothing at all.
      expect(await installations.listActiveForAccount(scope())).toEqual([])
    })
  })
}
