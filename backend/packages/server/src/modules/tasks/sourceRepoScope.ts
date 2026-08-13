import type { TaskSourceKind, TaskSourceReadReason } from '@cat-factory/contracts'
import { ValidationError, type TaskSearchRepoScope } from '@cat-factory/kernel'
import type { Context } from 'hono'
import type { TasksModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

// Where a REPO-BACKED task source's repository comes from, for every surface that needs one.
//
// It lives here rather than in either controller because two of them ask the same question about
// the same fact: an issue search scopes its vendor query to the searching service's repository,
// and a bug hunt takes that repository AS its board. A second copy would be a second authority on
// which sources are repo-backed and on what an unlinked service means, and the drift is silent in
// the direction that matters: one surface refusing what the other scopes.

/**
 * Resolve the repository a REPO-BACKED source reads for, from the block the surface runs on (a
 * service frame, or a task/module under one). A service is always created from (or with) a repo,
 * so this REQUIRES the link: if it can't be resolved we refuse rather than silently widening
 * (the task couldn't run against an unlinked service anyway, and an unscoped vendor issue search
 * reaches every repository the credential can see, which under a PAT is all of public GitHub, or
 * every project on the GitLab instance).
 *
 * `null` means the SOURCE has no repository notion (Jira, Linear), never that this block has no
 * repo, which throws instead. Callers depend on the two being distinguishable: a repo-less source
 * is scoped by its own board, a repo-backed one by this.
 *
 * Which sources are repo-backed is read off the provider's declared `repoScope`, never a source id
 * compared here. A list in this function is a second authority that has to be edited in step with
 * the registry, and the failure when it is not is silent in exactly the wrong direction: the
 * provider refuses every search for want of a scope this function decided not to resolve, so a
 * source that imports fine can never be searched. An UNREGISTERED source resolves no scope and
 * reaches the service, which is where an unconfigured source is refused.
 */
export async function resolveSourceRepoScope<E extends AppEnv>(
  c: Context<E>,
  tasks: TasksModule,
  source: TaskSourceKind,
  blockId: string,
): Promise<TaskSearchRepoScope | null> {
  const provider = tasks.registry.get(source)
  if (!provider?.repoScope) return null
  const resolve = c.get('container').resolveRepoTarget
  let target: Awaited<ReturnType<NonNullable<typeof resolve>>> = null
  try {
    target = resolve ? await resolve(param(c, 'workspaceId'), blockId) : null
  } catch (err) {
    // `resolveRepoTarget` throws a ValidationError precisely when the block isn't under a
    // repo-linked service, the case this refuses below. Anything else (an unexpected repo/DB
    // failure) is NOT a "link a repo" problem, so let it propagate rather than mislabel it; only
    // the documented not-linked outcome falls through.
    if (!(err instanceof ValidationError)) throw err
    target = null
  }
  if (!target) {
    // A machine-readable reason so the SPA can render a localized message; the prose is the
    // untranslated last resort (CLAUDE.md "Backend strings"). It names no vendor, because the
    // link that is missing is the board's own service→repo link and the source asking for it
    // may be any repo-backed one: naming GitHub here sends a GitLab deployment to an
    // integration it does not run.
    throw new ValidationError(
      'This service is not linked to a repository. Link it to a repo before reading its issues.',
      { reason: 'repo_not_linked' satisfies TaskSourceReadReason },
    )
  }
  return { owner: target.owner, repo: target.name }
}

/**
 * The board a hunt scans: the resolved repository for a repo-backed source, else the board the
 * caller named.
 *
 * Both mismatches are REFUSED rather than reconciled, because each one means the caller and the
 * platform disagree about what is being scanned. A board named for a repo-backed source would be
 * ignored in favour of the service's repository, which answers a request to scan one place with a
 * scan of another; and a repo-less source with no board has nothing to narrow at all, which is the
 * unscoped vendor search every layer of this path exists to prevent.
 *
 * A repository becomes a board scope as its `owner/name` slug on BOTH repo-backed vendors: it is
 * exactly what their intake query legs (`githubRepo`, a GitLab `path_with_namespace`) are split
 * back out of, and a GitLab owner carrying a nested group path composes into the same shape.
 */
export function huntBoardScope(scope: TaskSearchRepoScope | null, named: string | null): string {
  if (scope) {
    if (named !== null) {
      throw new ValidationError(
        'This source hunts the repository its service is linked to, so it cannot be given a board.',
        { reason: 'board_from_service' satisfies TaskSourceReadReason },
      )
    }
    return `${scope.owner}/${scope.repo}`
  }
  if (named === null) {
    throw new ValidationError('Pick the board to hunt for bugs on.', {
      reason: 'missing_board' satisfies TaskSourceReadReason,
    })
  }
  return named
}
