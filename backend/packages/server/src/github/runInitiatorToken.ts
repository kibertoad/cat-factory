import type {
  InitiatorPatGate,
  Logger,
  ResolveUserGitHubToken,
  RunCredentialScope,
} from '@cat-factory/kernel'
import { describeError } from '@cat-factory/kernel'
import { resolveInitiatorTokenCached } from './runInitiatorContext.js'

// The ONE answer to "does THIS run act with its initiator's own GitHub token, or with the
// deployment credential?".
//
// Three sites ask it — the engine's GitHub client (`PatPreferringAppRegistry`: the CI gate,
// mergeability and the real merge) and the container-dispatch token mint on each facade — and
// each of them used to spell the rule out itself. That was fine while the rule was one line
// ("prefer the initiator's PAT when they stored one"); it stopped being fine the moment a
// workspace could REFUSE that preference, because three copies of a security decision are
// three chances for an opted-out workspace to still hand a run a member's account-wide token.
//
// See `backend/docs/security-model.md`, Layer 3: an initiator's PAT outranks the App token on
// the run path, and its scope is whatever the human who minted it granted — routinely wider
// than the installation the operator scoped.

export interface RunInitiatorTokenDependencies {
  /** Decrypts a user's stored `github_pat`. */
  resolveUserGitHubToken: ResolveUserGitHubToken
  /**
   * The workspace's `allowInitiatorPat` switch (kernel's `createInitiatorPatGate`). Absent ⇒
   * no settings store is wired, so there is no stored opt-out to honour and the preference
   * applies — the same reading kernel's gate takes.
   */
  initiatorPatGate?: InitiatorPatGate
  logger?: Logger
}

/**
 * Resolve the token a run should authenticate as, or null to fall back to the deployment
 * credential. Null is the answer for every "no" in the chain: no initiator, a workspace that
 * refused the preference, an initiator with no stored PAT — and for an unreadable policy.
 *
 * **The policy read fails CLOSED.** An unreadable settings row is not permission to widen a
 * run's credential, and the failure mode is deliberately the safe-but-visible one: the run
 * proceeds on the App installation token (narrower), attributed to the bot rather than to the
 * human, with the cause logged. The opposite choice would silently restore exactly the
 * behaviour an operator turned off.
 */
export function createResolveRunInitiatorToken(
  deps: RunInitiatorTokenDependencies,
): (scope: RunCredentialScope) => Promise<string | null> {
  const { resolveUserGitHubToken, initiatorPatGate, logger } = deps
  return async (scope) => {
    const initiatedBy = scope.initiatedBy
    if (!initiatedBy) return null
    if (initiatorPatGate) {
      let allowed: boolean
      try {
        allowed = await initiatorPatGate(scope.workspaceId)
      } catch (error) {
        logger?.warn(
          'workspace credential policy unreadable; running as the deployment credential ' +
            'instead of the initiator personal access token',
          { workspaceId: scope.workspaceId, ...describeError(error) },
        )
        return null
      }
      if (!allowed) return null
    }
    // Through the ambient scope's memo when there is one (the engine's probe/merge boundary
    // fans out into several requests); a plain resolve otherwise (the dispatch mint).
    return resolveInitiatorTokenCached(resolveUserGitHubToken, initiatedBy)
  }
}
