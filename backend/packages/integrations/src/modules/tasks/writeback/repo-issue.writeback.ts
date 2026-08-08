import {
  ConflictError,
  UnavailableError,
  ValidationError,
  type GitHubClient,
  type GitHubInstallationRepository,
  type TaskInProgressMark,
  type TaskSourceWritebackAdapter,
  type TaskWritebackContext,
  type VcsProvider,
} from '@cat-factory/kernel'

// The writeback capability of the two REPO-BACKED task sources (GitHub Issues, GitLab Issues).
//
// One implementation serves both, because the difference between them is entirely in the values
// this factory takes: how an external id splits into `owner/repo#number`, which VCS provider the
// workspace's connection row must carry, how the vendor addresses an issue comment, and what a
// human calls the source. Both
// read through the SAME kernel `GitHubClient` port (the GitLab leg via `vcsBackedGitHubClient`),
// so a second copy would only be a place for the two to drift.
//
// Three rules bind every method here, each learned from the seams this replaced:
//
//  - **An unresolvable target THROWS.** Returning normally is the port's promise that the effect
//    landed, and the parked-review question echo records its idempotency marker on that promise.
//    A quiet return for a workspace whose installation is gone would mark the questions `posted`
//    for an issue that never received them, permanently suppressing the retry that reconnecting
//    should produce.
//  - **The connection is resolved per WORKSPACE, never per issue owner.** An external id names a
//    repository, not a tenant, so resolving by owner would let two workspaces that both linked
//    `acme/web#4` write through whichever installation happened to match first.
//  - **Which client method carries an issue comment is DECLARED, never probed.** They are the same
//    call only on GitHub, where issues and pull requests share one number space and one comment
//    API; on GitLab `comment` addresses MERGE REQUESTS, so an issue comment routed through it
//    lands on whatever MR shares the number. Whether a vendor separates them is a fact about the
//    vendor, so the source states it and a `??` fallback (which would silently reintroduce exactly
//    that cross-post on any client missing the dedicated method) is unspellable here.

export interface RepoIssueWritebackDependencies {
  /** The client that can read the workspace's connection for this source. */
  client: GitHubClient
  /** Resolves the workspace's VCS connection row. */
  installations: GitHubInstallationRepository
  /** Split a stored external id into its repo + issue number, or null when it does not parse. */
  parseExternalId(externalId: string): { owner: string; repo: string; number: number } | null
  /** The provider the workspace's connection row must carry for this source to be readable. */
  provider: VcsProvider
  /**
   * How this vendor's issue comments are addressed:
   *
   * - `shared-with-pull-requests` (GitHub): issues and PRs share one number space and one comment
   *   API, so the client's `comment` IS the issue comment.
   * - `dedicated` (GitLab): they are separate endpoints over separate `iid` spaces, so only
   *   `commentOnIssue` addresses an issue, and a client without it is REFUSED rather than fallen
   *   back from.
   */
  issueComments: 'shared-with-pull-requests' | 'dedicated'
  /** How the source is named in a refusal an operator reads (`GitHub`, `GitLab`). */
  label: string
}

/** Build the writeback adapter for a repo-backed issue source. */
export function createRepoIssueWriteback(
  deps: RepoIssueWritebackDependencies,
): TaskSourceWritebackAdapter {
  const target = async (ctx: TaskWritebackContext, externalId: string) => {
    const id = deps.parseExternalId(externalId)
    if (!id) {
      throw new ValidationError(`"${externalId}" is not a valid ${deps.label} issue reference`)
    }
    const connection = await deps.installations.getByWorkspace(ctx.workspaceId)
    if (!connection || connection.provider !== deps.provider) {
      throw new ConflictError(
        `This workspace has no ${deps.label} connection, so ${externalId} cannot be written back to.`,
      )
    }
    return {
      installationId: connection.installationId,
      ref: { owner: id.owner, repo: id.repo },
      id,
    }
  }

  return {
    async comment(ctx, externalId, body) {
      const { installationId, ref, id } = await target(ctx, externalId)
      if (deps.issueComments === 'shared-with-pull-requests') {
        await deps.client.comment(installationId, ref, id.number, body)
        return
      }
      const commentOnIssue = deps.client.commentOnIssue
      if (!commentOnIssue) {
        // Never a silent no-op and never a fall-through to `comment`: the fall-through is the
        // cross-posting bug the port doc names, and a no-op here would be recorded as delivered.
        throw new UnavailableError(
          `This deployment's ${deps.label} client cannot comment on issues.`,
        )
      }
      await commentOnIssue.call(deps.client, installationId, ref, id.number, body)
    },

    async resolve(ctx, externalId) {
      const { installationId, ref, id } = await target(ctx, externalId)
      await deps.client.closeIssue(installationId, ref, id.number)
    },

    /**
     * Neither vendor has a workflow status on an issue, so the in-progress mark IS the label.
     * A client without the label write refuses rather than commenting-without-marking: the
     * pickup's whole point is claiming the issue where it was filed, and an unmarked claim reads
     * to the next scan as an issue nobody took.
     */
    async markInProgress(ctx, externalId, mark: TaskInProgressMark) {
      const { installationId, ref, id } = await target(ctx, externalId)
      const applyLabel = deps.client.applyIssueLabel
      if (!applyLabel) {
        throw new UnavailableError(
          `This deployment's ${deps.label} client cannot apply an issue label, so a picked-up issue cannot be marked in progress.`,
        )
      }
      await applyLabel.call(
        deps.client,
        installationId,
        ref,
        id.number,
        mark.label ?? DEFAULT_IN_PROGRESS_LABEL,
      )
    },
  }
}

/** The label applied on pickup when the intake schedule names none. */
export const DEFAULT_IN_PROGRESS_LABEL = 'in-progress'
