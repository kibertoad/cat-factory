import type {
  DatadogConnectionView,
  ReleaseHealthConfig,
  UpsertDatadogConnectionInput,
  UpsertReleaseHealthConfigInput,
} from '~/types/releaseHealth'
import type { ApiContext } from './context'

/** Datadog post-release-health: the connection + per-block monitor/SLO mapping. */
export function releaseHealthApi({ http, ws }: ApiContext) {
  return {
    // ---- Datadog post-release-health settings -----------------------------
    getDatadogConnection: (workspaceId: string) =>
      http<DatadogConnectionView>(`${ws(workspaceId)}/datadog/connection`),

    setDatadogConnection: (workspaceId: string, body: UpsertDatadogConnectionInput) =>
      http<DatadogConnectionView>(`${ws(workspaceId)}/datadog/connection`, {
        method: 'PUT',
        body,
      }),

    deleteDatadogConnection: (workspaceId: string) =>
      http(`${ws(workspaceId)}/datadog/connection`, { method: 'DELETE' }),

    listReleaseHealthConfigs: (workspaceId: string) =>
      http<ReleaseHealthConfig[]>(`${ws(workspaceId)}/release-health-configs`),

    upsertReleaseHealthConfig: (
      workspaceId: string,
      blockId: string,
      body: UpsertReleaseHealthConfigInput,
    ) =>
      http<ReleaseHealthConfig>(
        `${ws(workspaceId)}/release-health-configs/${encodeURIComponent(blockId)}`,
        { method: 'PUT', body },
      ),

    deleteReleaseHealthConfig: (workspaceId: string, blockId: string) =>
      http(`${ws(workspaceId)}/release-health-configs/${encodeURIComponent(blockId)}`, {
        method: 'DELETE',
      }),
  }
}
