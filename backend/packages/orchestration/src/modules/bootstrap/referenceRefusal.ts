import {
  ConflictError,
  type ReferenceArchitectureRecord,
  type ReferenceRepoAccess,
  UnavailableError,
  ValidationError,
} from '@cat-factory/kernel'

// How a bootstrap run is REFUSED for the source control behind it: the connection it needs, and
// the reference template it was asked to build from. Pure mapping from a verdict to a domain
// error, extracted out of `BootstrapService` (which was over its size budget) because the rule
// is one cohesive thing and none of it touches a repository, a clock or the run's state: the
// service resolves the verdict and this decides what it means.

/**
 * The refusal for a workspace with no source-control connection to bootstrap through.
 *
 * ONE sentence, two raisers: the connection gate every run passes, and the reference-template
 * verdict that reports the same absence (a retry reaches the second without the first, since it
 * resolves the architecture rather than re-asking about the connection). Two literal copies of
 * one user-facing sentence drift the moment either is reworded.
 */
export function notConnected(): ConflictError {
  return new ConflictError(
    'Workspace is not connected to GitHub. Install the GitHub App for this workspace before bootstrapping a repository.',
    'github_not_connected',
  )
}

/**
 * Refuse a run whose reference template this workspace cannot reach, before anything is written.
 *
 * The check the flow was missing. A reference architecture is an admin-managed entry naming
 * `owner/name`, and nothing between typing it and the container's `git clone` ever asked the
 * provider whether that repository is there: a monorepo run answered by surveying the template as
 * unread (which reads to a reviewer as a template with no opinion, not as a template nobody
 * opened), and a new-repo run answered several minutes later with a clone failure, both with a job
 * row and a board card already left behind. The verdict is resolved through the BOOTSTRAPPER, so
 * the connection and the client asked are the ones the clone credential is minted from. Not the
 * same question as the clone's, though: it asks whether the template can be READ, and a public
 * repository the App was never granted answers yes to that and no to a scoped clone token, which
 * is refused at dispatch instead (see `ReferenceRepoAccess`).
 *
 * Three verdicts, three refusals, because they need three different next moves and only one of
 * them is about this run's inputs. Each carries the architecture's id and name, so the launch
 * dialog can open the entry that named the repository rather than only reporting a failure.
 */
export function assertReferenceUsable(
  reference: ReferenceArchitectureRecord,
  access: ReferenceRepoAccess,
): void {
  const repo = `${reference.repoOwner}/${reference.repoName}`
  const context = {
    referenceArchitectureId: reference.id,
    referenceArchitectureName: reference.name,
    repo,
  }
  switch (access.status) {
    case 'reachable':
      return
    case 'not_connected':
      throw notConnected()
    case 'not_found':
      throw new ValidationError(
        `The reference architecture "${reference.name}" points at ${repo}, which this workspace's source-control connection cannot see. Either it names the wrong repository, or the connection has not been granted access to it. Correct the reference architecture (or grant it access) and launch again: nothing has been created.`,
        { reason: 'reference_repo_not_found', ...context },
      )
    case 'unreadable':
      throw new UnavailableError(
        `${repo}, the repository behind the reference architecture "${reference.name}", could not be read just now, so this run was not started rather than started against a template it may be unable to clone. Nothing here is misconfigured: try again once the source-control connection recovers.`,
        'reference_repo_unreadable',
        { ...context, detail: access.detail },
      )
    default:
      return exhaustiveReferenceVerdict(access)
  }
}

/** Compile-time totality over the reference-repository verdict; see {@link assertReferenceUsable}. */
function exhaustiveReferenceVerdict(access: never): never {
  throw new Error(`Unhandled reference-repository verdict: ${JSON.stringify(access)}`)
}
