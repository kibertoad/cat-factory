import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AddApiKeyInput, ApiKey, ApiKeyProvider, UpdateApiKeyInput } from '~/types/domain'

/**
 * The direct-provider API keys reachable from a workspace: the workspace's own keys
 * plus the signed-in user's personal keys. Account-scoped keys (shared by every
 * workspace in the account, admin-managed) are loaded separately via `loadAccountKeys`
 * and surfaced in account/team settings. Onboarded via UI, stored encrypted + pooled by
 * the backend; keys are write-only so only metadata + rolling-window usage is ever
 * returned. `configuredProviders` drives the model picker (a direct model is selectable
 * once a key for its provider is connected at any reachable scope).
 */
export const useApiKeysStore = defineStore('apiKeys', () => {
  const api = useApi()
  const workspaceKeys = ref<ApiKey[]>([])
  const userKeys = ref<ApiKey[]>([])
  const accountKeys = ref<ApiKey[]>([])
  const accountId = ref<string | null>(null)
  const workspaceId = ref<string | null>(null)
  const loading = ref(false)

  async function load(ws: string) {
    workspaceId.value = ws
    loading.value = true
    try {
      const [wsRes, meRes] = await Promise.all([
        api.listWorkspaceApiKeys(ws),
        api.listMyApiKeys().catch(() => ({ keys: [] as ApiKey[] })),
      ])
      workspaceKeys.value = wsRes.keys
      userKeys.value = meRes.keys
    } finally {
      loading.value = false
    }
  }

  async function addWorkspaceKey(input: AddApiKeyInput) {
    if (!workspaceId.value) return
    const created = await api.addWorkspaceApiKey(workspaceId.value, input)
    workspaceKeys.value = [...workspaceKeys.value, created]
    return created
  }

  async function removeWorkspaceKey(id: string) {
    if (!workspaceId.value) return
    await api.removeWorkspaceApiKey(workspaceId.value, id)
    workspaceKeys.value = workspaceKeys.value.filter((k) => k.id !== id)
  }

  // Pinning a default clears any prior default of the same scope+provider server-side, so a
  // default change reloads the affected scope to reflect the single-default invariant; a plain
  // enable/disable patches the one row in place.
  async function updateWorkspaceKey(id: string, patch: UpdateApiKeyInput) {
    if (!workspaceId.value) return
    const updated = await api.updateWorkspaceApiKey(workspaceId.value, id, patch)
    if (patch.isDefault !== undefined) await load(workspaceId.value)
    else workspaceKeys.value = workspaceKeys.value.map((k) => (k.id === id ? updated : k))
    return updated
  }

  async function addUserKey(input: AddApiKeyInput) {
    const created = await api.addMyApiKey(input)
    userKeys.value = [...userKeys.value, created]
    return created
  }

  async function updateUserKey(id: string, patch: UpdateApiKeyInput) {
    const updated = await api.updateMyApiKey(id, patch)
    if (patch.isDefault !== undefined && workspaceId.value) await load(workspaceId.value)
    else userKeys.value = userKeys.value.map((k) => (k.id === id ? updated : k))
    return updated
  }

  async function removeUserKey(id: string) {
    await api.removeMyApiKey(id)
    userKeys.value = userKeys.value.filter((k) => k.id !== id)
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
  }

  async function updateAccountKey(id: string, patch: UpdateApiKeyInput) {
    if (!accountId.value) return
    const updated = await api.updateAccountApiKey(accountId.value, id, patch)
    if (patch.isDefault !== undefined) await loadAccountKeys(accountId.value)
    else accountKeys.value = accountKeys.value.map((k) => (k.id === id ? updated : k))
    return updated
  }

  async function removeAccountKey(id: string) {
    if (!accountId.value) return
    await api.removeAccountApiKey(accountId.value, id)
    accountKeys.value = accountKeys.value.filter((k) => k.id !== id)
  }

  /** Every key reachable from the workspace (workspace + user scopes), newest first. */
  const allKeys = computed<ApiKey[]>(() => [...workspaceKeys.value, ...userKeys.value])

  /** Providers with at least one reachable connected key. */
  const configuredProviders = computed(
    () => new Set<ApiKeyProvider>(allKeys.value.map((k) => k.provider)),
  )

  function hasProvider(provider: ApiKeyProvider | undefined): boolean {
    return provider ? configuredProviders.value.has(provider) : false
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
    hasProvider,
  }
})
