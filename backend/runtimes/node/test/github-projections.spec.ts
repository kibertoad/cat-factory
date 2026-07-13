import { beforeAll, describe, expect, it } from 'vitest'
import type {
  GitHubClient,
  SyncCursor,
  WebhookVerifier,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { buildNodeContainer } from '../src/container.js'
import type { DrizzleDb } from '../src/db/client.js'
import {
  DrizzleBranchProjectionRepository,
  DrizzleCheckRunProjectionRepository,
  DrizzleCommitProjectionRepository,
  DrizzleIssueProjectionRepository,
  DrizzlePullRequestProjectionRepository,
  DrizzleRepoProjectionRepository,
} from '../src/repositories/github.js'
import { DrizzleGitHubInstallationRepository } from '../src/repositories/containerExecution.js'
import { createApp } from '../src/server.js'
import { setupTestDb } from './harness.js'

// The Node facade's Drizzle GitHub projection repositories + the wired GitHub
// sync/webhook module — the Node analogue of the Worker's github specs. It proves
// the projections persist + read back identically (the inline sync writes through
// these repos) without a real GitHub App: the module is wired with a throwing fake
// client (the read path never touches it) and the real Drizzle projection repos.

const BASE = 'https://cat-factory.test'
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_DEV_OPEN: 'true',
  ENVIRONMENT: 'test',
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
}

// A GitHubClient whose every method throws — the projection READS serve from the
// repos, so the client must never be called. If a read path regresses into a live
// call, the test fails loudly here instead of silently hitting the network.
const throwingClient = new Proxy(
  {},
  {
    get(_t, prop) {
      return () => {
        throw new Error(`FakeGitHubClient.${String(prop)} should not be called in this test`)
      }
    },
  },
) as unknown as GitHubClient

const passVerifier: WebhookVerifier = { verify: async () => true }

function makeApp(db: DrizzleDb) {
  const overrides: Partial<CoreDependencies> = {
    githubClient: throwingClient,
    githubInstallationRepository: new DrizzleGitHubInstallationRepository(db),
    repoProjectionRepository: new DrizzleRepoProjectionRepository(db),
    branchProjectionRepository: new DrizzleBranchProjectionRepository(db),
    pullRequestProjectionRepository: new DrizzlePullRequestProjectionRepository(db),
    issueProjectionRepository: new DrizzleIssueProjectionRepository(db),
    commitProjectionRepository: new DrizzleCommitProjectionRepository(db),
    checkRunProjectionRepository: new DrizzleCheckRunProjectionRepository(db),
    webhookVerifier: passVerifier,
  }
  const container = buildNodeContainer({ db, env: TEST_ENV, overrides })
  const app = createApp(container, TEST_ENV)
  return async function call<T>(method: string, path: string, body?: unknown) {
    const res = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }
}

describe('GitHub projections (Postgres)', () => {
  let db: DrizzleDb
  let call: ReturnType<typeof makeApp>

  beforeAll(async () => {
    db = await setupTestDb()
    call = makeApp(db)
  })

  it('persists and reads repo / branch / PR / issue projections', async () => {
    const { body: snapshot } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const ws = snapshot.workspace.id
    const repoGithubId = 4242

    // Seed projections directly through the Drizzle repos (what the inline sync writes).
    await new DrizzleRepoProjectionRepository(db).upsertMany(ws, [
      {
        githubId: repoGithubId,
        installationId: 9,
        owner: 'octo',
        name: 'demo',
        defaultBranch: 'main',
        private: false,
        isMonorepo: false,
        syncedAt: 1000,
      },
    ])
    await new DrizzleBranchProjectionRepository(db).upsertMany(ws, [
      { repoGithubId, name: 'main', headSha: 'abc123', protected: true, syncedAt: 1000 },
    ])
    await new DrizzlePullRequestProjectionRepository(db).upsertMany(ws, [
      {
        repoGithubId,
        number: 7,
        githubId: 700,
        title: 'Add SSO',
        state: 'open',
        headRef: 'feat/sso',
        baseRef: 'main',
        headSha: 'abc123',
        merged: false,
        author: 'octocat',
        updatedAt: 2000,
        syncedAt: 1000,
      },
    ])
    await new DrizzleIssueProjectionRepository(db).upsertMany(ws, [
      {
        repoGithubId,
        number: 3,
        githubId: 300,
        title: 'Bug: login fails',
        state: 'open',
        author: 'octocat',
        labels: ['bug', 'p1'],
        updatedAt: 2000,
        syncedAt: 1000,
      },
    ])

    // The module is wired (a 200, not a 503), and reads serve from the projections.
    const repos = await call<{ githubId: number; name: string }[]>(
      'GET',
      `/workspaces/${ws}/github/repos`,
    )
    expect(repos.status).toBe(200)
    expect(repos.body.map((r) => r.githubId)).toEqual([repoGithubId])

    const branches = await call<{ name: string; protected: boolean }[]>(
      'GET',
      `/workspaces/${ws}/github/repos/${repoGithubId}/branches`,
    )
    expect(branches.body.map((b) => b.name)).toEqual(['main'])
    expect(branches.body[0]!.protected).toBe(true)

    const pulls = await call<{ number: number; merged: boolean }[]>(
      'GET',
      `/workspaces/${ws}/github/pulls`,
    )
    expect(pulls.body.map((p) => p.number)).toEqual([7])
    expect(pulls.body[0]!.merged).toBe(false)

    const issues = await call<{ number: number; labels: string[] }[]>(
      'GET',
      `/workspaces/${ws}/github/issues`,
    )
    expect(issues.body.map((i) => i.number)).toEqual([3])
    expect(issues.body[0]!.labels).toEqual(['bug', 'p1'])
  })

  it('round-trips check runs (the CI gate read) and sync cursors', async () => {
    const { body: snapshot } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const ws = snapshot.workspace.id
    const repoGithubId = 555

    const checks = new DrizzleCheckRunProjectionRepository(db)
    await checks.upsertMany(ws, [
      {
        repoGithubId,
        githubId: 1,
        headSha: 'deadbeef',
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        syncedAt: 1000,
      },
    ])
    const bySha = await checks.listBySha(ws, repoGithubId, 'deadbeef')
    expect(bySha).toHaveLength(1)
    expect(bySha[0]!.conclusion).toBe('success')

    // Sync cursors are keyed by (installation, repo, kind) — upsert replaces in place.
    const repoRepo = new DrizzleRepoProjectionRepository(db)
    const cursor: SyncCursor = {
      etag: 'W/"v1"',
      lastSyncedAt: 1000,
      sinceIso: '2026-01-01T00:00:00Z',
    }
    await repoRepo.setCursor(9, repoGithubId, 'pulls', cursor)
    expect(await repoRepo.getCursor(9, repoGithubId, 'pulls')).toEqual(cursor)
    await repoRepo.setCursor(9, repoGithubId, 'pulls', { ...cursor, etag: 'W/"v2"' })
    expect((await repoRepo.getCursor(9, repoGithubId, 'pulls'))?.etag).toBe('W/"v2"')
  })

  it('tombstones repos missing from a sync pass', async () => {
    const { body: snapshot } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const ws = snapshot.workspace.id
    const repoRepo = new DrizzleRepoProjectionRepository(db)
    const base = (githubId: number) => ({
      githubId,
      installationId: 77,
      owner: 'octo',
      name: `r${githubId}`,
      defaultBranch: 'main',
      private: false,
      isMonorepo: false,
      syncedAt: 1000,
    })
    await repoRepo.upsertMany(ws, [base(1), base(2), base(3)])
    // A sync pass that only saw repos 1 and 2 tombstones 3.
    await repoRepo.tombstoneMissing(ws, 77, [1, 2], 2000)
    const live = await repoRepo.list(ws)
    expect(live.map((r) => r.githubId).sort()).toEqual([1, 2])
  })

  it('listByInstallation batches the delegation-mint scoping read across workspaces (live rows only)', async () => {
    const { body: snapA } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const { body: snapB } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const wsA = snapA.workspace.id
    const wsB = snapB.workspace.id
    const repoRepo = new DrizzleRepoProjectionRepository(db)
    const base = (githubId: number, installationId: number, linkedVia?: 'app' | 'user_pat') => ({
      githubId,
      installationId,
      owner: 'octo',
      name: `r${githubId}`,
      defaultBranch: 'main',
      private: false,
      isMonorepo: false,
      ...(linkedVia ? { linkedVia } : {}),
      syncedAt: 1000,
    })
    // Installation 88 links repos in TWO workspaces (11 shared by both), one of them via a
    // member PAT; installation 99 is a different installation; repo 13 gets tombstoned.
    await repoRepo.upsertMany(wsA, [base(11, 88), base(12, 88, 'user_pat'), base(13, 88)])
    await repoRepo.upsertMany(wsB, [base(11, 88), base(21, 99)])
    await repoRepo.tombstoneMissing(wsA, 88, [11, 12], 2000)

    // One query across the installation's workspaces: live rows only, other installations
    // excluded; the shared repo returns one row PER workspace (callers dedupe by githubId),
    // and `linkedVia` survives so the caller can drop PAT-only rows.
    const rows = await repoRepo.listByInstallation(88)
    expect(rows.map((r) => r.githubId).sort()).toEqual([11, 11, 12])
    expect(rows.find((r) => r.githubId === 12)?.linkedVia).toBe('user_pat')
    expect(await repoRepo.listByInstallation(12345)).toEqual([])
  })

  it('multi-row upserts update in place (last duplicate wins) and list reads order/limit in SQL', async () => {
    const { body: snapshot } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const ws = snapshot.workspace.id
    const repoGithubId = 8080
    const commits = new DrizzleCommitProjectionRepository(db)
    const commit = (sha: string, authoredAt: number | null, message = sha) => ({
      repoGithubId,
      sha,
      message,
      author: 'octocat',
      authoredAt,
      syncedAt: 1000,
    })

    // One page lands as chunked multi-row INSERT ... ON CONFLICT; a duplicate sha within
    // the page must not blow up ("cannot affect row a second time") — the last one wins,
    // matching the former row-at-a-time loop.
    await commits.upsertMany(ws, [
      commit('sha_a', 3000, 'first write'),
      commit('sha_b', 1000),
      commit('sha_a', 3000, 'last write wins'),
      commit('sha_null', null),
    ])
    // A second page updates an existing row in place.
    await commits.upsertMany(ws, [commit('sha_b', 2000, 'updated'), commit('sha_c', 4000)])

    // ORDER BY authored_at DESC + LIMIT run in SQL, with NULLs last (D1/SQLite parity).
    const top2 = await commits.listByRepo(ws, repoGithubId, 2)
    expect(top2.map((c) => c.sha)).toEqual(['sha_c', 'sha_a'])
    expect(top2[1]?.message).toBe('last write wins')
    const all = await commits.listByRepo(ws, repoGithubId)
    expect(all.map((c) => c.sha)).toEqual(['sha_c', 'sha_a', 'sha_b', 'sha_null'])
    expect(all.find((c) => c.sha === 'sha_b')?.message).toBe('updated')
  })

  it('listByInstallationIds batches the connect-UI annotation read (tombstones included)', async () => {
    const { body: snapshot } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const ws = snapshot.workspace.id
    const repo = new DrizzleGitHubInstallationRepository(db)
    const installation = (installationId: number) => ({
      installationId,
      // github_installations.workspace_id is UNIQUE — one binding per workspace.
      workspaceId: `${ws}_${installationId}`,
      accountId: null,
      accountLogin: 'octo',
      targetType: 'Organization' as const,
      appId: null,
      cachedToken: null,
      tokenExpiresAt: null,
      createdAt: 1000,
      deletedAt: null,
    })
    await repo.upsert(installation(9001))
    await repo.upsert(installation(9002))
    await repo.softDelete(9002, 2000)

    // The batched read mirrors the point read: tombstoned rows included, unknown ids absent.
    const found = await repo.listByInstallationIds([9001, 9002, 9999])
    expect(found.map((i) => i.installationId).sort()).toEqual([9001, 9002])
    expect(found.find((i) => i.installationId === 9002)?.deletedAt).toBe(2000)
    expect(await repo.listByInstallationIds([])).toEqual([])
  })
})
