import type { InstallationPermissions, ResolveUserGitHubToken } from '@cat-factory/kernel'
import type { AppTokenSource } from './GitHubAppRegistry.js'
import { currentInitiator, resolveInitiatorTokenCached } from './runInitiatorContext.js'

// Decorates an {@link AppTokenSource} so the engine GitHub client (CI gate / merger /
// mergeability) mints the RUN INITIATOR's personal access token when they have one,
// falling back to the wrapped source (the GitHub App installation token, or local
// mode's static env PAT) otherwise. The initiator is read from the ambient
// `runInitiatorContext` set around the gate-probe / merge call boundaries.
//
// Generalizes local mode's `StaticTokenAppRegistry` swap (a constant token via the
// `installationToken()` seam) to "look up the initiator's PAT first". The app-JWT
// discovery/listing paths are unaffected — a PAT never participates in those.

export class PatPreferringAppRegistry implements AppTokenSource {
  constructor(
    private readonly inner: AppTokenSource,
    private readonly resolveUserGitHubToken: ResolveUserGitHubToken,
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
    opts?: { forceRefresh?: boolean },
  ): Promise<string> {
    const initiatedBy = currentInitiator()
    if (initiatedBy) {
      // The PAT is resolved through the ambient scope's memo, so a probe/merge that fans
      // out into several `request()`s does ONE DB read + decrypt. `forceRefresh` is moot
      // for a PAT (it never expires the way an App token does); it only matters for the
      // wrapped App-token cache below.
      const pat = await resolveInitiatorTokenCached(this.resolveUserGitHubToken, initiatedBy)
      if (pat) return pat
    }
    return this.inner.installationToken(installationId, opts)
  }

  async installationPermissions(installationId: number): Promise<InstallationPermissions> {
    // When the initiator's PAT is in play the call rides a user token, which has no
    // App-granted permissions map — return empty so canPush falls back to the repo's
    // user-role `permissions.push` (which IS authoritative for a PAT). Otherwise defer
    // to the wrapped App source.
    const initiatedBy = currentInitiator()
    if (
      initiatedBy &&
      (await resolveInitiatorTokenCached(this.resolveUserGitHubToken, initiatedBy))
    )
      return {}
    return this.inner.installationPermissions(installationId)
  }
}
