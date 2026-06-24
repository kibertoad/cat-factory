import type { Service, WorkspaceMount } from '~/types/domain'
import type {
  CreateScheduleInput,
  PipelineSchedule,
  ScheduleRun,
  UpdateScheduleInput,
} from '~/types/recurring'
import type { ApiContext, Position } from './context'

/** Recurring (scheduled) pipelines + the in-org shared-service mount catalog. */
export function recurringApi({ http, ws }: ApiContext) {
  return {
    // ---- recurring pipelines (scheduled runs against a service) -----------
    listRecurringPipelines: (workspaceId: string) =>
      http<PipelineSchedule[]>(`${ws(workspaceId)}/recurring-pipelines`),

    createRecurringPipeline: (workspaceId: string, body: CreateScheduleInput) =>
      http<PipelineSchedule>(`${ws(workspaceId)}/recurring-pipelines`, { method: 'POST', body }),

    updateRecurringPipeline: (workspaceId: string, id: string, body: UpdateScheduleInput) =>
      http<PipelineSchedule>(`${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body,
      }),

    deleteRecurringPipeline: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    listScheduleRuns: (workspaceId: string, id: string) =>
      http<ScheduleRun[]>(`${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}/runs`),

    runScheduleNow: (workspaceId: string, id: string) =>
      http<PipelineSchedule>(
        `${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}/run-now`,
        { method: 'POST' },
      ),

    // ---- in-org shared services (mount/unmount + org catalog) -------------
    // The services this workspace mounts, and the org catalog it can mount from. A 503
    // means the feature isn't wired (the store hides its UI on any error here).
    listServiceMounts: (workspaceId: string) =>
      http<WorkspaceMount[]>(`${ws(workspaceId)}/services`),

    listServiceCatalog: (workspaceId: string) =>
      http<Service[]>(`${ws(workspaceId)}/services/catalog`),

    mountService: (workspaceId: string, serviceId: string, body: { position?: Position } = {}) =>
      http<WorkspaceMount>(`${ws(workspaceId)}/services/${encodeURIComponent(serviceId)}`, {
        method: 'POST',
        body,
      }),

    unmountService: (workspaceId: string, serviceId: string) =>
      http(`${ws(workspaceId)}/services/${encodeURIComponent(serviceId)}`, { method: 'DELETE' }),

    updateMountLayout: (
      workspaceId: string,
      serviceId: string,
      body: { position?: Position; size?: { w: number; h: number } | null },
    ) =>
      http<WorkspaceMount>(`${ws(workspaceId)}/services/${encodeURIComponent(serviceId)}/layout`, {
        method: 'PATCH',
        body,
      }),
  }
}
