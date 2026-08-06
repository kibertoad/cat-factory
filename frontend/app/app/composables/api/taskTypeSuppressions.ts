import {
  listTaskTypeSuppressionsContract,
  restoreTaskTypeContract,
  suppressTaskTypeContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * Which of the deployment's REUSABLE OPERATIONS this board offers
 * (`backend/docs/reusable-operations.md`). Every call answers with the WHOLE list, because the
 * board snapshot's `customTaskTypes` changes with it: hiding one removes it from the picker's own
 * catalog, so a point response would leave the caller reconciling against data it just invalidated.
 */
export function taskTypeSuppressionsApi({ send, ws }: ApiContext) {
  return {
    listTaskTypeSuppressions: (workspaceId: string) =>
      send(listTaskTypeSuppressionsContract, { pathPrefix: ws(workspaceId) }),

    suppressTaskType: (workspaceId: string, taskType: string) =>
      send(suppressTaskTypeContract, { pathPrefix: ws(workspaceId), pathParams: { taskType } }),

    restoreTaskType: (workspaceId: string, taskType: string) =>
      send(restoreTaskTypeContract, { pathPrefix: ws(workspaceId), pathParams: { taskType } }),
  }
}
