import { createHash } from 'node:crypto'
import type { GitHubInstallation, GitHubInstallationRepository } from '@cat-factory/kernel'

// Local mode has no GitHub-App connect flow: a single developer runs the whole product
// against one PAT. So instead of binding a real App installation, every workspace is
// implicitly "connected" to the PAT. This module supplies the two pieces that makes the
// shared GitHub integration work that way:
//   - `syntheticInstallationId`: a stable per-workspace id (the projection rows the CLI
//     `linkRepo` helper and the in-UI link flow both write key off it, so they agree);
//   - `AutoProvisioningInstallationRepository`: a decorator that lazily materialises that
//     synthetic `github_installations` row the first time a workspace's installation is
//     read, so `getConnection` reports connected and the sync service has an
//     installation id to list/link repos under — no manual connect step.

/** A stable, positive, safe-integer installation id derived from the workspace id. */
export function syntheticInstallationId(workspaceId: string): number {
  // 48 bits keeps it well inside Number.MAX_SAFE_INTEGER and the bigint column; the value
  // is per-workspace (the table's workspace_id is unique) so two workspaces never collide,
  // and re-provisioning a workspace reuses the same id (upsert, not a new row).
  const hex = createHash('sha1').update(workspaceId).digest('hex').slice(0, 12)
  return Number.parseInt(hex, 16)
}

/** The PAT account a synthetic installation is attributed to (shown in the connect UI). */
export interface PatAccount {
  accountId: string | null
  accountLogin: string
  targetType: 'Organization' | 'User'
}

/**
 * Wraps a real {@link GitHubInstallationRepository} so that, in local PAT mode, a
 * workspace's installation is conjured on first read instead of requiring a connect flow.
 * Every method delegates to the inner repository; only {@link getByWorkspace} adds the
 * lazy provision (and only when no live row exists — a CLI-seeded or already-provisioned
 * row is returned untouched). The provisioned row carries the synthetic id, so a repo
 * later linked via the CLI lands under the same installation.
 */
export class AutoProvisioningInstallationRepository implements GitHubInstallationRepository {
  constructor(
    private readonly inner: GitHubInstallationRepository,
    private readonly resolveAccount: () => Promise<PatAccount>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getByWorkspace(workspaceId: string): Promise<GitHubInstallation | null> {
    const existing = await this.inner.getByWorkspace(workspaceId)
    if (existing && !existing.deletedAt) return existing
    const account = await this.resolveAccount()
    const installation: GitHubInstallation = {
      installationId: syntheticInstallationId(workspaceId),
      workspaceId,
      accountId: account.accountId,
      accountLogin: account.accountLogin,
      targetType: account.targetType,
      appId: null,
      cachedToken: null,
      tokenExpiresAt: null,
      createdAt: this.now(),
      deletedAt: null,
    }
    await this.inner.upsert(installation)
    return installation
  }

  getByInstallationId(installationId: number): Promise<GitHubInstallation | null> {
    return this.inner.getByInstallationId(installationId)
  }

  listByInstallationIds(installationIds: number[]): Promise<GitHubInstallation[]> {
    return this.inner.listByInstallationIds(installationIds)
  }

  listWorkspacesForInstallation(installationId: number): Promise<string[]> {
    return this.inner.listWorkspacesForInstallation(installationId)
  }

  listActive(): Promise<GitHubInstallation[]> {
    return this.inner.listActive()
  }

  upsert(installation: GitHubInstallation): Promise<void> {
    return this.inner.upsert(installation)
  }

  updateCachedToken(installationId: number, token: string, expiresAt: number): Promise<void> {
    return this.inner.updateCachedToken(installationId, token, expiresAt)
  }

  softDelete(installationId: number, at: number): Promise<void> {
    return this.inner.softDelete(installationId, at)
  }
}
