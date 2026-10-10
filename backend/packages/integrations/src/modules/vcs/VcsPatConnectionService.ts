import type {
  Clock,
  GitHubConnection,
  GitHubInstallation,
  GitHubInstallationRepository,
  SecretCipher,
  VcsIdentityResolver,
  VcsProvider,
  VcsWebUrls,
} from '@cat-factory/kernel'
import { requireWorkspace, ValidationError, VcsIdentityError } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { syntheticInstallationId } from './syntheticInstallationId.js'

// ---------------------------------------------------------------------------
// VcsPatConnectionService: the per-workspace PAT connect flow, the analogue of
// `GitHubInstallationService` for providers that authenticate with a user/group token
// rather than a GitHub-App installation (GitLab today). A workspace connects by pasting a
// PAT; the service validates it against the provider's "current user" endpoint (the
// `VcsIdentityResolver`), seals it with the deployment `SecretCipher`, and writes a
// `github_installations` row stamped with the provider — reusing the projection tables
// (VCS-neutral in shape) and the whole `GitHubSyncService` seed path unchanged.
//
// The stored token is decrypted at call time by a per-connection token source
// (`StoredGitLabTokenSource`), keyed by the synthetic installation id. Unlike GitHub App
// installations there is NO account-level sharing: each workspace connects its own token,
// so `accountId` is null and the binding is always direct.
// ---------------------------------------------------------------------------

export interface VcsPatConnectionServiceDependencies {
  /** Which provider this service connects (matches the resolver + the stored `provider`). */
  provider: VcsProvider
  installations: GitHubInstallationRepository
  workspaceRepository: WorkspaceRepository
  /** Verifies the pasted PAT and returns the account it belongs to (throws on a bad token). */
  identityResolver: VcsIdentityResolver
  /** Seals the PAT at rest; the per-connection token source decrypts it at call time. */
  cipher: SecretCipher
  clock: Clock
  /**
   * The browser-facing host of each provider's configured instance, so the connection states
   * where its projects can be opened. Keyed by provider (rather than taking this service's own
   * provider's host directly) so it is the SAME value the App connect path and the connect-
   * capability route read. Absent for this provider ⇒ a null host, and its readers withhold the
   * links that needed one.
   */
  webUrls?: VcsWebUrls
}

function toConnection(installation: GitHubInstallation, webUrls: VcsWebUrls): GitHubConnection {
  return {
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    targetType: installation.targetType,
    connectedAt: installation.createdAt,
    provider: installation.provider,
    // A pasted token, so none of the GitHub-App affordances apply: there is no installation
    // whose repo access can be edited, and nothing for the UI to link to.
    method: 'pat',
    webUrl: webUrls[installation.provider] ?? null,
    // A per-workspace PAT connect does not (yet) drive in-app repo creation — the connect +
    // browse + link flow is the value; provisioning is a later slice. GitLab has no
    // GitHub-App-style `workflows: write` gate (a PAT with `api` scope pushes CI config), so
    // there is no workflow-permission warning to surface.
    canCreateRepos: false,
    canManageWorkflows: true,
  }
}

export class VcsPatConnectionService {
  constructor(private readonly deps: VcsPatConnectionServiceDependencies) {}

  /** The provider this service connects — what the connect-capability route advertises. */
  get provider(): VcsProvider {
    return this.deps.provider
  }

  /**
   * Connect (or re-connect) a workspace with a pasted PAT. Idempotent per workspace: the
   * installation id is derived from the workspace id, so re-connecting with a fresh token
   * replaces the sealed credential in place while preserving the original `connectedAt`.
   */
  async connect(workspaceId: string, pat: string): Promise<GitHubConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    // Validate the token BEFORE sealing/persisting anything, so we never write a connection that
    // can't authenticate. Distinguish the two failure classes rather than blanket-mapping every
    // throw to a 4xx: a provider 4xx (invalid/revoked token or missing scope) is a CLIENT error,
    // surfaced as a typed ValidationError (→ 4xx); a 5xx or a transport failure is TRANSIENT (the
    // provider is down, not the user's token), so we re-throw it to surface as a 500 with its
    // diagnostic intact — reporting "your token is invalid" for a provider outage would be wrong
    // and would discard the real cause. Other failures (cipher, DB) likewise propagate as 500s.
    let identity
    try {
      identity = await this.deps.identityResolver.resolveIdentity(pat)
    } catch (err) {
      // Only a provider 4xx is the token's fault. A 5xx (VcsIdentityError, not a client error) or
      // a transport failure (an ordinary Error, no status) is transient — re-throw it verbatim so
      // it surfaces as a 500 with its diagnostic, rather than blaming the user's token.
      if (err instanceof VcsIdentityError && err.isClientError) {
        throw new ValidationError(
          `That ${this.deps.provider} token is invalid or lacks the required access.`,
          { reason: 'invalid_token' },
        )
      }
      throw err
    }
    const sealed = await this.deps.cipher.encrypt(pat)
    const installationId = await syntheticInstallationId(workspaceId)

    // Tombstone a prior DIRECT connection for THIS workspace under a different installation id
    // (e.g. a previous GitHub-App binding), so the unique `(workspace_id) WHERE deleted_at IS
    // NULL` index holds. A row shared via account (a different connector workspace) has a
    // different workspace_id, so it neither conflicts nor may be touched here.
    const prior = await this.deps.installations.getByWorkspace(workspaceId)
    const priorDirect =
      prior && !prior.deletedAt && prior.workspaceId === workspaceId ? prior : null
    if (priorDirect && priorDirect.installationId !== installationId) {
      await this.deps.installations.softDelete(priorDirect.installationId, this.deps.clock.now())
    }
    const sameConnection = priorDirect?.installationId === installationId ? priorDirect : null

    const installation: GitHubInstallation = {
      installationId,
      workspaceId,
      // No account-level sharing for a per-workspace token: each workspace holds its own PAT.
      accountId: null,
      accountLogin: identity.login,
      // A PAT authenticates as a user; the account it can reach (groups/orgs) is a call-time
      // concern, not part of the binding.
      targetType: 'User',
      appId: null,
      provider: this.deps.provider,
      cachedToken: null,
      tokenExpiresAt: null,
      accessToken: sealed,
      createdAt: sameConnection?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.installations.upsert(installation)
    return toConnection(installation, this.deps.webUrls ?? {})
  }

  /** The workspace's current connection for this provider, or null when not connected. */
  async getConnection(workspaceId: string): Promise<GitHubConnection | null> {
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt || installation.provider !== this.deps.provider) {
      return null
    }
    return toConnection(installation, this.deps.webUrls ?? {})
  }

  /** Disconnect the workspace's connection for this provider (tombstones the binding). */
  async disconnect(workspaceId: string): Promise<void> {
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt || installation.provider !== this.deps.provider) {
      return
    }
    await this.deps.installations.softDelete(installation.installationId, this.deps.clock.now())
  }
}
