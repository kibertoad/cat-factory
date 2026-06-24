import type {
  AddApiKeyInput,
  ApiKey,
  ModelOption,
  PersonalSubscriptionStatus,
  ServiceFragmentDefaults,
  StorePersonalSubscriptionInput,
  SubscriptionVendor,
  VendorCredential,
} from '~/types/domain'
import type {
  LocalModelEndpoint,
  LocalModelEndpointTestResult,
  LocalRunner,
  TestLocalModelEndpointInput,
  UpsertLocalModelEndpointInput,
} from '~/types/localModels'
import type { ApiContext } from './context'

/**
 * Model catalog + the credential pools that gate selectability (direct-provider
 * API keys, vendor subscription tokens, per-user personal subscriptions + local
 * runners) + the per-workspace routing/selection defaults.
 */
export function modelsApi({ http, ws }: ApiContext) {
  return {
    // ---- model picker catalog (effective per-deployment flavours) ---------
    getModels: () => http<ModelOption[]>('/models'),
    // Per-workspace catalog: selectability reflects the workspace's (+ account's +
    // caller's) configured API keys and subscription tokens (`available` flag).
    getWorkspaceModels: (workspaceId: string) => http<ModelOption[]>(`${ws(workspaceId)}/models`),

    // ---- direct-provider API keys (the DB-backed pool) --------------------
    // Onboarded via UI, stored encrypted, pooled + rotated. Scoped to a workspace,
    // its owning account, or the signed-in user. Keys are write-only (never returned).
    listWorkspaceApiKeys: (workspaceId: string) =>
      http<{ keys: ApiKey[] }>(`${ws(workspaceId)}/api-keys`),
    addWorkspaceApiKey: (workspaceId: string, body: AddApiKeyInput) =>
      http<ApiKey>(`${ws(workspaceId)}/api-keys`, { method: 'POST', body }),
    removeWorkspaceApiKey: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    listMyApiKeys: () => http<{ keys: ApiKey[] }>('/me/api-keys'),
    addMyApiKey: (body: AddApiKeyInput) => http<ApiKey>('/me/api-keys', { method: 'POST', body }),
    removeMyApiKey: (id: string) =>
      http(`/me/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // Account-scoped keys (shared by every workspace in the account); admin-only.
    listAccountApiKeys: (accountId: string) =>
      http<{ keys: ApiKey[] }>(`/accounts/${encodeURIComponent(accountId)}/api-keys`),
    addAccountApiKey: (accountId: string, body: AddApiKeyInput) =>
      http<ApiKey>(`/accounts/${encodeURIComponent(accountId)}/api-keys`, { method: 'POST', body }),
    removeAccountApiKey: (accountId: string, id: string) =>
      http(`/accounts/${encodeURIComponent(accountId)}/api-keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    // ---- LLM vendor subscription credentials (the token pool) -------------
    listVendorCredentials: (workspaceId: string) =>
      http<{ credentials: VendorCredential[] }>(`${ws(workspaceId)}/vendor-credentials`),
    addVendorCredential: (
      workspaceId: string,
      body: { vendor: SubscriptionVendor; label: string; token: string },
    ) => http<VendorCredential>(`${ws(workspaceId)}/vendor-credentials`, { method: 'POST', body }),
    removeVendorCredential: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/vendor-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ---- personal (individual-usage) subscriptions (per-user, e.g. Claude) ----
    // Stored per signed-in user, double-encrypted under their personal password.
    // Metadata only is returned (never the token). User-scoped (no workspace).
    listPersonalSubscriptions: () =>
      http<{ subscriptions: PersonalSubscriptionStatus[] }>('/personal-subscriptions'),

    storePersonalSubscription: (body: StorePersonalSubscriptionInput) =>
      http<PersonalSubscriptionStatus>('/personal-subscriptions', { method: 'POST', body }),

    removePersonalSubscription: (vendor: SubscriptionVendor) =>
      http(`/personal-subscriptions/${encodeURIComponent(vendor)}`, { method: 'DELETE' }),

    // ---- local model runners (per-user, e.g. Ollama / LM Studio) ----------
    // A developer's own-machine LLM endpoints, stored per signed-in user (the API
    // key is write-only, never returned). User-scoped (no workspace). The enabled
    // models then surface automatically in the per-workspace `/models` catalog.
    listLocalModelEndpoints: () =>
      http<{ endpoints: LocalModelEndpoint[] }>('/local-model-endpoints'),

    upsertLocalModelEndpoint: (provider: LocalRunner, body: UpsertLocalModelEndpointInput) =>
      http<LocalModelEndpoint>(`/local-model-endpoints/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        body,
      }),

    deleteLocalModelEndpoint: (provider: LocalRunner) =>
      http(`/local-model-endpoints/${encodeURIComponent(provider)}`, { method: 'DELETE' }),

    // Probe a runner endpoint for reachability + the models it currently serves
    // (no persistence — drives the "Test connection" model multi-select).
    testLocalModelEndpoint: (body: TestLocalModelEndpointInput) =>
      http<LocalModelEndpointTestResult>('/local-model-endpoints/test', {
        method: 'POST',
        body,
      }),

    // The workspace's default service-fragment selection (the fragment ids new
    // services inherit). `setServiceFragmentDefaults` replaces the whole list.
    getServiceFragmentDefaults: (workspaceId: string) =>
      http<ServiceFragmentDefaults>(`${ws(workspaceId)}/service-fragment-defaults`),

    setServiceFragmentDefaults: (workspaceId: string, fragmentIds: string[]) =>
      http<ServiceFragmentDefaults>(`${ws(workspaceId)}/service-fragment-defaults`, {
        method: 'PUT',
        body: { fragmentIds },
      }),
  }
}
