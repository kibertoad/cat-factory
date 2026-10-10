import { ref } from 'vue'
import type {
  InitiativeExecutionPolicy,
  PromoteInitiativeFollowUpInput,
  UpdateInitiativeItemInput,
} from '~/types/domain'
import type { InitiativeActionContext } from './planning'

/**
 * The tracker-curation actions: promoting / dismissing a harvested follow-up, editing one
 * tracker item (or driving its status), and replacing the execution policy. Every one runs
 * through the shared `curate` wrapper so the window has a single in-flight flag.
 */
export function createInitiativeCurationActions(ctx: InitiativeActionContext) {
  const { api, workspace, upsert } = ctx

  /** True while a curation action (promote/dismiss/edit item/edit policy) is in flight. */
  const curating = ref(false)

  async function curate<T>(fn: () => Promise<T>): Promise<T> {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    curating.value = true
    try {
      return await fn()
    } finally {
      curating.value = false
    }
  }

  /** Promote an `open` harvested follow-up into a new pending tracker item. */
  async function promoteFollowUp(
    initiativeId: string,
    followUpId: string,
    input: PromoteInitiativeFollowUpInput,
  ) {
    return curate(async () => {
      const updated = await api.promoteInitiativeFollowUp(
        workspace.workspaceId!,
        initiativeId,
        followUpId,
        input,
      )
      upsert(updated)
      return updated
    })
  }

  /** Dismiss a harvested follow-up. */
  async function dismissFollowUp(initiativeId: string, followUpId: string) {
    return curate(async () => {
      const updated = await api.dismissInitiativeFollowUp(
        workspace.workspaceId!,
        initiativeId,
        followUpId,
      )
      upsert(updated)
      return updated
    })
  }

  /** Edit one tracker item and/or drive its status (retry a blocked item / skip it). */
  async function updateItem(
    initiativeId: string,
    itemId: string,
    input: UpdateInitiativeItemInput,
  ) {
    return curate(async () => {
      const updated = await api.updateInitiativeItem(
        workspace.workspaceId!,
        initiativeId,
        itemId,
        input,
      )
      upsert(updated)
      return updated
    })
  }

  /** Replace the execution policy (concurrency + pipeline rules). */
  async function updatePolicy(initiativeId: string, policy: InitiativeExecutionPolicy) {
    return curate(async () => {
      const updated = await api.updateInitiativePolicy(workspace.workspaceId!, initiativeId, policy)
      upsert(updated)
      return updated
    })
  }

  return { curating, promoteFollowUp, dismissFollowUp, updateItem, updatePolicy }
}
