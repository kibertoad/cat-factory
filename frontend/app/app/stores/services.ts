import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Service, WorkspaceMount } from '~/types/services'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * In-org shared services. A `Service` is account-owned (a service frame + its subtree + repo)
 * and can be mounted onto several teams' boards; a `WorkspaceMount` places one onto THIS
 * board with its own frame layout. Hydrated from the workspace snapshot:
 *   - `mounts` — the services this board mounts (drives the per-board frame layout),
 *   - `catalog` — the org's services this board can mount from (each with a `mountCount`).
 */
export const useServicesStore = defineStore('services', () => {
  const api = useApi()

  const mounts = ref<WorkspaceMount[]>([])
  const catalog = ref<Service[]>([])

  function hydrate(nextMounts: WorkspaceMount[], nextCatalog: Service[]) {
    mounts.value = [...nextMounts]
    catalog.value = [...nextCatalog]
  }

  /** Mount row keyed by service id. */
  const byServiceId = computed<Record<string, WorkspaceMount>>(() => {
    const map: Record<string, WorkspaceMount> = {}
    for (const m of mounts.value) map[m.serviceId] = m
    return map
  })

  /** Catalog service keyed by its frame block id (resolve a frame → its service). */
  const serviceByFrameBlock = computed<Record<string, Service>>(() => {
    const map: Record<string, Service> = {}
    for (const s of catalog.value) map[s.frameBlockId] = s
    return map
  })

  /** Org services NOT yet mounted on this board (the "add existing service" picker's options). */
  const mountable = computed<Service[]>(() => {
    const mounted = new Set(mounts.value.map((m) => m.serviceId))
    return catalog.value.filter((s) => !mounted.has(s.id))
  })

  /** A frame is "shared" when its service is mounted on more than one board. */
  function isSharedFrame(frameBlockId: string): boolean {
    return (serviceByFrameBlock.value[frameBlockId]?.mountCount ?? 0) > 1
  }

  /**
   * Drop the account-owned service (and this board's mount) backing a just-deleted frame.
   * The acting tab is deliberately NOT echoed its own coarse `board` event (see
   * `useWorkspaceStream`), so a service-frame delete never triggers a snapshot re-hydrate
   * here — without this the deleted service lingers in `catalog`, which the add-service
   * picker reads to flag a repo as "already on board", so the repo can't be re-added until
   * a full refresh. Called once the delete has COMMITTED server-side (the service is gone),
   * so it can never briefly present a still-linked repo as addable. A no-op for a task/module
   * id (nothing in the catalog matches its frame).
   */
  function dropByFrameBlock(frameBlockId: string) {
    const service = catalog.value.find((s) => s.frameBlockId === frameBlockId)
    if (!service) return
    catalog.value = catalog.value.filter((s) => s.id !== service.id)
    mounts.value = mounts.value.filter((m) => m.serviceId !== service.id)
  }

  async function mount(serviceId: string, position?: { x: number; y: number }) {
    const ws = useWorkspaceStore()
    const created = await api.mountService(ws.requireId(), serviceId, position ? { position } : {})
    await ws.refresh()
    return created
  }

  async function unmount(serviceId: string) {
    const ws = useWorkspaceStore()
    await api.unmountService(ws.requireId(), serviceId)
    await ws.refresh()
  }

  /** Persist a mounted frame's per-board layout (called on frame drag/resize end). */
  async function updateLayout(
    serviceId: string,
    position?: { x: number; y: number },
    size?: { w: number; h: number } | null,
  ) {
    const ws = useWorkspaceStore()
    const updated = await api.updateMountLayout(ws.requireId(), serviceId, { position, size })
    const local = mounts.value.find((m) => m.serviceId === serviceId)
    if (local) Object.assign(local, updated)
    return updated
  }

  return {
    mounts,
    catalog,
    byServiceId,
    serviceByFrameBlock,
    mountable,
    isSharedFrame,
    dropByFrameBlock,
    hydrate,
    mount,
    unmount,
    updateLayout,
  }
})
