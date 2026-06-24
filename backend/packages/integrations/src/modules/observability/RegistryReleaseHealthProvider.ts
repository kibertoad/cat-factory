import type {
  BlockRepository,
  ObservabilityConnectionRepository,
  ObservabilityProviderKind,
  ReleaseEvidence,
  ReleaseHealthConfigRecord,
  ReleaseHealthConfigRepository,
  ReleaseHealthProvider,
  ReleaseHealthReport,
  ReleaseSignal,
  SecretCipher,
} from '@cat-factory/kernel'

/**
 * A single observability vendor's reads, built from its already-decrypted credentials.
 * The composite owns everything vendor-neutral (connection loading + decryption, config
 * resolution up the frame chain, the verdict reduction); an adapter just turns a config
 * into signals + recent errors for its vendor.
 */
export interface ObservabilityAdapter {
  readSignals(config: ReleaseHealthConfigRecord, since: number): Promise<ReleaseSignal[]>
  recentErrors(config: ReleaseHealthConfigRecord, since: number): Promise<ReleaseEvidence['errors']>
}

/** Builds an adapter from decrypted credentials. Registered per provider kind. */
export type ObservabilityAdapterFactory = (
  credentials: unknown,
  opts: { fetchImpl?: typeof fetch },
) => ObservabilityAdapter

/** The set of observability providers a facade can serve. */
export type ObservabilityProviderRegistry = Partial<
  Record<ObservabilityProviderKind, ObservabilityAdapterFactory>
>

export interface RegistryReleaseHealthProviderDependencies {
  observabilityConnectionRepository: ObservabilityConnectionRepository
  releaseHealthConfigRepository: ReleaseHealthConfigRepository
  /** Resolves the service-frame config when a task block has none of its own. */
  blockRepository: BlockRepository
  /** Decrypts the workspace's sealed credentials blob at call time. */
  secretCipher: SecretCipher
  /** The provider adapters this facade can build. */
  registry: ObservabilityProviderRegistry
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch
}

/**
 * The pluggable `ReleaseHealthProvider` the post-release-health gate reads: resolve the
 * block's monitor/SLO config (its own, else its service frame's) → load the workspace's
 * observability connection → build the matching provider adapter from its decrypted
 * credentials → read each signal → reduce to a single verdict. On a regression,
 * `gatherEvidence` adds the adapter's recent error groups for the on-call agent. Returns
 * a `healthy`/empty report when nothing is configured (the gate passes through).
 */
export class RegistryReleaseHealthProvider implements ReleaseHealthProvider {
  constructor(private readonly deps: RegistryReleaseHealthProviderDependencies) {}

  async probe(workspaceId: string, blockId: string, since: number): Promise<ReleaseHealthReport> {
    const resolved = await this.resolve(workspaceId, blockId)
    if (!resolved) return { status: 'healthy', signals: [] }
    const { adapter, config } = resolved

    const signals = await adapter.readSignals(config, since)
    if (signals.length === 0) return { status: 'pending', signals }
    if (signals.some((s) => s.state === 'alert')) return { status: 'regressed', signals }
    if (signals.every((s) => s.state === 'no_data')) return { status: 'pending', signals }
    return { status: 'healthy', signals }
  }

  async gatherEvidence(
    workspaceId: string,
    blockId: string,
    since: number,
  ): Promise<ReleaseEvidence> {
    const resolved = await this.resolve(workspaceId, blockId)
    if (!resolved) return { regressedSignals: [], errors: [] }
    const { adapter, config } = resolved

    const signals = await adapter.readSignals(config, since)
    const regressedSignals = signals.filter((s) => s.state === 'alert')
    const errors = await adapter.recentErrors(config, since)

    return {
      regressedSignals,
      errors,
      notes: `Monitored ${config.monitorIds.length} monitor(s) and ${config.sloIds.length} SLO(s)${config.envTag ? ` for env ${config.envTag}` : ''}.`,
    }
  }

  /** Resolve config + connection + adapter for a block. Null when unconfigured. */
  private async resolve(
    workspaceId: string,
    blockId: string,
  ): Promise<{ adapter: ObservabilityAdapter; config: ReleaseHealthConfigRecord } | null> {
    const config = await this.resolveConfig(workspaceId, blockId)
    if (!config || (config.monitorIds.length === 0 && config.sloIds.length === 0)) return null

    const connection = await this.deps.observabilityConnectionRepository.get(workspaceId)
    if (!connection) return null
    const factory = this.deps.registry[connection.provider]
    if (!factory) return null

    const credentials: unknown = JSON.parse(
      await this.deps.secretCipher.decrypt(connection.credentials),
    )
    const adapter = factory(credentials, { fetchImpl: this.deps.fetchImpl })
    return { adapter, config }
  }

  /** A block's release-health config: its own, else its nearest ancestor frame's. */
  private async resolveConfig(
    workspaceId: string,
    blockId: string,
  ): Promise<ReleaseHealthConfigRecord | null> {
    let currentId: string | null = blockId
    // Walk up the parent chain (task → module → frame), bounded against cycles.
    for (let hops = 0; currentId && hops < 5; hops++) {
      const config = await this.deps.releaseHealthConfigRepository.getByBlock(
        workspaceId,
        currentId,
      )
      if (config) return config
      const block = await this.deps.blockRepository.get(workspaceId, currentId)
      currentId = block?.parentId ?? null
    }
    return null
  }
}
