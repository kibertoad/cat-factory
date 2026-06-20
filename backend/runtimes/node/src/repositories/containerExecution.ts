import type {
  BlockRepository,
  GitHubInstallation,
  GitHubInstallationRepository,
  RunnerPoolConnectionRecord,
  RunnerPoolConnectionRepository,
} from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '@cat-factory/server'
import { and, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import {
  githubInstallations,
  githubRepos,
  runnerPoolConnections,
  workspaces,
} from '../db/schema.js'

// Drizzle/Postgres adapters for the persistence the container-agent execution path
// needs on the Node facade: a workspace's self-hosted runner-pool binding, its
// GitHub App installation, and the repo-target lookup that tells the harness which
// repo a run operates on. These mirror the Cloudflare D1 repositories
// (D1RunnerPoolConnectionRepository / D1GitHubInstallationRepository /
// buildResolveRepoTarget) column-for-column so behaviour matches across stores.

/** Postgres-backed store of workspace → runner-pool bindings (mirror of D1 migration 0013). */
export class DrizzleRunnerPoolConnectionRepository implements RunnerPoolConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByWorkspace(workspaceId: string): Promise<RunnerPoolConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(runnerPoolConnections)
      .where(
        and(
          eq(runnerPoolConnections.workspace_id, workspaceId),
          isNull(runnerPoolConnections.deleted_at),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      providerId: row.provider_id,
      label: row.label,
      baseUrl: row.base_url,
      manifestJson: row.manifest_json,
      secretsCipher: row.secrets_cipher,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
  }

  async upsert(record: RunnerPoolConnectionRecord): Promise<void> {
    // A workspace has a single live pool: clear any prior binding (live or
    // tombstoned) before inserting, so re-registering a different pool can't
    // collide on the (workspace_id, provider_id) primary key.
    await this.db
      .delete(runnerPoolConnections)
      .where(eq(runnerPoolConnections.workspace_id, record.workspaceId))
    await this.db.insert(runnerPoolConnections).values({
      workspace_id: record.workspaceId,
      provider_id: record.providerId,
      label: record.label,
      base_url: record.baseUrl,
      manifest_json: record.manifestJson,
      secrets_cipher: record.secretsCipher,
      created_at: record.createdAt,
      deleted_at: null,
    })
  }

  async softDelete(workspaceId: string, at: number): Promise<void> {
    await this.db
      .update(runnerPoolConnections)
      .set({ deleted_at: at })
      .where(
        and(
          eq(runnerPoolConnections.workspace_id, workspaceId),
          isNull(runnerPoolConnections.deleted_at),
        ),
      )
  }
}

function rowToInstallation(row: typeof githubInstallations.$inferSelect): GitHubInstallation {
  return {
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    accountId: row.account_id ?? null,
    accountLogin: row.account_login,
    targetType: row.target_type === 'Organization' ? 'Organization' : 'User',
    appId: row.app_id ?? null,
    cachedToken: row.cached_token,
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** Postgres-backed store of workspace → GitHub App installation bindings (mirror of D1 migration 0004). */
export class DrizzleGitHubInstallationRepository implements GitHubInstallationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByInstallationId(installationId: number): Promise<GitHubInstallation | null> {
    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installation_id, installationId))
      .limit(1)
    return rows[0] ? rowToInstallation(rows[0]) : null
  }

  async getByWorkspace(workspaceId: string): Promise<GitHubInstallation | null> {
    // Prefer the workspace's own direct binding (the connector, or the
    // auth-disabled path); else one shared via its account.
    const direct = await this.db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.workspace_id, workspaceId),
          isNull(githubInstallations.deleted_at),
        ),
      )
      .limit(1)
    if (direct[0]) return rowToInstallation(direct[0])

    const ws = await this.db
      .select({ accountId: workspaces.account_id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    const accountId = ws[0]?.accountId
    if (!accountId) return null
    const shared = await this.db
      .select()
      .from(githubInstallations)
      .where(
        and(eq(githubInstallations.account_id, accountId), isNull(githubInstallations.deleted_at)),
      )
      .limit(1)
    return shared[0] ? rowToInstallation(shared[0]) : null
  }

  async listWorkspacesForInstallation(installationId: number): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.installation_id, installationId),
          isNull(githubInstallations.deleted_at),
        ),
      )
      .limit(1)
    const install = rows[0]
    if (!install) return []
    const ids = new Set<string>([install.workspace_id])
    if (install.account_id) {
      const peers = await this.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.account_id, install.account_id))
      for (const p of peers) ids.add(p.id)
    }
    return [...ids]
  }

  async listActive(): Promise<GitHubInstallation[]> {
    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(isNull(githubInstallations.deleted_at))
    return rows.map(rowToInstallation)
  }

  async upsert(installation: GitHubInstallation): Promise<void> {
    const values = {
      installation_id: installation.installationId,
      workspace_id: installation.workspaceId,
      account_id: installation.accountId,
      account_login: installation.accountLogin,
      target_type: installation.targetType,
      app_id: installation.appId,
      cached_token: installation.cachedToken,
      token_expires_at: installation.tokenExpiresAt,
      created_at: installation.createdAt,
      deleted_at: installation.deletedAt,
    }
    await this.db
      .insert(githubInstallations)
      .values(values)
      .onConflictDoUpdate({ target: githubInstallations.installation_id, set: values })
  }

  async updateCachedToken(installationId: number, token: string, expiresAt: number): Promise<void> {
    await this.db
      .update(githubInstallations)
      .set({ cached_token: token, token_expires_at: expiresAt })
      .where(eq(githubInstallations.installation_id, installationId))
  }

  async softDelete(installationId: number, at: number): Promise<void> {
    await this.db
      .update(githubInstallations)
      .set({ deleted_at: at })
      .where(eq(githubInstallations.installation_id, installationId))
  }
}

/**
 * Resolve which repo (and installation) a run targets, mirroring the Worker's
 * `buildResolveRepoTarget`: find the GitHub installation backing the workspace,
 * then the projected repo linked to the service frame the block sits under (walking
 * up the parent chain). Returns null when GitHub isn't connected; throws when the
 * block isn't under a repo-linked service so the run fails with a clear reason
 * rather than guessing a repo.
 */
export function buildNodeResolveRepoTarget(
  db: DrizzleDb,
  installationRepository: GitHubInstallationRepository,
  blockRepository: BlockRepository,
): ResolveRepoTarget {
  return async (workspaceId, blockId) => {
    const installation = await installationRepository.getByWorkspace(workspaceId)
    if (!installation) return null
    const repos = await db
      .select()
      .from(githubRepos)
      .where(and(eq(githubRepos.workspace_id, workspaceId), isNull(githubRepos.deleted_at)))
    if (repos.length === 0) return null
    const linkedIds = new Set(repos.map((r) => r.block_id).filter((id): id is string => !!id))

    let linkedBlockId: string | undefined
    let cursor: string | null = blockId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (linkedIds.has(cursor)) {
        linkedBlockId = cursor
        break
      }
      seen.add(cursor)
      const block = await blockRepository.get(workspaceId, cursor)
      cursor = block?.parentId ?? null
    }

    const repo = repos.find((r) => r.block_id === linkedBlockId)
    if (!repo) {
      throw new Error(
        `Block '${blockId}' is not under a service linked to a GitHub repository ` +
          `(workspace '${workspaceId}'). Link the service frame to its repo so execution ` +
          `targets the right repository instead of guessing one.`,
      )
    }
    return {
      installationId: installation.installationId,
      owner: repo.owner,
      name: repo.name,
      baseBranch: repo.default_branch ?? 'main',
    }
  }
}
