import type { ReleaseEvidence, ReleaseHealthConfigRecord, ReleaseSignal } from '@cat-factory/kernel'
import { DatadogClient } from './DatadogClient.js'
import { mapMonitorState, mapSloState } from './datadog.logic.js'
import type { ObservabilityAdapter } from '../observability/RegistryReleaseHealthProvider.js'

/** Decrypted Datadog credentials (the sealed `credentials` blob, parsed). */
export interface DatadogCredentialsShape {
  site: string
  apiKey: string
  appKey: string
}

/**
 * The Datadog observability adapter: reads a block's configured monitors/SLOs and recent
 * error logs through the Datadog API. Built from already-decrypted credentials by the
 * provider registry (`RegistryReleaseHealthProvider` owns connection loading + decryption,
 * config resolution and the verdict reduction — this adapter is purely the Datadog reads).
 */
export class DatadogObservabilityAdapter implements ObservabilityAdapter {
  private readonly client: DatadogClient

  constructor(credentials: DatadogCredentialsShape, opts: { fetchImpl?: typeof fetch } = {}) {
    this.client = new DatadogClient(
      { site: credentials.site, apiKey: credentials.apiKey, appKey: credentials.appKey },
      { fetchImpl: opts.fetchImpl },
    )
  }

  async readSignals(config: ReleaseHealthConfigRecord, since: number): Promise<ReleaseSignal[]> {
    const now = Date.now()
    const fromTs = Math.floor(since / 1000)
    const toTs = Math.floor(now / 1000)

    const monitors = await Promise.all(
      config.monitorIds.map(async (id): Promise<ReleaseSignal> => {
        const m = await this.client.getMonitor(id)
        // Attribute the alert to THIS release: a monitor already alerting before the
        // release marker (`since`) is a pre-existing incident, not this PR's regression.
        const state = mapMonitorState(m.overallState, { stateModifiedMs: m.stateModifiedMs, since })
        return { kind: 'monitor', id, name: m.name, state }
      }),
    )
    const slos = await Promise.all(
      config.sloIds.map(async (id): Promise<ReleaseSignal> => {
        const s = await this.client.getSloState(id, fromTs, toTs)
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

  async recentErrors(
    config: ReleaseHealthConfigRecord,
    since: number,
  ): Promise<ReleaseEvidence['errors']> {
    // Pull recent error logs scoped to the env (when configured), best-effort, over the
    // window [since, now].
    const query = config.envTag ? `status:error env:${config.envTag}` : 'status:error'
    const ddErrors = await this.client.recentErrorLogs(query, since, Date.now())
    return ddErrors.map((e) => ({
      title: e.title,
      count: e.count,
      sampleMessage: e.sampleMessage,
    }))
  }
}
