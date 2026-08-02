import type {
  GitHubBranch,
  GitHubChangedFile,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Pure mappers: GitHub JSON payloads → projection entities. Shared by the
// worker's fetch client (mapping REST responses) and the webhook consumer
// (mapping the resource objects embedded in delivery payloads), which carry the
// same shapes. Only the fields we project are typed; everything else is ignored.
// These functions are deterministic and have no I/O, so they unit-test cleanly.
// ---------------------------------------------------------------------------

/** Parse a GitHub ISO-8601 timestamp to epoch ms, or null if absent/invalid. */
export function isoToEpochMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

export interface GhRepoPayload {
  id: number
  name: string
  private?: boolean
  default_branch?: string | null
  owner?: { login?: string } | null
}

export function toRepoProjection(
  p: GhRepoPayload,
  installationId: number,
  syncedAt: number,
): GitHubRepo {
  return {
    githubId: p.id,
    installationId,
    owner: p.owner?.login ?? '',
    name: p.name,
    defaultBranch: p.default_branch ?? null,
    private: p.private ?? false,
    // Synced from the GitHub App installation, so App-reachable for every member.
    linkedVia: 'app',
    syncedAt,
  }
}

export interface GhBranchPayload {
  name: string
  commit?: { sha?: string } | null
  protected?: boolean
}

export function toBranchProjection(
  p: GhBranchPayload,
  repoGithubId: number,
  syncedAt: number,
): GitHubBranch {
  return {
    repoGithubId,
    name: p.name,
    headSha: p.commit?.sha ?? '',
    protected: p.protected ?? false,
    syncedAt,
  }
}

export interface GhPullPayload {
  id: number
  number: number
  title: string
  state: string
  merged?: boolean
  merged_at?: string | null
  updated_at?: string | null
  user?: { login?: string } | null
  head?: { ref?: string; sha?: string; repo?: { id?: number } | null } | null
  base?: { ref?: string; repo?: { id?: number } | null } | null
}

/** Resolve the repo a PR belongs to (base repo, falling back to head repo). */
export function pullRepoGithubId(p: GhPullPayload): number | null {
  return p.base?.repo?.id ?? p.head?.repo?.id ?? null
}

export function toPullRequestProjection(
  p: GhPullPayload,
  repoGithubId: number,
  syncedAt: number,
): GitHubPullRequest {
  return {
    repoGithubId,
    number: p.number,
    githubId: p.id,
    title: p.title,
    state: p.state === 'closed' ? 'closed' : 'open',
    headRef: p.head?.ref ?? null,
    baseRef: p.base?.ref ?? null,
    headSha: p.head?.sha ?? null,
    merged: p.merged ?? p.merged_at != null,
    author: p.user?.login ?? null,
    updatedAt: isoToEpochMs(p.updated_at),
    syncedAt,
  }
}

export interface GhIssuePayload {
  id: number
  number: number
  title: string
  state: string
  updated_at?: string | null
  user?: { login?: string } | null
  labels?: ({ name?: string } | string)[] | null
  /** Present when this "issue" is actually a pull request. */
  pull_request?: unknown
}

/** GitHub's issues API returns PRs too; this flags those so we can skip them. */
export function isPullRequest(p: GhIssuePayload): boolean {
  return p.pull_request != null
}

export function toIssueProjection(
  p: GhIssuePayload,
  repoGithubId: number,
  syncedAt: number,
): GitHubIssue {
  const labels = (p.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((l) => l !== '')
  return {
    repoGithubId,
    number: p.number,
    githubId: p.id,
    title: p.title,
    state: p.state === 'closed' ? 'closed' : 'open',
    author: p.user?.login ?? null,
    labels,
    updatedAt: isoToEpochMs(p.updated_at),
    syncedAt,
  }
}

export interface GhCommitPayload {
  sha?: string
  /** REST list-commits shape. */
  commit?: { message?: string; author?: { name?: string; date?: string } | null } | null
  author?: { login?: string } | null
  /** Push-webhook shape. */
  id?: string
  message?: string
  timestamp?: string
}

export function toCommitProjection(
  p: GhCommitPayload,
  repoGithubId: number,
  syncedAt: number,
): GitHubCommit {
  const sha = p.sha ?? p.id ?? ''
  const message = p.commit?.message ?? p.message ?? ''
  const author = p.author?.login ?? p.commit?.author?.name ?? null
  const authoredAt = isoToEpochMs(p.commit?.author?.date ?? p.timestamp)
  return { repoGithubId, sha, message, author, authoredAt, syncedAt }
}

export interface GhCheckRunPayload {
  id: number
  name: string
  status: string
  conclusion?: string | null
  head_sha: string
  html_url?: string | null
}

export function toCheckRunProjection(
  p: GhCheckRunPayload,
  repoGithubId: number,
  syncedAt: number,
): GitHubCheckRun {
  return {
    repoGithubId,
    githubId: p.id,
    headSha: p.head_sha,
    name: p.name,
    status: p.status,
    conclusion: p.conclusion ?? null,
    htmlUrl: p.html_url ?? null,
    syncedAt,
  }
}

/** One entry of `GET /repos/{o}/{r}/pulls/{n}/files`. */
export interface GhChangedFilePayload {
  filename?: string
  previous_filename?: string | null
  status?: string
  additions?: number
  deletions?: number
  patch?: string | null
}

/**
 * A GitHub PR file entry → the neutral {@link GitHubChangedFile} the PR-review slicer and the
 * merge track record's change classifier consume. Extracted from the fetch client so it sits
 * beside its GitLab counterpart (`@cat-factory/gitlab`'s `toChangedFileProjection`): the two
 * providers have to agree on what a neutral changed file MEANS, or every consumer downstream
 * means something different depending on where a repo happens to be hosted.
 *
 * The line counts are `?? null` — "the host did not report this" — and never `?? 0`. GitHub sends
 * both fields on every file in practice, INCLUDING a real `0` for a binary it cannot line-count,
 * so a missing field here is the shape of an unexpected payload rather than a routine case. The
 * distinction is load-bearing because zero is a CLAIM about the file (nothing changed) that the
 * reviewer acts on by skipping it, and it is a live case on GitLab, which reports no counts at all
 * and withholds the hunk they would be derived from once a diff is too large.
 */
export function toChangedFileProjection(f: GhChangedFilePayload): GitHubChangedFile {
  return {
    path: f.filename ?? '',
    previousPath: f.previous_filename ?? null,
    status: f.status ?? 'modified',
    additions: f.additions ?? null,
    deletions: f.deletions ?? null,
    patch: f.patch ?? null,
  }
}
