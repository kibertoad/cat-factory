import type { ResolveUserGitHubToken } from '@cat-factory/kernel'
import type { AppTokenSource } from './GitHubAppRegistry.js'
import { currentInitiator } from './runInitiatorContext.js'

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

  async installationToken(installationId: number): Promise<string> {
    const initiatedBy = currentInitiator()
    if (initiatedBy) {
      const pat = await this.resolveUserGitHubToken(initiatedBy)
      if (pat) return pat
    }
    return this.inner.installationToken(installationId)
  }
}
