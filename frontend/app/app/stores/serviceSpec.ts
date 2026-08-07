import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import type { ServiceSpecView } from '~/types/spec'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Service-spec read state. The spec lives sharded in the service repo under `spec/`; the backend
 * reassembles it and serves a {@link ServiceSpecView}. Read-only, fetched on demand, cached.
 * Nothing is persisted client-side.
 *
 * TWO reads, because there are two questions and they have different answers while a pull
 * request is open:
 *
 *  - {@link load} / {@link viewFor}: what the SERVICE requires, from the repo's default branch,
 *    for the inspector's "View Requirements" window.
 *  - {@link loadForRun} / {@link viewForRun}: what ONE RUN was judged against, from the branch
 *    that run pushed to, for the outcome card's requirement join. The card used to read the
 *    first, so every verdict naming a requirement the run itself added joined against a spec
 *    that does not carry it yet and rendered as "not checked" — and the card's counts then
 *    disagreed with `GET /api/v1/runs/:runId/outcome`, which reads the run's branch.
 *
 * One cache, two key spaces: the entries are keyed by a PREFIXED id so a block id and an
 * execution id can never collide, and every accessor mints its key through the same helper.
 */
export const useServiceSpecStore = defineStore('serviceSpec', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  const serviceKey = (blockId: string) => `service:${blockId}`
  const runKey = (executionId: string) => `run:${executionId}`

  /** The fetched view per cache key (undefined = not yet fetched). */
  const views = ref<Record<string, ServiceSpecView>>({})
  /**
   * In-flight loads keyed by cache key — the SINGLE source of truth for "is this loading". A
   * reactive Map so `isLoading` (derived from `.has`) tracks set/delete, and it also coalesces
   * overlapping loads onto one request: no separate loading-flag Set to keep in sync.
   */
  const inFlight = reactive(new Map<string, Promise<void>>())
  /** Cache keys whose last fetch failed (network / unexpected error). */
  const erroredByKey = ref<Set<string>>(new Set())

  function viewFor(blockId: string): ServiceSpecView | undefined {
    return views.value[serviceKey(blockId)]
  }
  function viewForRun(executionId: string): ServiceSpecView | undefined {
    return views.value[runKey(executionId)]
  }
  function isLoading(blockId: string): boolean {
    return inFlight.has(serviceKey(blockId))
  }
  function isErrored(blockId: string): boolean {
    return erroredByKey.value.has(serviceKey(blockId))
  }

  function setErrored(key: string, on: boolean) {
    const next = new Set(erroredByKey.value)
    if (on) next.add(key)
    else next.delete(key)
    erroredByKey.value = next
  }

  /** Fetch (and cache) one view, coalescing concurrent loads of the same key. */
  function loadKeyed(key: string, fetch: (workspaceId: string) => Promise<ServiceSpecView>) {
    if (!workspace.workspaceId) return
    const pending = inFlight.get(key)
    if (pending) return pending
    setErrored(key, false)
    const promise = (async () => {
      try {
        const view = await fetch(workspace.requireId())
        views.value = { ...views.value, [key]: view }
      } catch {
        setErrored(key, true)
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
    return promise
  }

  /** Fetch the DEFAULT-branch spec view for a service frame block. */
  async function load(blockId: string) {
    return loadKeyed(serviceKey(blockId), (workspaceId) => api.getServiceSpec(workspaceId, blockId))
  }

  /** Fetch the spec view ONE RUN was judged against, from that run's own branch. */
  async function loadForRun(executionId: string) {
    return loadKeyed(runKey(executionId), (workspaceId) => api.getRunSpec(workspaceId, executionId))
  }

  return {
    views,
    viewFor,
    viewForRun,
    isLoading,
    isErrored,
    load,
    loadForRun,
  }
})
