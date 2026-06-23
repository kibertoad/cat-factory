import type {
  BlockRepository,
  DatadogConnectionRepository,
  ReleaseEvidence,
  ReleaseHealthConfigRecord,
  ReleaseHealthConfigRepository,
  ReleaseHealthProvider,
  ReleaseHealthReport,
  ReleaseSignal,
  SecretCipher,
} from '@cat-factory/kernel'
import { DatadogClient } from './DatadogClient.js'
import { mapMonitorState, mapSloState } from './datadog.logic.js'

export interface DatadogReleaseHealthProviderDependencies {
  datadogConnectionRepository: DatadogConnectionRepository
  releaseHealthConfigRepository: ReleaseHealthConfigRepository
  /** Resolves the service-frame config when a task block has none of its own. */
  blockRepository: BlockRepository
  /** Decrypts the workspace's Datadog API/app keys at call time. */
  secretCipher: SecretCipher
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch
}

/**
 * Reads a block's release health from Datadog for the post-release-health gate:
 * resolve the block's monitor/SLO config (its own, else its service frame's) → read
 * each monitor's state + each SLO's SLI-vs-target → reduce to a single verdict. On a
 * regression, `gatherEvidence` adds recent error-log groups for the on-call agent.
 * Returns a `healthy`/empty report when nothing is configured (the gate passes through).
 */
export class DatadogReleaseHealthProvider implements ReleaseHealthProvider {
  constructor(private readonly deps: DatadogReleaseHealthProviderDependencies) {}

  async probe(workspaceId: string, blockId: string, since: number): Promise<ReleaseHealthReport> {
    const resolved = await this.resolve(workspaceId, blockId)
    if (!resolved) return { status: 'healthy', signals: [] }
    const { client, config } = resolved

    const signals = await this.readSignals(client, config, since)
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
    const { client, config } = resolved

    const signals = await this.readSignals(client, config, since)
    const regressedSignals = signals.filter((s) => s.state === 'alert')

    // Pull recent error logs scoped to the env (when configured), best-effort, over the
    // window [since, now].
    const query = config.envTag ? `status:error env:${config.envTag}` : 'status:error'
    const ddErrors = await client.recentErrorLogs(query, since, Date.now())
    const errors: ReleaseEvidence['errors'] = ddErrors.map((e) => ({
      title: e.title,
      count: e.count,
      sampleMessage: e.sampleMessage,
    }))

    return {
      regressedSignals,
      errors,
      notes: `Monitored ${config.monitorIds.length} monitor(s) and ${config.sloIds.length} SLO(s)${config.envTag ? ` for env ${config.envTag}` : ''}.`,
    }
  }

  /** Resolve the connection + config for a block, building a client. Null when unconfigured. */
  private async resolve(
    workspaceId: string,
    blockId: string,
  ): Promise<{ client: DatadogClient; config: ReleaseHealthConfigRecord } | null> {
    const config = await this.resolveConfig(workspaceId, blockId)
    if (!config || (config.monitorIds.length === 0 && config.sloIds.length === 0)) return null

    const connection = await this.deps.datadogConnectionRepository.get(workspaceId)
    if (!connection) return null
    const [apiKey, appKey] = await Promise.all([
      this.deps.secretCipher.decrypt(connection.apiKey),
      this.deps.secretCipher.decrypt(connection.appKey),
    ])
    const client = new DatadogClient(
      { site: connection.site, apiKey, appKey },
      { fetchImpl: this.deps.fetchImpl },
    )
    return { client, config }
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

  private async readSignals(
    client: DatadogClient,
    config: ReleaseHealthConfigRecord,
    since: number,
  ): Promise<ReleaseSignal[]> {
    const now = Date.now()
    const fromTs = Math.floor(since / 1000)
    const toTs = Math.floor(now / 1000)

    const monitors = await Promise.all(
      config.monitorIds.map(async (id): Promise<ReleaseSignal> => {
        const m = await client.getMonitor(id)
        // Attribute the alert to THIS release: a monitor already alerting before the
        // release marker (`since`) is a pre-existing incident, not this PR's regression.
        const state = mapMonitorState(m.overallState, { stateModifiedMs: m.stateModifiedMs, since })
        return { kind: 'monitor', id, name: m.name, state }
      }),
    )
    const slos = await Promise.all(
      config.sloIds.map(async (id): Promise<ReleaseSignal> => {
        const s = await client.getSloState(id, fromTs, toTs)
        const state = mapSloState(s.sliValue, s.target)
        const detail =
          s.sliValue !== null && s.target !== null
            ? `SLI ${s.sliValue.toFixed(2)} vs target ${s.target}`
            : undefined
        return { kind: 'slo', id, name: s.name, state, detail }
      }),
    )
    return [...monitors, ...slos]
  }
}
