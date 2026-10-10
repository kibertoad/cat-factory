import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AddPackageRegistryInput, PackageRegistryEntryView } from '~/types/packageRegistries'
import { useWorkspaceStore } from '~/stores/workspace'
import { apiErrorStatus } from '~/composables/api/errors'

/**
 * The workspace's private package-registry entries (npm private orgs, GitHub
 * Packages) that agent containers install with. Tokens are write-only — the store
 * only ever holds the redacted summary views. Loaded on demand (the Infrastructure
 * window's "Package registries" tab, whose very existence gates on the probe below),
 * not from the snapshot.
 */
export const usePackageRegistriesStore = defineStore('packageRegistries', () => {
  const api = useApi()

  const entries = ref<PackageRegistryEntryView[]>([])
  const loading = ref(false)
  // Mirrors the backend's opt-in gate (the module 503s when the encryption key is
  // absent): `null` until first probed, then `true`/`false`. The Infrastructure window
  // shows no registries tab unless this is `true`.
  const available = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /** Force a refresh of the entry list (used after an add/remove). */
  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      entries.value = (await api.listPackageRegistries(ws.requireId())).entries
      available.value = true
    } catch (err) {
      if (apiErrorStatus(err) === 503) {
        // A definitive 503 means the integration is unconfigured (no encryption key on
        // the backend): hide the UI entry points and stop probing. This is an ANSWER, not a
        // failure, so it resolves normally.
        available.value = false
        entries.value = []
        return
      }
      // Any other failure (transient 5xx / network) leaves the state untouched: it must not
      // hide an already-available panel nor cache a false "unavailable". `available` stays
      // `null` when never probed, so `ensureLoaded` remains retryable on the next open — and
      // the error PROPAGATES so a caller can say so. Swallowing it made every caller's error
      // branch dead code: "the backend is unreachable" and "your deployment has no registries
      // module" are different problems that must not render identically, and the panel is the
      // one surface that can tell a reader which it hit. The PROBE callers still swallow (a
      // failed probe means no tab, not a broken window) — the split is deliberate.
      //
      // NB `publicApiKeys` carries the same availability shape and still swallows here. It is
      // not being changed alongside: its probe only hides one row of a hub full of others,
      // whereas this one gates the feature's ONLY surface.
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

  async function add(input: AddPackageRegistryInput) {
    const ws = useWorkspaceStore()
    entries.value = (await api.addPackageRegistry(ws.requireId(), input)).entries
    available.value = true
  }

  async function remove(entryId: string) {
    const ws = useWorkspaceStore()
    await api.deletePackageRegistry(ws.requireId(), entryId)
    entries.value = entries.value.filter((entry) => entry.id !== entryId)
  }

  return { entries, loading, available, load, ensureLoaded, add, remove }
})
