import type { Logger, OperationalMetrics } from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'
import type { ResolveRunInitiatorToken } from '../github/PatPreferringAppRegistry.js'
import type { MintInstallationToken } from './repoTargeting.js'

/**
 * The clone/push credential a container dispatch carries, built ONCE for every facade and every
 * dispatcher (the step executor, the repo bootstrapper, the env-config repairer, preview jobs).
 *
 * Two decisions live here, and both were previously copy-pasted per facade:
 *
 * 1. **Whose token.** The run initiator's stored PAT wins over the deployment credential where
 *    the account and the workspace both permit it. The "should we?" answer is
 *    `createResolveRunInitiatorToken`, shared with the engine's own GitHub client so an opted-out
 *    workspace cannot be honoured on one path and missed on another. A dispatcher with no
 *    initiator (the bootstrapper, a preview job) names no `initiatedBy`, and that chain answers
 *    null on its first question, so the same builder serves it without a second shape.
 * 2. **How wide.** A GitHub App token is narrowed with `repository_ids` to the repos THIS dispatch
 *    resolved (`jobTokenRepoIds`), so a fully compromised run reaches the repos the run was about
 *    rather than everything the installation covers (`backend/docs/security-model.md`, Layer 3).
 *
 * The two interact, which is the reason they belong in one place: scoping applies only to the App
 * mint. A PAT (the initiator's, local mode's `GITHUB_PAT`, a workspace's GitLab token) carries
 * whatever the human who created it granted, and `repository_ids` has no PAT equivalent, so a run
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
   * is wired, or this dispatcher has no initiator to act as, and the mint always uses the
   * deployment credential.
   */
  resolveRunInitiatorToken?: ResolveRunInitiatorToken
  logger?: Logger
  /**
   * REQUIRED, not optional: an un-wired counter reads as a ZERO, and a zero on this one asserts
   * "every dispatch was scoped", which is the exact claim it exists to check. A caller with
   * nothing to export passes kernel's `noopOperationalMetrics`, which says so in code.
   */
  operationalMetrics: OperationalMetrics
}

/**
 * How wide the token about to be minted may be, as one value rather than a nullable list, because
 * three cases take three different actions and two of them present as an absent scope.
 */
type TokenScope =
  /** No run context: an engine call on the platform's own behalf. Installation-wide by design. */
  | { kind: 'installation-wide' }
  /** The dispatch's repos, expressed as GitHub's `repository_ids`. */
  | { kind: 'repos'; repositoryIds: number[] }
  /**
   * The dispatch named a scope that cannot be expressed as GitHub repo ids: either it resolved
   * nothing at all, or a projection row carries an id GitHub would not recognise. The token is
   * still minted, installation-wide, and the widening is reported.
   */
  | { kind: 'unresolved'; repoIds: readonly string[] }

export function buildDispatchTokenMint(deps: DispatchTokenMintDependencies): MintInstallationToken {
  const log = deps.logger ?? noopLogger
  return async (installationId, ctx) => {
    if (deps.resolveRunInitiatorToken && ctx) {
      const pat = await deps.resolveRunInitiatorToken(ctx)
      if (pat) return pat
    }
    const scope = resolveTokenScope(ctx?.repoIds)
    if (scope.kind === 'repos') {
      return deps.mint(installationId, { repositoryIds: scope.repositoryIds })
    }
    if (scope.kind === 'unresolved') {
      // The dispatch is going to a container and could not say which repos it needs, so the token
      // about to be minted is wider than the run asked for. Widening is the right disposition (a
      // scope that dropped a leg would mint a token that cannot clone a repo the harness is told
      // to clone, turning a data problem into a failed run), but it must never be silent: the log
      // line names the run, and only the counter answers whether this is happening more than it
      // was. An EMPTY `repoIds` means the dispatcher resolved no repo at all; a non-empty one
      // means a repo projection row carries an id GitHub would not recognise.
      log.warn('dispatch token scope could not be applied, minting installation-wide', {
        installationId,
        ...(ctx?.executionId ? { executionId: ctx.executionId } : {}),
        ...(ctx?.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
        repoIds: scope.repoIds,
      })
      deps.operationalMetrics.increment('dispatch.token_scope_widened')
    }
    return deps.mint(installationId)
  }
}

/**
 * The neutral `VcsRepoRef.repoId` scope read as GitHub's `repository_ids`.
 *
 * A GitHub repo id is a positive integer that the projection stringifies, so this is the one place
 * the GitHub shape of those ids is re-asserted. The parse is deliberately STRICT (digits only: no
 * sign, exponent, fraction, surrounding whitespace or hex prefix) rather than `Number()` coercion.
 * The question being asked is whether the projection carries something GitHub will recognise, and
 * a string JavaScript merely happens to coerce to a number is not evidence of that.
 *
 * It is ALL-OR-NOTHING: a set with one unparseable member yields `unresolved` rather than the
 * parseable remainder, because the remainder is not the scope anyone asked for. GitHub would mint
 * a token that cannot reach a repo the job body still tells the harness to clone.
 */
function resolveTokenScope(repoIds: readonly string[] | undefined): TokenScope {
  if (!repoIds) return { kind: 'installation-wide' }
  if (repoIds.length === 0) return { kind: 'unresolved', repoIds }
  const repositoryIds: number[] = []
  for (const raw of repoIds) {
    if (!/^[1-9][0-9]*$/.test(raw)) return { kind: 'unresolved', repoIds }
    const id = Number(raw)
    if (!Number.isSafeInteger(id)) return { kind: 'unresolved', repoIds }
    repositoryIds.push(id)
  }
  return { kind: 'repos', repositoryIds }
}
