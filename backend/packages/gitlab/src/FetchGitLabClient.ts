import type {
  BranchUpdateOutcome,
  Clock,
  CommitFilesResult,
  GitHubBranch,
  GitHubCheckRun,
  GitHubCodeSearchHit,
  GitHubCommit,
  GitHubIssue,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
  GitHubPullRequest,
  GitHubPullRequestComment,
  GitHubPullRequestReview,
  GitHubRepo,
  GitHubReviewThread,
  ListOptions,
  Paged,
  RepoContentEntry,
  RepoEntry,
  RepoFileContent,
  VcsClient,
  VcsConnectionRef,
  VcsRepoRef,
} from '@cat-factory/kernel'
import type {
  CommitFilesInput,
  MergePullRequestInput,
  OpenPullRequestInput,
} from '@cat-factory/contracts'
import type { GitLabTokenSource } from './tokenSource.js'
import {
  type GlBranchPayload,
  type GlCommitPayload,
  type GlCommitStatusPayload,
  type GlIssuePayload,
  type GlMergeRequestPayload,
  type GlProjectPayload,
  mergeabilityFromStatus,
  toBranchProjection,
  toCheckRunProjection,
  toCommitProjection,
  toIssueProjection,
  toMergeRequestProjection,
  toRepoProjection,
} from './projection.js'

// ---------------------------------------------------------------------------
// Thin `fetch`-based VcsClient for GitLab (REST v4), the GitLab analogue of the
// GitHub `FetchGitHubClient`. It authenticates with a per-connection token
// (`PRIVATE-TOKEN` header), follows `Link` pagination up to a bounded number of
// pages, and maps responses to the shared projection entities via the pure mappers.
//
// Each method is keyed by a `VcsConnectionRef` (which connection's token) + a
// `VcsRepoRef` (which project). GitLab projects are addressed by their numeric id
// (the ref's `repoId`); when absent the URL-encoded `owner/repo` path is used.
// ---------------------------------------------------------------------------

const PER_PAGE = 100
const MAX_PAGES = 10
/** GitLab's MR rebase runs asynchronously; poll its status up to this many times. */
const REBASE_POLL_ATTEMPTS = 30
const REBASE_POLL_INTERVAL_MS = 1000

export interface FetchGitLabClientDependencies {
  tokenSource: GitLabTokenSource
  clock: Clock
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injected for tests; defaults to a `setTimeout`-based delay (used between rebase polls). */
  sleep?: (ms: number) => Promise<void>
  /**
   * Optional sink, warned when a listing hits the {@link MAX_PAGES} page cap with more
   * results still available — so a truncated sync is surfaced rather than silently dropped
   * (CLAUDE.md "no silent caps"). Defaults to no-op.
   */
  logger?: { warn: (message: string) => void }
}

interface RequestOptions {
  method?: string
  connection: VcsConnectionRef
  body?: unknown
}

interface GitLabResponse {
  status: number
  json: unknown
  /** Absolute URL of the next page, if any (`Link: rel="next"`). */
  next?: string
}

export class FetchGitLabClient implements VcsClient {
  constructor(private readonly deps: FetchGitLabClientDependencies) {}

  // ---- reads --------------------------------------------------------------

  async listRepos(connection: VcsConnectionRef): Promise<Paged<GitHubRepo>> {
    const syncedAt = this.deps.clock.now()
    const numericId = connectionNumericId(connection)
    const items = await this.paginate<GitHubRepo>(
      `/projects?membership=true&per_page=${PER_PAGE}`,
      { connection },
      (json) => (json as GlProjectPayload[]).map((p) => toRepoProjection(p, numericId, syncedAt)),
    )
    return { items }
  }

  async getRepo(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<GitHubRepo> {
    const { json } = await this.request(`/projects/${projectPath(ref)}`, { connection })
    return toRepoProjection(
      json as GlProjectPayload,
      connectionNumericId(connection),
      this.deps.clock.now(),
    )
  }

  async canPush(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<boolean> {
    try {
      const { json } = await this.request(`/projects/${projectPath(ref)}`, { connection })
      const p = json as {
        permissions?: {
          project_access?: { access_level?: number } | null
          group_access?: { access_level?: number } | null
        }
      }
      // GitLab access levels: 30 = Developer (can push to non-protected branches),
      // 40 = Maintainer, 50 = Owner. Developer+ is enough to push a work branch.
      const project = p.permissions?.project_access?.access_level ?? 0
      const group = p.permissions?.group_access?.access_level ?? 0
      return Math.max(project, group) >= 30
    } catch (err) {
      if (err instanceof GitLabApiError && (err.status === 403 || err.status === 404)) return false
      throw err
    }
  }

  async listBranches(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<Paged<GitHubBranch>> {
    const syncedAt = this.deps.clock.now()
    const repoId = numericRepoId(ref)
    const items = await this.paginate<GitHubBranch>(
      `/projects/${projectPath(ref)}/repository/branches?per_page=${PER_PAGE}`,
      { connection },
      (json) => (json as GlBranchPayload[]).map((b) => toBranchProjection(b, repoId, syncedAt)),
    )
    return { items }
  }

  async branchHeadSha(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    branch: string,
  ): Promise<string | null> {
    try {
      const { json } = await this.request(
        `/projects/${projectPath(ref)}/repository/branches/${encodeURIComponent(branch)}`,
        { connection },
      )
      return (json as GlBranchPayload).commit?.id ?? null
    } catch (err) {
      if (err instanceof GitLabApiError && err.status === 404) return null
      throw err
    }
  }

  async listRootEntries(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<RepoEntry[]> {
    return (await this.listDirectory(connection, ref, '')).map((e) => ({
      path: e.path,
      type: e.type,
    }))
  }

  async listDirectory(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoContentEntry[]> {
    const clean = path.replace(/^\/+|\/+$/g, '')
    const params = new URLSearchParams({ per_page: String(PER_PAGE) })
    if (clean) params.set('path', clean)
    if (gitRef) params.set('ref', gitRef)
    let json: unknown
    try {
      ;({ json } = await this.request(
        `/projects/${projectPath(ref)}/repository/tree?${params.toString()}`,
        { connection },
      ))
    } catch (err) {
      if (err instanceof GitLabApiError && err.status === 404) return []
      throw err
    }
    const entries = (Array.isArray(json) ? json : []) as Array<{
      path?: string
      name?: string
      type?: string
      id?: string
    }>
    // GitLab tree `type` is `blob` | `tree`; normalise to the neutral file/dir vocabulary.
    return entries.map((e) => ({
      path: e.path ?? e.name ?? '',
      name: e.name ?? (e.path ?? '').split('/').pop() ?? '',
      type: e.type === 'tree' ? 'dir' : 'file',
      sha: e.id ?? '',
    }))
  }

  async getFileContent(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoFileContent | null> {
    const clean = path.replace(/^\/+/, '')
    // GitLab's files API REQUIRES a concrete `ref` (branch/tag/commit); unlike GitHub it
    // does not default to the repo's default branch, and `HEAD` is not a reliable ref on
    // every instance. Resolve the project default branch when the caller passes none.
    const resolvedRef = gitRef ?? (await this.defaultBranch(connection, ref))
    const params = new URLSearchParams({ ref: resolvedRef })
    let json: unknown
    try {
      ;({ json } = await this.request(
        `/projects/${projectPath(ref)}/repository/files/${encodeURIComponent(clean)}?${params.toString()}`,
        { connection },
      ))
    } catch (err) {
      if (err instanceof GitLabApiError && err.status === 404) return null
      throw err
    }
    const file = json as { content?: string; encoding?: string; blob_id?: string }
    if (typeof file.content !== 'string') return null
    const content = file.encoding === 'base64' ? decodeBase64Utf8(file.content) : file.content
    return { content, sha: file.blob_id ?? '' }
  }

  async listPullRequests(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    opts: ListOptions = {},
  ): Promise<Paged<GitHubPullRequest>> {
    const syncedAt = this.deps.clock.now()
    const repoId = numericRepoId(ref)
    const since = opts.since ? `&updated_after=${encodeURIComponent(opts.since)}` : ''
    const items = await this.paginate<GitHubPullRequest>(
      `/projects/${projectPath(ref)}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=${PER_PAGE}${since}`,
      { connection },
      (json) =>
        (json as GlMergeRequestPayload[]).map((m) => toMergeRequestProjection(m, repoId, syncedAt)),
    )
    return { items }
  }

  async listIssues(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    opts: ListOptions = {},
  ): Promise<Paged<GitHubIssue>> {
    const syncedAt = this.deps.clock.now()
    const repoId = numericRepoId(ref)
    const since = opts.since ? `&updated_after=${encodeURIComponent(opts.since)}` : ''
    const items = await this.paginate<GitHubIssue>(
      `/projects/${projectPath(ref)}/issues?scope=all&order_by=updated_at&sort=desc&per_page=${PER_PAGE}${since}`,
      { connection },
      (json) => (json as GlIssuePayload[]).map((i) => toIssueProjection(i, repoId, syncedAt)),
    )
    return { items }
  }

  async getIssue(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    issueNumber: number,
  ): Promise<GitHubIssueDetail> {
    const base = `/projects/${projectPath(ref)}/issues/${issueNumber}`
    const { json } = await this.request(base, { connection })
    const issue = (json ?? {}) as GlIssuePayload & {
      description?: string
      web_url?: string
      assignee?: { username?: string } | null
    }
    const notesRes = await this.request(
      `${base}/notes?sort=asc&order_by=created_at&per_page=${PER_PAGE}`,
      {
        connection,
      },
    )
    const rawNotes = (notesRes.json ?? []) as Array<{
      body?: string
      created_at?: string
      system?: boolean
      author?: { username?: string } | null
    }>
    return {
      number: issue.iid ?? issueNumber,
      title: issue.title ?? '(untitled)',
      state: issue.state === 'opened' ? 'open' : 'closed',
      url: issue.web_url ?? '',
      author: issue.author?.username ?? null,
      assignee: issue.assignee?.username ?? null,
      labels: (issue.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
        .filter(Boolean),
      body: issue.description ?? '',
      // Skip GitLab "system" notes (label/assignee change events) — they are not human comments.
      comments: (Array.isArray(rawNotes) ? rawNotes : [])
        .filter((n) => !n.system)
        .map((n) => ({
          author: n.author?.username ?? '',
          createdAt: n.created_at ?? '',
          body: n.body ?? '',
        })),
    }
  }

  async searchIssues(
    connection: VcsConnectionRef,
    query: string,
    limit = 20,
  ): Promise<GitHubIssueSearchHit[]> {
    const per = Math.min(Math.max(limit, 1), 100)
    const { json } = await this.request(
      `/search?scope=issues&search=${encodeURIComponent(query)}&per_page=${per}`,
      { connection },
    )
    const items = (Array.isArray(json) ? json : []) as Array<{
      iid?: number
      title?: string
      state?: string
      web_url?: string
    }>
    const hits: GitHubIssueSearchHit[] = []
    for (const item of items) {
      const parts = parseProjectWebUrl(item.web_url ?? '')
      if (!parts) continue
      hits.push({
        owner: parts.owner,
        repo: parts.repo,
        number: item.iid ?? 0,
        title: item.title ?? '(untitled)',
        state: item.state === 'opened' ? 'open' : 'closed',
        url: item.web_url ?? '',
      })
    }
    return hits.slice(0, limit)
  }

  async searchCode(): Promise<GitHubCodeSearchHit[]> {
    // GitLab blob (code) search needs the instance's Advanced Search (Elasticsearch) and
    // does not return a usable `owner/repo/url` per hit on the basic API. The neutral
    // doc-search box degrades to "no results" rather than returning misleading hits.
    return []
  }

  async listCommits(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    opts: ListOptions & { sha?: string } = {},
  ): Promise<Paged<GitHubCommit>> {
    const syncedAt = this.deps.clock.now()
    const repoId = numericRepoId(ref)
    const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : ''
    const refName = opts.sha ? `&ref_name=${encodeURIComponent(opts.sha)}` : ''
    const items = await this.paginate<GitHubCommit>(
      `/projects/${projectPath(ref)}/repository/commits?per_page=${PER_PAGE}${since}${refName}`,
      { connection },
      (json) => (json as GlCommitPayload[]).map((c) => toCommitProjection(c, repoId, syncedAt)),
    )
    return { items }
  }

  async listCheckRuns(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    sha: string,
  ): Promise<Paged<GitHubCheckRun>> {
    const syncedAt = this.deps.clock.now()
    const repoId = numericRepoId(ref)
    const items = await this.paginate<GitHubCheckRun>(
      `/projects/${projectPath(ref)}/repository/commits/${encodeURIComponent(sha)}/statuses?per_page=${PER_PAGE}`,
      { connection },
      (json) =>
        (json as GlCommitStatusPayload[]).map((s) => toCheckRunProjection(s, repoId, syncedAt)),
    )
    return { items }
  }

  // ---- review reads (the human-review gate) -------------------------------

  async getPullRequestBaseRef(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<string | null> {
    try {
      const mr = await this.getMergeRequest(connection, ref, number)
      return mr.target_branch ?? null
    } catch (err) {
      if (err instanceof GitLabApiError && err.status === 404) return null
      throw err
    }
  }

  async listRequestedReviewers(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<string[]> {
    const mr = await this.getMergeRequest(connection, ref, number)
    return (mr.reviewers ?? []).map((r) => r.username ?? '').filter(Boolean)
  }

  async listPullRequestReviews(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GitHubPullRequestReview[]> {
    // GitLab models "approval" rather than GitHub's review-event log: there is one current
    // set of approvers, not a per-event history. Map each current approver to a single
    // standing APPROVED review — enough for the caller, which reduces to the latest review
    // per author and counts APPROVED. The approvals payload carries no per-approval
    // timestamp/commit, so `submittedAt` is 0 and `commitId` is null.
    const { json } = await this.request(
      `/projects/${projectPath(ref)}/merge_requests/${number}/approvals`,
      { connection },
    )
    const approvedBy =
      ((json ?? {}) as { approved_by?: Array<{ user?: { username?: string } | null }> })
        .approved_by ?? []
    return approvedBy
      .map((a) => a.user?.username ?? '')
      .filter(Boolean)
      .map((author) => ({ author, state: 'APPROVED', submittedAt: 0, commitId: null }))
  }

  async getRequiredApprovingReviewCount(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    _branch: string,
  ): Promise<number> {
    // GitLab's required-approval count is project- (or MR-) scoped, not keyed by branch on the
    // basic API (per-branch protected-branch approval rules need a premium tier + a different
    // endpoint). Read the project's `approvals_before_merge`; fall back to 1 when it is
    // unreadable — parity with the GitHub provider's unreadable-protection default.
    try {
      const { json } = await this.request(`/projects/${projectPath(ref)}/approvals`, { connection })
      const n = ((json ?? {}) as { approvals_before_merge?: number }).approvals_before_merge
      return typeof n === 'number' ? n : 1
    } catch (err) {
      if (err instanceof GitLabApiError && (err.status === 403 || err.status === 404)) return 1
      throw err
    }
  }

  async listReviewThreads(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GitHubReviewThread[]> {
    const discussions = await this.paginate<GlDiscussion>(
      `/projects/${projectPath(ref)}/merge_requests/${number}/discussions?per_page=${PER_PAGE}`,
      { connection },
      (json) => (Array.isArray(json) ? (json as GlDiscussion[]) : []),
    )
    const threads: GitHubReviewThread[] = []
    for (const d of discussions) {
      const notes = d.notes ?? []
      // Only diff/review discussions are "resolvable"; a plain conversation discussion (no
      // resolvable note) is not a review thread — those surface via listIssueComments.
      const resolvable = notes.filter((n) => n.resolvable && !n.system)
      if (resolvable.length === 0) continue
      const first = resolvable[0]!
      threads.push({
        // The reply/resolve endpoints are MR-scoped (`/merge_requests/:iid/discussions/:id`),
        // but the neutral reply/resolve calls receive ONLY the thread id — so carry the MR iid
        // alongside the discussion id in the opaque thread id (`<iid>:<discussionId>`). The
        // caller treats it as opaque and hands it back verbatim.
        id: `${number}:${d.id}`,
        isResolved: resolvable.every((n) => n.resolved),
        path: first.position?.new_path ?? first.position?.old_path ?? null,
        line: first.position?.new_line ?? first.position?.old_line ?? null,
        comments: resolvable.map((n) => ({
          author: n.author?.username ?? '',
          body: n.body ?? '',
          createdAt: epochMs(n.created_at),
        })),
      })
    }
    return threads
  }

  async listIssueComments(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GitHubPullRequestComment[]> {
    const notes = await this.paginate<GlNote>(
      `/projects/${projectPath(ref)}/merge_requests/${number}/notes?sort=asc&order_by=created_at&per_page=${PER_PAGE}`,
      { connection },
      (json) => (Array.isArray(json) ? (json as GlNote[]) : []),
    )
    // Conversation comments only: drop system notes (label/assignee events) and threaded
    // diff/discussion notes (those are review threads, surfaced via listReviewThreads). A
    // standalone MR comment has no `type`.
    return notes
      .filter((n) => !n.system && !n.type)
      .map((n) => ({
        id: String(n.id ?? ''),
        author: n.author?.username ?? '',
        body: n.body ?? '',
        createdAt: epochMs(n.created_at),
      }))
  }

  async replyToReviewThread(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    threadId: string,
    body: string,
  ): Promise<void> {
    const { iid, discussionId } = parseThreadId(threadId)
    const params = new URLSearchParams({ body })
    await this.request(
      `/projects/${projectPath(ref)}/merge_requests/${iid}/discussions/${discussionId}/notes?${params.toString()}`,
      { connection, method: 'POST' },
    )
  }

  async resolveReviewThread(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    threadId: string,
  ): Promise<void> {
    const { iid, discussionId } = parseThreadId(threadId)
    await this.request(
      `/projects/${projectPath(ref)}/merge_requests/${iid}/discussions/${discussionId}?resolved=true`,
      { connection, method: 'PUT' },
    )
  }

  // ---- writes -------------------------------------------------------------

  async createBranch(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    name: string,
    fromSha: string,
  ): Promise<void> {
    const params = new URLSearchParams({ branch: name, ref: fromSha })
    await this.request(`/projects/${projectPath(ref)}/repository/branches?${params.toString()}`, {
      connection,
      method: 'POST',
    })
  }

  async commitFiles(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    input: CommitFilesInput,
  ): Promise<CommitFilesResult> {
    // GitLab commits files atomically via a single actions[] payload. Each existing path
    // is an `update`; a path that doesn't exist yet must be `create`, so probe per file
    // against the parent the commit will build on: `baseSha` when the caller pinned one
    // (so the create/update classification matches the parent the commit is rooted at),
    // else the branch tip.
    const probeRef = input.baseSha ?? input.branch
    const actions: Array<{ action: string; file_path: string; content?: string }> = []
    for (const file of input.files) {
      const exists = (await this.getFileContent(connection, ref, file.path, probeRef)) !== null
      actions.push({
        action: exists ? 'update' : 'create',
        file_path: file.path,
        content: file.content,
      })
    }
    for (const path of input.deletions ?? []) {
      actions.push({ action: 'delete', file_path: path })
    }
    const body: Record<string, unknown> = {
      branch: input.branch,
      commit_message: input.message,
      actions,
    }
    // Pin the parent to `baseSha`: GitLab honours `start_sha` only when `branch` does not
    // yet exist (it creates the branch from that commit) — for an existing branch this API
    // always appends to the tip, so unlike the GitHub Git-Data path it cannot force a
    // specific parent. Passing it still gives the right parent on first-commit/branch-create.
    if (input.baseSha) body.start_sha = input.baseSha
    const { json } = await this.request(`/projects/${projectPath(ref)}/repository/commits`, {
      connection,
      method: 'POST',
      body,
    })
    return { sha: (json as { id?: string }).id ?? '' }
  }

  async createIssue(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    input: { title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const params = new URLSearchParams({ title: input.title, description: input.body })
    const { json } = await this.request(
      `/projects/${projectPath(ref)}/issues?${params.toString()}`,
      { connection, method: 'POST' },
    )
    const issue = (json ?? {}) as { iid?: number; web_url?: string }
    return { number: issue.iid ?? 0, url: issue.web_url ?? '' }
  }

  async closeIssue(connection: VcsConnectionRef, ref: VcsRepoRef, number: number): Promise<void> {
    await this.request(`/projects/${projectPath(ref)}/issues/${number}?state_event=close`, {
      connection,
      method: 'PUT',
    })
  }

  async openPullRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    input: OpenPullRequestInput,
  ): Promise<GitHubPullRequest> {
    const { json } = await this.request(`/projects/${projectPath(ref)}/merge_requests`, {
      connection,
      method: 'POST',
      body: {
        source_branch: input.head,
        target_branch: input.base,
        title: input.title,
        description: input.body ?? '',
      },
    })
    return toMergeRequestProjection(
      json as GlMergeRequestPayload,
      numericRepoId(ref),
      this.deps.clock.now(),
    )
  }

  async updatePullRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
  ): Promise<GitHubPullRequest> {
    const body: Record<string, unknown> = {}
    if (patch.title !== undefined) body.title = patch.title
    if (patch.body !== undefined) body.description = patch.body
    if (patch.base !== undefined) body.target_branch = patch.base
    if (patch.state === 'closed') body.state_event = 'close'
    if (patch.state === 'open') body.state_event = 'reopen'
    const { json } = await this.request(`/projects/${projectPath(ref)}/merge_requests/${number}`, {
      connection,
      method: 'PUT',
      body,
    })
    return toMergeRequestProjection(
      json as GlMergeRequestPayload,
      numericRepoId(ref),
      this.deps.clock.now(),
    )
  }

  async getPullRequestMergeability(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<{ mergeable: boolean | null; mergeableState: string; headSha: string | null }> {
    const { json } = await this.request(`/projects/${projectPath(ref)}/merge_requests/${number}`, {
      connection,
    })
    const mr = (json ?? {}) as {
      merge_status?: string
      detailed_merge_status?: string
      sha?: string | null
    }
    return {
      ...mergeabilityFromStatus(mr.detailed_merge_status, mr.merge_status),
      headSha: mr.sha ?? null,
    }
  }

  async mergePullRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void> {
    // GitLab's squash flag is per-merge; rebase is a separate endpoint. Map the neutral
    // method: 'squash' → squash=true, else a plain merge commit.
    const body: Record<string, unknown> = {}
    if (input?.method === 'squash') body.squash = true
    await this.request(`/projects/${projectPath(ref)}/merge_requests/${number}/merge`, {
      connection,
      method: 'PUT',
      body,
    })
  }

  async mergeBranch(
    _connection: VcsConnectionRef,
    _ref: VcsRepoRef,
    _input: { base: string; head: string },
  ): Promise<'merged' | 'noop' | 'conflict'> {
    // GitLab has no server-side "merge branch A into branch B" endpoint (the GitHub Merges
    // API analogue). The human-testing gate's "pull latest base into the branch" action is
    // therefore unsupported here; surface it explicitly rather than silently no-op.
    throw new GitLabApiError(
      501,
      'mergeBranch is not supported on GitLab (no server-side branch merge API).',
    )
  }

  async rebasePullRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<BranchUpdateOutcome> {
    // GitLab has no "merge branch A into B" endpoint, but the conflicts / human-testing gate
    // always operates on an open MR — and bringing an MR's source branch up to date with its
    // target branch IS the MR `rebase` endpoint. Kick it off, then poll the MR's rebase
    // status: `merge_error` set ⇒ the rebase conflicts (escalate to the conflict-resolver),
    // else the branch was updated ('merged'). Rebase is asynchronous, so poll with a bounded
    // delay between reads.
    await this.request(`/projects/${projectPath(ref)}/merge_requests/${number}/rebase`, {
      connection,
      method: 'PUT',
    })
    for (let attempt = 0; attempt < REBASE_POLL_ATTEMPTS; attempt++) {
      const { json } = await this.request(
        `/projects/${projectPath(ref)}/merge_requests/${number}?include_rebase_in_progress=true`,
        { connection },
      )
      const mr = (json ?? {}) as { rebase_in_progress?: boolean; merge_error?: string | null }
      if (!mr.rebase_in_progress) return mr.merge_error ? 'conflict' : 'merged'
      await (this.deps.sleep ?? defaultSleep)(REBASE_POLL_INTERVAL_MS)
    }
    // Still in progress after the cap: surface it (CLAUDE.md "no silent caps") and treat the
    // branch as updated — a genuine conflict still surfaces on the gate's next mergeability
    // probe, so we never wedge the gate on a slow rebase.
    this.deps.logger?.warn(
      `GitLab MR !${number} rebase still in progress after ${REBASE_POLL_ATTEMPTS} polls; treating as updated.`,
    )
    return 'merged'
  }

  async deleteBranch(connection: VcsConnectionRef, ref: VcsRepoRef, branch: string): Promise<void> {
    try {
      await this.request(
        `/projects/${projectPath(ref)}/repository/branches/${encodeURIComponent(branch)}`,
        { connection, method: 'DELETE' },
      )
    } catch (err) {
      if (err instanceof GitLabApiError && err.status === 404) return
      throw err
    }
  }

  async comment(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void> {
    // GitLab issues and MRs have SEPARATE iid spaces and distinct notes endpoints, so the
    // neutral `comment(number)` is ambiguous. The platform uses `comment` for PR/MR
    // conversation (the gates), so route to merge-request notes.
    const params = new URLSearchParams({ body })
    await this.request(
      `/projects/${projectPath(ref)}/merge_requests/${issueOrPrNumber}/notes?${params.toString()}`,
      { connection, method: 'POST' },
    )
  }

  // ---- internals ----------------------------------------------------------

  /** Read a single merge request's detail object (target branch, reviewers, …). */
  private async getMergeRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GlMrDetail> {
    const { json } = await this.request(`/projects/${projectPath(ref)}/merge_requests/${number}`, {
      connection,
    })
    return (json ?? {}) as GlMrDetail
  }

  /** Resolve a project's default branch (for the files API, which needs a concrete ref). */
  private async defaultBranch(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<string> {
    const repo = await this.getRepo(connection, ref)
    return repo.defaultBranch ?? 'HEAD'
  }

  private async paginate<T>(
    path: string,
    opts: Omit<RequestOptions, 'method' | 'body'>,
    map: (json: unknown) => T[],
  ): Promise<T[]> {
    const all: T[] = []
    let url: string | undefined = path
    let page = 0
    for (; url && page < MAX_PAGES; page++) {
      const response: GitLabResponse = await this.request(url, opts)
      all.push(...map(response.json))
      url = response.next
    }
    // A `next` link still set at the cap means GitLab had more pages we did not fetch.
    if (url) {
      this.deps.logger?.warn(
        `GitLab listing truncated at MAX_PAGES=${MAX_PAGES} (~${PER_PAGE * MAX_PAGES} items) for "${path}"; remaining results were dropped.`,
      )
    }
    return all
  }

  private async request(pathOrUrl: string, opts: RequestOptions): Promise<GitLabResponse> {
    const apiBase = this.deps.tokenSource.apiBase(opts.connection)
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${apiBase}${pathOrUrl}`
    const token = await this.deps.tokenSource.token(opts.connection)
    const headers: Record<string, string> = {
      'private-token': token,
      accept: 'application/json',
      'user-agent': 'cat-factory',
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json'

    const fetchImpl = this.deps.fetchImpl ?? fetch
    const res = await fetchImpl(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GitLabApiError(
        res.status,
        `GitLab ${opts.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    const json = res.status === 204 ? null : await res.json().catch(() => null)
    return { status: res.status, json, next: parseNextLink(res.headers.get('link')) }
  }
}

/** Carries the HTTP status so callers can decide whether to retry. */
export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GitLabApiError'
  }
}

/** The project segment for a path: prefer the numeric project id, else the encoded path. */
function projectPath(ref: VcsRepoRef): string {
  if (ref.repoId && /^\d+$/.test(ref.repoId)) return ref.repoId
  return encodeURIComponent(`${ref.owner}/${ref.repo}`)
}

/** The numeric project id used to stamp projection rows (0 when the ref carries a path). */
function numericRepoId(ref: VcsRepoRef): number {
  const n = Number(ref.repoId)
  return Number.isInteger(n) ? n : 0
}

/** A connection id stringified from a number maps back to a number for projection rows. */
function connectionNumericId(connection: VcsConnectionRef): number {
  const n = Number(connection.connectionId)
  return Number.isInteger(n) ? n : 0
}

/** Derive `{owner, repo}` from a GitLab issue/MR `web_url`. */
function parseProjectWebUrl(url: string): { owner: string; repo: string } | null {
  // e.g. https://gitlab.com/group/sub/project/-/issues/12
  const m = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|merge_requests)\//)
  if (!m) return null
  const full = m[1]!
  const idx = full.lastIndexOf('/')
  if (idx < 0) return { owner: '', repo: full }
  return { owner: full.slice(0, idx), repo: full.slice(idx + 1) }
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Parse an ISO timestamp to epoch ms (0 when absent/unparseable). */
function epochMs(iso?: string): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Recover the `{iid, discussionId}` from a review-thread id minted by {@link
 * FetchGitLabClient.listReviewThreads} (`<iid>:<discussionId>`). A discussion id can itself
 * contain no colon, so split on the FIRST colon only.
 */
function parseThreadId(threadId: string): { iid: number; discussionId: string } {
  const idx = threadId.indexOf(':')
  if (idx < 0) return { iid: 0, discussionId: threadId }
  return { iid: Number(threadId.slice(0, idx)) || 0, discussionId: threadId.slice(idx + 1) }
}

/** A merge-request detail object — the fields the review reads consume. */
interface GlMrDetail {
  target_branch?: string
  reviewers?: Array<{ username?: string }>
}

/** A single note within a GitLab MR discussion / the MR notes list. */
interface GlNote {
  id?: number
  body?: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  type?: string | null
  created_at?: string
  author?: { username?: string } | null
  position?: {
    new_path?: string | null
    old_path?: string | null
    new_line?: number | null
    old_line?: number | null
  } | null
}

/** A GitLab MR discussion (a thread of {@link GlNote}s). */
interface GlDiscussion {
  id: string
  notes?: GlNote[]
}
