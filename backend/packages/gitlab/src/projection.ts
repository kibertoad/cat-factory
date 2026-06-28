import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Pure mappers from GitLab REST v4 payloads to the shared projection entities. The
// projection types are still GitHub-named (`GitHubRepo`, …) but their shapes are
// VCS-neutral — numeric ids + strings — so GitLab's project id / MR `iid` map onto them
// directly. A follow-up renames the entity types to neutral names; until then GitLab
// reuses them as-is.
//
// `repoId`/`projectId` is GitLab's numeric project id (the analogue of GitHub's repo
// id); MR/issue `iid` is the per-project number (the analogue of GitHub's PR/issue
// number); `id` is the global id.
// ---------------------------------------------------------------------------

export interface GlProjectPayload {
  id?: number
  path?: string
  path_with_namespace?: string
  name?: string
  default_branch?: string | null
  visibility?: string
  namespace?: { path?: string; full_path?: string }
}

export interface GlBranchPayload {
  name?: string
  protected?: boolean
  commit?: { id?: string }
}

export interface GlMergeRequestPayload {
  id?: number
  iid?: number
  title?: string
  state?: string
  source_branch?: string | null
  target_branch?: string | null
  sha?: string | null
  author?: { username?: string } | null
  updated_at?: string | null
}

export interface GlIssuePayload {
  id?: number
  iid?: number
  title?: string
  state?: string
  author?: { username?: string } | null
  labels?: Array<string | { name?: string }>
  updated_at?: string | null
}

export interface GlCommitPayload {
  id?: string
  message?: string
  author_name?: string | null
  authored_date?: string | null
}

export interface GlCommitStatusPayload {
  id?: number
  sha?: string
  name?: string
  status?: string
  target_url?: string | null
}

/** Owner (namespace) + name for a GitLab project, used to fill the neutral ref. */
export function projectOwnerName(p: GlProjectPayload): { owner: string; name: string } {
  const name = p.path ?? p.name ?? ''
  // `path_with_namespace` is `group/sub/project`; the owner is everything before the
  // final segment. Fall back to the namespace path.
  if (p.path_with_namespace && p.path_with_namespace.includes('/')) {
    return { owner: p.path_with_namespace.slice(0, p.path_with_namespace.lastIndexOf('/')), name }
  }
  return { owner: p.namespace?.full_path ?? p.namespace?.path ?? '', name }
}

export function toRepoProjection(
  p: GlProjectPayload,
  connectionNumericId: number,
  syncedAt: number,
): GitHubRepo {
  const { owner, name } = projectOwnerName(p)
  return {
    githubId: p.id ?? 0,
    installationId: connectionNumericId,
    owner,
    name,
    defaultBranch: p.default_branch ?? null,
    private: p.visibility !== 'public',
    blockId: null,
    syncedAt,
  }
}

export function toBranchProjection(
  b: GlBranchPayload,
  repoId: number,
  syncedAt: number,
): GitHubBranch {
  return {
    repoGithubId: repoId,
    name: b.name ?? '',
    headSha: b.commit?.id ?? '',
    protected: b.protected ?? false,
    syncedAt,
  }
}

/** Map GitLab's MR `state` to the neutral open/closed + merged flag. */
export function mrState(state: string | undefined): { state: 'open' | 'closed'; merged: boolean } {
  if (state === 'opened') return { state: 'open', merged: false }
  if (state === 'merged') return { state: 'closed', merged: true }
  // 'closed' | 'locked' | anything else
  return { state: 'closed', merged: false }
}

export function toMergeRequestProjection(
  mr: GlMergeRequestPayload,
  repoId: number,
  syncedAt: number,
): GitHubPullRequest {
  const { state, merged } = mrState(mr.state)
  return {
    repoGithubId: repoId,
    number: mr.iid ?? 0,
    githubId: mr.id ?? 0,
    title: mr.title ?? '',
    state,
    headRef: mr.source_branch ?? null,
    baseRef: mr.target_branch ?? null,
    headSha: mr.sha ?? null,
    merged,
    author: mr.author?.username ?? null,
    updatedAt: parseTime(mr.updated_at),
    syncedAt,
  }
}

export function toIssueProjection(
  i: GlIssuePayload,
  repoId: number,
  syncedAt: number,
): GitHubIssue {
  return {
    repoGithubId: repoId,
    number: i.iid ?? 0,
    githubId: i.id ?? 0,
    title: i.title ?? '',
    // GitLab issues are 'opened'/'closed'.
    state: i.state === 'opened' ? 'open' : 'closed',
    author: i.author?.username ?? null,
    labels: (i.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
      .filter(Boolean),
    updatedAt: parseTime(i.updated_at),
    syncedAt,
  }
}

export function toCommitProjection(
  c: GlCommitPayload,
  repoId: number,
  syncedAt: number,
): GitHubCommit {
  return {
    repoGithubId: repoId,
    sha: c.id ?? '',
    message: c.message ?? '',
    author: c.author_name ?? null,
    authoredAt: parseTime(c.authored_date),
    syncedAt,
  }
}

/**
 * Map a GitLab commit status / pipeline-job state to a GitHub-style check run so the
 * shared CI gate (`aggregateCi`) reduces it correctly. GitHub semantics: terminal
 * states are `status: 'completed'` with a `conclusion`; in-flight states are
 * `status: 'in_progress'` with a null conclusion.
 */
export function toCheckRunProjection(
  s: GlCommitStatusPayload,
  repoId: number,
  syncedAt: number,
): GitHubCheckRun {
  const { status, conclusion } = checkState(s.status)
  return {
    repoGithubId: repoId,
    githubId: s.id ?? 0,
    headSha: s.sha ?? '',
    name: s.name ?? '',
    status,
    conclusion,
    htmlUrl: s.target_url ?? null,
    syncedAt,
  }
}

/** GitLab pipeline/commit-status state → GitHub check `status` + `conclusion`. */
export function checkState(state: string | undefined): {
  status: string
  conclusion: string | null
} {
  switch (state) {
    case 'success':
      return { status: 'completed', conclusion: 'success' }
    case 'failed':
      return { status: 'completed', conclusion: 'failure' }
    case 'canceled':
    case 'cancelled':
      return { status: 'completed', conclusion: 'cancelled' }
    case 'skipped':
      return { status: 'completed', conclusion: 'skipped' }
    case 'manual':
      // Awaiting a manual action — neutral (don't block the gate on an optional job).
      return { status: 'completed', conclusion: 'neutral' }
    default:
      // created / waiting_for_resource / preparing / pending / running / scheduled
      return { status: 'in_progress', conclusion: null }
  }
}

/** GitLab's `merge_status` → the neutral mergeability triplet the gate normalises. */
export function mergeabilityFromStatus(mergeStatus: string | undefined): {
  mergeable: boolean | null
  mergeableState: string
} {
  switch (mergeStatus) {
    case 'can_be_merged':
      return { mergeable: true, mergeableState: 'clean' }
    case 'cannot_be_merged':
      // The GitHub mergeability provider treats `mergeable_state === 'dirty'` as conflicted.
      return { mergeable: false, mergeableState: 'dirty' }
    default:
      // 'unchecked' | 'checking' | 'cannot_be_merged_recheck' — still computing.
      return { mergeable: null, mergeableState: mergeStatus ?? 'unknown' }
  }
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}
