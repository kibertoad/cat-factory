import type { Clock } from '../../ports/runtime'
import type {
  ConfluenceConnectionRecord,
  ConfluenceConnectionRepository,
} from '../../ports/confluence-repositories'
import type { ConfluenceConnection } from '../../domain/types'
import { ConflictError } from '../../domain/errors'
import { requireWorkspace } from '../workspaces/WorkspaceService'
import type { WorkspaceRepository } from '../../ports/repositories'
import { assertSafeConfluenceBaseUrl } from './confluence.logic'

// ConfluenceConnectionService: owns the binding between a cat-factory workspace
// and a Confluence Cloud site. The connect flow stores the site URL, account
// email and API token; the import path resolves them to authenticate. The token
// is never exposed back to clients — only the safe connection metadata is.

export interface ConfluenceConnectionServiceDependencies {
  confluenceConnectionRepository: ConfluenceConnectionRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

function toConnection(record: ConfluenceConnectionRecord): ConfluenceConnection {
  return {
    baseUrl: record.baseUrl,
    accountEmail: record.accountEmail,
    connectedAt: record.createdAt,
  }
}

/** Drop a trailing slash and a trailing `/wiki` so we can build paths uniformly. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/wiki$/i, '')
}

export class ConfluenceConnectionService {
  constructor(private readonly deps: ConfluenceConnectionServiceDependencies) {}

  /** Connect (or re-connect) a workspace to a Confluence site. */
  async connect(
    workspaceId: string,
    input: { baseUrl: string; accountEmail: string; apiToken: string },
  ): Promise<ConfluenceConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    // Guard against SSRF: the stored base URL is later fetched with the
    // workspace's Confluence credentials, so it must be a public https host.
    assertSafeConfluenceBaseUrl(baseUrl)
    const existing = await this.deps.confluenceConnectionRepository.getByWorkspace(workspaceId)
    const record: ConfluenceConnectionRecord = {
      workspaceId,
      baseUrl,
      accountEmail: input.accountEmail.trim(),
      apiToken: input.apiToken,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.confluenceConnectionRepository.upsert(record)
    return toConnection(record)
  }

  /** The workspace's current connection, or null if not connected. */
  async getConnection(workspaceId: string): Promise<ConfluenceConnection | null> {
    const record = await this.deps.confluenceConnectionRepository.getByWorkspace(workspaceId)
    return record ? toConnection(record) : null
  }

  /** Resolve the live connection (with token) or throw if not connected. */
  async requireConnection(workspaceId: string): Promise<ConfluenceConnectionRecord> {
    const record = await this.deps.confluenceConnectionRepository.getByWorkspace(workspaceId)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' is not connected to Confluence`)
    }
    return record
  }

  /** Disconnect a workspace from Confluence (tombstones the binding). */
  async disconnect(workspaceId: string): Promise<void> {
    const record = await this.deps.confluenceConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return
    await this.deps.confluenceConnectionRepository.softDelete(workspaceId, this.deps.clock.now())
  }
}
