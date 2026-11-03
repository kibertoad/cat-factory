import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AddApiKeyInput, ApiKey, ApiKeyProvider, UpdateApiKeyInput } from '~/types/domain'

/**
 * The direct-provider API keys reachable from a workspace: the workspace's own keys
 * plus the signed-in user's personal keys. Account-scoped keys (shared by every
 * workspace in the account, admin-managed) are loaded separately via `loadAccountKeys`
 * and surfaced in account/team settings. Onboarded via UI, stored encrypted + pooled by
 * the backend; keys are write-only so only metadata + rolling-window usage is ever
 * returned.
 *
 * `configuredProviders` is the SERVER's answer (`GET /workspaces/:ws/configured-providers`), the
 * same resolution the model catalog and the run-start guard use, never one derived from the key
 * rows here: those rows leave out the account's keys, and a copy of the backend's eligibility
 * rules (an enabled key, a gateway base URL) would drift. The provider hub and the OpenRouter
 * panel read it; the model picker reads the catalog instead.
 */
export const useApiKeysStore = defineStore('apiKeys', () => {
  const api = useApi()
  const workspaceKeys = ref<ApiKey[]>([])
  const userKeys = ref<ApiKey[]>([])
  const accountKeys = ref<ApiKey[]>([])
  const accountId = ref<string | null>(null)
  const workspaceId = ref<string | null>(null)
  const loading = ref(false)
  /** Providers with an enabled key a run here can reach, at any pool scope (server-resolved). */
  const configuredProviders = ref<ReadonlySet<ApiKeyProvider>>(new Set())

  async function loadKeys(ws: string) {
    const [wsRes, meRes] = await Promise.all([
      api.listWorkspaceApiKeys(ws),
      api.listMyApiKeys().catch(() => ({ keys: [] as ApiKey[] })),
    ])
    workspaceKeys.value = wsRes.keys
    userKeys.value = meRes.keys
  }

  async function loadConfigured(ws: string) {
    configuredProviders.value = new Set((await api.listConfiguredProviders(ws)).providers)
  }

  // The two reads land independently, so a key list that fails to load still leaves the
  // configured providers in place.
  async function load(ws: string) {
    workspaceId.value = ws
    loading.value = true
    try {
      await Promise.all([loadKeys(ws), loadConfigured(ws)])
    } finally {
      loading.value = false
    }
  }

  /** Re-read the configured providers after a key mutation (adding, toggling, removing). */
  async function refreshConfigured() {
    if (workspaceId.value) await loadConfigured(workspaceId.value)
  }

  async function addWorkspaceKey(input: AddApiKeyInput) {
    if (!workspaceId.value) return
    const created = await api.addWorkspaceApiKey(workspaceId.value, input)
    workspaceKeys.value = [...workspaceKeys.value, created]
    await refreshConfigured()
    return created
  }

  async function removeWorkspaceKey(id: string) {
    if (!workspaceId.value) return
    await api.removeWorkspaceApiKey(workspaceId.value, id)
    workspaceKeys.value = workspaceKeys.value.filter((k) => k.id !== id)
    await refreshConfigured()
  }

  // Pinning a default clears any prior default of the same scope+provider server-side, so a
  // default change reloads the affected scope to reflect the single-default invariant; a plain
  // enable/disable patches the one row in place.
  async function updateWorkspaceKey(id: string, patch: UpdateApiKeyInput) {
    if (!workspaceId.value) return
    const updated = await api.updateWorkspaceApiKey(workspaceId.value, id, patch)
    if (patch.isDefault !== undefined) await load(workspaceId.value)
    else {
      workspaceKeys.value = workspaceKeys.value.map((k) => (k.id === id ? updated : k))
      await refreshConfigured()
    }
    return updated
  }

  async function addUserKey(input: AddApiKeyInput) {
    const created = await api.addMyApiKey(input)
    userKeys.value = [...userKeys.value, created]
    await refreshConfigured()
    return created
  }

  async function updateUserKey(id: string, patch: UpdateApiKeyInput) {
    const updated = await api.updateMyApiKey(id, patch)
    if (patch.isDefault !== undefined && workspaceId.value) await load(workspaceId.value)
    else {
      userKeys.value = userKeys.value.map((k) => (k.id === id ? updated : k))
      await refreshConfigured()
    }
    return updated
  }

  async function removeUserKey(id: string) {
    await api.removeMyApiKey(id)
    userKeys.value = userKeys.value.filter((k) => k.id !== id)
    await refreshConfigured()
  }

  // ---- Account-scoped keys (admin-managed, shared by the account's workspaces) ----

  async function loadAccountKeys(acc: string) {
    accountId.value = acc
    accountKeys.value = (await api.listAccountApiKeys(acc)).keys
  }

  async function addAccountKey(input: AddApiKeyInput) {
    if (!accountId.value) return
    const created = await api.addAccountApiKey(accountId.value, input)
    accountKeys.value = [...accountKeys.value, created]
    await refreshConfigured()
  }

  async function updateAccountKey(id: string, patch: UpdateApiKeyInput) {
    if (!accountId.value) return
    const updated = await api.updateAccountApiKey(accountId.value, id, patch)
    if (patch.isDefault !== undefined) await loadAccountKeys(accountId.value)
    else accountKeys.value = accountKeys.value.map((k) => (k.id === id ? updated : k))
    await refreshConfigured()
    return updated
  }

  async function removeAccountKey(id: string) {
    if (!accountId.value) return
    await api.removeAccountApiKey(accountId.value, id)
    accountKeys.value = accountKeys.value.filter((k) => k.id !== id)
    await refreshConfigured()
  }

  /** Every key reachable from the workspace (workspace + user scopes), newest first. */
  const allKeys = computed<ApiKey[]>(() => [...workspaceKeys.value, ...userKeys.value])

  /**
   * Where a provider's key stands for this caller. `disabled` is a provider that is not configured
   * while a key for it the caller can see is turned off, so a surface offers that key back rather
   * than a form to paste a duplicate. A disabled account key is not visible here, so it reads
   * `none`; only an account admin could re-enable it anyway.
   */
  function keyState(provider: ApiKeyProvider): 'connected' | 'disabled' | 'none' {
    if (configuredProviders.value.has(provider)) return 'connected'
    return allKeys.value.some((k) => k.provider === provider && !k.enabled) ? 'disabled' : 'none'
  }

  return {
    workspaceKeys,
    userKeys,
    accountKeys,
    allKeys,
    loading,
    load,
    addWorkspaceKey,
    updateWorkspaceKey,
    removeWorkspaceKey,
    addUserKey,
    updateUserKey,
    removeUserKey,
    loadAccountKeys,
    addAccountKey,
    updateAccountKey,
    removeAccountKey,
    configuredProviders,
    keyState,
  }
})
