import {
  createServiceAcceptanceCriterionContract,
  deleteAcceptanceCriterionContract,
  getServiceAcceptanceCriteriaContract,
  listServiceAcceptanceCriteriaContract,
  updateAcceptanceCriterionContract,
} from '@cat-factory/contracts'
import type {
  CreateAcceptanceCriterionInput,
  UpdateAcceptanceCriterionInput,
} from '~/types/acceptanceCriteria'
import type { ApiContext } from './context'

/** Acceptance criteria: the per-service-frame given/when/outcome behaviour contract. */
export function acceptanceCriteriaApi({ send, ws }: ApiContext) {
  return {
    listServiceAcceptanceCriteria: (workspaceId: string) =>
      send(listServiceAcceptanceCriteriaContract, { pathPrefix: ws(workspaceId) }),

    getServiceAcceptanceCriteria: (workspaceId: string, blockId: string) =>
      send(getServiceAcceptanceCriteriaContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),

    createServiceAcceptanceCriterion: (
      workspaceId: string,
      blockId: string,
      body: CreateAcceptanceCriterionInput,
    ) =>
      send(createServiceAcceptanceCriterionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body,
      }),

    updateAcceptanceCriterion: (
      workspaceId: string,
      criterionId: string,
      body: UpdateAcceptanceCriterionInput,
    ) =>
      send(updateAcceptanceCriterionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { criterionId },
        body,
      }),

    deleteAcceptanceCriterion: (workspaceId: string, criterionId: string) =>
      send(deleteAcceptanceCriterionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { criterionId },
      }),
  }
}
