import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createUserScopedLoad } from '~/stores/userScopedLoad'
import type {
  LocalModelEndpoint,
  LocalModelEndpointTestResult,
  LocalRunner,
  TestLocalModelEndpointInput,
  UpsertLocalModelEndpointInput,
} from '~/types/localModels'

// The signed-in user's local model runner endpoints — Ollama / LM Studio / llama.cpp /
// vLLM / a custom OpenAI-compatible server running on their OWN machine. A runner lives
// on a person's box (`localhost:11434` means something different per member), so these are
// stored PER USER, not pooled on the workspace. The API key is write-only server-side and
// never returned; this store only carries the metadata (+ the enabled model ids). Loaded
// INDEPENDENTLY (not from the workspace snapshot) — like personal subscriptions.
export const useLocalModelsStore = defineStore('localModels', () => {
  const api = useApi()
  const endpoints = ref<LocalModelEndpoint[]>([])
  const { loading, loadFailed, load } = createUserScopedLoad({
    fetch: () => api.listLocalModelEndpoints(),
    apply: ({ endpoints: list }) => (endpoints.value = list),
    reset: () => (endpoints.value = []),
  })

  async function upsert(input: UpsertLocalModelEndpointInput) {
    const endpoint = await api.upsertLocalModelEndpoint(input.provider, input)
    endpoints.value = [...endpoints.value.filter((e) => e.provider !== endpoint.provider), endpoint]
    return endpoint
  }

  async function remove(provider: LocalRunner) {
    await api.deleteLocalModelEndpoint(provider)
    endpoints.value = endpoints.value.filter((e) => e.provider !== provider)
  }

  async function test(input: TestLocalModelEndpointInput): Promise<LocalModelEndpointTestResult> {
    return await api.testLocalModelEndpoint(input)
  }

  return { endpoints, loading, loadFailed, load, upsert, remove, test }
})
