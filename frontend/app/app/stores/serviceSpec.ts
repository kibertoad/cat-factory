import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
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
  /**
   * In-flight loads keyed by block id — the SINGLE source of truth for "is this block
   * loading". A reactive Map so `isLoading` (derived from `.has`) tracks set/delete, and it
   * also coalesces overlapping loads onto one request: no separate loading-flag Set to keep
   * in sync.
   */
  const inFlight = reactive(new Map<string, Promise<void>>())
  /** Block ids whose last fetch failed (network / unexpected error). */
  const erroredByBlock = ref<Set<string>>(new Set())

  function viewFor(blockId: string): ServiceSpecView | undefined {
    return views.value[blockId]
  }
  function isLoading(blockId: string): boolean {
    return inFlight.has(blockId)
  }
  function isErrored(blockId: string): boolean {
    return erroredByBlock.value.has(blockId)
  }

  function setErrored(key: string, on: boolean) {
    const next = new Set(erroredByBlock.value)
    if (on) next.add(key)
    else next.delete(key)
    erroredByBlock.value = next
  }

  /** Fetch (and cache) the spec view for a service frame block. */
  async function load(blockId: string) {
    if (!workspace.workspaceId) return
    const pending = inFlight.get(blockId)
    if (pending) return pending
    setErrored(blockId, false)
    const promise = (async () => {
      try {
        const view = await api.getServiceSpec(workspace.requireId(), blockId)
        views.value = { ...views.value, [blockId]: view }
      } catch {
        setErrored(blockId, true)
      } finally {
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
