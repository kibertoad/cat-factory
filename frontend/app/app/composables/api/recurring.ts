import {
  createScheduleContract,
  deleteScheduleContract,
  listSchedulesContract,
  listScheduleRunsContract,
  listServiceCatalogContract,
  listServiceMountsContract,
  mountServiceContract,
  runScheduleNowContract,
  unmountServiceContract,
  updateScheduleContract,
  updateServiceMountLayoutContract,
} from '@cat-factory/contracts'
import type { UpdateScheduleInput } from '~/types/recurring'
import type { SendParams } from './client'
import type { ApiContext, Position } from './context'

// The create-schedule body is typed from the contract's INPUT shape so the
// valibot-defaulted `enabled` stays optional for callers (the exported
// `CreateScheduleInput` is the post-default OUTPUT shape).
type CreateScheduleBody = NonNullable<SendParams<typeof createScheduleContract>['body']>

/** Recurring (scheduled) pipelines + the in-org shared-service mount catalog. */
export function recurringApi({ send, ws }: ApiContext) {
  return {
    // ---- recurring pipelines (scheduled runs against a service) -----------
    listRecurringPipelines: (workspaceId: string) =>
      send(listSchedulesContract, { pathPrefix: ws(workspaceId) }),

    createRecurringPipeline: (workspaceId: string, body: CreateScheduleBody) =>
      send(createScheduleContract, { pathPrefix: ws(workspaceId), body }),

    updateRecurringPipeline: (workspaceId: string, id: string, body: UpdateScheduleInput) =>
      send(updateScheduleContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { scheduleId: id },
        body,
      }),

    deleteRecurringPipeline: (workspaceId: string, id: string) =>
      send(deleteScheduleContract, { pathPrefix: ws(workspaceId), pathParams: { scheduleId: id } }),

    listScheduleRuns: (workspaceId: string, id: string) =>
      send(listScheduleRunsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { scheduleId: id },
      }),

    runScheduleNow: (workspaceId: string, id: string) =>
      send(runScheduleNowContract, { pathPrefix: ws(workspaceId), pathParams: { scheduleId: id } }),

    // ---- in-org shared services (mount/unmount + org catalog) -------------
    // The services this workspace mounts, and the org catalog it can mount from. A 503
    // means the feature isn't wired (the store hides its UI on any error here).
    listServiceMounts: (workspaceId: string) =>
      send(listServiceMountsContract, { pathPrefix: ws(workspaceId) }),

    listServiceCatalog: (workspaceId: string) =>
      send(listServiceCatalogContract, { pathPrefix: ws(workspaceId) }),

    mountService: (workspaceId: string, serviceId: string, body: { position?: Position } = {}) =>
      send(mountServiceContract, { pathPrefix: ws(workspaceId), pathParams: { serviceId }, body }),

    unmountService: (workspaceId: string, serviceId: string) =>
      send(unmountServiceContract, { pathPrefix: ws(workspaceId), pathParams: { serviceId } }),

    updateMountLayout: (
      workspaceId: string,
      serviceId: string,
      body: { position?: Position; size?: { w: number; h: number } | null },
    ) =>
      send(updateServiceMountLayoutContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { serviceId },
        body,
      }),
  }
}
