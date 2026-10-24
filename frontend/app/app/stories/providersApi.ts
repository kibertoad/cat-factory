// The answers to the model-provider status reads the provider hubs send when they open: the
// workspace's and the user's API keys, the user's local runners and their personal
// subscriptions. Each defaults to empty, which is a deployment with nothing connected. The account's
// own keys are a separate answer, for the account's team settings.
import {
  listAccountApiKeysContract,
  listLocalModelEndpointsContract,
  listPersonalSubscriptionsContract,
  listUserApiKeysContract,
  listWorkspaceApiKeysContract,
} from '@cat-factory/contracts'
import type { ApiKey, LocalModelEndpoint, PersonalSubscriptionStatus } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { orgAccount } from './accounts.stories.mocks'
import { apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'

export function providersApi(
  seed: {
    workspaceKeys?: ApiKey[]
    userKeys?: ApiKey[]
    endpoints?: LocalModelEndpoint[]
    subscriptions?: PersonalSubscriptionStatus[]
  } = {},
): HttpHandler[] {
  return [
    apiResponse(listWorkspaceApiKeysContract, {
      pathPrefix: storyWorkspacePrefix,
      body: { keys: seed.workspaceKeys ?? [] },
    }),
    apiResponse(listUserApiKeysContract, { body: { keys: seed.userKeys ?? [] } }),
    apiResponse(listLocalModelEndpointsContract, { body: { endpoints: seed.endpoints ?? [] } }),
    apiResponse(listPersonalSubscriptionsContract, {
      body: { subscriptions: seed.subscriptions ?? [] },
    }),
  ]
}

/** An account's own keys (the org's by default), which the account's team settings list. */
export function accountApiKeysApi(keys: ApiKey[] = [], accountId = orgAccount.id): HttpHandler {
  return apiResponse(listAccountApiKeysContract, {
    pathParams: { accountId },
    body: { keys },
  })
}
