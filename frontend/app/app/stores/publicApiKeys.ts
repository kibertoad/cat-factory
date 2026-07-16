import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CreatedPublicApiKey, PublicApiKey } from '~/types/publicApiKeys'
import { useWorkspaceStore } from '~/stores/workspace'
import { apiErrorStatus } from '~/composables/api/errors'

/**
 * The workspace's inbound public-API keys ("API access tokens") external systems present
 * to the `/api/v1` surface. Secrets are one-way hashed server-side and returned only once
 * on create, so the store holds metadata-only views; the raw secret is surfaced by the
 * caller from the `create()` result. Loaded on demand (the tokens panel + the Integrations
 * hub badge), not from the snapshot.
 */
export const usePublicApiKeysStore = defineStore('publicApiKeys', () => {
  const api = useApi()

  const keys = ref<PublicApiKey[]>([])
  const loading = ref(false)
  // Mirrors the backend's opt-in gate (the module 503s when the encryption key is absent):
  // `null` until first probed, then `true`/`false`. The hub hides its tokens entry point
  // when this is false.
  const available = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /** Force a refresh of the key list (used after a create/revoke). */
  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      keys.value = (await api.listPublicApiKeys(ws.requireId())).keys
      available.value = true
    } catch (err) {
      if (apiErrorStatus(err) === 503) {
        // A definitive 503 means the feature is unconfigured (no encryption key on the
        // backend): hide the UI entry points and stop probing.
        available.value = false
        keys.value = []
      }
      // Any other failure (transient 5xx / network) is left untouched: it must not hide an
      // already-available panel nor cache a false "unavailable". `available` stays `null`
      // when never probed, so `ensureLoaded` remains retryable on the next open.
    } finally {
      loading.value = false
    }
  }

  /** Load once and share the result (coalescing concurrent callers); `load()` refreshes. */
  async function ensureLoaded() {
    if (available.value !== null) return
    if (!inFlight) inFlight = load().finally(() => (inFlight = null))
    return inFlight
  }

  /** Mint a key. Returns the created record PLUS the one-time raw secret (shown once). */
  async function create(label: string): Promise<CreatedPublicApiKey> {
    const ws = useWorkspaceStore()
    const created = await api.createPublicApiKey(ws.requireId(), { label })
    // Prepend: the backend lists newest-first, so the freshly minted key belongs at the
    // top — matching the order a subsequent `load()` would produce.
    keys.value = [created.key, ...keys.value]
    available.value = true
    return created
  }

  async function revoke(id: string) {
    const ws = useWorkspaceStore()
    await api.revokePublicApiKey(ws.requireId(), id)
    keys.value = keys.value.filter((k) => k.id !== id)
  }

  return { keys, loading, available, load, ensureLoaded, create, revoke }
})
