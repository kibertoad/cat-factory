import {
  createSharedStackContract,
  deleteSharedStackContract,
  ensureSharedStackUpContract,
  listSharedStacksContract,
  teardownSharedStackContract,
  updateSharedStackContract,
} from '@cat-factory/contracts'
import type { UpdateSharedStackInput } from '~/types/sharedStacks'
import type { SendParams } from './client'
import type { ApiContext } from './context'

// The create body is typed from the contract's INPUT shape so the valibot-defaulted array fields
// (profiles, envFiles, managedNetworks, setupSteps, allowHostCommands) stay optional for callers.
type CreateSharedStackBody = NonNullable<SendParams<typeof createSharedStackContract>['body']>

/** A workspace's shared stacks: CRUD plus the ensure-up / teardown lifecycle actions. */
export function sharedStacksApi({ send, ws }: ApiContext) {
  return {
    listSharedStacks: (workspaceId: string) =>
      send(listSharedStacksContract, { pathPrefix: ws(workspaceId) }),

    createSharedStack: (workspaceId: string, body: CreateSharedStackBody) =>
      send(createSharedStackContract, { pathPrefix: ws(workspaceId), body }),

    updateSharedStack: (workspaceId: string, stackId: string, body: UpdateSharedStackInput) =>
      send(updateSharedStackContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { stackId },
        body,
      }),

    deleteSharedStack: (workspaceId: string, stackId: string) =>
      send(deleteSharedStackContract, { pathPrefix: ws(workspaceId), pathParams: { stackId } }),

    ensureSharedStackUp: (workspaceId: string, stackId: string) =>
      send(ensureSharedStackUpContract, { pathPrefix: ws(workspaceId), pathParams: { stackId } }),

    teardownSharedStack: (workspaceId: string, stackId: string) =>
      send(teardownSharedStackContract, { pathPrefix: ws(workspaceId), pathParams: { stackId } }),
  }
}
