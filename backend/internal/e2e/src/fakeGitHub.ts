// Turns the GitHub App integration ON in the e2e backend WITHOUT any real credentials
// (no GITHUB_APP_ID / private key / OAuth). The GitHub module is assembled inside
// `createCore` purely from the PRESENCE of its dependencies — a `GitHubClient` + the six
// projection repos + a webhook verifier — never from `config.github.enabled`, and
// `buildNodeContainer` spreads `overrides` last. So wiring the fake client + the real
// Drizzle projection repos through `overrides` (exactly what `github-projections.spec.ts`
// does) unlocks every GitHub read endpoint (connection probe, repos, branches, PRs, issues)
// and the connect / link / add-service-from-repo flows — served from Postgres projections,
// no network.
//
// A workspace becomes "connected with repos + branches" via `seedGitHubForWorkspace`, which
// writes the installation row + repo/branch projection rows DIRECTLY (the analogue of the
// per-workspace fake-agent profile channel). The read endpoints the SPA loads serve straight
// from those rows.
import { FakeGitHubClient } from '@cat-factory/conformance'
import {
  DrizzleBranchProjectionRepository,
  DrizzleGitHubInstallationRepository,
  DrizzleRepoProjectionRepository,
  type DrizzleDb,
} from '@cat-factory/node-server'

/** The deterministic repo the e2e GitHub catalog exposes (owner/name/id are fixed). */
export const E2E_REPO = {
  githubId: 424242,
  owner: 'octo',
  name: 'demo',
  defaultBranch: 'main',
} as const

/** The branches the e2e repo carries — one protected default + two feature branches usable as
 * apriori reference / working branches. */
export const E2E_BRANCHES: { name: string; protected: boolean }[] = [
  { name: 'main', protected: true },
  { name: 'feature/spike', protected: false },
  { name: 'feature/wip', protected: false },
]

/**
 * A per-workspace-unique installation id derived deterministically from the workspace id
 * (`github_installations.workspace_id` is UNIQUE and `installation_id` is the PK, so two
 * serially-run specs sharing one Postgres must not collide on either). No `Math.random` — the
 * suite must be deterministic.
 */
export function installationIdFor(workspaceId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < workspaceId.length; i++) {
    hash ^= workspaceId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // A positive 31-bit int, offset into a high range so it can't clash with any hand-picked id.
  return 1_000_000 + ((hash >>> 0) % 8_000_000)
}

/**
 * The shared, globally-catalogued `FakeGitHubClient` wired as the module's client. Its canned
 * `installations`/`repos`/`branches` back the INTERACTIVE flows (connect, available-repos,
 * link) for any workspace; the per-workspace connection + projection state that the SPA reads
 * on load is seeded separately by {@link seedGitHubForWorkspace}. Reads never mutate it, so one
 * shared instance across the serial suite is safe.
 *
 * NOTE: its canned `installationId: 1` is NOT workspace-safe — driving the real interactive
 * connect flow (instead of {@link seedGitHubForWorkspace}) would persist id `1` for every
 * workspace and collide on the installation PK. Specs must seed via `seedGitHub`, which uses the
 * per-workspace {@link installationIdFor}; the connect flow is out of scope until it needs one.
 */
export function createE2eGitHubClient(): FakeGitHubClient {
  const client = new FakeGitHubClient()
  client.installations = [
    {
      installationId: 1,
      accountLogin: E2E_REPO.owner,
      targetType: 'Organization',
      accountAvatarUrl: null,
    },
  ]
  client.repos = [
    {
      githubId: E2E_REPO.githubId,
      installationId: 1,
      owner: E2E_REPO.owner,
      name: E2E_REPO.name,
      defaultBranch: E2E_REPO.defaultBranch,
      private: false,
      isMonorepo: false,
      syncedAt: 0,
    },
  ]
  client.branches = E2E_BRANCHES.map((b) => ({
    repoGithubId: E2E_REPO.githubId,
    name: b.name,
    headSha: `sha-${b.name}`,
    protected: b.protected,
    syncedAt: 0,
  }))
  return client
}

/** The GitHub state a spec asks the control channel to seed for its workspace. */
export interface GitHubSeed {
  /** Repos to project (default: the single {@link E2E_REPO}). */
  repos?: { githubId: number; owner: string; name: string; defaultBranch?: string }[]
  /** Branches to project for {@link E2E_REPO} (default: {@link E2E_BRANCHES}). */
  branches?: { repoGithubId?: number; name: string; protected?: boolean }[]
}

/**
 * Make `workspaceId` "connected with repos + branches" by writing the installation row and the
 * repo/branch projection rows directly through the real Drizzle repos — so the SPA loads a
 * connected GitHub (the connection probe, `/github/repos`, `/github/repos/:id/branches`) with
 * no live client call and no connect flow to drive. Idempotent (upserts).
 */
export async function seedGitHubForWorkspace(
  db: DrizzleDb,
  workspaceId: string,
  seed: GitHubSeed = {},
): Promise<void> {
  const now = Date.now()
  const installationId = installationIdFor(workspaceId)
  const repos: { githubId: number; owner: string; name: string; defaultBranch?: string }[] =
    seed.repos ?? [E2E_REPO]
  const branches: { repoGithubId?: number; name: string; protected?: boolean }[] =
    seed.branches ?? E2E_BRANCHES

  await new DrizzleGitHubInstallationRepository(db).upsert({
    installationId,
    workspaceId,
    accountId: null,
    accountLogin: E2E_REPO.owner,
    targetType: 'Organization',
    appId: null,
    provider: 'github',
    cachedToken: null,
    tokenExpiresAt: null,
    createdAt: now,
    deletedAt: null,
  })

  await new DrizzleRepoProjectionRepository(db).upsertMany(
    workspaceId,
    repos.map((r) => ({
      githubId: r.githubId,
      installationId,
      owner: r.owner,
      name: r.name,
      defaultBranch: r.defaultBranch ?? 'main',
      private: false,
      isMonorepo: false,
      syncedAt: now,
    })),
  )

  await new DrizzleBranchProjectionRepository(db).upsertMany(
    workspaceId,
    branches.map((b) => ({
      repoGithubId: b.repoGithubId ?? E2E_REPO.githubId,
      name: b.name,
      headSha: `sha-${b.name}`,
      protected: b.protected ?? false,
      syncedAt: now,
    })),
  )
}
