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
  toRepoProjection,
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
    const workspaceId = installation.workspaceId
    const now = this.deps.clock.now()

    switch (eventName) {
      case 'pull_request': {
        const pr = asObject(root.pull_request) as GhPullPayload | null
        if (!pr) return
        const repoId = pullRepoGithubId(pr) ?? this.repoIdOf(root)
        if (repoId === null) return
        await this.deps.pullRequestProjectionRepository.upsertMany(workspaceId, [
          toPullRequestProjection(pr, repoId, now),
        ])
        return
      }
      case 'issues': {
        const issue = asObject(root.issue) as GhIssuePayload | null
        const repoId = this.repoIdOf(root)
        if (!issue || repoId === null) return
        await this.deps.issueProjectionRepository.upsertMany(workspaceId, [
          toIssueProjection(issue, repoId, now),
        ])
        return
      }
      case 'push': {
        const repoId = this.repoIdOf(root)
        if (repoId === null) return
        // Update the pushed branch head and project the new commits.
        const ref = typeof root.ref === 'string' ? root.ref : ''
        const after = typeof root.after === 'string' ? root.after : ''
        if (ref.startsWith('refs/heads/') && after) {
          await this.deps.branchProjectionRepository.upsertMany(workspaceId, [
            {
              repoGithubId: repoId,
              name: ref.slice('refs/heads/'.length),
              headSha: after,
              protected: false,
              syncedAt: now,
            },
          ])
        }
        const commits = Array.isArray(root.commits) ? (root.commits as GhCommitPayload[]) : []
        if (commits.length > 0) {
          await this.deps.commitProjectionRepository.upsertMany(
            workspaceId,
            commits.map((c) => toCommitProjection(c, repoId, now)),
          )
        }
        return
      }
      case 'check_run': {
        const check = asObject(root.check_run) as GhCheckRunPayload | null
        const repoId = this.repoIdOf(root)
        if (!check || repoId === null) return
        await this.deps.checkRunProjectionRepository.upsertMany(workspaceId, [
          toCheckRunProjection(check, repoId, now),
        ])
        return
      }
      default:
        // Unhandled event kind: nothing to project incrementally.
        return
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

    // Lifecycle: suspend/uninstall tombstones the binding; (un)installing repos
    // adds/removes projected repos.
    if (eventName === 'installation') {
      if (action === 'deleted' || action === 'suspend') {
        await this.deps.githubInstallationRepository.softDelete(installationId, now)
      } else if (action === 'unsuspend') {
        await this.deps.githubInstallationRepository.upsert({ ...installation, deletedAt: null })
      }
      const repos = Array.isArray(root.repositories) ? (root.repositories as GhRepoPayload[]) : []
      if (repos.length > 0) {
        await this.deps.repoProjectionRepository.upsertMany(
          installation.workspaceId,
          repos.map((r) => toRepoProjection(r, installationId, now)),
        )
      }
      return
    }

    // installation_repositories: repositories_added / repositories_removed.
    const added = Array.isArray(root.repositories_added)
      ? (root.repositories_added as GhRepoPayload[])
      : []
    const removed = Array.isArray(root.repositories_removed)
      ? (root.repositories_removed as GhRepoPayload[])
      : []
    if (added.length > 0) {
      await this.deps.repoProjectionRepository.upsertMany(
        installation.workspaceId,
        added.map((r) => toRepoProjection(r, installationId, now)),
      )
    }
    for (const r of removed) {
      // Tombstone each removed repo by excluding it from the "seen" set.
      const remaining = (await this.deps.repoProjectionRepository.list(installation.workspaceId))
        .filter((repo) => repo.githubId !== r.id && repo.installationId === installationId)
        .map((repo) => repo.githubId)
      await this.deps.repoProjectionRepository.tombstoneMissing(
        installation.workspaceId,
        installationId,
        remaining,
        now,
      )
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
