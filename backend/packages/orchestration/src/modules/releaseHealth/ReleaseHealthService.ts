import type {
  BlockRepository,
  Clock,
  ObservabilityConnectionRepository,
  ReleaseHealthConfigRepository,
  SecretCipher,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { assertFound, requireWorkspace } from '@cat-factory/kernel'
import type {
  ObservabilityConnectionView,
  ReleaseHealthConfigWire,
  UpsertObservabilityConnectionInput,
  UpsertReleaseHealthConfigInput,
} from '@cat-factory/contracts'
import { observabilityConnectionSummary } from '@cat-factory/contracts'

export interface ReleaseHealthServiceDependencies {
  observabilityConnectionRepository: ObservabilityConnectionRepository
  releaseHealthConfigRepository: ReleaseHealthConfigRepository
  /** Seals the observability credentials at rest (domain tag 'cat-factory:observability'). */
  observabilitySecretCipher: SecretCipher
  workspaceRepository: WorkspaceRepository
  /** Validates a per-block config targets a block that exists in the workspace. */
  blockRepository: BlockRepository
  clock: Clock
}

/**
 * Manages the post-release-health integration's settings for a workspace: the (single)
 * observability connection — provider-keyed, credentials sealed at rest as one JSON blob
 * and never read back — and the per-block monitor/SLO mappings the gate reads. Read paths
 * return redacted views (provider + a non-secret summary); the secrets only leave the
 * cipher inside the provider adapter at probe time.
 */
export class ReleaseHealthService {
  private readonly connections: ObservabilityConnectionRepository
  private readonly configs: ReleaseHealthConfigRepository
  private readonly cipher: SecretCipher
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blocks: BlockRepository
  private readonly clock: Clock

  constructor(deps: ReleaseHealthServiceDependencies) {
    this.connections = deps.observabilityConnectionRepository
    this.configs = deps.releaseHealthConfigRepository
    this.cipher = deps.observabilitySecretCipher
    this.workspaceRepository = deps.workspaceRepository
    this.blocks = deps.blockRepository
    this.clock = deps.clock
  }

  /** The workspace's observability connection, redacted (never returns the secret keys). */
  async getConnection(workspaceId: string): Promise<ObservabilityConnectionView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const connection = await this.connections.get(workspaceId)
    if (!connection) return { connected: false, provider: null, summary: null }
    return {
      connected: true,
      provider: connection.provider,
      summary: parseSummary(connection.summary),
    }
  }

  /** Set/replace the workspace's observability connection, sealing the credentials at rest. */
  async setConnection(
    workspaceId: string,
    input: UpsertObservabilityConnectionInput,
  ): Promise<ObservabilityConnectionView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const now = this.clock.now()
    const summary = observabilityConnectionSummary(input.provider, input.credentials)
    const credentials = await this.cipher.encrypt(JSON.stringify(input.credentials))
    const existing = await this.connections.get(workspaceId)
    await this.connections.upsert({
      workspaceId,
      provider: input.provider,
      credentials,
      summary: JSON.stringify(summary),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return { connected: true, provider: input.provider, summary }
  }

  async deleteConnection(workspaceId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.connections.delete(workspaceId)
  }

  /** The workspace's per-block monitor/SLO mappings. */
  async listConfigs(workspaceId: string): Promise<ReleaseHealthConfigWire[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const rows = await this.configs.listByWorkspace(workspaceId)
    return rows.map((r) => ({
      blockId: r.blockId,
      monitorIds: r.monitorIds,
      sloIds: r.sloIds,
      envTag: r.envTag,
    }))
  }

  /** Create/replace a block's release-health config. */
  async upsertConfig(
    workspaceId: string,
    blockId: string,
    input: UpsertReleaseHealthConfigInput,
  ): Promise<ReleaseHealthConfigWire> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    // The config is keyed by (workspace, block); reject a block that isn't in this
    // workspace so a config can't be planted against a foreign/non-existent block id.
    assertFound(await this.blocks.get(workspaceId, blockId), 'Block', blockId)
    const now = this.clock.now()
    const existing = await this.configs.getByBlock(workspaceId, blockId)
    const record = {
      workspaceId,
      blockId,
      monitorIds: input.monitorIds ?? [],
      sloIds: input.sloIds ?? [],
      envTag: input.envTag ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.configs.upsert(record)
    return {
      blockId: record.blockId,
      monitorIds: record.monitorIds,
      sloIds: record.sloIds,
      envTag: record.envTag,
    }
  }

  async deleteConfig(workspaceId: string, blockId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    assertFound(await this.blocks.get(workspaceId, blockId), 'Block', blockId)
    await this.configs.delete(workspaceId, blockId)
  }
}

/** Parse the stored non-secret summary JSON, tolerating a malformed/empty value. */
function parseSummary(raw: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : null
  } catch {
    return null
  }
}
