import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AddPackageRegistryInput, PackageRegistryEntryView } from '~/types/packageRegistries'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's private package-registry entries (npm private orgs, GitHub
 * Packages) that agent containers install with. Tokens are write-only — the store
 * only ever holds the redacted summary views. Loaded on demand (the registries
 * panel + the Integrations hub badge), not from the snapshot.
 */
export const usePackageRegistriesStore = defineStore('packageRegistries', () => {
  const api = useApi()

  const entries = ref<PackageRegistryEntryView[]>([])
  const loading = ref(false)
  // Mirrors the backend's opt-in gate (the module 503s when the encryption key is
  // absent): `null` until first probed, then `true`/`false`. The hub hides its
  // registries entry point when this is false.
  const available = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /** Force a refresh of the entry list (used after an add/remove). */
  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      entries.value = (await api.listPackageRegistries(ws.requireId())).entries
      available.value = true
    } catch {
      // 503 (package registries unconfigured) or any error → hide the UI entry points.
      available.value = false
      entries.value = []
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
