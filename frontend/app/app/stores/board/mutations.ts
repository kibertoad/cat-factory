import type {
  BlockType,
  CreateTaskType,
  FrameRepoType,
  TaskTypeFields,
  Block,
} from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'
import type { BoardWriteContext } from './context'

/**
 * The board's creation writes (services / modules / tasks / epics) plus the archive-restore
 * lifecycle, extracted from the store setup. Each closes over the shared
 * {@link BoardWriteContext} (the authoritative block returned by the API is applied via `upsert`)
 * so behaviour is identical to the original in-closure functions — the split is purely to keep
 * every function within the size budget. The placement + edit writes live alongside in
 * {@link createBoardPlacement}.
 */
export function createBoardMutations(ctx: BoardWriteContext) {
  const { getBlock, upsert, api, present } = ctx

  async function addBlock(type: BlockType, position: { x: number; y: number }): Promise<Block> {
    const block = await api.addFrame(useWorkspaceStore().requireId(), { type, position })
    upsert(block)
    return block
  }

  /**
   * Import an existing GitHub repo (the App is installed + it's projected) as a
   * service frame, with no bootstrap run. The backend links the repo to the new
   * frame and returns it `ready`; we upsert it onto the board. When the repo already
   * backs an org service, the backend MOUNTS that shared service here instead of
   * minting a rival — so refresh the snapshot to pull in the shared frame's subtree
   * + its mount layout (a fresh import has no subtree, but the reconcile is harmless).
   */
  async function addServiceFromRepo(
    repoGithubId: number,
    opts?: {
      directory?: string
      isMonorepo?: boolean
      type?: FrameRepoType
      position?: { x: number; y: number }
    },
  ): Promise<Block> {
    const block = await api.addServiceFromRepo(useWorkspaceStore().requireId(), {
      repoGithubId,
      ...(opts?.directory ? { directory: opts.directory } : {}),
      ...(opts?.isMonorepo !== undefined ? { isMonorepo: opts.isMonorepo } : {}),
      ...(opts?.type ? { type: opts.type } : {}),
      ...(opts?.position ? { position: opts.position } : {}),
    })
    upsert(block)
    await useWorkspaceStore().refresh()
    return block
  }

  /**
   * Add a task inside a container (a service or a module). The user supplies the
   * title (and optional description) — the task is created in `planned` state and
   * is not launched until the user explicitly starts a pipeline on it.
   */
  async function addTask(
    containerId: string,
    title: string,
    description?: string,
    options?: {
      taskType?: CreateTaskType
      taskTypeFields?: TaskTypeFields
      riskPolicyId?: string
      modelPresetId?: string
      pipelineId?: string
      agentConfig?: Record<string, string>
      fragmentIds?: string[]
      technical?: boolean
      // Opt-in review-debt friction: set on the retry after the human confirms the friction
      // dialog, so a soft `review_debt_warn` 409 is tunnelled through (never a hard block).
      acknowledgeReviewDebt?: boolean
    },
  ): Promise<Block | undefined> {
    if (!getBlock(containerId)) return
    const block = await api.addTask(useWorkspaceStore().requireId(), containerId, {
      title,
      description,
      ...(options?.taskType ? { taskType: options.taskType } : {}),
      ...(options?.taskTypeFields ? { taskTypeFields: options.taskTypeFields } : {}),
      ...(options?.riskPolicyId ? { riskPolicyId: options.riskPolicyId } : {}),
      ...(options?.modelPresetId ? { modelPresetId: options.modelPresetId } : {}),
      ...(options?.pipelineId ? { pipelineId: options.pipelineId } : {}),
      ...(options?.agentConfig ? { agentConfig: options.agentConfig } : {}),
      // Forward the selection when the caller provides one (the create form always does, even
      // when empty — an explicit clear the backend must honour rather than re-seed); omit only
      // when a caller doesn't manage fragments at all (then the backend seeds from the service).
      ...(options?.fragmentIds !== undefined ? { fragmentIds: options.fragmentIds } : {}),
      ...(options?.technical ? { technical: true } : {}),
      ...(options?.acknowledgeReviewDebt ? { acknowledgeReviewDebt: true } : {}),
    })
    upsert(block)
    return block
  }

  /**
   * Add an epic grouping node. Epics are non-structural: they group tasks via the tasks'
   * `epicId`, so this just drops a new `epic`-level block on the board.
   */
  async function addEpic(
    title: string,
    position: { x: number; y: number },
    options?: { description?: string; parentId?: string },
  ): Promise<Block> {
    const block = await api.addEpic(useWorkspaceStore().requireId(), {
      title,
      position,
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.parentId ? { parentId: options.parentId } : {}),
    })
    upsert(block)
    return block
  }

  /** Assign a task to an epic, or detach it (epicId: null). */
  async function assignToEpic(taskId: string, epicId: string | null) {
    const t = getBlock(taskId)
    if (!t) return
    const prev = t.epicId ?? null
    t.epicId = epicId // optimistic
    try {
      upsert(await api.assignToEpic(useWorkspaceStore().requireId(), taskId, { epicId }))
    } catch (e) {
      t.epicId = prev
      present(e, 'board.toast.epicFailed')
    }
  }

  /** Add a module (sub-frame) inside a service. */
  async function addModule(
    serviceId: string,
    name: string,
    position?: { x: number; y: number },
  ): Promise<Block | undefined> {
    if (!getBlock(serviceId)) return
    const block = await api.addModule(useWorkspaceStore().requireId(), serviceId, {
      name,
      position,
    })
    upsert(block)
    return block
  }

  /**
   * Archive a service (hide it + its subtree, restorable with no expiry) — the non-destructive
   * alternative to deleting a service that still has unfinished tasks. The acting tab isn't
   * echoed its own coarse board event, so re-hydrate explicitly to drop the frame from the board
   * and surface it under the archived list.
   */
  async function archiveService(id: string) {
    await api.archiveBlock(useWorkspaceStore().requireId(), id)
    await useWorkspaceStore().refresh()
  }

  /** Restore an archived service back onto the board. Re-hydrates to pull its subtree back in. */
  async function restoreService(id: string) {
    await api.restoreBlock(useWorkspaceStore().requireId(), id)
    await useWorkspaceStore().refresh()
  }

  return {
    addBlock,
    addServiceFromRepo,
    addTask,
    addModule,
    addEpic,
    assignToEpic,
    archiveService,
    restoreService,
  }
}
