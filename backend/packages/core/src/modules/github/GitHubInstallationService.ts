import type { Clock } from '../../ports/runtime'
import type { GitHubClient } from '../../ports/github-client'
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
} from '../../ports/github-repositories'
import type { GitHubConnection } from '../../domain/types'
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
}

function toConnection(installation: GitHubInstallation): GitHubConnection {
  return {
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    targetType: installation.targetType,
    connectedAt: installation.createdAt,
  }
}

export class GitHubInstallationService {
  constructor(private readonly deps: GitHubInstallationServiceDependencies) {}

  /** Bind a GitHub App installation to a workspace (idempotent on re-install). */
  async connect(workspaceId: string, installationId: number): Promise<GitHubConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)

    // Guard against binding an installation that already belongs elsewhere.
    const existing =
      await this.deps.githubInstallationRepository.getByInstallationId(installationId)
    if (existing && !existing.deletedAt && existing.workspaceId !== workspaceId) {
      throw new ConflictError(
        `Installation ${installationId} is already connected to another workspace`,
      )
    }

    const meta = await this.deps.githubClient.getInstallation(installationId)
    const installation: GitHubInstallation = {
      installationId,
      workspaceId,
      accountLogin: meta.accountLogin,
      targetType: meta.targetType,
      cachedToken: null,
      tokenExpiresAt: null,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.githubInstallationRepository.upsert(installation)
    return toConnection(installation)
  }

  /** The workspace's current connection, or null if not connected. */
  async getConnection(workspaceId: string): Promise<GitHubConnection | null> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return null
    return toConnection(installation)
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
