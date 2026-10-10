import { defineStore } from 'pinia'
import type {
  DetectSharedStackInput,
  SharedStack,
  UpdateSharedStackInput,
} from '~/types/sharedStacks'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's shared stacks — long-lived compose infra (e.g. acme-shared-services) that
 * per-PR consumer environments attach to over an external network. Hydrated from the workspace
 * snapshot; managed via the Infrastructure window's "Shared stacks" panel. CRUD works on every
 * backend, but the bring-up (`ensureUp`) / teardown drive a host Docker daemon, so they succeed
 * only on the local facade (elsewhere the backend returns a clear error the panel surfaces).
 *
 * Mutations refresh the workspace snapshot (the stack list rides it), while the async lifecycle
 * actions patch the returned record in place so the panel shows the new status immediately.
 */
export const useSharedStacksStore = defineStore('sharedStacks', () => {
  const api = useApi()
  const { items: stacks, upsert: patch } = useUpsertList<SharedStack>({ key: (s) => s.id })

  function hydrate(list: SharedStack[]) {
    // Keep the snapshot sorted oldest-first; the helper's plain hydrate wouldn't sort.
    stacks.value = [...list].sort((a, b) => a.createdAt - b.createdAt)
  }

  async function create(input: Parameters<typeof api.createSharedStack>[1]) {
    const ws = useWorkspaceStore()
    const created = await api.createSharedStack(ws.requireId(), input)
    await ws.refresh()
    return created
  }

  async function detect(input: DetectSharedStackInput) {
    const ws = useWorkspaceStore()
    return api.detectSharedStack(ws.requireId(), input)
  }

  async function update(stackId: string, patchInput: UpdateSharedStackInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateSharedStack(ws.requireId(), stackId, patchInput)
    await ws.refresh()
    return updated
  }

  async function remove(stackId: string) {
    const ws = useWorkspaceStore()
    await api.deleteSharedStack(ws.requireId(), stackId)
    await ws.refresh()
  }

  async function ensureUp(stackId: string) {
    const ws = useWorkspaceStore()
    const updated = await api.ensureSharedStackUp(ws.requireId(), stackId)
    patch(updated)
    return updated
  }

  async function teardown(stackId: string) {
    const ws = useWorkspaceStore()
    const updated = await api.teardownSharedStack(ws.requireId(), stackId)
    patch(updated)
    return updated
  }

  return { stacks, hydrate, create, detect, update, remove, ensureUp, teardown }
})
