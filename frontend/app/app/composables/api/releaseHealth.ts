import type {
  ObservabilityConnectionView,
  ReleaseHealthConfig,
  UpsertObservabilityConnectionInput,
  UpsertReleaseHealthConfigInput,
} from '~/types/releaseHealth'
import type { ApiContext } from './context'

/** Post-release-health: the observability connection + per-block monitor/SLO mapping. */
export function releaseHealthApi({ http, ws }: ApiContext) {
  return {
    // ---- Observability connection ------------------------------------------
    getObservabilityConnection: (workspaceId: string) =>
      http<ObservabilityConnectionView>(`${ws(workspaceId)}/observability/connection`),

    setObservabilityConnection: (workspaceId: string, body: UpsertObservabilityConnectionInput) =>
      http<ObservabilityConnectionView>(`${ws(workspaceId)}/observability/connection`, {
        method: 'PUT',
        body,
      }),

    deleteObservabilityConnection: (workspaceId: string) =>
      http(`${ws(workspaceId)}/observability/connection`, { method: 'DELETE' }),

    // ---- Per-block monitor/SLO config --------------------------------------
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
