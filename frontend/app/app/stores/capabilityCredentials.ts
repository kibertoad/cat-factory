import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CapabilityCredentialsView } from '~/types/capabilityCredentials'
import { useWorkspaceStore } from '~/stores/workspace'
import { apiErrorStatus } from '~/composables/api/errors'

/**
 * The workspace's capability credentials: the sealed, tenant-scoped values behind the secrets a
 * registered tool server (MCP) or generative binary integration declares BY NAME. Values are
 * write-only — the store only ever holds the view, which pairs the deployment's DECLARATIONS with
 * which of them this workspace has stored. Loaded on demand (the Infrastructure window's
 * "Capability credentials" tab, whose existence gates on the probe below), not from the snapshot.
 *
 * Writes are PER KEY. A whole-set write exists on the API for a caller declaring a set at once,
 * and this store cannot use it: it never receives the values, so replacing the set would delete
 * every credential the operator did not retype in this sitting.
 */
export const useCapabilityCredentialsStore = defineStore('capabilityCredentials', () => {
  const api = useApi()

  const view = ref<CapabilityCredentialsView | null>(null)
  const loading = ref(false)
  // Mirrors the backend's two definitive refusals: the module 503s with no encryption key, and
  // the whole surface (the READ included) is `secrets.manage`-gated, so a member without it gets
  // a 403. `null` until first probed, then `true`/`false`. Both answers hide the tab rather than
  // disabling it — a member who cannot manage secrets has no business learning which environment
  // variables the deployment's capabilities want, which is the very content of this view.
  const available = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /**
   * Whether there is anything to show. The panel is a CHECKLIST projected from the deployment's
   * registered capabilities, so with nothing declared, nothing orphaned and a complete read there
   * is no credential to type and no tab worth rendering.
   *
   * `declarationsIncomplete` keeps the surface even when both lists are empty, because then the
   * emptiness is an OUTAGE (`BinaryGeneratorSource` throws rather than answering an empty set)
   * rather than an answer, and hiding the tab would render the outage as "this deployment needs
   * no credentials".
   */
  const hasSurface = computed(
    () =>
      view.value !== null &&
      (view.value.declared.length > 0 ||
        view.value.orphaned.length > 0 ||
        view.value.declarationsIncomplete),
  )

  /** Force a refresh of the view (used after a save/remove). */
  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      view.value = await api.getCapabilityCredentials(ws.requireId())
      available.value = true
    } catch (err) {
      const status = apiErrorStatus(err)
      if (status === 503 || status === 403) {
        // Definitive answers, not failures: the module is unconfigured, or this caller may not
        // manage secrets. Hide the entry point and stop probing; resolve normally.
        available.value = false
        view.value = null
        return
      }
      // Any other failure (transient 5xx / network) leaves the state untouched: it must not hide
      // an already-available panel nor cache a false "unavailable", and `available` stays `null`
      // when never probed so `ensureLoaded` remains retryable. The error PROPAGATES, because the
      // panel is the one surface that can tell a reader it is looking at a list we could not
      // fetch — the PROBE caller swallows instead (a failed probe means no tab, not a broken
      // window). Same split as the package-registries store.
      throw err
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

  /** Store ONE credential's value, leaving every other stored key as it is. */
  async function save(key: string, value: string) {
    const ws = useWorkspaceStore()
    view.value = await api.setCapabilityCredential(ws.requireId(), key, value)
    available.value = true
  }

  /** Remove ONE stored credential (a rotated key, or an orphan nothing declares any more). */
  async function remove(key: string) {
    const ws = useWorkspaceStore()
    await api.deleteCapabilityCredential(ws.requireId(), key)
    // The DELETE answers 204, so the view is re-read rather than patched locally: the declared
    // half is deployment state this client does not own, and a locally-patched row would drift
    // from it the moment the deployment changed.
    await load()
  }

  return { view, loading, available, hasSurface, load, ensureLoaded, save, remove }
})
