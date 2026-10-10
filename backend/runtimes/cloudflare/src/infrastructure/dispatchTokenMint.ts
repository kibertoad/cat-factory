import {
  buildDispatchTokenMint,
  type GitHubAppRegistry,
  logger,
  type MintInstallationToken,
  operationalMetrics,
} from '@cat-factory/server'

/**
 * The clone/push credential for a Worker container dispatch: the App registry's mint, narrowed by
 * the shared builder to the repos that dispatch resolved. Every Worker site that hands a container
 * a GitHub token goes through this, so none of them can quietly fall back to an installation-wide
 * one. No `resolveRunInitiatorToken`: the step executor composes its own mint with that chain (see
 * `container-executor-deps.ts`), while bootstrap, repair and the deploy clone have no initiator to
 * act as, and saying so once here beats three call sites each omitting it by accident.
 *
 * It sits in a LEAF module rather than in the composition root because three of its callers are
 * modules the root itself pulls in: importing it back out of `container.ts` made each of them
 * depend on the whole root, and for `containers/deployJobDeps.ts` (which the root re-exported) it
 * closed a genuine cycle that only stayed harmless while every reference sat inside a function
 * body.
 */
export function workerDispatchTokenMint(registry: GitHubAppRegistry): MintInstallationToken {
  return buildDispatchTokenMint({
    mint: (id, opts) => registry.installationToken(id, opts),
    logger,
    operationalMetrics,
  })
}
