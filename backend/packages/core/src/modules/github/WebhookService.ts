import type { Clock } from '../../ports/runtime'
import type {
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubInstallationRepository,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
} from '../../ports/github-repositories'
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
} from './projection.logic'

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
    for (const ws of workspaceIds) {
      const repo = await this.deps.repoProjectionRepository.get(ws, repoGithubId)
      if (repo) await project(ws)
    }
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
    for (const ws of workspaceIds) {
      const tracked = await this.deps.repoProjectionRepository.list(ws)
      const removedIds = new Set(removed.map((r) => r.id))
      const remaining = tracked
        .filter((repo) => repo.installationId === installationId && !removedIds.has(repo.githubId))
        .map((repo) => repo.githubId)
      // Only rewrite when this workspace actually tracks one of the removed repos.
      if (remaining.length !== tracked.filter((r) => r.installationId === installationId).length) {
        await this.deps.repoProjectionRepository.tombstoneMissing(
          ws,
          installationId,
          remaining,
          now,
        )
      }
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
