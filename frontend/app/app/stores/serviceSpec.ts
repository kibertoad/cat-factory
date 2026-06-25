import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ServiceSpecView } from '~/types/spec'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Service-spec read state for the inspector's "View Requirements" window. The spec lives
 * sharded in the service repo under `spec/`; the backend reassembles it from the repo's
 * default branch and serves a {@link ServiceSpecView}. Read-only and fetched on demand
 * (per service frame block), cached per block. Nothing is persisted client-side.
 */
export const useServiceSpecStore = defineStore('serviceSpec', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** The fetched view per block id (undefined = not yet fetched). */
  const views = ref<Record<string, ServiceSpecView>>({})
  /** Block ids whose view is currently being fetched. */
  const loadingByBlock = ref<Set<string>>(new Set())
  /** Block ids whose last fetch failed (network / unexpected error). */
  const erroredByBlock = ref<Set<string>>(new Set())
  /** Coalesce overlapping loads of the same block onto one request. */
  const inFlight = new Map<string, Promise<void>>()

  function viewFor(blockId: string): ServiceSpecView | undefined {
    return views.value[blockId]
  }
  function isLoading(blockId: string): boolean {
    return loadingByBlock.value.has(blockId)
  }
  function isErrored(blockId: string): boolean {
    return erroredByBlock.value.has(blockId)
  }

  function withFlag(set: typeof loadingByBlock, key: string, on: boolean) {
    const next = new Set(set.value)
    if (on) next.add(key)
    else next.delete(key)
    set.value = next
  }

  /** Fetch (and cache) the spec view for a service frame block. */
  async function load(blockId: string) {
    if (!workspace.workspaceId) return
    const pending = inFlight.get(blockId)
    if (pending) return pending
    const promise = (async () => {
      withFlag(loadingByBlock, blockId, true)
      withFlag(erroredByBlock, blockId, false)
      try {
        const view = await api.getServiceSpec(workspace.requireId(), blockId)
        views.value = { ...views.value, [blockId]: view }
      } catch {
        withFlag(erroredByBlock, blockId, true)
      } finally {
        withFlag(loadingByBlock, blockId, false)
        inFlight.delete(blockId)
      }
    })()
    inFlight.set(blockId, promise)
    return promise
  }

  return {
    views,
    viewFor,
    isLoading,
    isErrored,
    load,
  }
})
