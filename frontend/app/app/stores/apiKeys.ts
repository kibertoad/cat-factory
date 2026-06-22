import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AddApiKeyInput, ApiKey, ApiKeyProvider } from '~/types/domain'

/**
 * The direct-provider API keys reachable from a workspace: the workspace's own keys
 * plus the signed-in user's personal keys (account-scoped keys are managed in the
 * account/team settings). Onboarded via UI, stored encrypted + pooled by the backend;
 * keys are write-only so only metadata + rolling-window usage is ever returned.
 * `configuredProviders` drives the model picker (a direct model is selectable once a
 * key for its provider is connected at any reachable scope).
 */
export const useApiKeysStore = defineStore('apiKeys', () => {
  const api = useApi()
  const workspaceKeys = ref<ApiKey[]>([])
  const userKeys = ref<ApiKey[]>([])
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
  }

  async function removeWorkspaceKey(id: string) {
    if (!workspaceId.value) return
    await api.removeWorkspaceApiKey(workspaceId.value, id)
    workspaceKeys.value = workspaceKeys.value.filter((k) => k.id !== id)
  }

  async function addUserKey(input: AddApiKeyInput) {
    const created = await api.addMyApiKey(input)
    userKeys.value = [...userKeys.value, created]
  }

  async function removeUserKey(id: string) {
    await api.removeMyApiKey(id)
    userKeys.value = userKeys.value.filter((k) => k.id !== id)
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
    allKeys,
    loading,
    load,
    addWorkspaceKey,
    removeWorkspaceKey,
    addUserKey,
    removeUserKey,
    configuredProviders,
    hasProvider,
  }
})
