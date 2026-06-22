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
        blockId: null,
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
      blockId: null,
      isMonorepo: false,
      syncedAt: 1000,
    })
    await repoRepo.upsertMany(ws, [base(1), base(2), base(3)])
    // A sync pass that only saw repos 1 and 2 tombstones 3.
    await repoRepo.tombstoneMissing(ws, 77, [1, 2], 2000)
    const live = await repoRepo.list(ws)
    expect(live.map((r) => r.githubId).sort()).toEqual([1, 2])
  })
})
