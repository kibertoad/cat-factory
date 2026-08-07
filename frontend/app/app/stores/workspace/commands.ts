import type { Ref } from 'vue'
import type { WorkspaceListItem, WorkspaceSnapshot } from '~/types/domain'
import { useAccountsStore } from '~/stores/accounts'

/**
 * Shared reactive state + injected dependencies the workspace-store board-CRUD factory closes
 * over. Created once in the `workspace` store setup and threaded into
 * {@link createWorkspaceCommands} so the split operations stay behaviourally identical to the
 * original single-closure store — a size-only extraction mirroring `stores/workspace/hydrate.ts`
 * and `stores/workspace/infraSetup.ts`, not a new seam.
 */
export interface WorkspaceCommandContext {
  api: ReturnType<typeof useApi>
  workspaceId: Ref<string | null>
  workspaces: Ref<WorkspaceListItem[]>
  hydrate: (snapshot: WorkspaceSnapshot) => void
  /** Open one of the active account's boards, creating one when it has none. */
  resolveActiveBoard: () => Promise<void>
}

/** Open / create / rename / delete a board, plus switching the active account. */
export function createWorkspaceCommands(ctx: WorkspaceCommandContext) {
  const { api, workspaceId, workspaces, hydrate, resolveActiveBoard } = ctx

  /** Switch to another board (within reach of the active account). */
  async function switchTo(id: string) {
    if (id === workspaceId.value) return
    hydrate(await api.getWorkspace(id))
  }

  /** Switch the active account, then open one of its boards (creating one if needed). */
  async function selectAccount(id: string) {
    const accounts = useAccountsStore()
    if (id === accounts.activeAccountId) return
    accounts.switchTo(id)
    workspaceId.value = null
    await resolveActiveBoard()
  }

  /** Create a new board in the active account and open it. */
  async function create(name?: string, description?: string) {
    const accounts = useAccountsStore()
    const snapshot = await api.createWorkspace({
      seed: false,
      name,
      description,
      accountId: accounts.activeAccountId ?? undefined,
    })
    hydrate(snapshot)
    return snapshot.workspace
  }

  /** Rename a board and/or update its description. */
  async function update(id: string, patch: { name?: string; description?: string | null }) {
    const updated = await api.updateWorkspace(id, patch)
    const i = workspaces.value.findIndex((w) => w.id === id)
    if (i >= 0) workspaces.value[i] = updated
    return updated
  }

  /** Rename a board (kept for the existing rename callers). */
  async function rename(id: string, name: string) {
    return update(id, { name })
  }

  /** Delete a board; if it was active, fall back to another in the account. */
  async function remove(id: string) {
    await api.deleteWorkspace(id)
    workspaces.value = workspaces.value.filter((w) => w.id !== id)
    if (workspaceId.value === id) {
      workspaceId.value = null
      await resolveActiveBoard()
    }
  }

  return { switchTo, selectAccount, create, update, rename, remove }
}
