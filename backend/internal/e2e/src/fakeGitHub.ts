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
 * A repo of the workspace's OWN, derived deterministically from its id.
 *
 * The shared {@link E2E_REPO} cannot be imported as a service by more than one spec: a `Service` is
 * ACCOUNT-owned, so `addServiceFromRepo` dedupes by repo across every board in the account and
 * MOUNTS the existing frame instead of minting a rival. The mounted frame's block row still belongs
 * to the workspace that first imported it, so a second spec importing the same repo gets a frame it
 * cannot start runs under (`Block not found` for its own workspace). A spec that needs a
 * repo-LINKED frame of its own therefore seeds its own repo, which dedupes against nothing.
 */
export function ownRepoFor(workspaceId: string): {
  githubId: number
  owner: string
  name: string
  defaultBranch: string
} {
  // Offset well clear of both E2E_REPO's fixed id and the installation-id range.
  const githubId = 50_000_000 + (installationIdFor(workspaceId) % 8_000_000)
  return { githubId, owner: E2E_REPO.owner, name: `demo-${githubId}`, defaultBranch: 'main' }
}

/**
 * The pull request the review surfaces are driven against: the reviewed PR of a `review` task.
 * Its number is what a spec puts in the task's `taskTypeFields`, so the engine resolves the same
 * PR the fake serves a diff for.
 */
export const E2E_REVIEWED_PR = { number: 42, url: `https://github.com/octo/demo/pull/42` } as const

/**
 * The one file the reviewed PR changes, as a unified patch. It exists so a review FINDING can
 * anchor to a real diff line: the engine pre-filters the human's selection against the PR's
 * actual changed lines (`computeCommentableLines`) and folds anything out-of-diff into the summary
 * comment instead of posting it inline. The hunk starts at line 10 on the head side, so lines
 * 10-13 are commentable on `RIGHT` — which is why the review fixture anchors its blocker at 12.
 */
const E2E_PR_CHANGED_FILES: E2eChangedFile[] = [
  {
    path: 'src/auth.ts',
    previousPath: null,
    status: 'modified',
    additions: 2,
    deletions: 0,
    changes: 2,
    patch:
      '@@ -10,2 +10,4 @@\n const token = read()\n+if (!token) return null\n+log(token)\n use(token)',
  },
]

/**
 * The four OPTIONAL `GitHubClient` PR-review members, typed structurally — this test-only package
 * deliberately has no direct `@cat-factory/kernel` dependency (mirrors `fakeProfile.ts`, which
 * derives its shapes from the conformance fakes). The drift guard is the wiring site: the client
 * is passed to `buildNodeContainer`'s `overrides.githubClient`, which IS typed against the port,
 * so a member whose shape stops matching fails the e2e typecheck there.
 */
type E2eGitHubClient = FakeGitHubClient & {
  /** Reviews posted through {@link E2eGitHubClient.createReview}, newest last (debugging aid). */
  postedReviews: { number: number; input: E2eCreateReviewInput }[]
  listChangedFiles(installationId: number, ref: unknown, number: number): Promise<E2eChangedFile[]>
  getPullRequestHeadSha(
    installationId: number,
    ref: unknown,
    number: number,
  ): Promise<string | null>
  getPullRequestHeadRef(
    installationId: number,
    ref: unknown,
    number: number,
  ): Promise<string | null>
  createReview(
    installationId: number,
    ref: unknown,
    number: number,
    input: E2eCreateReviewInput,
  ): Promise<{
    comments: { posted: boolean; error?: string }[]
    bodyPosted: boolean | null
  }>
}
/** One file a PR changed, as the port's `GitHubChangedFile`. */
interface E2eChangedFile {
  path: string
  /** The pre-rename path; null unless the file was renamed. */
  previousPath: string | null
  status: string
  additions: number | null
  deletions: number | null
  changes: number | null
  patch: string | null
}
/** The review to publish, as the port's `CreateReviewInput`. */
interface E2eCreateReviewInput {
  body?: string
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
  comments: { path: string; line: number; side?: 'LEFT' | 'RIGHT'; body: string }[]
}

/**
 * The DEEP-REVIEW write capability, layered onto the shared fake client.
 *
 * The canonical `FakeGitHubClient` deliberately omits the PR-review methods: they are OPTIONAL on
 * the `GitHubClient` port and conformance asserts the unwired behaviour (a `post` resolution with
 * no review write records the selection and finishes without posting). The e2e backend wants the
 * opposite half — the real `repoFiles` → `createReview` path a human's "Post" click takes — so the
 * methods are added HERE rather than on the shared fake, which would change what conformance
 * observes.
 *
 * `createReview` reports success per comment rather than throwing, exactly as the port specifies
 * (the real client posts each inline comment individually so one un-anchorable line can't reject
 * the rest). Posted reviews are recorded in memory for debugging; the SPA assertion is the post
 * REPORT the engine derives from the returned outcomes.
 */
function withReviewCapability(client: FakeGitHubClient): E2eGitHubClient {
  const reviewCapable = client as E2eGitHubClient
  reviewCapable.postedReviews = []
  reviewCapable.listChangedFiles = async () => E2E_PR_CHANGED_FILES
  // A STABLE head sha: the engine captures it when the review dispatches and re-reads it at post
  // time, treating a change as branch drift (which would fold every finding into the summary
  // instead of anchoring it inline). A constant means "the branch did not move", so the inline
  // path is the one under test.
  reviewCapable.getPullRequestHeadSha = async () => 'sha-pr-head'
  reviewCapable.getPullRequestHeadRef = async () => 'feature/pr-head'
  reviewCapable.createReview = async (_installationId, _ref, number, input) => {
    reviewCapable.postedReviews.push({ number, input })
    return {
      comments: input.comments.map(() => ({ posted: true })),
      bodyPosted: input.body ? true : null,
    }
  }
  return reviewCapable
}

/**
 * The engine's run↔repository seam (`resolveRunRepoContext`), scoped to what a spec seeded.
 *
 * The production resolver is composed by the facade from its VCS client + the block-ancestry walk
 * (`resolveRepoTarget`), and it THROWS for a block under no repo-linked service frame — on purpose:
 * a run must never guess which repository to write to. The e2e sample board has no linked frame, so
 * wiring the production resolver here fails the POLL of every seeded run whose agent kind declares
 * repo hooks (`runRegisteredPreOps` propagates that throw by design), which is a suite-wide break
 * for one spec's benefit.
 *
 * So this resolves ONE thing: the repo a spec seeded as the workspace's own ({@link ownRepoFor}).
 * A workspace that seeded none gets `null`, which is byte-for-byte what an unwired resolver means
 * for those blocks — no existing spec changes behaviour. It deliberately does NOT walk the block
 * ancestry (conformance owns that, and asserts the throw), so the block id is unused: what it
 * unlocks is the engine's own repo-WRITE path, above all the deep review's `createReview` post,
 * which without a wired repo silently records the selection and posts nothing.
 */
export function makeE2eRunRepoResolver(
  db: DrizzleDb,
  client: FakeGitHubClient,
): (workspaceId: string, blockId: string) => Promise<E2eRunRepoContext | null> {
  const reviewCapable = client as E2eGitHubClient
  return async (workspaceId) => {
    const own = ownRepoFor(workspaceId)
    const projected = await new DrizzleRepoProjectionRepository(db).get(workspaceId, own.githubId)
    if (!projected) return null
    const ref = { owner: projected.owner, repo: projected.name }
    const installationId = projected.installationId
    return {
      // Every member delegates to the same fake client the GitHub module reads through, so a repo
      // op's write lands where a spec can observe it (`client.files` / `client.writes` /
      // `client.postedReviews`). This is the shape `makeRepoFiles` composes in production; it is
      // hand-written here because that composer lives in a package this test-only one does not
      // depend on, and the drift guard is the `overrides` boundary, which is typed against the port.
      repo: {
        getFile: (path, gitRef) => client.getFileContent(installationId, ref, path, gitRef),
        listDirectory: (path, gitRef) => client.listDirectory(installationId, ref, path, gitRef),
        headSha: (branch) => client.branchHeadSha(installationId, ref, branch),
        createBranch: (branch, fromSha) =>
          client.createBranch(installationId, ref, branch, fromSha),
        deleteBranch: (branch) => client.deleteBranch(installationId, ref, branch),
        commitFiles: (input) => client.commitFiles(installationId, ref, input),
        openPullRequest: (input) => client.openPullRequest(installationId, ref, input),
        listChangedFiles: (number) => reviewCapable.listChangedFiles(installationId, ref, number),
        pullRequestHeadSha: (number) =>
          reviewCapable.getPullRequestHeadSha(installationId, ref, number),
        pullRequestHeadRef: (number) =>
          reviewCapable.getPullRequestHeadRef(installationId, ref, number),
        createReview: (number, input) =>
          reviewCapable.createReview(installationId, ref, number, input),
      },
      baseBranch: projected.defaultBranch ?? 'main',
      repoId: String(projected.githubId),
      owner: projected.owner,
      name: projected.name,
    }
  }
}

/**
 * What the e2e resolver returns, as the kernel `RunRepoContext`. Its `repo` is derived from the
 * fake client's own method types rather than restated, so a delegate that stops matching the client
 * fails here; the PORT side is checked where the resolver is wired (`overrides` is typed against
 * `ResolveRunRepoContext`).
 */
interface E2eRunRepoContext {
  repo: {
    getFile: (path: string, gitRef?: string) => ReturnType<FakeGitHubClient['getFileContent']>
    listDirectory: (path: string, gitRef?: string) => ReturnType<FakeGitHubClient['listDirectory']>
    headSha: (branch: string) => ReturnType<FakeGitHubClient['branchHeadSha']>
    createBranch: (branch: string, fromSha: string) => Promise<void>
    deleteBranch: (branch: string) => Promise<void>
    commitFiles: (
      input: Parameters<FakeGitHubClient['commitFiles']>[2],
    ) => ReturnType<FakeGitHubClient['commitFiles']>
    openPullRequest: (
      input: Parameters<FakeGitHubClient['openPullRequest']>[2],
    ) => ReturnType<FakeGitHubClient['openPullRequest']>
    listChangedFiles: (number: number) => Promise<E2eChangedFile[]>
    pullRequestHeadSha: (number: number) => Promise<string | null>
    pullRequestHeadRef: (number: number) => Promise<string | null>
    createReview: (
      number: number,
      input: E2eCreateReviewInput,
    ) => Promise<{ comments: { posted: boolean; error?: string }[]; bodyPosted: boolean | null }>
  }
  baseBranch: string
  repoId: string
  owner: string
  name: string
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
  const client = withReviewCapability(new FakeGitHubClient())
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
    accessToken: null,
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
