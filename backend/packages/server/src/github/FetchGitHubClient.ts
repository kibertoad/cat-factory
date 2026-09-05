import {
  type Clock,
  type CommitFilesResult,
  type CreateReviewInput,
  type CreateReviewResult,
  type GitHubBranch,
  type GitHubChangedFile,
  type GitHubCheckRun,
  type GitHubClient,
  type GitHubCodeSearchHit,
  type GitHubCommit,
  type GitHubIssue,
  type GitHubIssueDetail,
  type GitHubIssueSearchHit,
  type GitHubSubIssue,
  type GitHubPullRequest,
  type OpenedPullRequest,
  type GitHubPullRequestReview,
  type GitHubPullRequestComment,
  type GitHubReviewThread,
  type GitHubRepo,
  type GitHubRepoRef,
  type BranchProtectionSummary,
  type IdGenerator,
  type InstallationMeta,
  type InstallationSummary,
  type ListOptions,
  type MergePullRequestInput,
  type OpenPullRequestInput,
  type Paged,
  type RateLimitRepository,
  type RateLimitSnapshot,
  type RepoContentEntry,
  type RepoEntry,
  type RepoFileContent,
  type RepoTreeListing,
  describeVcsApiError,
  runBestEffort,
  VCS_DOC_URLS,
} from '@cat-factory/kernel'
import { githubProjection as gp } from '@cat-factory/integrations'
import { logger } from '../observability/logger.js'
import type { CommitFilesInput } from '@cat-factory/contracts'
import type { AppTokenSource } from './GitHubAppRegistry.js'
import { postPrReview } from './reviewPosting.js'
import { probeBranchProtection, readRequiredApprovingReviewCount } from './branchProtection.js'
import {
  type ContentsRequest,
  readDirectory,
  readFileContent,
  readRootEntries,
  readLatestCommitSha,
  readTree,
} from './repoContents.js'
import { getRepoForToken, listReposForToken } from './viewerTokenReads.js'
import {
  listPrReviewThreads,
  replyToPrReviewThread,
  resolvePrReviewThread,
  type GitHubGraphQlFn,
} from './reviewThreads.js'
import { searchCode, searchIssues } from './searchApi.js'
import {
  ACCEPT,
  API_VERSION,
  GitHubApiError,
  PER_PAGE,
  USER_AGENT,
  githubApiStatus,
  numHeader,
  parseGitHubTime,
  parseIssueHtmlUrl,
  parseNextLink,
  walkPages,
} from './githubHttpHelpers.js'

// Re-exported so every existing importer keeps resolving it from the client it is thrown by;
// the class itself moved to `githubHttpHelpers.ts` (see its doc).
export { GitHubApiError } from './githubHttpHelpers.js'

// Thin `fetch`-based GitHubClient: the only place that talks to the GitHub REST
// API. It authenticates via the App (installation tokens for repo calls, the app
// JWT for installation-level calls), records a rate-limit snapshot on every
// response, follows `Link` pagination up to a bounded number of pages, and maps
// responses to projection entities with the shared pure mappers. Octokit is
// deliberately avoided — Web Crypto + fetch cover everything we need without the
// bundle weight (see backend/docs/adr/0001-github-app-integration.md).

/** Neutral default colour for a label we create on the fly (GitHub requires a colour). */
const DEFAULT_LABEL_COLOR = 'ededed'

// (installationId, owner, repo) → numeric repo id. GitHub never reassigns a repo's numeric
// id, so this mapping is immutable and safe to memoize per-process — sparing a
// `GET /repos/{owner}/{repo}` on every payload that omits the id (branches / issues /
// commits / check runs backfill it purely for that number, several times per gate/sync
// tick). Same justified process-level memo as `ownerAppCache` in `GitHubAppRegistry`.
const repoIdCache = new Map<string, number>()

const repoIdCacheKey = (installationId: number, ref: GitHubRepoRef): string =>
  `${installationId}:${ref.owner}/${ref.repo}`

export interface FetchGitHubClientDependencies {
  /**
   * Mints the per-call token. The App registry (resolving which App's credentials to
   * use per installation, ADR 0005) satisfies this; a static-PAT source does too (it
   * returns the PAT for installation calls and has no app-JWT paths).
   */
  registry: AppTokenSource
  rateLimitRepository: RateLimitRepository
  idGenerator: IdGenerator
  clock: Clock
  apiBase: string
}

type AuthMode = 'installation' | 'app'

interface RequestOptions {
  method?: string
  installationId: number
  auth?: AuthMode
  /**
   * For app-JWT calls (`auth: 'app'`), which App signs the JWT. Defaults to the
   * default App; the connect probe / installation listing pass each App in turn.
   */
  appId?: string
  etag?: string
  body?: unknown
  /**
   * Mint a fresh installation token for this call instead of reusing the cached
   * one. Used to recheck a permission after the user changed the App's access on
   * GitHub (a cached token keeps its grant-at-mint scopes). Ignored for `auth: 'app'`.
   */
  forceRefreshToken?: boolean
}

interface GitHubResponse {
  status: number
  res: Response
  /** Parsed JSON body, or null for 204/304. */
  json: unknown
  etag?: string
  /** Absolute URL of the next page, if any. */
  next?: string
}

/** The slice of the single-issue REST payload `getIssue` reads. */
interface GhIssueDetailPayload {
  number?: number
  title?: string
  state?: string
  html_url?: string
  body?: string
  user?: { login?: string } | null
  assignee?: { login?: string } | null
  labels?: Array<string | { name?: string } | null>
  /** The parent issue, present when this is a sub-issue (GitHub sub-issues). */
  parent?: { html_url?: string } | null
}

/** The slice of a `/sub_issues` item `listSubIssues` reads. */
interface GhSubIssueItem {
  number?: number
  html_url?: string
  title?: string
  state?: string
}

/** The slice of the issue-comment REST payload `getIssue` reads. */
interface GhIssueCommentPayload {
  body?: string
  created_at?: string
  user?: { login?: string } | null
}

export class FetchGitHubClient implements GitHubClient {
  constructor(private readonly deps: FetchGitHubClientDependencies) {}

  /**
   * `graphql` as a plain delegate, for the extracted review-thread helpers (a private method
   * can't be handed over directly). The REST half passes `request` the same way.
   */
  private readonly graphqlFn: GitHubGraphQlFn = (installationId, query, variables) =>
    this.graphql(installationId, query, variables)

  // ---- installation-level (app JWT) --------------------------------------

  async getInstallation(installationId: number): Promise<InstallationMeta> {
    // An installation belongs to exactly one App; probe each configured App's JWT
    // until one can see it (404 = not this App's), so the binding records the
    // owning App for later token minting (ADR 0005).
    for (const { appId } of this.deps.registry.apps()) {
      try {
        const { json } = await this.request(`/app/installations/${installationId}`, {
          installationId,
          auth: 'app',
          appId,
        })
        const body = json as { account?: { login?: string }; target_type?: string }
        return {
          accountLogin: body.account?.login ?? '',
          targetType: body.target_type === 'Organization' ? 'Organization' : 'User',
          appId,
        }
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 404) continue
        throw err
      }
    }
    throw new GitHubApiError(
      404,
      `Installation ${installationId} not found on any configured App — the GitHub App was likely uninstalled from the account, or this workspace points at a stale installation. Fix: reconnect GitHub for this workspace to re-link it. See ${VCS_DOC_URLS.githubIntegration}.`,
    )
  }

  async listInstallations(): Promise<InstallationSummary[]> {
    // App-JWT call, so no specific installation: pass 0 (used only for the
    // best-effort rate-limit snapshot). Listed per App and merged, so the connect
    // picker surfaces installations of both the default and privileged Apps.
    const out: InstallationSummary[] = []
    for (const { appId } of this.deps.registry.apps()) {
      const page = await this.paginate<InstallationSummary>(
        `/app/installations?per_page=${PER_PAGE}`,
        { installationId: 0, auth: 'app', appId },
        (json) =>
          (
            (json as Array<{
              id: number
              account?: { login?: string; avatar_url?: string }
              target_type?: string
            }>) ?? []
          ).map((i) => ({
            installationId: i.id,
            accountLogin: i.account?.login ?? '',
            targetType: i.target_type === 'Organization' ? 'Organization' : 'User',
            accountAvatarUrl: i.account?.avatar_url ?? null,
          })),
      )
      out.push(...page)
    }
    return out
  }

  async listInstallationRepos(installationId: number): Promise<Paged<GitHubRepo>> {
    const syncedAt = this.deps.clock.now()
    // Paged rather than flattened: a wide installation exceeds the page cap, and the callers that
    // SHOW this list (the picker, the public available-repos read) have to say so rather than let a
    // repository beyond the window read as one the installation was never granted.
    return walkPages<GitHubRepo>(
      `/installation/repositories?per_page=${PER_PAGE}`,
      (url) => this.request(url, { installationId }),
      (json) => {
        const repos = (json as { repositories?: gp.GhRepoPayload[] }).repositories ?? []
        return repos.map((r) => gp.toRepoProjection(r, installationId, syncedAt))
      },
    )
  }

  async searchInstallationRepos(
    installationId: number,
    query: string,
    opts: { owner?: string; ownerType?: 'Organization' | 'User'; limit?: number } = {},
  ): Promise<Paged<GitHubRepo>> {
    const trimmed = query.trim()
    // An empty query asks nothing, so it omitted nothing either.
    if (!trimmed) return { items: [], truncated: false }
    const syncedAt = this.deps.clock.now()
    const per = Math.min(Math.max(opts.limit ?? 50, 1), 100)
    // Without an account to scope it to, `/search/repositories` would run UNSCOPED across
    // all of GitHub and return arbitrary public repos this installation can't link (each
    // would then 404 on `getRepoById`). Never do that: fall back to filtering the
    // installation's own bounded repo listing, so a missing account can't leak the search.
    if (!opts.owner) {
      const q = trimmed.toLowerCase()
      const { items, truncated } = await this.listInstallationRepos(installationId)
      const matched = items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
      // Truncated by EITHER cap: the enumeration this filters may have stopped before the
      // match existed, which no count of the results could reveal.
      return { items: matched.slice(0, per), truncated: truncated === true || matched.length > per }
    }
    // Match the typed text against the repo NAME (accepting an `owner/name` paste by
    // matching only the name segment), scoped to the installation's account so results stay
    // within what it manages. GitHub matches names by token/prefix (NOT arbitrary
    // substring), and a public org repo the App wasn't granted may still surface — linking
    // one point-reads it via `getRepoById`, which returns null (a clean "grant access"
    // signal) when the installation genuinely can't access it.
    const nameTerm = trimmed.slice(trimmed.lastIndexOf('/') + 1).trim() || trimmed
    const scope = ` ${opts.ownerType === 'Organization' ? 'org' : 'user'}:${opts.owner}`
    const q = encodeURIComponent(`${nameTerm} in:name fork:true${scope}`)
    const { json } = await this.request(`/search/repositories?q=${q}&per_page=${per}`, {
      installationId,
    })
    const found = (json as { items?: gp.GhRepoPayload[]; total_count?: number } | null) ?? {}
    const items = (found.items ?? []).map((r) => gp.toRepoProjection(r, installationId, syncedAt))
    // GitHub reports the full match count, so this leg knows exactly what it left behind
    // rather than inferring it from a page that happens to be full.
    return { items, truncated: (found.total_count ?? items.length) > items.length }
  }

  // ---- reads --------------------------------------------------------------

  async getRepo(installationId: number, ref: GitHubRepoRef): Promise<GitHubRepo> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}`, { installationId })
    return gp.toRepoProjection(json as gp.GhRepoPayload, installationId, this.deps.clock.now())
  }

  async getRepoById(installationId: number, repoGithubId: number): Promise<GitHubRepo | null> {
    // `/repositories/{id}` resolves a repo by its numeric id in one request. A 404/403 means
    // the installation can't access it (or it's gone) — surface that as null, exactly the
    // "not accessible" signal linking checks for.
    try {
      const { json } = await this.request(`/repositories/${repoGithubId}`, { installationId })
      return gp.toRepoProjection(json as gp.GhRepoPayload, installationId, this.deps.clock.now())
    } catch (err) {
      if (err instanceof GitHubApiError && (err.status === 404 || err.status === 403)) return null
      throw err
    }
  }

  /**
   * Repo reads authenticated with the CALLER's personal access token rather than this client's
   * installation credential (the personal-PAT repo picker). Thin delegates: the reads live in
   * `viewerTokenReads.ts`, because nothing about them mints, caches or rate-limit-accounts the
   * way the rest of this client does.
   */
  listReposForToken(token: string): Promise<Paged<GitHubRepo>> {
    return listReposForToken(this.deps, token)
  }

  getRepoForToken(token: string, repoGithubId: number): Promise<GitHubRepo | null> {
    return getRepoForToken(this.deps, token, repoGithubId)
  }

  async canPush(installationId: number, ref: GitHubRepoRef): Promise<boolean> {
    // The repo payload carries the *token's* effective access in `permissions`. A
    // public repo the installation can read but is not granted (not in the App's
    // selected repos, or the App lacks contents:write) comes back with push:false —
    // exactly the case that 403s on the bootstrap container's push. A 404 (the repo
    // is private + not granted at all) means no access either; surface that as false.
    if (await this.probePush(installationId, ref, false)) return true
    // A negative answer may just be stale. Installation tokens bake in their repo
    // set + permission scopes at mint time and we cache them in-memory for ~1h, so a
    // token minted before the user granted the App access keeps reporting the old
    // (no-write) grant — which is exactly the "I just added the App, why does retry
    // still say no?" case. Mint a fresh token and probe once more before concluding
    // there's genuinely no write access. The fresh mint also replaces the cached
    // entry the bootstrap push token reads, so a real grant fixes the push too.
    return this.probePush(installationId, ref, true)
  }

  /** One write-access probe; `forceRefreshToken` mints a fresh token for it. */
  private async probePush(
    installationId: number,
    ref: GitHubRepoRef,
    forceRefreshToken: boolean,
  ): Promise<boolean> {
    try {
      const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}`, {
        installationId,
        forceRefreshToken,
      })
      // A user/OAuth/PAT token has a collaborator role, reported here — authoritative
      // for those (e.g. local mode's PAT).
      if ((json as { permissions?: { push?: boolean } }).permissions?.push === true) return true
    } catch (err) {
      if (err instanceof GitHubApiError && (err.status === 404 || err.status === 403)) return false
      throw err
    }
    // A GitHub App installation token is not a repo collaborator, so the repo object's
    // `permissions` is empty for it — `permissions.push` is never true no matter the
    // grant. The authoritative source for an App is its granted `contents` scope from
    // the token mint response. The repo read above already proved the repo is reachable
    // (in the installation's selected set), and an App's permission set is
    // installation-wide across its selected repos, so contents:write ⇒ pushable here.
    const granted = await this.deps.registry.installationPermissions(installationId)
    return granted.contents === 'write'
  }

  async listBranches(
    installationId: number,
    ref: GitHubRepoRef,
    etag?: string,
  ): Promise<Paged<GitHubBranch>> {
    const syncedAt = this.deps.clock.now()
    const first = await this.request(
      `/repos/${ref.owner}/${ref.repo}/branches?per_page=${PER_PAGE}`,
      { installationId, etag },
    )
    if (first.status === 304) return { items: [], notModified: true, etag }
    const items = (first.json as gp.GhBranchPayload[]).map((b) =>
      gp.toBranchProjection(b, 0, syncedAt),
    )
    // branches don't carry a repo id; backfill it from the repo we already know.
    const repoId = await this.repoId(installationId, ref)
    return {
      items: items.map((b) => ({ ...b, repoGithubId: repoId })),
      etag: first.etag,
    }
  }

  async branchHeadSha(
    installationId: number,
    ref: GitHubRepoRef,
    branch: string,
  ): Promise<string | null> {
    // Exact single-ref lookup (mirrors commitFiles' base-sha resolution) so it stays
    // correct regardless of branch count; a 404 means the branch does not exist yet.
    // Encode each segment so a slashed branch (`feature/x`) keeps its path separators.
    const encoded = branch.split('/').map(encodeURIComponent).join('/')
    try {
      const { json } = await this.request(
        `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${encoded}`,
        { installationId },
      )
      return (json as { object?: { sha?: string } }).object?.sha ?? null
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null
      throw err
    }
  }

  // The four repository-CONTENTS reads are thin delegates over `repoContents.ts` (extracted along
  // the same seam as `reviewPosting.ts` and `branchProtection.ts`, since this file is at its size
  // budget). What lives there is the classification they share: which statuses are ANSWERS here, and
  // the two facts this endpoint states as something it is not.
  async listRootEntries(installationId: number, ref: GitHubRepoRef): Promise<RepoEntry[]> {
    return readRootEntries(this.contentsRequest(), installationId, ref)
  }

  async listDirectory(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoContentEntry[]> {
    return readDirectory(this.contentsRequest(), installationId, ref, path, gitRef)
  }

  async listTree(
    installationId: number,
    ref: GitHubRepoRef,
    gitRef?: string,
  ): Promise<RepoTreeListing> {
    return readTree(this.contentsRequest(), installationId, ref, gitRef)
  }

  async getFileContent(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoFileContent | null> {
    return readFileContent(this.contentsRequest(), installationId, ref, path, gitRef)
  }

  /** This client's authenticated GET, as the narrow callback the contents reads take. */
  private contentsRequest(): ContentsRequest {
    return (path, opts) => this.request(path, opts)
  }

  async latestCommitSha(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<string | null> {
    return readLatestCommitSha(this.contentsRequest(), installationId, ref, path, gitRef)
  }

  async listPullRequests(
    installationId: number,
    ref: GitHubRepoRef,
    opts: ListOptions = {},
  ): Promise<Paged<GitHubPullRequest>> {
    const syncedAt = this.deps.clock.now()
    const sinceMs = opts.since ? Date.parse(opts.since) : null
    const items = await this.paginate<GitHubPullRequest>(
      `/repos/${ref.owner}/${ref.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}`,
      { installationId, etag: opts.etag },
      (json) =>
        (json as gp.GhPullPayload[]).map((p) =>
          gp.toPullRequestProjection(p, gp.pullRepoGithubId(p) ?? 0, syncedAt),
        ),
      // Pulls are sorted newest-updated first; stop once we cross `since`.
      (page) =>
        sinceMs !== null && page.length > 0 && (page[page.length - 1]!.updatedAt ?? 0) < sinceMs,
    )
    const filtered = sinceMs !== null ? items.filter((p) => (p.updatedAt ?? 0) >= sinceMs) : items
    return { items: filtered }
  }

  async listIssues(
    installationId: number,
    ref: GitHubRepoRef,
    opts: ListOptions = {},
  ): Promise<Paged<GitHubIssue>> {
    const syncedAt = this.deps.clock.now()
    const repoId = await this.repoId(installationId, ref)
    const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : ''
    const items = await this.paginate<GitHubIssue>(
      `/repos/${ref.owner}/${ref.repo}/issues?state=all&sort=updated&per_page=${PER_PAGE}${since}`,
      { installationId },
      (json) =>
        (json as gp.GhIssuePayload[])
          .filter((i) => !gp.isPullRequest(i))
          .map((i) => gp.toIssueProjection(i, repoId, syncedAt)),
    )
    return { items }
  }

  async getIssue(
    installationId: number,
    ref: GitHubRepoRef,
    issueNumber: number,
  ): Promise<GitHubIssueDetail> {
    const base = `/repos/${ref.owner}/${ref.repo}/issues/${issueNumber}`
    const { json } = await this.request(base, { installationId })
    const issue = (json ?? {}) as GhIssueDetailPayload
    // Comments are a separate paginated collection; oldest→newest is the API's
    // default order. One page (100) is plenty of context for an agent.
    const commentsRes = await this.request(`${base}/comments?per_page=${PER_PAGE}`, {
      installationId,
    })
    const rawComments = (commentsRes.json ?? []) as GhIssueCommentPayload[]
    return {
      number: issue.number ?? issueNumber,
      title: issue.title ?? '(untitled)',
      state: issue.state ?? '',
      url: issue.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/issues/${issueNumber}`,
      author: issue.user?.login ?? null,
      assignee: issue.assignee?.login ?? null,
      labels: (issue.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
        .filter(Boolean),
      body: issue.body ?? '',
      comments: (Array.isArray(rawComments) ? rawComments : []).map((c) => ({
        author: c.user?.login ?? '',
        createdAt: c.created_at ?? '',
        body: c.body ?? '',
      })),
      parentRef: issue.parent?.html_url
        ? (() => {
            const p = parseIssueHtmlUrl(issue.parent.html_url ?? '')
            return p ? `${p.owner}/${p.repo}#${p.number}` : null
          })()
        : null,
    }
  }

  async listSubIssues(
    installationId: number,
    ref: GitHubRepoRef,
    issueNumber: number,
  ): Promise<GitHubSubIssue[]> {
    // Follow `Link` pagination so an epic with >100 sub-issues imports its full child set
    // (a single page would silently truncate the spawned board graph).
    return this.paginate<GitHubSubIssue>(
      `/repos/${ref.owner}/${ref.repo}/issues/${issueNumber}/sub_issues?per_page=${PER_PAGE}`,
      { installationId },
      (json) => {
        const items = (Array.isArray(json) ? json : []) as GhSubIssueItem[]
        const out: GitHubSubIssue[] = []
        for (const item of items) {
          const parts = parseIssueHtmlUrl(item.html_url ?? '')
          if (!parts) continue
          out.push({
            owner: parts.owner,
            repo: parts.repo,
            number: item.number ?? parts.number,
            title: item.title ?? '(untitled)',
            state: item.state ?? '',
            url: item.html_url ?? '',
          })
        }
        return out
      },
    )
  }

  // The two `/search/*` endpoints live in `searchApi.ts` (a cohesive extraction like
  // `reviewPosting.ts`); these stay as thin delegates over the shared `request` executor.
  async searchIssues(
    installationId: number,
    query: string,
    limit = 20,
    order?: 'created-asc',
    page = 1,
  ): Promise<GitHubIssueSearchHit[]> {
    return searchIssues(
      (path, opts) => this.request(path, opts),
      installationId,
      query,
      limit,
      order,
      page,
    )
  }

  async searchCode(
    installationId: number,
    query: string,
    limit = 20,
  ): Promise<GitHubCodeSearchHit[]> {
    return searchCode((path, opts) => this.request(path, opts), installationId, query, limit)
  }

  async listCommits(
    installationId: number,
    ref: GitHubRepoRef,
    opts: ListOptions & { sha?: string } = {},
  ): Promise<Paged<GitHubCommit>> {
    const syncedAt = this.deps.clock.now()
    const repoId = await this.repoId(installationId, ref)
    const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : ''
    const sha = opts.sha ? `&sha=${encodeURIComponent(opts.sha)}` : ''
    const items = await this.paginate<GitHubCommit>(
      `/repos/${ref.owner}/${ref.repo}/commits?per_page=${PER_PAGE}${since}${sha}`,
      { installationId },
      (json) =>
        (json as gp.GhCommitPayload[]).map((c) => gp.toCommitProjection(c, repoId, syncedAt)),
    )
    return { items }
  }

  async listCheckRuns(
    installationId: number,
    ref: GitHubRepoRef,
    sha: string,
  ): Promise<Paged<GitHubCheckRun>> {
    const syncedAt = this.deps.clock.now()
    const repoId = await this.repoId(installationId, ref)
    const { json } = await this.request(
      `/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs?per_page=${PER_PAGE}`,
      { installationId },
    )
    const runs = (json as { check_runs?: gp.GhCheckRunPayload[] }).check_runs ?? []
    return { items: runs.map((r) => gp.toCheckRunProjection(r, repoId, syncedAt)) }
  }

  // ---- PR review reads (human-review gate) ---------------------------------

  async listRequestedReviewers(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<string[]> {
    const { json } = await this.request(
      `/repos/${ref.owner}/${ref.repo}/pulls/${number}/requested_reviewers`,
      { installationId },
    )
    const users = (json as { users?: { login?: string }[] }).users ?? []
    return users.map((u) => u.login ?? '').filter((l) => l !== '')
  }

  async listPullRequestReviews(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<GitHubPullRequestReview[]> {
    return this.paginate<GitHubPullRequestReview>(
      `/repos/${ref.owner}/${ref.repo}/pulls/${number}/reviews?per_page=${PER_PAGE}`,
      { installationId },
      (json) =>
        (
          json as {
            user?: { login?: string }
            state?: string
            body?: string | null
            submitted_at?: string | null
            commit_id?: string | null
          }[]
        ).map((r) => ({
          author: r.user?.login ?? '',
          state: r.state ?? '',
          body: r.body ?? '',
          submittedAt: parseGitHubTime(r.submitted_at),
          commitId: r.commit_id ?? null,
        })),
    )
  }

  async listIssueComments(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<GitHubPullRequestComment[]> {
    return this.paginate<GitHubPullRequestComment>(
      `/repos/${ref.owner}/${ref.repo}/issues/${number}/comments?per_page=${PER_PAGE}`,
      { installationId },
      (json) =>
        (
          json as { id?: number; user?: { login?: string }; body?: string; created_at?: string }[]
        ).map((c) => ({
          id: String(c.id ?? ''),
          author: c.user?.login ?? '',
          body: c.body ?? '',
          createdAt: parseGitHubTime(c.created_at),
        })),
    )
  }

  async listChangedFiles(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<GitHubChangedFile[]> {
    return this.paginate<GitHubChangedFile>(
      `/repos/${ref.owner}/${ref.repo}/pulls/${number}/files?per_page=${PER_PAGE}`,
      { installationId },
      (json) => (json as gp.GhChangedFilePayload[]).map(gp.toChangedFileProjection),
    )
  }

  async getRequiredApprovingReviewCount(
    installationId: number,
    ref: GitHubRepoRef,
    branch: string,
    // GitHub's required count is branch-protection-scoped; the PR number a provider with a
    // PR-scoped rule (GitLab) needs is accepted by the port but unused here.
    _number?: number,
  ): Promise<number> {
    return readRequiredApprovingReviewCount(
      this.protectionRequest(installationId),
      githubApiStatus,
      ref,
      branch,
    )
  }

  /**
   * A branch's protection posture — the backing read for the security preflight. A thin
   * delegate: the probe itself lives in `branchProtection.ts` (extracted along the same seam as
   * `reviewPosting.ts`, since this file is at its size budget), bound to this installation's
   * authenticated GET. Never throws; see the probe's own doc for why.
   */
  async getBranchProtection(
    installationId: number,
    ref: GitHubRepoRef,
    branch: string,
  ): Promise<BranchProtectionSummary> {
    return probeBranchProtection(
      this.protectionRequest(installationId),
      githubApiStatus,
      ref,
      branch,
    )
  }

  /** This installation's authenticated GET, as the narrow callback the probe helpers take. */
  private protectionRequest(installationId: number) {
    return (path: string) => this.request(path, { installationId })
  }

  /**
   * `GET /pulls/{n}` — the one read every single-PR accessor below is a projection of. A 404 (the
   * repo has no such PR: never opened, or hard-deleted) answers null; ANY other failure throws, so
   * a caller can tell "this PR does not exist" from "the provider could not answer". That
   * distinction is what makes {@link getPullRequest} usable as an existence check.
   */
  private async readPullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<gp.GhPullPayload | null> {
    try {
      const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${number}`, {
        installationId,
      })
      return json as gp.GhPullPayload
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null
      throw error
    }
  }

  // A missing PR degrades differently per caller, but always to null: no base to gate against
  // (the human-review gate falls back to its default), no head branch to push to (the deep-review
  // "fix" reports it unresolvable rather than cloning the wrong ref), no head sha to compare
  // against (the drift check skips).
  async getPullRequestBaseRef(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<string | null> {
    return (await this.readPullRequest(installationId, ref, number))?.base?.ref ?? null
  }

  async getPullRequestHeadRef(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<string | null> {
    return (await this.readPullRequest(installationId, ref, number))?.head?.ref ?? null
  }

  async getPullRequestHeadSha(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<string | null> {
    return (await this.readPullRequest(installationId, ref, number))?.head?.sha ?? null
  }

  async getPullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<OpenedPullRequest | null> {
    const payload = await this.readPullRequest(installationId, ref, number)
    return payload ? this.toOpenedPullRequest(payload) : null
  }

  // The GraphQL review-thread reads/writes live in `reviewThreads.ts` (the sibling of
  // `reviewPosting.ts`, the REST half); these stay thin delegates over the shared executor.
  listReviewThreads(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<GitHubReviewThread[]> {
    return listPrReviewThreads(this.graphqlFn, installationId, ref, number)
  }

  replyToReviewThread(
    installationId: number,
    _ref: GitHubRepoRef,
    threadId: string,
    body: string,
  ): Promise<void> {
    return replyToPrReviewThread(this.graphqlFn, installationId, threadId, body)
  }

  resolveReviewThread(
    installationId: number,
    _ref: GitHubRepoRef,
    threadId: string,
  ): Promise<void> {
    return resolvePrReviewThread(this.graphqlFn, installationId, threadId)
  }

  createReview(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    input: CreateReviewInput,
  ): Promise<CreateReviewResult> {
    // The per-comment posting + partial-success reporting lives in `reviewPosting.ts`; this stays
    // a thin transport delegate (see the deep-review "post" resolution).
    return postPrReview(
      (path, opts) => this.request(path, opts),
      installationId,
      ref,
      number,
      input,
    )
  }

  // ---- writes -------------------------------------------------------------

  async createBranch(
    installationId: number,
    ref: GitHubRepoRef,
    name: string,
    fromSha: string,
  ): Promise<void> {
    await this.request(`/repos/${ref.owner}/${ref.repo}/git/refs`, {
      installationId,
      method: 'POST',
      body: { ref: `refs/heads/${name}`, sha: fromSha },
    })
  }

  async commitFiles(
    installationId: number,
    ref: GitHubRepoRef,
    input: CommitFilesInput,
  ): Promise<CommitFilesResult> {
    const base = `/repos/${ref.owner}/${ref.repo}/git`
    // 1. Resolve the branch tip (the parent commit) and its tree.
    const baseSha =
      input.baseSha ??
      (
        (await this.request(`${base}/ref/heads/${input.branch}`, { installationId })).json as {
          object?: { sha?: string }
        }
      ).object?.sha
    if (!baseSha) throw new Error(`Cannot resolve base commit for branch ${input.branch}`)
    const baseCommit = (await this.request(`${base}/commits/${baseSha}`, { installationId }))
      .json as { tree?: { sha?: string } }
    const baseTreeSha = baseCommit.tree?.sha

    // 2. Create a blob per file, then a tree referencing them. A deleted path is a tree
    // entry with `sha: null` against the `base_tree`, which removes it (the Git Data API's
    // delete encoding) — so a deterministic render that drops a path also prunes it.
    const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> =
      await Promise.all(
        input.files.map(async (file) => {
          const blob = (
            await this.request(`${base}/blobs`, {
              installationId,
              method: 'POST',
              body: { content: file.content, encoding: 'utf-8' },
            })
          ).json as { sha: string }
          return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha }
        }),
      )
    for (const path of input.deletions ?? []) {
      tree.push({ path, mode: '100644', type: 'blob', sha: null })
    }
    const newTree = (
      await this.request(`${base}/trees`, {
        installationId,
        method: 'POST',
        body: { base_tree: baseTreeSha, tree },
      })
    ).json as { sha: string }

    // 3. Create the commit and fast-forward the branch ref to it.
    const commit = (
      await this.request(`${base}/commits`, {
        installationId,
        method: 'POST',
        body: { message: input.message, tree: newTree.sha, parents: [baseSha] },
      })
    ).json as { sha: string }
    await this.request(`${base}/refs/heads/${input.branch}`, {
      installationId,
      method: 'PATCH',
      body: { sha: commit.sha },
    })
    return { sha: commit.sha }
  }

  async openPullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    input: OpenPullRequestInput,
  ): Promise<OpenedPullRequest> {
    try {
      const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls`, {
        installationId,
        method: 'POST',
        body: input,
      })
      return this.toOpenedPullRequest(json)
    } catch (err) {
      // Idempotency (see the RepoFiles/GitHubClient port doc): re-opening a PR for a head/base
      // that already has an open one is a 422 from GitHub ("A pull request already exists"). A
      // durable-driver replay of a committing post-op (e.g. the `spike` findings PR) hits this,
      // so treat it as a success: look up and return the existing open PR instead of failing.
      if (!(err instanceof GitHubApiError) || err.status !== 422) throw err
      const existing = await this.findOpenPullRequest(installationId, ref, input.head, input.base)
      if (!existing) throw err
      return existing
    }
  }

  /** Map a `/pulls` create/list payload to the {@link OpenedPullRequest} (projection + web url). */
  private toOpenedPullRequest(json: unknown): OpenedPullRequest {
    const p = json as gp.GhPullPayload
    // The projection drops `html_url` (not a sync field); the create/list response carries it, so
    // surface it as the `OpenedPullRequest.url` a post-op records on the block.
    const url = (json as { html_url?: string }).html_url ?? ''
    return {
      ...gp.toPullRequestProjection(p, gp.pullRepoGithubId(p) ?? 0, this.deps.clock.now()),
      url,
    }
  }

  /** The open PR matching `head`/`base` (for {@link openPullRequest}'s idempotent replay), or null. */
  private async findOpenPullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    head: string,
    base: string,
  ): Promise<OpenedPullRequest | null> {
    // GitHub filters `head` by `owner:branch`; the work branch lives on the target repo itself.
    const headFilter = head.includes(':') ? head : `${ref.owner}:${head}`
    const { json } = await this.request(
      `/repos/${ref.owner}/${ref.repo}/pulls?state=open&head=${encodeURIComponent(headFilter)}` +
        `&base=${encodeURIComponent(base)}&per_page=1`,
      { installationId },
    )
    const first = (json as gp.GhPullPayload[] | null)?.[0]
    return first ? this.toOpenedPullRequest(first) : null
  }

  async createIssue(
    installationId: number,
    ref: GitHubRepoRef,
    input: { title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}/issues`, {
      installationId,
      method: 'POST',
      body: { title: input.title, body: input.body },
    })
    const issue = (json ?? {}) as { number?: number; html_url?: string }
    return { number: issue.number ?? 0, url: issue.html_url ?? '' }
  }

  async updatePullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
  ): Promise<GitHubPullRequest> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${number}`, {
      installationId,
      method: 'PATCH',
      body: patch,
    })
    const p = json as gp.GhPullPayload
    return gp.toPullRequestProjection(p, gp.pullRepoGithubId(p) ?? 0, this.deps.clock.now())
  }

  /** The PR's current description, for the verification report's read-splice-write upsert. */
  async getPullRequestBody(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<string | null> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${number}`, {
      installationId,
    })
    return ((json ?? {}) as { body?: string | null }).body ?? null
  }

  async getPullRequestMergeability(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<{ mergeable: boolean | null; mergeableState: string; headSha: string | null }> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${number}`, {
      installationId,
    })
    const p = (json ?? {}) as {
      mergeable?: boolean | null
      mergeable_state?: string
      head?: { sha?: string }
    }
    return {
      mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
      mergeableState: typeof p.mergeable_state === 'string' ? p.mergeable_state : 'unknown',
      headSha: p.head?.sha ?? null,
    }
  }

  async mergePullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void> {
    await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${number}/merge`, {
      installationId,
      method: 'PUT',
      body: { merge_method: input?.method ?? 'merge' },
    })
  }

  async mergeBranch(
    installationId: number,
    ref: GitHubRepoRef,
    input: { base: string; head: string },
  ): Promise<'merged' | 'noop' | 'conflict'> {
    try {
      const { status } = await this.request(`/repos/${ref.owner}/${ref.repo}/merges`, {
        installationId,
        method: 'POST',
        body: { base: input.base, head: input.head },
      })
      // 201 → a merge commit was created; 204 → already up to date (nothing to merge).
      return status === 204 ? 'noop' : 'merged'
    } catch (err) {
      // 409 is GitHub's signal that the merge conflicts; the caller escalates from here.
      if (err instanceof GitHubApiError && err.status === 409) return 'conflict'
      throw err
    }
  }

  async deleteBranch(installationId: number, ref: GitHubRepoRef, branch: string): Promise<void> {
    try {
      await this.request(
        `/repos/${ref.owner}/${ref.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
        { installationId, method: 'DELETE' },
      )
    } catch (err) {
      // 404/422 mean the ref is already gone (or never existed) — treat as success so
      // deletion is idempotent for a caller that may retry or race a manual delete.
      if (err instanceof GitHubApiError && (err.status === 404 || err.status === 422)) return
      throw err
    }
  }

  async comment(
    installationId: number,
    ref: GitHubRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void> {
    await this.request(`/repos/${ref.owner}/${ref.repo}/issues/${issueOrPrNumber}/comments`, {
      installationId,
      method: 'POST',
      body: { body },
    })
  }

  async closeIssue(installationId: number, ref: GitHubRepoRef, number: number): Promise<void> {
    await this.request(`/repos/${ref.owner}/${ref.repo}/issues/${number}`, {
      installationId,
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'completed' },
    })
  }

  async applyIssueLabel(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    label: string,
  ): Promise<void> {
    // Ensure the label exists first — a 422 means it already does, which is fine.
    // (Relying on the add-labels endpoint to auto-create is undocumented behaviour.)
    // GitHub's create-label endpoint requires BOTH `name` and `color`; omitting the
    // colour makes every create fail 422 (missing field), which the catch below would
    // otherwise mistake for "already exists" — so send a neutral default colour.
    try {
      await this.request(`/repos/${ref.owner}/${ref.repo}/labels`, {
        installationId,
        method: 'POST',
        body: { name: label, color: DEFAULT_LABEL_COLOR },
      })
    } catch (err) {
      if (!(err instanceof GitHubApiError && err.status === 422)) throw err
    }
    await this.request(`/repos/${ref.owner}/${ref.repo}/issues/${number}/labels`, {
      installationId,
      method: 'POST',
      body: { labels: [label] },
    })
  }

  // ---- internals ----------------------------------------------------------

  /**
   * POST a GraphQL query/mutation to the v4 endpoint with the installation token and return
   * `data`, throwing on a GraphQL `errors` payload. Used for the review-thread reads/mutations
   * the REST API can't express (thread resolution state, resolveReviewThread).
   */
  private async graphql<T>(
    installationId: number,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const { json } = await this.request(`/graphql`, {
      installationId,
      method: 'POST',
      body: { query, variables },
    })
    const payload = json as { data?: T; errors?: { message?: string }[] }
    if (payload.errors && payload.errors.length > 0) {
      throw new GitHubApiError(
        200,
        `GitHub GraphQL error: ${payload.errors
          .map((e) => e.message ?? '')
          .join('; ')
          .slice(0, 300)}`,
      )
    }
    return (payload.data ?? ({} as T)) as T
  }

  /** Lazily resolve a repo's numeric id (needed where the payload omits it). Memoized
   * per `(installationId, owner, repo)` — the mapping is immutable, so repeated backfills
   * (list branches / issues / commits / check runs) reuse the single `/repos` read. */
  private async repoId(installationId: number, ref: GitHubRepoRef): Promise<number> {
    const key = repoIdCacheKey(installationId, ref)
    const cached = repoIdCache.get(key)
    if (cached !== undefined) return cached
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}`, { installationId })
    const id = (json as { id?: number }).id ?? 0
    // Only cache a resolved id; a 0 means the payload omitted it, so let a later call retry.
    if (id !== 0) repoIdCache.set(key, id)
    return id
  }

  /** Follow `Link` pagination, mapping each page, until exhausted/capped/`stop`. */
  private async paginate<T>(
    path: string,
    opts: Omit<RequestOptions, 'method' | 'body'>,
    map: (json: unknown) => T[],
    stop?: (page: T[]) => boolean,
  ): Promise<T[]> {
    const { items } = await walkPages(path, (url) => this.request(url, opts), map, stop)
    return items
  }

  private async request(pathOrUrl: string, opts: RequestOptions): Promise<GitHubResponse> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.deps.apiBase}${pathOrUrl}`
    const token =
      opts.auth === 'app'
        ? await this.deps.registry
            .authForApp(opts.appId ?? this.deps.registry.defaultAppId)
            .appJwt()
        : await this.deps.registry.installationToken(opts.installationId, {
            forceRefresh: opts.forceRefreshToken === true,
          })

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: ACCEPT,
      'user-agent': USER_AGENT,
      'x-github-api-version': API_VERSION,
    }
    if (opts.etag) headers['if-none-match'] = opts.etag
    if (opts.body !== undefined) headers['content-type'] = 'application/json'

    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    await this.recordRateLimit(opts.installationId, res)

    if (res.status === 304) return { status: 304, res, json: null, next: undefined }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const resetSec = numHeader(res, 'x-ratelimit-reset')
      const rateLimited = numHeader(res, 'x-ratelimit-remaining') === 0
      const body = text.slice(0, 300)
      throw new GitHubApiError(
        res.status,
        describeVcsApiError({
          provider: 'github',
          status: res.status,
          method: opts.method ?? 'GET',
          url,
          body,
          rateLimited,
          resetAt: resetSec === null ? null : resetSec * 1000,
        }),
        rateLimited,
        body,
      )
    }
    const json = res.status === 204 ? null : await res.json().catch(() => null)
    return {
      status: res.status,
      res,
      json,
      etag: res.headers.get('etag') ?? undefined,
      next: parseNextLink(res.headers.get('link')),
    }
  }

  private async recordRateLimit(installationId: number, res: Response): Promise<void> {
    const limit = numHeader(res, 'x-ratelimit-limit')
    const remaining = numHeader(res, 'x-ratelimit-remaining')
    const resetSec = numHeader(res, 'x-ratelimit-reset')
    if (limit === null && remaining === null) return
    const snapshot: RateLimitSnapshot = {
      installationId,
      resource: res.headers.get('x-ratelimit-resource') ?? 'core',
      limit,
      remaining,
      resetAt: resetSec === null ? null : resetSec * 1000,
      observedAt: this.deps.clock.now(),
    }
    // Best-effort: rate-limit accounting must never fail the actual call.
    await runBestEffort(
      logger,
      'github.recordRateLimit',
      () => this.deps.rateLimitRepository.record(snapshot),
      { installationId, resource: snapshot.resource },
    )
  }
}
