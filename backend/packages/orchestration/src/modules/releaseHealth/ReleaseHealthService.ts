import type {
  Clock,
  DatadogConnectionRepository,
  ReleaseHealthConfigRepository,
  SecretCipher,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type {
  DatadogConnectionView,
  ReleaseHealthConfigWire,
  UpsertDatadogConnectionInput,
  UpsertReleaseHealthConfigInput,
} from '@cat-factory/contracts'

export interface ReleaseHealthServiceDependencies {
  datadogConnectionRepository: DatadogConnectionRepository
  releaseHealthConfigRepository: ReleaseHealthConfigRepository
  /** Seals the Datadog API/app keys at rest (domain tag 'cat-factory:datadog'). */
  datadogSecretCipher: SecretCipher
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/**
 * Manages the post-release-health integration's settings for a workspace: the (single)
 * Datadog connection — credentials sealed at rest, never read back — and the per-block
 * monitor/SLO mappings the gate reads. Read paths return redacted views; the secrets
 * only leave the cipher inside the `DatadogReleaseHealthProvider` at probe time.
 */
export class ReleaseHealthService {
  private readonly connections: DatadogConnectionRepository
  private readonly configs: ReleaseHealthConfigRepository
  private readonly cipher: SecretCipher
  private readonly workspaceRepository: WorkspaceRepository
  private readonly clock: Clock

  constructor(deps: ReleaseHealthServiceDependencies) {
    this.connections = deps.datadogConnectionRepository
    this.configs = deps.releaseHealthConfigRepository
    this.cipher = deps.datadogSecretCipher
    this.workspaceRepository = deps.workspaceRepository
    this.clock = deps.clock
  }

  /** The workspace's Datadog connection, redacted (never returns the secret keys). */
  async getConnection(workspaceId: string): Promise<DatadogConnectionView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const connection = await this.connections.get(workspaceId)
    return connection ? { connected: true, site: connection.site } : { connected: false, site: null }
  }

  /** Set/replace the workspace's Datadog connection, sealing the keys at rest. */
  async setConnection(
    workspaceId: string,
    input: UpsertDatadogConnectionInput,
  ): Promise<DatadogConnectionView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const now = this.clock.now()
    const [apiKey, appKey] = await Promise.all([
      this.cipher.encrypt(input.apiKey),
      this.cipher.encrypt(input.appKey),
    ])
    const existing = await this.connections.get(workspaceId)
    await this.connections.upsert({
      workspaceId,
      site: input.site,
      apiKey,
      appKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return { connected: true, site: input.site }
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
      bugsnagProject: r.bugsnagProject,
    }))
  }

  /** Create/replace a block's release-health config. */
  async upsertConfig(
    workspaceId: string,
    blockId: string,
    input: UpsertReleaseHealthConfigInput,
  ): Promise<ReleaseHealthConfigWire> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const now = this.clock.now()
    const existing = await this.configs.getByBlock(workspaceId, blockId)
    const record = {
      workspaceId,
      blockId,
      monitorIds: input.monitorIds ?? [],
      sloIds: input.sloIds ?? [],
      envTag: input.envTag ?? null,
      bugsnagProject: input.bugsnagProject ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.configs.upsert(record)
    return {
      blockId: record.blockId,
      monitorIds: record.monitorIds,
      sloIds: record.sloIds,
      envTag: record.envTag,
      bugsnagProject: record.bugsnagProject,
    }
  }

  async deleteConfig(workspaceId: string, blockId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.configs.delete(workspaceId, blockId)
  }
}
