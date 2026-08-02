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

/** One entry of `GET /merge_requests/:iid/diffs` (or the `changes[]` of `/changes`). */
export interface GlMrDiffPayload {
  old_path?: string
  new_path?: string
  diff?: string
  new_file?: boolean
  renamed_file?: boolean
  deleted_file?: boolean
  /** Set when GitLab omitted the hunk because the file's diff exceeds its size limit. */
  too_large?: boolean
  generated_file?: boolean
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
    // Reached through the connection's shared token, so visible to every member.
    linkedVia: 'app',
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

/**
 * A GitLab MR diff entry → the neutral {@link GitHubChangedFile} the PR-review slicer and the
 * merge track record's change classifier consume.
 *
 * Two mapping decisions carry weight:
 *
 * - **The status vocabulary is GitHub's**, because `classifyChangedFiles` and the reviewer prompt
 *   are written against it. GitLab reports the change as three independent booleans rather than a
 *   single status, and a renamed-AND-edited file sets `renamed_file` alone — so `renamed` wins over
 *   `modified` exactly as GitHub's own status does.
 * - **Line counts are COUNTED from the hunk**, since GitLab's diff payload carries no
 *   `additions`/`deletions`. That makes them exact when a hunk is present and honestly ZERO when it
 *   is not (a binary file, or one GitLab truncated as `too_large`) — the same shape GitHub reports
 *   for a patch-less file, so the slicer's cheap-field grouping behaves identically on both.
 */
export function toChangedFileProjection(d: GlMrDiffPayload): GitHubChangedFile {
  // `new_path` is empty only for a delete, where GitLab still fills it with the old path; prefer
  // it so the path always names the file as the reviewer will refer to it.
  const path = d.new_path || d.old_path || ''
  const patch = d.diff ? d.diff : null
  const { additions, deletions } = countDiffLines(d.diff)
  return {
    path,
    previousPath: d.renamed_file ? (d.old_path ?? null) : null,
    status: changedFileStatus(d),
    additions,
    deletions,
    patch,
  }
}

function changedFileStatus(d: GlMrDiffPayload): string {
  if (d.new_file) return 'added'
  if (d.deleted_file) return 'removed'
  if (d.renamed_file) return 'renamed'
  return 'modified'
}

/**
 * Count added/removed lines in a unified diff. `+++`/`---` are the file HEADERS, not content, and
 * `\ No newline at end of file` is a marker — counting any of them would inflate every file's
 * stats by a constant and skew the slicer's size-based grouping.
 */
function countDiffLines(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

/**
 * GitLab mergeability → the neutral triplet the conflicts gate normalises. Prefers
 * GitLab 15.6+ `detailed_merge_status` (precise) over the deprecated `merge_status`.
 *
 * Only a genuine textual `conflict` maps to GitHub's `dirty` state — the single signal
 * the `conflicts` gate escalates a conflict-resolver on. Every OTHER non-mergeable reason
 * (CI pending, unresolved discussions, behind target, draft, not open) is reported as
 * not-mergeable-but-not-`dirty`, so `classifyMergeability` returns `mergeable` (nothing to
 * resolve) and the gate advances instead of spuriously spawning a conflict-resolver.
 * `checking`/`unchecked` stay `mergeable: null` so the gate re-polls.
 */
export function mergeabilityFromStatus(
  detailedStatus: string | undefined,
  legacyStatus?: string | undefined,
): {
  mergeable: boolean | null
  mergeableState: string
} {
  if (detailedStatus) {
    switch (detailedStatus) {
      case 'mergeable':
        return { mergeable: true, mergeableState: 'clean' }
      case 'conflict':
        return { mergeable: false, mergeableState: 'dirty' }
      case 'checking':
      case 'unchecked':
        return { mergeable: null, mergeableState: detailedStatus }
      default:
        // not_open | draft_status | discussions_not_resolved | ci_must_pass |
        // ci_still_running | need_rebase | broken_status | commits_status | …
        return { mergeable: false, mergeableState: 'blocked' }
    }
  }
  switch (legacyStatus) {
    case 'can_be_merged':
      return { mergeable: true, mergeableState: 'clean' }
    case 'cannot_be_merged':
      // Ambiguous on the legacy field (a real conflict OR merely CI/discussions/draft).
      // Report not-mergeable WITHOUT the `dirty` conflict signal so the gate does not
      // escalate on a non-conflict block; `detailed_merge_status` (above) disambiguates.
      return { mergeable: false, mergeableState: 'blocked' }
    case 'checking':
    case 'unchecked':
    case 'cannot_be_merged_recheck':
      return { mergeable: null, mergeableState: legacyStatus }
    default:
      return { mergeable: null, mergeableState: legacyStatus ?? 'unknown' }
  }
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}
