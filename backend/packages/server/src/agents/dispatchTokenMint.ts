import type { Logger, OperationalMetrics } from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'
import type { ResolveRunInitiatorToken } from '../github/PatPreferringAppRegistry.js'
import type { MintInstallationToken } from './repoTargeting.js'

/**
 * The clone/push credential a container dispatch carries, built ONCE for every facade.
 *
 * Two decisions live here, and both were previously copy-pasted per facade:
 *
 * 1. **Whose token.** The run initiator's stored PAT wins over the deployment credential where
 *    the account and the workspace both permit it. The "should we?" answer is
 *    `createResolveRunInitiatorToken`, shared with the engine's own GitHub client so an opted-out
 *    workspace cannot be honoured on one path and missed on another.
 * 2. **How wide.** A GitHub App token is narrowed with `repository_ids` to the repos THIS dispatch
 *    resolved (`jobTokenRepoIds`), so a fully compromised run reaches the repos the run was about
 *    rather than everything the installation covers (`backend/docs/security-model.md`, Layer 3).
 *
 * The two interact, which is the reason they belong in one place: scoping applies only to the App
 * mint. A PAT (the initiator's, local mode's `GITHUB_PAT`, a workspace's GitLab token) carries
 * whatever the human who created it granted, and `repository_ids` has no PAT equivalent — so a run
 * on an initiator's token silently returns to that token's own blast radius. That is a documented
 * property of allowing initiator PATs at all, not a fault of this path, and `allowInitiatorPat` is
 * the control for it.
 */
export interface DispatchTokenMintDependencies {
  /**
   * The deployment credential: the GitHub App registry's mint, or a facade override (local mode's
   * static PAT). Receives `repositoryIds` when the dispatch's scope maps onto GitHub repo ids; an
   * override that cannot narrow simply ignores the option.
   */
  mint: (installationId: number, opts?: { repositoryIds?: number[] }) => Promise<string>
  /**
   * Whether THIS run acts with its initiator's own GitHub token. Absent ⇒ no per-user secret store
   * is wired and the mint always uses the deployment credential.
   */
  resolveRunInitiatorToken?: ResolveRunInitiatorToken
  logger?: Logger
  operationalMetrics?: OperationalMetrics
}

export function buildDispatchTokenMint(deps: DispatchTokenMintDependencies): MintInstallationToken {
  const log = deps.logger ?? noopLogger
  return async (installationId, ctx) => {
    if (deps.resolveRunInitiatorToken && ctx) {
      const pat = await deps.resolveRunInitiatorToken(ctx)
      if (pat) return pat
    }
    const repositoryIds = githubRepositoryIds(ctx?.repoIds)
    if (repositoryIds === UNMAPPABLE_SCOPE) {
      // The dispatch NAMED a scope and it could not be expressed as GitHub repo ids, so the token
      // about to be minted is wider than the run asked for. Widening is the right disposition (a
      // scope that dropped a leg would mint a token that cannot clone a repo the harness is told
      // to clone, turning a data problem into a failed run), but it must never be silent: the log
      // line names the run, and only the counter answers whether this is happening more than it
      // was. It means a repo projection row carries an id GitHub would not recognise.
      log.warn('dispatch token scope could not be applied, minting installation-wide', {
        installationId,
        ...(ctx?.executionId ? { executionId: ctx.executionId } : {}),
        ...(ctx?.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
        repoIds: ctx?.repoIds,
      })
      deps.operationalMetrics?.increment('dispatch.token_scope_widened')
      return deps.mint(installationId)
    }
    return deps.mint(installationId, repositoryIds ? { repositoryIds } : undefined)
  }
}

/** The scope was named but does not map onto GitHub repo ids: distinct from "none was named". */
const UNMAPPABLE_SCOPE = Symbol('unmappable-repo-scope')

/**
 * The neutral `VcsRepoRef.repoId` scope as GitHub's `repository_ids`, or `undefined` when the
 * caller named no scope (the bootstrapper, the env-config repairer, tests) and the mint should stay
 * installation-wide.
 *
 * A GitHub repo id is a positive integer that the projection stringifies, so this is the one place
 * the GitHub shape of those ids is re-asserted. It is ALL-OR-NOTHING: a set with one unparseable
 * member yields {@link UNMAPPABLE_SCOPE} rather than the parseable remainder, because the remainder
 * is not the scope anyone asked for — GitHub would mint a token that cannot reach a repo the job
 * body still tells the harness to clone.
 */
function githubRepositoryIds(
  repoIds: readonly string[] | undefined,
): number[] | undefined | typeof UNMAPPABLE_SCOPE {
  if (!repoIds || repoIds.length === 0) return undefined
  const ids: number[] = []
  for (const raw of repoIds) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) return UNMAPPABLE_SCOPE
    ids.push(id)
  }
  return ids
}
