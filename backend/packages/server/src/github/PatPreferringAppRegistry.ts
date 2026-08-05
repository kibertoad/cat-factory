import type { InstallationPermissions, RunCredentialScope } from '@cat-factory/kernel'
import type { AppTokenSource } from './GitHubAppRegistry.js'
import { currentCredentialScope } from './runInitiatorContext.js'

// Decorates an {@link AppTokenSource} so the engine GitHub client (CI gate / merger /
// mergeability) mints the RUN INITIATOR's personal access token when they have one AND their
// workspace permits it, falling back to the wrapped source (the GitHub App installation token,
// or local mode's static env PAT) otherwise. The scope is read from the ambient
// `runInitiatorContext` set around the gate-probe / merge call boundaries.
//
// Generalizes local mode's `StaticTokenAppRegistry` swap (a constant token via the
// `installationToken()` seam) to "look up the initiator's PAT first". The app-JWT
// discovery/listing paths are unaffected — a PAT never participates in those.
//
// The "should we?" decision is NOT made here: it is `createResolveRunInitiatorToken`, shared
// with both facades' dispatch mints, so an opted-out workspace can't be honoured on one path
// and missed on another.

/** Resolves the token a run should act with, or null to use the wrapped source. */
export type ResolveRunInitiatorToken = (scope: RunCredentialScope) => Promise<string | null>

export class PatPreferringAppRegistry implements AppTokenSource {
  constructor(
    private readonly inner: AppTokenSource,
    private readonly resolveRunInitiatorToken: ResolveRunInitiatorToken,
  ) {}

  get defaultAppId(): string {
    return this.inner.defaultAppId
  }

  apps(): readonly { appId: string }[] {
    return this.inner.apps()
  }

  authForApp(appId: string | null | undefined): { appJwt(): Promise<string> } {
    return this.inner.authForApp(appId)
  }

  async installationToken(
    installationId: number,
    opts?: { forceRefresh?: boolean; repositoryIds?: number[] },
  ): Promise<string> {
    // Both options are moot for a PAT: it never expires the way an App token does, and
    // `repository_ids` scoping is an App-token mechanism with no PAT equivalent — a run on the
    // initiator's own token is bounded by that token, which is what `allowInitiatorPat` governs
    // (`backend/docs/security-model.md`, Layer 3). They matter only for the wrapped source below.
    const pat = await this.initiatorToken()
    if (pat) return pat
    return this.inner.installationToken(installationId, opts)
  }

  async installationPermissions(installationId: number): Promise<InstallationPermissions> {
    // When the initiator's PAT is in play the call rides a user token, which has no
    // App-granted permissions map — return empty so canPush falls back to the repo's
    // user-role `permissions.push` (which IS authoritative for a PAT). Otherwise defer
    // to the wrapped App source.
    if (await this.initiatorToken()) return {}
    return this.inner.installationPermissions(installationId)
  }

  /**
   * The initiator's token for the ambient run, or null outside a run scope / when the
   * decision says no. The resolve rides the scope's own memo, so the several requests one
   * probe fans out into pay a single DB read + decrypt.
   */
  private async initiatorToken(): Promise<string | null> {
    const scope = currentCredentialScope()
    return scope ? this.resolveRunInitiatorToken(scope) : null
  }
}
