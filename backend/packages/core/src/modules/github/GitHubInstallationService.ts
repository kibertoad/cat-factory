import type { Clock } from '../../ports/runtime'
import type { GitHubClient } from '../../ports/github-client'
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
} from '../../ports/github-repositories'
import type { GitHubConnection, GitHubInstallationOption } from '../../domain/types'
import { ConflictError } from '../../domain/errors'
import { requireWorkspace } from '../workspaces/WorkspaceService'
import type { WorkspaceRepository } from '../../ports/repositories'

// ---------------------------------------------------------------------------
// GitHubInstallationService: owns the binding between a cat-factory workspace
// and a GitHub App installation. The connect flow (after GitHub's setup
// callback) calls `connect` to fetch the installation's account metadata and
// persist the binding; write/resync endpoints call `requireInstallation` to
// resolve which installation's credentials to use.
// ---------------------------------------------------------------------------

export interface GitHubInstallationServiceDependencies {
  githubClient: GitHubClient
  githubInstallationRepository: GitHubInstallationRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /**
   * Whether cat-factory can create repos under an account itself (privileged App
   * tier, ADR 0005). Surfaced on the connection so the UI can drop the manual
   * "create on GitHub" step. Absent → always false (single-App default).
   */
  canCreateReposForOrg?: (accountLogin: string) => boolean
}

function toConnection(installation: GitHubInstallation, canCreateRepos: boolean): GitHubConnection {
  return {
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    targetType: installation.targetType,
    connectedAt: installation.createdAt,
    canCreateRepos,
  }
}

export class GitHubInstallationService {
  constructor(private readonly deps: GitHubInstallationServiceDependencies) {}

  /**
   * Bind a GitHub App installation to the workspace's account (idempotent on
   * re-install). Once bound, every workspace in that account shares it.
   */
  async connect(workspaceId: string, installationId: number): Promise<GitHubConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null

    // Guard against binding an installation that already belongs to a DIFFERENT
    // account. We reject regardless of the other binding's `deletedAt`: a
    // previously disconnected/suspended installation is still installed on GitHub
    // (its tokens still mint), so letting another tenant claim it would be an
    // account-takeover primitive. Sharing WITHIN the same account is fine — that's
    // the whole point — and the auth-disabled path (both accounts null) is
    // unrestricted, exactly like the rest of the dev path.
    const existing =
      await this.deps.githubInstallationRepository.getByInstallationId(installationId)
    if (
      existing &&
      existing.accountId !== null &&
      accountId !== null &&
      existing.accountId !== accountId
    ) {
      throw new ConflictError(
        `Installation ${installationId} is already connected to another account`,
      )
    }

    const meta = await this.deps.githubClient.getInstallation(installationId)
    const installation: GitHubInstallation = {
      installationId,
      workspaceId,
      accountId,
      accountLogin: meta.accountLogin,
      targetType: meta.targetType,
      cachedToken: null,
      tokenExpiresAt: null,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.githubInstallationRepository.upsert(installation)
    return toConnection(installation, this.canCreateRepos(installation.accountLogin))
  }

  /** Whether the privileged App tier can create repos under this account (ADR 0005). */
  private canCreateRepos(accountLogin: string): boolean {
    return this.deps.canCreateReposForOrg?.(accountLogin) ?? false
  }

  /**
   * Discover the App's installations so the connect UI can offer a pick instead
   * of a manually typed installation id. Each is annotated with whether it's
   * already bound — to THIS workspace, to ANOTHER (so connecting would be
   * rejected by {@link connect}), or to NONE (free to connect). The `connected`
   * computation mirrors that guard: a binding to another workspace counts as
   * taken even when soft-deleted (the installation still lives on GitHub), while
   * a soft-deleted binding to THIS workspace is re-connectable, so reported NONE.
   */
  async listAvailableInstallations(workspaceId: string): Promise<GitHubInstallationOption[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
    const installations = await this.deps.githubClient.listInstallations()
    return Promise.all(
      installations.map(async (i) => {
        const existing = await this.deps.githubInstallationRepository.getByInstallationId(
          i.installationId,
        )
        let connected: GitHubInstallationOption['connected'] = 'none'
        if (existing) {
          const sameAccount =
            existing.accountId !== null && accountId !== null && existing.accountId === accountId
          if (existing.workspaceId === workspaceId || sameAccount) {
            // Already available to this workspace (directly, or shared via account).
            if (!existing.deletedAt || sameAccount) connected = 'this'
          } else {
            connected = 'other'
          }
        }
        return { ...i, connected }
      }),
    )
  }

  /**
   * Resolve the workspace an installation is already bound to, or null if it's
   * unknown (or tombstoned). Used by the setup callback to recover from GitHub's
   * *stateless* redirects: saving a repo-access change from the App's
   * installation settings page redirects back with `setup_action=update` but no
   * signed `state`, so there's no workspace id to bind. We can only act on an
   * installation that's ALREADY bound — binding a NEW one still requires a state.
   */
  async resolveBoundWorkspace(installationId: number): Promise<string | null> {
    const existing =
      await this.deps.githubInstallationRepository.getByInstallationId(installationId)
    if (!existing || existing.deletedAt) return null
    return existing.workspaceId
  }

  /** The workspace's current connection, or null if not connected. */
  async getConnection(workspaceId: string): Promise<GitHubConnection | null> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return null
    return toConnection(installation, this.canCreateRepos(installation.accountLogin))
  }

  /** Resolve the live installation for a workspace, or throw if not connected. */
  async requireInstallation(workspaceId: string): Promise<GitHubInstallation> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) {
      throw new ConflictError(`Workspace '${workspaceId}' is not connected to GitHub`)
    }
    return installation
  }

  /** Disconnect a workspace from GitHub (tombstones the binding). */
  async disconnect(workspaceId: string): Promise<void> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return
    await this.deps.githubInstallationRepository.softDelete(
      installation.installationId,
      this.deps.clock.now(),
    )
  }
}
