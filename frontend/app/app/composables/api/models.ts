import {
  addAccountApiKeyContract,
  addUserApiKeyContract,
  addVendorCredentialContract,
  addWorkspaceApiKeyContract,
  getOpenRouterCatalogContract,
  getServiceFragmentDefaultsContract,
  listAccountApiKeysContract,
  listLocalModelEndpointsContract,
  listModelsContract,
  listPersonalSubscriptionsContract,
  listUserApiKeysContract,
  listVendorCredentialsContract,
  listWorkspaceApiKeysContract,
  listWorkspaceModelsContract,
  refreshOpenRouterCatalogContract,
  removeAccountApiKeyContract,
  removeLocalModelEndpointContract,
  removePersonalSubscriptionContract,
  removeUserApiKeyContract,
  removeVendorCredentialContract,
  removeWorkspaceApiKeyContract,
  setServiceFragmentDefaultsContract,
  storePersonalSubscriptionContract,
  testLocalModelEndpointContract,
  upsertLocalModelEndpointContract,
  upsertOpenRouterCatalogContract,
} from '@cat-factory/contracts'
import type {
  AddApiKeyInput,
  StorePersonalSubscriptionInput,
  SubscriptionVendor,
} from '~/types/domain'
import type {
  LocalRunner,
  TestLocalModelEndpointInput,
  UpsertLocalModelEndpointInput,
} from '~/types/localModels'
import type { UpsertOpenRouterCatalogInput } from '~/types/openrouter'
import type { ApiContext } from './context'

/**
 * Model catalog + the credential pools that gate selectability (direct-provider
 * API keys, vendor subscription tokens, per-user personal subscriptions + local
 * runners) + the per-workspace routing/selection defaults.
 */
export function modelsApi({ send, ws }: ApiContext) {
  return {
    // ---- model picker catalog (effective per-deployment flavours) ---------
    getModels: () => send(listModelsContract, {}),
    // Per-workspace catalog: selectability reflects the workspace's (+ account's +
    // caller's) configured API keys and subscription tokens (`available` flag).
    getWorkspaceModels: (workspaceId: string) =>
      send(listWorkspaceModelsContract, { pathParams: { workspaceId } }),

    // ---- direct-provider API keys (the DB-backed pool) --------------------
    // Onboarded via UI, stored encrypted, pooled + rotated. Scoped to a workspace,
    // its owning account, or the signed-in user. Keys are write-only (never returned).
    listWorkspaceApiKeys: (workspaceId: string) =>
      send(listWorkspaceApiKeysContract, { pathPrefix: ws(workspaceId) }),
    addWorkspaceApiKey: (workspaceId: string, body: AddApiKeyInput) =>
      send(addWorkspaceApiKeyContract, { pathPrefix: ws(workspaceId), body }),
    removeWorkspaceApiKey: (workspaceId: string, id: string) =>
      send(removeWorkspaceApiKeyContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),
    listMyApiKeys: () => send(listUserApiKeysContract, {}),
    addMyApiKey: (body: AddApiKeyInput) => send(addUserApiKeyContract, { body }),
    removeMyApiKey: (id: string) => send(removeUserApiKeyContract, { pathParams: { id } }),
    // Account-scoped keys (shared by every workspace in the account); admin-only.
    listAccountApiKeys: (accountId: string) =>
      send(listAccountApiKeysContract, { pathParams: { accountId } }),
    addAccountApiKey: (accountId: string, body: AddApiKeyInput) =>
      send(addAccountApiKeyContract, { pathParams: { accountId }, body }),
    removeAccountApiKey: (accountId: string, id: string) =>
      send(removeAccountApiKeyContract, { pathParams: { accountId, id } }),

    // ---- LLM vendor subscription credentials (the token pool) -------------
    listVendorCredentials: (workspaceId: string) =>
      send(listVendorCredentialsContract, { pathPrefix: ws(workspaceId) }),
    addVendorCredential: (
      workspaceId: string,
      body: { vendor: SubscriptionVendor; label: string; token: string },
    ) => send(addVendorCredentialContract, { pathPrefix: ws(workspaceId), body }),
    removeVendorCredential: (workspaceId: string, id: string) =>
      send(removeVendorCredentialContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),

    // ---- personal (individual-usage) subscriptions (per-user, e.g. Claude) ----
    // Stored per signed-in user, double-encrypted under their personal password.
    // Metadata only is returned (never the token). User-scoped (no workspace).
    listPersonalSubscriptions: () => send(listPersonalSubscriptionsContract, {}),

    storePersonalSubscription: (body: StorePersonalSubscriptionInput) =>
      send(storePersonalSubscriptionContract, { body }),

    removePersonalSubscription: (vendor: SubscriptionVendor) =>
      send(removePersonalSubscriptionContract, { pathParams: { vendor } }),

    // ---- local model runners (per-user, e.g. Ollama / LM Studio) ----------
    // A developer's own-machine LLM endpoints, stored per signed-in user (the API
    // key is write-only, never returned). User-scoped (no workspace). The enabled
    // models then surface automatically in the per-workspace `/models` catalog.
    listLocalModelEndpoints: () => send(listLocalModelEndpointsContract, {}),

    upsertLocalModelEndpoint: (provider: LocalRunner, body: UpsertLocalModelEndpointInput) =>
      send(upsertLocalModelEndpointContract, { pathParams: { provider }, body }),

    deleteLocalModelEndpoint: (provider: LocalRunner) =>
      send(removeLocalModelEndpointContract, { pathParams: { provider } }),

    // Probe a runner endpoint for reachability + the models it currently serves
    // (no persistence — drives the "Test connection" model multi-select).
    testLocalModelEndpoint: (body: TestLocalModelEndpointInput) =>
      send(testLocalModelEndpointContract, { body }),

    // ---- OpenRouter dynamic catalog (per-workspace gateway models) --------
    // Browse OpenRouter's live catalog (`refresh`, leasing the workspace's pooled
    // OpenRouter key server-side) and enable a subset; enabled models then surface
    // in the per-workspace `/models` catalog with their context + price.
    getOpenRouterCatalog: (workspaceId: string) =>
      send(getOpenRouterCatalogContract, { pathParams: { workspaceId } }),

    setOpenRouterCatalog: (workspaceId: string, body: UpsertOpenRouterCatalogInput) =>
      send(upsertOpenRouterCatalogContract, { pathParams: { workspaceId }, body }),

    refreshOpenRouterCatalog: (workspaceId: string) =>
      send(refreshOpenRouterCatalogContract, { pathParams: { workspaceId } }),

    // The workspace's default service-fragment selection (the fragment ids new
    // services inherit). `setServiceFragmentDefaults` replaces the whole list.
    getServiceFragmentDefaults: (workspaceId: string) =>
      send(getServiceFragmentDefaultsContract, { pathPrefix: ws(workspaceId) }),

    setServiceFragmentDefaults: (workspaceId: string, fragmentIds: string[]) =>
      send(setServiceFragmentDefaultsContract, {
        pathPrefix: ws(workspaceId),
        body: { fragmentIds },
      }),
  }
}
