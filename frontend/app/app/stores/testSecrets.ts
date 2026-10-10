import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { TestSecretRef, UpsertServiceTestSecretsInput } from '~/types/testSecrets'
import { useWorkspaceStore } from '~/stores/workspace'
import { apiErrorStatus } from '~/composables/api/errors'

/**
 * A service frame's SENSITIVE test secrets (a third-party token a Tester needs to
 * exercise an integration). Sealed on the backend and delivered to the container out of
 * band; the store only ever holds the non-secret refs (key + description) — values are
 * write-only and never read back. Loaded on demand per service frame (the inspector
 * panel), not from the snapshot, since the secrets never leave the server.
 */
export const useTestSecretsStore = defineStore('testSecrets', () => {
  const api = useApi()

  // Per service-frame block id → the configured secret refs (key + description).
  const byBlock = ref<Record<string, TestSecretRef[]>>({})
  const loading = ref(false)
  // Mirrors the backend's opt-in gate (the controller 503s when ENCRYPTION_KEY is absent):
  // `null` until first probed, then `true`/`false`. The inspector panel hides itself when
  // this is false, so a deployment with no sealed-secret store doesn't surface a dead control.
  const available = ref<boolean | null>(null)
  const inFlight = new Map<string, Promise<void>>()

  /** Force a refresh of one block's configured secret refs (used after a save/clear). */
  async function load(blockId: string) {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      const view = await api.getServiceTestSecrets(ws.requireId(), blockId)
      byBlock.value[blockId] = view.entries
      available.value = true
    } catch (err) {
      if (apiErrorStatus(err) === 503) {
        // A definitive 503 means the store is unconfigured (no encryption key on the
        // backend): hide the UI entry point and stop probing.
        available.value = false
        byBlock.value[blockId] = []
      }
      // Any other failure (transient 5xx / network) is left untouched: it must not hide an
      // already-available panel nor cache a false "unavailable". `available` stays `null`
      // when never probed, so `ensureLoaded` remains retryable on the next open.
    } finally {
      loading.value = false
    }
  }

  /**
   * Load one block's refs once and share the result, coalescing concurrent callers for the
   * SAME block. `load()` forces a refresh.
   */
  async function ensureLoaded(blockId: string) {
    // Store known-unconfigured (a definitive 503) is a deployment-level fact — don't re-probe
    // per service frame; the panel is hidden anyway.
    if (available.value === false) return
    if (byBlock.value[blockId] !== undefined) return
    if (!inFlight.has(blockId)) {
      inFlight.set(
        blockId,
        load(blockId).finally(() => inFlight.delete(blockId)),
      )
    }
    return inFlight.get(blockId)
  }

  /** The configured refs for a block (empty until loaded). */
  function entriesForBlock(blockId: string): TestSecretRef[] {
    return byBlock.value[blockId] ?? []
  }

  /** Replace a service frame's full secret set (values write-only); empty set clears it. */
  async function save(blockId: string, input: UpsertServiceTestSecretsInput) {
    const ws = useWorkspaceStore()
    const view = await api.setServiceTestSecrets(ws.requireId(), blockId, input)
    byBlock.value[blockId] = view.entries
    available.value = true
    return view
  }

  /** Remove all of a service frame's secrets. */
  async function clear(blockId: string) {
    const ws = useWorkspaceStore()
    await api.deleteServiceTestSecrets(ws.requireId(), blockId)
    byBlock.value[blockId] = []
  }

  return { byBlock, loading, available, load, ensureLoaded, entriesForBlock, save, clear }
})
