import type {
  BlockRepository,
  ExecutionEventPublisher,
  PipelineRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { dependenciesMet, serviceOf } from '../board/board.logic.js'
import type { BoardService } from '../board/BoardService.js'
import type { RunAdmission } from './RunAdmission.js'

/**
 * The slice of `ExecutionService` this controller reads. Taking the service's own already-built
 * collaborators — rather than re-listing five of them in the constructor literal — keeps the
 * wiring to the two things the service must BIND, and means adding a repository here does not
 * touch the service at all.
 */
export interface PostMergeBoardHost {
  readonly blockRepository: BlockRepository
  readonly pipelineRepository: PipelineRepository
  readonly admission: RunAdmission
  readonly board: BoardService
  readonly events: ExecutionEventPublisher
}

/** The two calls that must be bound to the service, because they need state only it holds. */
export interface PostMergeBoardControllerDeps {
  /**
   * Bound `ExecutionService.resolveIndividualVendors` — an auto-start must not lease a credential
   * only its owner can unlock, and resolving that needs the workspace model defaults the service
   * holds.
   */
  resolveIndividualVendors: (
    workspaceId: string,
    blockModelId: string | undefined,
    modelPresetId: string | undefined,
    agentKinds: string[],
  ) => Promise<SubscriptionVendor[]>
  /** Bound `ExecutionService.start` — dependents start through the real entry point, not a copy. */
  start: (
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    opts: { initiatedBy: string | null },
  ) => Promise<unknown>
}

/**
 * The board-shaped follow-up a MERGED task triggers: materialise the module it was assigned to,
 * and start the dependents it was blocking. Extracted from `ExecutionService` as a cohesive
 * collaborator (the file-size ratchet: split, never grow) — both methods run after the merge has
 * already happened, read the board rather than execution state, and are best-effort by
 * construction, which is exactly what separates them from the run state machine they sat beside.
 *
 * The service keeps thin delegates, so the call sites and their `runBestEffort` wrapping are
 * unchanged.
 */
export class PostMergeBoardController {
  constructor(
    private readonly host: PostMergeBoardHost,
    private readonly deps: PostMergeBoardControllerDeps,
  ) {}

  /**
   * After a task with `autoStartDependents` merges, start every task that `dependsOn` it
   * and whose remaining dependencies are all now `done`. System-initiated (no human
   * present), so a dependent on an individual-usage model — which needs its owner to
   * unlock a personal credential per run — is SKIPPED rather than started (it would fault
   * at dispatch); the human starts it manually. Each dependent is started independently so
   * one failure (already running, no provider, …) never blocks the rest.
   */
  async autoStartDependents(workspaceId: string, mergedBlockId: string): Promise<void> {
    const blocks = await this.host.blockRepository.listByWorkspace(workspaceId)
    const dependents = blocks.filter(
      (b) => b.level === 'task' && b.dependsOn.includes(mergedBlockId),
    )
    // Nothing depends on the merged block (the common case) — skip the cross-workspace
    // augment and the pipeline list entirely rather than paying reads with no dependent to act on.
    if (dependents.length === 0) return
    // A dependent's OTHER blockers may live in another workspace (a shared service); resolve
    // them so `dependenciesMet` doesn't treat a cross-workspace blocker as missing-⇒-satisfied.
    await this.host.admission.augmentWithCrossWorkspaceDeps(
      blocks,
      dependents.flatMap((d) => d.dependsOn),
    )
    // Resolve every dependent's pipeline from ONE workspace list, not a per-dependent
    // point-read in the loop (banned N+1): index the catalog by id, and take the board's
    // "Run" default (the first pipeline) for any dependent with no pinned pipeline.
    const pipelines = await this.host.pipelineRepository.listByWorkspace(workspaceId)
    const pipelinesById = new Map(pipelines.map((p) => [p.id, p]))
    const firstPipeline = pipelines[0] ?? null
    for (const dependent of dependents) {
      // All of the dependent's blockers must now be satisfied (not just the one that merged).
      if (!dependenciesMet(blocks, dependent.id)) continue
      // Only auto-start a fresh task — never replace a run already in flight or a finished one.
      if (dependent.status !== 'planned' && dependent.status !== 'ready') continue
      const pipeline = dependent.pipelineId
        ? (pipelinesById.get(dependent.pipelineId) ?? null)
        : firstPipeline
      if (!pipeline) continue
      // Skip dependents that would lease an individual-usage credential (can't unlock
      // unattended) — resolved from the block + pipeline already in hand, no re-reads.
      const individual = await this.deps.resolveIndividualVendors(
        workspaceId,
        dependent.modelId,
        dependent.modelPresetId,
        pipeline.agentKinds,
      )
      if (individual.length > 0) continue
      try {
        await this.deps.start(workspaceId, dependent.id, pipeline.id, { initiatedBy: null })
      } catch {
        // Already running, no usable provider, still-unmet dep racing, etc. — leave this
        // dependent for a manual start; the others still get their chance.
      }
    }
  }

  /**
   * Implementing a task assigned to a module materialises that module: create it
   * in the service if missing, then move the task inside it.
   */
  async applyModuleAssignment(workspaceId: string, taskId: string): Promise<void> {
    const task = await this.host.blockRepository.get(workspaceId, taskId)
    if (!task || !task.moduleName) return
    const blocks = await this.host.blockRepository.listByWorkspace(workspaceId)
    const service = serviceOf(blocks, task)
    if (!service) return

    let module = blocks.find(
      (b) => b.parentId === service.id && b.level === 'module' && b.title === task.moduleName,
    )
    if (!module) {
      module = await this.host.board.addModule(workspaceId, service.id, { name: task.moduleName })
    }
    if (module.id !== task.parentId) {
      const n = blocks.filter((b) => b.parentId === module?.id && b.level === 'task').length
      await this.host.board.reparent(workspaceId, taskId, {
        parentId: module.id,
        position: { x: 16 + (n % 2) * 190, y: 40 + Math.floor(n / 2) * 130 },
      })
    }
    // A module node appeared and/or a task changed parent — the per-block event
    // can't express that hierarchy change, so signal a coarse board refresh. Name the moved
    // task so the refresh fans out to every board mounting its shared service.
    await this.host.events.boardChanged(workspaceId, 'module', taskId)
  }
}
