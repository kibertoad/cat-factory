import type { ProvisioningLogEntry, ProvisioningSubsystem } from '~/types/provisioningLogs'
import type { ApiContext } from './context'

/** Read access to the unified provisioning event log (the "View logs" drawers + run details). */
export function provisioningLogsApi({ http, ws }: ApiContext) {
  return {
    listProvisioningLogs: (
      workspaceId: string,
      params: { subsystem?: ProvisioningSubsystem; executionId?: string; limit?: number } = {},
    ) => {
      const q = new URLSearchParams()
      if (params.subsystem) q.set('subsystem', params.subsystem)
      if (params.executionId) q.set('executionId', params.executionId)
      if (params.limit != null) q.set('limit', String(params.limit))
      const qs = q.toString()
      return http<{ entries: ProvisioningLogEntry[] }>(
        `${ws(workspaceId)}/provisioning-logs${qs ? `?${qs}` : ''}`,
      )
    },
  }
}
