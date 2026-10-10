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
  // A positive 31-bit int, offset into a high range so it can't clash with any hand-picked id.
  return 1_000_000 + (fnv1a(workspaceId) % 8_000_000)
}

/** FNV-1a over a string, as an unsigned 32-bit int. The one hash both id derivations read. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
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
  // Offset well clear of both E2E_REPO's fixed id and the installation-id range, and hashed off a
  // SALTED workspace id over a wide range: a collision between two workspaces would hand the
  // second one the first one's frame, which is the exact failure this derivation exists to avoid,
  // so it does not inherit the installation id's narrower 8M space.
  const githubId = 50_000_000 + (fnv1a(`own-repo:${workspaceId}`) % 900_000_000)
  return { githubId, owner: E2E_REPO.owner, name: `demo-${githubId}`, defaultBranch: 'main' }
}

/**
 * The pull request every review surface is driven against: the reviewed PR of a `review` task.
 *
 * A spec puts {@link E2E_REVIEWED_PR.number} in the task's `taskTypeFields`, and the fake answers
 * for THIS number only (an unknown number reads as a PR that does not exist), so a run that
 * resolved the wrong PR fails instead of quietly reviewing the same canned diff. The head ref/sha
 * are fixture-wide too: `getPullRequest`, `getPullRequestHeadRef` and `getPullRequestHeadSha` all
 * report them, so the engine's drift check sees a branch that did not move and takes the INLINE
 * path rather than folding every finding into the summary.
 */
export const E2E_REVIEWED_PR = {
  number: 42,
  headRef: 'feature/pr-head',
  headSha: 'sha-pr-head',
} as const

/** The reviewed PR's canonical web URL for a repo, which is what task creation canonicalises to. */
function reviewedPrUrl(ref: { owner: string; repo: string }): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${E2E_REVIEWED_PR.number}`
}

/**
 * The one inline comment the fake refuses, ONCE, per PR and workspace: a TRANSIENT upstream
 * failure, which is the shape the port models (per-comment outcomes rather than a throw, because
 * one un-postable comment must not reject the rest).
 *
 * It exists because a partial post is a whole disposition of its own: the run is re-parked carrying
 * the report instead of finishing, and a retry posts ONLY what did not land (`postedFindingIds`),
 * so nothing is double-posted. Refusing only the FIRST attempt is what lets one spec drive both
 * halves. The memory is keyed per installation + PR + anchor, so the shared client cannot leak one
 * spec's refusal into another's.
 */
export const E2E_TRANSIENT_REVIEW_POST_FAILURE = {
  path: 'src/session.ts',
  line: 21,
  reason: 'Transient upstream error posting the inline comment.',
} as const

/**
 * The files the reviewed PR changes, as unified patches. They exist so a review FINDING can anchor
 * to a real diff line: the engine pre-filters the human's selection against the PR's actual changed
 * lines (`computeCommentableLines`) and folds anything out-of-diff into the summary comment instead
 * of posting it inline.
 *
 * `src/auth.ts`' hunk starts at line 10 on the head side, so lines 10-13 are commentable on
 * `RIGHT` (the review fixture anchors its blocker at 12). `src/session.ts` hosts
 * {@link E2E_TRANSIENT_REVIEW_POST_FAILURE}: line 21 is an added line, so a finding there is
 * commentable and DOES reach the write, which is the only way to drive a per-comment failure.
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
  {
    // The path comes from the refusal fixture rather than being restated: the two have to name the
    // same file, or the finding anchored for the partial-post path is folded into the summary and
    // that test silently stops testing anything. Its line 21 is the `+audit(session)` line below.
    path: E2E_TRANSIENT_REVIEW_POST_FAILURE.path,
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -20,2 +20,3 @@\n const session = start()\n+audit(session)\n return session',
  },
]

/**
 * The shared fake client PLUS the five OPTIONAL `GitHubClient` PR-review members, typed
 * structurally: this test-only package deliberately has no direct `@cat-factory/kernel` dependency
 * (mirrors `fakeProfile.ts`, which derives its shapes from the conformance fakes).
 *
 * Two guards keep it honest in both directions. Towards the PORT: the client is passed to
 * `buildNodeContainer`'s `overrides.githubClient`, which IS typed against `GitHubClient`, so a
 * member whose shape stops matching fails the e2e typecheck there. Towards the FAKE: this is what
 * {@link createE2eGitHubClient} returns and what {@link makeE2eRunRepoResolver} takes, so a
 * capability that stops being installed is a compile error rather than a `TypeError` inside a
 * resolver that had cast its way past the missing methods.
 */
export type E2eGitHubClient = FakeGitHubClient & E2eReviewCapability

/** One `createReview` CALL, whether or not every comment in it landed (see `reviewAttempts`). */
interface E2eReviewAttempt {
  installationId: number
  number: number
  input: E2eCreateReviewInput
}

/** The PR-review members {@link withReviewCapability} installs on the shared fake. */
interface E2eReviewCapability {
  /**
   * Every `createReview` ATTEMPT, oldest first, across all workspaces (filter by installation id;
   * {@link listReviewAttemptsFor} does). It is the only place the WIRE truth is visible: what the
   * engine actually sent, as opposed to what the window renders about it, which is what makes it
   * the evidence for at-most-once posting.
   */
  reviewAttempts: E2eReviewAttempt[]
  getPullRequest(
    installationId: number,
    ref: E2eRepoRef,
    number: number,
  ): Promise<E2eOpenedPullRequest | null>
  listChangedFiles(
    installationId: number,
    ref: E2eRepoRef,
    number: number,
  ): Promise<E2eChangedFile[]>
  getPullRequestHeadSha(
    installationId: number,
    ref: E2eRepoRef,
    number: number,
  ): Promise<string | null>
  getPullRequestHeadRef(
    installationId: number,
    ref: E2eRepoRef,
    number: number,
  ): Promise<string | null>
  createReview(
    installationId: number,
    ref: E2eRepoRef,
    number: number,
    input: E2eCreateReviewInput,
  ): Promise<{
    comments: { posted: boolean; error?: string }[]
    bodyPosted: boolean | null
  }>
}
/** The repo a client call is keyed by, as the port's `GitHubRepoRef`. */
type E2eRepoRef = Parameters<FakeGitHubClient['getFileContent']>[1]
/** A pull request as the port's `OpenedPullRequest`, derived from the fake's own write method. */
type E2eOpenedPullRequest = Awaited<ReturnType<FakeGitHubClient['openPullRequest']>>
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
 * the rest). It throws only when it cannot begin at all, which here means a PR the fake does not
 * serve: the engine reports that as an all-failed attempt, so a run pointed at the wrong PR is
 * loud instead of silently reviewing the canned diff.
 *
 * `Object.assign` rather than assignment-through-a-cast: it types the returned value as the
 * intersection, so the capability object is checked against {@link E2eReviewCapability} here and
 * the callers see the members instead of casting them back into existence.
 */
function withReviewCapability(client: FakeGitHubClient): E2eGitHubClient {
  const reviewAttempts: E2eReviewAttempt[] = []
  /** Anchors already refused once, keyed per installation + PR, so one spec cannot spend another's. */
  const refused = new Set<string>()
  const servesPr = (number: number): boolean => number === E2E_REVIEWED_PR.number
  const capability: E2eReviewCapability = {
    reviewAttempts,
    getPullRequest: async (_installationId, ref, number) =>
      servesPr(number)
        ? {
            // The catalogued repo id when the ref is one the canned catalog knows, else 0: a spec's
            // OWN repo lives only in the Postgres projection. Nothing on the review path reads it
            // (creation validates `number` and canonicalises `url`), so it is reported rather than
            // invented, mirroring the shared fake's own `openPullRequest`.
            repoGithubId:
              client.repos.find((r) => r.owner === ref.owner && r.name === ref.repo)?.githubId ?? 0,
            number: E2E_REVIEWED_PR.number,
            githubId: 900_042,
            title: 'Harden the session bootstrap',
            state: 'open',
            headRef: E2E_REVIEWED_PR.headRef,
            baseRef: 'main',
            headSha: E2E_REVIEWED_PR.headSha,
            merged: false,
            author: 'octo-dev',
            updatedAt: 0,
            syncedAt: 0,
            url: reviewedPrUrl(ref),
          }
        : null,
    listChangedFiles: async (_installationId, _ref, number) =>
      servesPr(number) ? E2E_PR_CHANGED_FILES : [],
    // A STABLE head sha: the engine captures it when the review dispatches and re-reads it at post
    // time, treating a change as branch drift (which would fold every finding into the summary
    // instead of anchoring it inline). A constant means "the branch did not move", so the inline
    // path is the one under test.
    getPullRequestHeadSha: async (_installationId, _ref, number) =>
      servesPr(number) ? E2E_REVIEWED_PR.headSha : null,
    getPullRequestHeadRef: async (_installationId, _ref, number) =>
      servesPr(number) ? E2E_REVIEWED_PR.headRef : null,
    createReview: async (installationId, _ref, number, input) => {
      if (!servesPr(number)) throw new Error(`e2e fake serves no pull request #${number}`)
      reviewAttempts.push({ installationId, number, input })
      return {
        comments: input.comments.map((comment) => {
          const transient =
            comment.path === E2E_TRANSIENT_REVIEW_POST_FAILURE.path &&
            comment.line === E2E_TRANSIENT_REVIEW_POST_FAILURE.line
          if (!transient) return { posted: true }
          const key = `${installationId}:${number}:${comment.path}:${comment.line}`
          if (refused.has(key)) return { posted: true }
          refused.add(key)
          return { posted: false, error: E2E_TRANSIENT_REVIEW_POST_FAILURE.reason }
        }),
        bodyPosted: input.body ? true : null,
      }
    },
  }
  return Object.assign(client, capability)
}

/** One recorded attempt, projected to what a spec can assert on over the control channel. */
export interface E2eReviewAttemptView {
  number: number
  comments: { path: string; line: number }[]
  /** Whether this attempt carried the summary/body comment (suppressed once it has landed). */
  hasBody: boolean
}

/**
 * The review attempts a workspace's runs made, oldest first.
 *
 * Read over the control channel by the deep-review spec, because the AT-MOST-ONCE rule is a fact
 * about the wire and nothing else can see it: the window reports what the engine derived, which
 * would read identically if a retry re-sent a comment that had already landed.
 */
export function listReviewAttemptsFor(
  client: E2eGitHubClient,
  workspaceId: string,
): E2eReviewAttemptView[] {
  const installationId = installationIdFor(workspaceId)
  return client.reviewAttempts
    .filter((attempt) => attempt.installationId === installationId)
    .map((attempt) => ({
      number: attempt.number,
      comments: attempt.input.comments.map((c) => ({ path: c.path, line: c.line })),
      hasBody: !!attempt.input.body,
    }))
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
  client: E2eGitHubClient,
): (workspaceId: string, blockId: string) => Promise<E2eRunRepoContext | null> {
  return async (workspaceId) => {
    const own = ownRepoFor(workspaceId)
    const projected = await new DrizzleRepoProjectionRepository(db).get(workspaceId, own.githubId)
    if (!projected) return null
    const ref = { owner: projected.owner, repo: projected.name }
    const installationId = projected.installationId
    return {
      // Every member delegates to the same fake client the GitHub module reads through, so a repo
      // op's write lands where a spec can observe it (`client.files` / `client.writes` /
      // `client.reviewAttempts`). This is the shape `makeRepoFiles` composes in production; it is
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
        // Wired, so `review`-task creation runs its real VALIDATION: an unknown PR number is
        // refused at the create call and the stored reference is canonicalised to the provider's
        // own URL. Omitting it (the shape before) passed every reference through unchecked, which
        // silently exempted the fixture from the repo-mismatch and not-found refusals.
        getPullRequest: (number) => client.getPullRequest(installationId, ref, number),
        listChangedFiles: (number) => client.listChangedFiles(installationId, ref, number),
        pullRequestHeadSha: (number) => client.getPullRequestHeadSha(installationId, ref, number),
        pullRequestHeadRef: (number) => client.getPullRequestHeadRef(installationId, ref, number),
        createReview: (number, input) => client.createReview(installationId, ref, number, input),
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
    getPullRequest: (number: number) => Promise<E2eOpenedPullRequest | null>
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
export function createE2eGitHubClient(): E2eGitHubClient {
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
