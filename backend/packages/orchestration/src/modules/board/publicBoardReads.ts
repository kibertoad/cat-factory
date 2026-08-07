import type { AddTaskInput, BlockEditAuthority } from '@cat-factory/contracts'
import type { Block, BlockRepository, BlockStatus } from '@cat-factory/kernel'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import { serviceOf } from './board.logic.js'

// The external `/api/v1` board surface (see PublicApiController), extracted from BoardService as a
// cohesive collaborator: one small deps object of bound call-backs, with the service keeping thin
// delegate methods. It is its own unit because the whole group shares one non-obvious contract the
// rest of the board does NOT have — a key's OWN workspace only.
//
// Every read here is STRICTLY scoped to `workspaceId` and goes through the workspace-scoped
// repository reads, which never surface a service merely MOUNTED from another workspace (those are
// homed elsewhere), so an external key can only ever touch its own board. They key on the FRAME
// BLOCK id (`serviceId` in the wire contract) and always exclude the headless `internal` anchors,
// exactly as the board snapshot does.

export interface PublicBoardReadsDeps {
  blockRepository: BlockRepository
  /** Throws when the workspace does not exist; bound from the owning service. */
  requireWorkspace(workspaceId: string): Promise<unknown>
  /** The normal task-creation path, reused verbatim so placement + task-type validation applies. */
  addTask(
    workspaceId: string,
    containerId: string,
    input: AddTaskInput,
    editor: BlockEditAuthority,
    createdBy: string | null,
  ): Promise<Block>
}

export class PublicBoardReads {
  constructor(private readonly deps: PublicBoardReadsDeps) {}

  /** The workspace's board services (visible service frames). */
  async listServices(workspaceId: string): Promise<Block[]> {
    await this.deps.requireWorkspace(workspaceId)
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    return blocks.filter((b) => b.level === 'frame' && !b.internal && !b.archived)
  }

  /**
   * Refuse a container that cannot hold a new task: missing / not the workspace's / a headless
   * `internal` anchor / not a frame / archived.
   *
   * Separate from {@link addServiceTask} so a caller doing PREPARATORY work for the create can
   * apply the same rule first, without duplicating it or having to create the task to find out.
   * `POST /api/v1/services/:serviceId/tasks` with a `ticket` is the case: it resolves the tracker
   * issue before the block exists, and resolving one is an outbound call to the workspace's
   * tracker, so a bad `serviceId` would otherwise cost a live third-party fetch and be answered
   * by the 404 it could have had first.
   */
  async assertTaskContainer(workspaceId: string, serviceId: string): Promise<Block> {
    await this.deps.requireWorkspace(workspaceId)
    const frame = await this.deps.blockRepository.get(workspaceId, serviceId)
    if (!frame || frame.internal) throw new NotFoundError('service', serviceId)
    if (frame.level !== 'frame') {
      throw new ValidationError('Tasks can only be created under a service')
    }
    if (frame.archived) throw new ValidationError('Cannot add a task to an archived service')
    return frame
  }

  /**
   * Create a task under a visible SERVICE FRAME the workspace owns. Rejects a missing / non-frame
   * / internal / archived container, then delegates to the normal `addTask` (which reuses all the
   * placement + task-type validation). Headless / no initiator.
   *
   * `editor` is supplied by the caller rather than fixed here even though every caller today is
   * the headless `/api/v1` surface: `input` is a full {@link AddTaskInput}, so it can carry a
   * merge preset the moment the public contract exposes one, and an exemption written INSIDE a
   * collaborator is one no route states and no coverage spec can see.
   */
  async addServiceTask(
    workspaceId: string,
    serviceId: string,
    input: AddTaskInput,
    editor: BlockEditAuthority,
  ): Promise<Block> {
    await this.assertTaskContainer(workspaceId, serviceId)
    return this.deps.addTask(workspaceId, serviceId, input, editor, null)
  }

  /**
   * Fetch a board task + its enclosing service frame, scoped to the workspace. Returns null when
   * no such task exists in the workspace, it is not a `task`-level block, it is a headless
   * `internal` anchor, or it has no resolvable enclosing service frame — so the caller (and any
   * external key) sees only real, board-visible tasks it owns. The frame is returned in full (not
   * just its id) so a caller can gate on service state (e.g. refuse to START a task under an
   * archived service, while still allowing its status to be READ).
   */
  async getServiceTask(
    workspaceId: string,
    taskId: string,
  ): Promise<{ block: Block; service: Block } | null> {
    await this.deps.requireWorkspace(workspaceId)
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    const block = blocks.find((b) => b.id === taskId)
    if (!block || block.level !== 'task' || block.internal) return null
    const frame = serviceOf(blocks, block)
    if (!frame) return null
    return { block, service: frame }
  }

  /**
   * List ONE BOUNDED PAGE of a visible service's tasks — the whole subtree (tasks directly under
   * the frame AND under its modules), excluding headless `internal` anchors, optionally filtered
   * to one status. Returns null when the frame does not exist in the workspace or is not a visible
   * service frame (a non-frame / internal / archived block), so the caller 404s.
   *
   * Reads are SQL-bounded rather than "load the whole board and filter in JS": one point-read for
   * the frame, then ONE paged subtree query. That is exhaustive because a `task` may only be
   * parented by a `frame` or a `module` (enforced by `canReparent` on reparent and by
   * `BoardService.addTask` on create) — there is no deeper level to recurse through, so the
   * general `descendantIds` walk (which needs every block in memory) is unnecessary here.
   *
   * `afterId` is the exclusive keyset cursor and ordering is by block id: blocks carry no creation
   * timestamp, so id order is arbitrary but STABLE, which is what a cursor needs. One extra row
   * beyond `limit` is read so "is there another page" costs no second query.
   */
  async listServiceTasksPage(
    workspaceId: string,
    serviceId: string,
    opts: { limit: number; afterId?: string; status?: BlockStatus },
  ): Promise<{ tasks: Block[]; hasMore: boolean } | null> {
    await this.deps.requireWorkspace(workspaceId)
    const frame = await this.deps.blockRepository.get(workspaceId, serviceId)
    if (!frame || frame.level !== 'frame' || frame.internal || frame.archived) return null
    const rows = await this.deps.blockRepository.listServiceTasks(workspaceId, serviceId, {
      ...opts,
      limit: opts.limit + 1,
    })
    const hasMore = rows.length > opts.limit
    return { tasks: hasMore ? rows.slice(0, opts.limit) : rows, hasMore }
  }
}
