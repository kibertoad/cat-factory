import { defineStore } from 'pinia'
import { ref } from 'vue'
import { isAbsentFeatureRefusal } from '~/composables/api/errors'
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
  const loading = ref(false)
  /** True when the last `load()` failed for a reason other than auth or the feature being off. */
  const loadFailed = ref(false)

  async function load() {
    loading.value = true
    try {
      const { endpoints: list } = await api.listLocalModelEndpoints()
      endpoints.value = list
      loadFailed.value = false
    } catch (err) {
      // Auth disabled / not signed in (401) or feature off (503) → no local runners surface.
      // Any other failure is recorded, so a reader can tell it from an empty list.
      loadFailed.value = !isAbsentFeatureRefusal(err)
      endpoints.value = []
    } finally {
      loading.value = false
    }
  }

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
