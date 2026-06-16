import {
  type Clock,
  type CommitFilesResult,
  type GitHubBranch,
  type GitHubCheckRun,
  type GitHubClient,
  type GitHubCommit,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubRepo,
  type GitHubRepoRef,
  type IdGenerator,
  type InstallationMeta,
  type InstallationSummary,
  type ListOptions,
  type MergePullRequestInput,
  type OpenPullRequestInput,
  type Paged,
  type RateLimitRepository,
  type RateLimitSnapshot,
  type RepoEntry,
  githubProjection as gp,
} from '@cat-factory/core'
import type { CommitFilesInput } from '@cat-factory/contracts'
import type { GitHubAppAuth } from './GitHubAppAuth'

// Thin `fetch`-based GitHubClient: the only place that talks to the GitHub REST
// API. It authenticates via the App (installation tokens for repo calls, the app
// JWT for installation-level calls), records a rate-limit snapshot on every
// response, follows `Link` pagination up to a bounded number of pages, and maps
// responses to projection entities with the shared pure mappers. Octokit is
// deliberately avoided — Web Crypto + fetch cover everything we need without the
// bundle weight (see backend/docs/adr/0001-github-app-integration.md).

const USER_AGENT = 'cat-factory'
const API_VERSION = '2022-11-28'
const ACCEPT = 'application/vnd.github+json'
const PER_PAGE = 100
const MAX_PAGES = 10

export interface FetchGitHubClientDependencies {
  auth: GitHubAppAuth
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
  etag?: string
  body?: unknown
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

export class FetchGitHubClient implements GitHubClient {
  constructor(private readonly deps: FetchGitHubClientDependencies) {}

  // ---- installation-level (app JWT) --------------------------------------

  async getInstallation(installationId: number): Promise<InstallationMeta> {
    const { json } = await this.request(`/app/installations/${installationId}`, {
      installationId,
      auth: 'app',
    })
    const body = json as { account?: { login?: string }; target_type?: string }
    return {
      accountLogin: body.account?.login ?? '',
      targetType: body.target_type === 'Organization' ? 'Organization' : 'User',
    }
  }

  async listInstallations(): Promise<InstallationSummary[]> {
    // App-JWT call, so no specific installation: pass 0 (used only for the
    // best-effort rate-limit snapshot). Paginates like the rest.
    return this.paginate<InstallationSummary>(
      `/app/installations?per_page=${PER_PAGE}`,
      { installationId: 0, auth: 'app' },
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
  }

  async listInstallationRepos(installationId: number): Promise<Paged<GitHubRepo>> {
    const syncedAt = this.deps.clock.now()
    const items = await this.paginate<GitHubRepo>(
      `/installation/repositories?per_page=${PER_PAGE}`,
      { installationId },
      (json) => {
        const repos = (json as { repositories?: gp.GhRepoPayload[] }).repositories ?? []
        return repos.map((r) => gp.toRepoProjection(r, installationId, syncedAt))
      },
    )
    return { items }
  }

  // ---- reads --------------------------------------------------------------

  async getRepo(installationId: number, ref: GitHubRepoRef): Promise<GitHubRepo> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}`, { installationId })
    return gp.toRepoProjection(json as gp.GhRepoPayload, installationId, this.deps.clock.now())
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

  async listRootEntries(installationId: number, ref: GitHubRepoRef): Promise<RepoEntry[]> {
    let json: unknown
    try {
      ;({ json } = await this.request(`/repos/${ref.owner}/${ref.repo}/contents/`, {
        installationId,
      }))
    } catch (err) {
      // An empty repository has no default branch, so the contents endpoint 404s.
      // That's the signal we want — treat it as "no entries", not an error.
      if (err instanceof GitHubApiError && err.status === 404) return []
      throw err
    }
    const entries = Array.isArray(json)
      ? (json as Array<{ path?: string; name?: string; type?: string }>)
      : []
    return entries.map((e) => ({ path: e.path ?? e.name ?? '', type: e.type ?? 'file' }))
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

    // 2. Create a blob per file, then a tree referencing them.
    const tree = await Promise.all(
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
  ): Promise<GitHubPullRequest> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls`, {
      installationId,
      method: 'POST',
      body: input,
    })
    const p = json as gp.GhPullPayload
    return gp.toPullRequestProjection(p, gp.pullRepoGithubId(p) ?? 0, this.deps.clock.now())
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

  // ---- internals ----------------------------------------------------------

  /** Lazily resolve a repo's numeric id (needed where the payload omits it). */
  private async repoId(installationId: number, ref: GitHubRepoRef): Promise<number> {
    const { json } = await this.request(`/repos/${ref.owner}/${ref.repo}`, { installationId })
    return (json as { id?: number }).id ?? 0
  }

  /** Follow `Link` pagination, mapping each page, until exhausted/capped/`stop`. */
  private async paginate<T>(
    path: string,
    opts: Omit<RequestOptions, 'method' | 'body'>,
    map: (json: unknown) => T[],
    stop?: (page: T[]) => boolean,
  ): Promise<T[]> {
    const all: T[] = []
    let url: string | undefined = path
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const response: GitHubResponse = await this.request(url, opts)
      if (response.status === 304) break
      const mapped = map(response.json)
      all.push(...mapped)
      if (stop?.(mapped)) break
      url = response.next
    }
    return all
  }

  private async request(pathOrUrl: string, opts: RequestOptions): Promise<GitHubResponse> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.deps.apiBase}${pathOrUrl}`
    const token =
      opts.auth === 'app'
        ? await this.deps.auth.appJwt()
        : await this.deps.auth.installationToken(opts.installationId)

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
      throw new GitHubApiError(
        res.status,
        `GitHub ${opts.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 300)}`,
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
    await this.deps.rateLimitRepository.record(snapshot).catch(() => {})
  }
}

/** Carries the HTTP status so callers/queue can decide whether to retry. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

function numHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}
