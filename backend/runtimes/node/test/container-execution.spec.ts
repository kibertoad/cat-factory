import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DrizzleDb } from '../src/db/client.js'
import { blocks, githubRepos } from '../src/db/schema.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
  buildNodeResolveRepoTarget,
} from '../src/repositories/containerExecution.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { SystemClock } from '../src/runtime.js'
import { setupTestDb } from './harness.js'

// The Postgres persistence + repo-target resolution the Node container-agent
// execution path relies on, mirroring the Worker's D1 repositories + buildResolveTransport.
// Runs against the real Postgres the rest of the Node suite uses.

describe('container-execution persistence (Postgres)', () => {
  let db: DrizzleDb

  beforeAll(async () => {
    db = await setupTestDb()
  })

  // Each test scopes its rows to a fresh workspace id so the shared DB stays isolated.
  const ws = () => `ws_${randomUUID()}`

  describe('DrizzleRunnerPoolConnectionRepository', () => {
    it('round-trips a connection and tombstones it on soft delete', async () => {
      const repo = new DrizzleRunnerPoolConnectionRepository(db)
      const workspaceId = ws()
      await repo.upsert({
        workspaceId,
        providerId: 'acme-pool',
        label: 'Acme',
        baseUrl: 'https://pool.test/api',
        manifestJson: '{"providerId":"acme-pool"}',
        secretsCipher: 'v1.cipher',
        createdAt: 1000,
        deletedAt: null,
      })
      const got = await repo.getByWorkspace(workspaceId)
      expect(got?.providerId).toBe('acme-pool')
      expect(got?.secretsCipher).toBe('v1.cipher')

      await repo.softDelete(workspaceId, 2000)
      expect(await repo.getByWorkspace(workspaceId)).toBeNull()
    })

    it('replaces a workspace’s prior pool on re-register (single live pool)', async () => {
      const repo = new DrizzleRunnerPoolConnectionRepository(db)
      const workspaceId = ws()
      const base = {
        workspaceId,
        label: 'L',
        baseUrl: 'https://p',
        manifestJson: '{}',
        secretsCipher: 'c',
        createdAt: 1,
        deletedAt: null,
      }
      await repo.upsert({ ...base, providerId: 'first' })
      await repo.upsert({ ...base, providerId: 'second' })
      const got = await repo.getByWorkspace(workspaceId)
      expect(got?.providerId).toBe('second')
    })
  })

  describe('DrizzleGitHubInstallationRepository', () => {
    it('round-trips an installation by id and by workspace', async () => {
      const repo = new DrizzleGitHubInstallationRepository(db)
      const workspaceId = ws()
      await repo.upsert({
        installationId: 4242,
        workspaceId,
        accountId: null,
        accountLogin: 'octo',
        targetType: 'Organization',
        appId: null,
        cachedToken: null,
        tokenExpiresAt: null,
        createdAt: 1,
        deletedAt: null,
      })
      expect((await repo.getByInstallationId(4242))?.accountLogin).toBe('octo')
      expect((await repo.getByWorkspace(workspaceId))?.installationId).toBe(4242)

      await repo.softDelete(4242, 5)
      expect(await repo.getByWorkspace(workspaceId)).toBeNull()
    })
  })

  describe('buildNodeResolveRepoTarget', () => {
    it('resolves the repo linked to the service frame a block sits under', async () => {
      const workspaceId = ws()
      const installations = new DrizzleGitHubInstallationRepository(db)
      const { blockRepository } = createDrizzleRepositories(db, new SystemClock())

      await installations.upsert({
        installationId: 77,
        workspaceId,
        accountId: null,
        accountLogin: 'octo',
        targetType: 'Organization',
        appId: null,
        cachedToken: null,
        tokenExpiresAt: null,
        createdAt: 1,
        deletedAt: null,
      })
      // A service frame and a task nested under it.
      await db.insert(blocks).values([
        {
          workspace_id: workspaceId,
          id: 'frame1',
          title: 'Svc',
          type: 'service',
          status: 'todo',
          level: 'frame',
        },
        {
          workspace_id: workspaceId,
          id: 'task1',
          title: 'Task',
          type: 'task',
          status: 'todo',
          level: 'task',
          parent_id: 'frame1',
        },
      ])
      // The repo projection row links to the frame.
      await db.insert(githubRepos).values({
        workspace_id: workspaceId,
        github_id: 999,
        installation_id: 77,
        owner: 'octo',
        name: 'widget',
        default_branch: 'main',
        private: 1,
        block_id: 'frame1',
        synced_at: 1,
      })

      const resolve = buildNodeResolveRepoTarget(db, installations, blockRepository)
      const target = await resolve(workspaceId, 'task1')
      expect(target).toEqual({
        installationId: 77,
        owner: 'octo',
        name: 'widget',
        baseBranch: 'main',
      })
    })

    it('returns null when GitHub is not connected', async () => {
      const workspaceId = ws()
      const installations = new DrizzleGitHubInstallationRepository(db)
      const { blockRepository } = createDrizzleRepositories(db, new SystemClock())
      const resolve = buildNodeResolveRepoTarget(db, installations, blockRepository)
      expect(await resolve(workspaceId, 'whatever')).toBeNull()
    })

    it('throws when the block is not under a repo-linked service', async () => {
      const workspaceId = ws()
      const installations = new DrizzleGitHubInstallationRepository(db)
      const { blockRepository } = createDrizzleRepositories(db, new SystemClock())
      await installations.upsert({
        installationId: 88,
        workspaceId,
        accountId: null,
        accountLogin: 'octo',
        targetType: 'User',
        appId: null,
        cachedToken: null,
        tokenExpiresAt: null,
        createdAt: 1,
        deletedAt: null,
      })
      await db.insert(blocks).values({
        workspace_id: workspaceId,
        id: 'orphan',
        title: 'Orphan',
        type: 'task',
        status: 'todo',
        level: 'task',
      })
      // A repo exists but is linked to a different (absent) block, so the orphan
      // task resolves to no repo.
      await db.insert(githubRepos).values({
        workspace_id: workspaceId,
        github_id: 1234,
        installation_id: 88,
        owner: 'octo',
        name: 'other',
        default_branch: 'main',
        private: 0,
        block_id: 'some-other-frame',
        synced_at: 1,
      })
      const resolve = buildNodeResolveRepoTarget(db, installations, blockRepository)
      await expect(resolve(workspaceId, 'orphan')).rejects.toThrow(/not under a service linked/)
    })
  })
})
