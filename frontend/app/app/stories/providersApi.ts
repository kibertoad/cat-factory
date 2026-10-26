// The answers to the model-provider status reads the provider hubs send when they open: the
// workspace's and the user's API keys, the user's local runners and their personal
// subscriptions, plus the configured providers the server resolves from those keys. Each defaults
// to empty, which is a deployment with nothing connected. The account's own keys are a separate
// answer, for the account's team settings.
import {
  listAccountApiKeysContract,
  listConfiguredProvidersContract,
  listLocalModelEndpointsContract,
  listPersonalSubscriptionsContract,
  listUserApiKeysContract,
  listWorkspaceApiKeysContract,
} from '@cat-factory/contracts'
import type {
  ApiKey,
  ApiKeyProvider,
  LocalModelEndpoint,
  PersonalSubscriptionStatus,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { orgAccount } from './accounts.stories.mocks'
import { apiResponse } from './api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from './workspace'

export function providersApi(
  seed: {
    workspaceKeys?: ApiKey[]
    userKeys?: ApiKey[]
    endpoints?: LocalModelEndpoint[]
    subscriptions?: PersonalSubscriptionStatus[]
    /**
     * What the server resolves as configured. Defaults to the providers of the ENABLED seeded keys;
     * set it for a case the visible keys do not show, such as a key at the account scope.
     */
    configured?: ApiKeyProvider[]
  } = {},
): HttpHandler[] {
  const enabledKeys = [...(seed.workspaceKeys ?? []), ...(seed.userKeys ?? [])].filter(
    (k) => k.enabled,
  )
  const configured = seed.configured ?? [...new Set(enabledKeys.map((k) => k.provider))]
  return [
    apiResponse(listConfiguredProvidersContract, {
      pathParams: { workspaceId: STORY_WORKSPACE_ID },
      body: { providers: configured },
    }),
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
