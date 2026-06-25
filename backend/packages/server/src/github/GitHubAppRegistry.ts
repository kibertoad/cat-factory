import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  InstallationPermissions,
} from '@cat-factory/kernel'
import type { GitHubAppAuth } from './GitHubAppAuth.js'

// The multi-App resolver (ADR 0005, single-App-per-org model). A single GitHub
// App has one permission set across every installation, so to run sensitive orgs
// on a minimal grant while letting trusted orgs create repos we register two
// Apps:
//   - default (restricted) — minimal permissions; owns most installations.
//   - privileged           — carries `Administration: write`; an org installs it
//                            instead of (or alongside) the default App.
//
// An installation id belongs to exactly one App on GitHub, so each installation
// records its owning `appId` (probed at connect). This registry routes every
// token mint / app-JWT call to that App's key. Installations created before the
// tier have a null appId and are treated as the default App.

/** One configured App: its id and the auth that signs/mint for it. */
export interface RegisteredApp {
  appId: string
  auth: GitHubAppAuth
}

/**
 * The narrow token-minting surface {@link FetchGitHubClient} needs, so the client can
 * be driven by something OTHER than the App registry — e.g. a static-PAT source in
 * local mode. {@link GitHubAppRegistry} satisfies it structurally; a PAT source
 * implements `installationToken` to return the token and may throw on the app-JWT
 * paths (which only the installation discovery/listing calls use).
 */
export interface AppTokenSource {
  /** The default App id used for app-JWT calls that don't name one. */
  readonly defaultAppId: string
  /** Every configured App, iterated for cross-App installation discovery. */
  apps(): readonly { appId: string }[]
  /** The auth (app-JWT signer) for an appId. */
  authForApp(appId: string | null | undefined): { appJwt(): Promise<string> }
  /**
   * An installation token (the repo-call credential). `forceRefresh` bypasses any
   * cached token and mints a fresh one — used to defeat the in-memory token cache
   * after a permission/repo-access change on GitHub, since a token keeps its
   * grant-at-mint scopes and a stale one misreports a just-granted access.
   */
  installationToken(installationId: number, opts?: { forceRefresh?: boolean }): Promise<string>
}

export interface GitHubAppRegistryDependencies {
  /** The default (restricted) App — always present; owns legacy installations. */
  default: RegisteredApp
  /** The privileged App, when configured. */
  privileged?: RegisteredApp
  /** Resolves an installation's owning appId from its persisted binding. */
  installationRepository: GitHubInstallationRepository
}

// installationId → owning appId. The mapping is immutable on GitHub (an
// installation belongs to one App forever), so caching per-process is safe and
// spares a read on the hot token-mint path.
const ownerAppCache = new Map<number, string>()

export class GitHubAppRegistry {
  constructor(private readonly deps: GitHubAppRegistryDependencies) {}

  get defaultAppId(): string {
    return this.deps.default.appId
  }

  /** Every configured App, for cross-App discovery (connect probe, listing). */
  apps(): RegisteredApp[] {
    return this.deps.privileged ? [this.deps.default, this.deps.privileged] : [this.deps.default]
  }

  /** The auth for an appId, falling back to the default App for null/legacy/unknown ids. */
  authForApp(appId: string | null | undefined): GitHubAppAuth {
    if (appId && this.deps.privileged && appId === this.deps.privileged.appId) {
      return this.deps.privileged.auth
    }
    return this.deps.default.auth
  }

  /** An installation token, minted by the App that owns the installation. */
  async installationToken(
    installationId: number,
    opts?: { forceRefresh?: boolean },
  ): Promise<string> {
    return (await this.ownerAuth(installationId)).installationToken(installationId, opts)
  }

  /** The installation's granted permissions, via its owning App. */
  async installationPermissions(installationId: number): Promise<InstallationPermissions> {
    return (await this.ownerAuth(installationId)).installationPermissions(installationId)
  }

  /**
   * Whether this installation's owning App can create repos — i.e. it's the
   * privileged tier (ADR 0005). A null appId means the default App, which never
   * can. Used to flag `canCreateRepos` on the connection.
   */
  canCreateRepos(installation: GitHubInstallation): boolean {
    const owner = installation.appId ?? this.defaultAppId
    return this.deps.privileged !== undefined && owner === this.deps.privileged.appId
  }

  private async ownerAuth(installationId: number): Promise<GitHubAppAuth> {
    let appId = ownerAppCache.get(installationId)
    if (appId === undefined) {
      const record = await this.deps.installationRepository.getByInstallationId(installationId)
      appId = record?.appId ?? this.defaultAppId
      ownerAppCache.set(installationId, appId)
    }
    return this.authForApp(appId)
  }
}
