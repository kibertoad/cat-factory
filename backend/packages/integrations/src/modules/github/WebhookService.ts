import type { Clock } from '@cat-factory/kernel'
import type {
  BranchProjectionRepository,
  CachedRepoRead,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubInstallationRepository,
  GitHubRepo,
  GroupCacheHandle,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import { repoFilesCacheGroup } from '@cat-factory/kernel'
import {
  type GhCheckRunPayload,
  type GhCommitPayload,
  type GhIssuePayload,
  type GhPullPayload,
  type GhRepoPayload,
  pullRepoGithubId,
  toCheckRunProjection,
  toCommitProjection,
  toIssueProjection,
  toPullRequestProjection,
} from './projection.logic.js'

// ---------------------------------------------------------------------------
// WebhookService: the *push* side of resync. A verified GitHub webhook delivery
// already embeds the changed resource (the PR, issue, commit, check-run), so the
// common events update the projection directly — no extra API round-trip. Heavy
// or ambiguous events fall back to a queued repo resync (the pull side).
//
// This runs in the queue consumer (after fast-ack verification at the edge), so
// it tolerates partial/unknown payloads and never throws on a field it doesn't
// recognise; it simply ignores what it can't map.
// ---------------------------------------------------------------------------

export interface WebhookServiceDependencies {
  githubInstallationRepository: GitHubInstallationRepository
  repoProjectionRepository: RepoProjectionRepository
  branchProjectionRepository: BranchProjectionRepository
  pullRequestProjectionRepository: PullRequestProjectionRepository
  issueProjectionRepository: IssueProjectionRepository
  commitProjectionRepository: CommitProjectionRepository
  checkRunProjectionRepository: CheckRunProjectionRepository
  clock: Clock
  /**
   * The workspace repo-projection cache (`AppCaches.repoProjection`, slice 3). The only
   * repo-projection write here is the installation-removed tombstone; it drops each
   * affected workspace's group so the resolver re-lists without the removed repos. The
   * push-event projections (branches/PRs/issues/commits/checks) are separate tables the
   * resolver never lists, so they don't invalidate it. Absent (tests / the Worker's
   * pass-through profile) ⇒ no-op.
   */
  repoProjectionCache?: GroupCacheHandle<GitHubRepo[]>
  /**
   * The checkout-free `RepoFiles` read cache (`AppCaches.repoFiles`, slice 4). A push moves a
   * branch, so its cached file/dir reads must drop — this is the invalidation site for a branch
   * advanced OUTSIDE the app's own `commitFiles` (which self-invalidates): an agent container's
   * git push, or a human editing the PR branch. Keyed per `(installation, owner, repo, branch)`
   * and workspace-independent, so it's ONE `invalidateGroup` per push (not per linked workspace).
   * Absent (tests / no cache) ⇒ no-op; the head-sha probe still bounds staleness regardless.
   */
  repoFilesCache?: GroupCacheHandle<CachedRepoRead>
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null ? (value as Json) : null
}

export class WebhookService {
  constructor(private readonly deps: WebhookServiceDependencies) {}

  /** Apply a verified webhook delivery to the local projections. */
  async handle(eventName: string, payload: unknown): Promise<void> {
    const root = asObject(payload)
    if (!root) return

    if (eventName === 'installation' || eventName === 'installation_repositories') {
      await this.handleInstallation(eventName, root)
      return
    }

    const installationId = this.installationIdOf(root)
    if (installationId === null) return
    const installation =
      await this.deps.githubInstallationRepository.getByInstallationId(installationId)
    if (!installation || installation.deletedAt) return
    const now = this.deps.clock.now()

    switch (eventName) {
      case 'pull_request': {
        const pr = asObject(root.pull_request) as GhPullPayload | null
        if (!pr) return
        const repoId = pullRepoGithubId(pr) ?? this.repoIdOf(root)
        if (repoId === null) return
        await this.forEachLinkedWorkspace(installationId, repoId, (ws) =>
          this.deps.pullRequestProjectionRepository.upsertMany(ws, [
            toPullRequestProjection(pr, repoId, now),
          ]),
        )
        return
      }
      case 'issues': {
        const issue = asObject(root.issue) as GhIssuePayload | null
        const repoId = this.repoIdOf(root)
        if (!issue || repoId === null) return
        await this.forEachLinkedWorkspace(installationId, repoId, (ws) =>
          this.deps.issueProjectionRepository.upsertMany(ws, [
            toIssueProjection(issue, repoId, now),
          ]),
        )
        return
      }
      case 'push': {
        const repoId = this.repoIdOf(root)
        if (repoId === null) return
        // Update the pushed branch head and project the new commits.
        const ref = typeof root.ref === 'string' ? root.ref : ''
        const after = typeof root.after === 'string' ? root.after : ''
        const commits = Array.isArray(root.commits) ? (root.commits as GhCommitPayload[]) : []
        await this.forEachLinkedWorkspace(installationId, repoId, async (ws) => {
          if (ref.startsWith('refs/heads/') && after) {
            await this.deps.branchProjectionRepository.upsertMany(ws, [
              {
                repoGithubId: repoId,
                name: ref.slice('refs/heads/'.length),
                headSha: after,
                protected: false,
                syncedAt: now,
              },
            ])
          }
          if (commits.length > 0) {
            await this.deps.commitProjectionRepository.upsertMany(
              ws,
              commits.map((c) => toCommitProjection(c, repoId, now)),
            )
          }
        })
        // Drop the pushed branch's cached RepoFiles reads (slice 4). Workspace-independent —
        // the cache is grouped by installation+repo+branch — so one call, outside the fan-out.
        if (ref.startsWith('refs/heads/') && this.deps.repoFilesCache) {
          const repo = asObject(root.repository)
          const owner = asObject(repo?.owner)?.login
          const name = repo?.name
          if (typeof owner === 'string' && typeof name === 'string') {
            await this.deps.repoFilesCache.invalidateGroup(
              repoFilesCacheGroup(installationId, owner, name, ref.slice('refs/heads/'.length)),
            )
          }
        }
        return
      }
      case 'check_run': {
        const check = asObject(root.check_run) as GhCheckRunPayload | null
        const repoId = this.repoIdOf(root)
        if (!check || repoId === null) return
        await this.forEachLinkedWorkspace(installationId, repoId, (ws) =>
          this.deps.checkRunProjectionRepository.upsertMany(ws, [
            toCheckRunProjection(check, repoId, now),
          ]),
        )
        return
      }
      default:
        // Unhandled event kind: nothing to project incrementally.
        return
    }
  }

  /**
   * Apply `project` to every workspace backed by this installation that actually
   * links the affected repo. Since repos are linked explicitly per workspace, an
   * event for a repo only updates the boards that chose to track it.
   */
  private async forEachLinkedWorkspace(
    installationId: number,
    repoGithubId: number,
    project: (workspaceId: string) => Promise<void>,
  ): Promise<void> {
    const workspaceIds =
      await this.deps.githubInstallationRepository.listWorkspacesForInstallation(installationId)
    if (workspaceIds.length === 0) return
    // One batched query resolves which of those workspaces link the repo — this runs on
    // every webhook delivery, so a per-workspace point-read here would be an N+1.
    const linked = await this.deps.repoProjectionRepository.linkedWorkspaces(
      repoGithubId,
      workspaceIds,
    )
    for (const ws of linked) await project(ws)
  }

  private async handleInstallation(eventName: string, root: Json): Promise<void> {
    const installationId = this.installationIdOf(root)
    if (installationId === null) return
    const installation =
      await this.deps.githubInstallationRepository.getByInstallationId(installationId)
    if (!installation) return
    const now = this.deps.clock.now()
    const action = typeof root.action === 'string' ? root.action : ''

    // Lifecycle: suspend/uninstall tombstones the binding (account-wide, since the
    // installation is shared); unsuspend revives it. Repos are NOT auto-projected
    // here — they are linked explicitly per workspace.
    if (eventName === 'installation') {
      if (action === 'deleted' || action === 'suspend') {
        await this.deps.githubInstallationRepository.softDelete(installationId, now)
      } else if (action === 'unsuspend') {
        await this.deps.githubInstallationRepository.upsert({ ...installation, deletedAt: null })
      }
      return
    }

    // installation_repositories: a removed repo is no longer accessible, so
    // tombstone it in every workspace that linked it. Added repos just become
    // available — the user links them explicitly, so we don't project them here.
    const removed = Array.isArray(root.repositories_removed)
      ? (root.repositories_removed as GhRepoPayload[])
      : []
    if (removed.length === 0) return
    const workspaceIds =
      await this.deps.githubInstallationRepository.listWorkspacesForInstallation(installationId)
    if (workspaceIds.length === 0) return
    // Narrow to the workspaces that actually track one of the removed repos (one batched
    // query per removed repo) before touching each one, instead of listing every
    // workspace's full repo projection.
    const removedIds = new Set(removed.map((r) => r.id))
    const affected = new Set<string>()
    for (const id of removedIds) {
      const linked = await this.deps.repoProjectionRepository.linkedWorkspaces(id, workspaceIds)
      for (const ws of linked) affected.add(ws)
    }
    for (const ws of affected) {
      const tracked = await this.deps.repoProjectionRepository.list(ws)
      const remaining = tracked
        .filter((repo) => repo.installationId === installationId && !removedIds.has(repo.githubId))
        .map((repo) => repo.githubId)
      await this.deps.repoProjectionRepository.tombstoneMissing(ws, installationId, remaining, now)
      await this.deps.repoProjectionCache?.invalidateGroup(ws)
    }
  }

  private installationIdOf(root: Json): number | null {
    const inst = asObject(root.installation)
    const id = inst?.id
    return typeof id === 'number' ? id : null
  }

  private repoIdOf(root: Json): number | null {
    const repo = asObject(root.repository)
    const id = repo?.id
    return typeof id === 'number' ? id : null
  }
}
