import type { BlueprintService, BoardScanSpawnResult } from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { BoardService } from '../board/BoardService.js'
import { countModules, describeNode } from './board-scan.logic.js'

// ---------------------------------------------------------------------------
// BoardScanService: reconciles a service blueprint onto the board. It is the
// `BlueprintReconciler` the execution engine drives when a `blueprints` pipeline
// step returns a decomposition tree (see ExecutionService.ingestBlueprint) — there
// is no longer a standalone "scan repository" command or a persisted blueprint
// store; the in-repo `blueprints/` files are the source of truth and the board is
// the projection.
//
// Reconciling maps the tree (one service → its modules, anchored to codebase paths)
// onto an existing service frame in place, never deleting human-authored work, and
// spawns a fresh frame only when the target frame can't be found.
// ---------------------------------------------------------------------------

export interface BoardScanServiceDependencies {
  boardService: BoardService
  /** Read board blocks directly, to reconcile a blueprint onto an existing frame. */
  blockRepository: BlockRepository
}

/** Case-insensitive, whitespace-tolerant name match used to pair board ↔ blueprint nodes. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export class BoardScanService {
  constructor(private readonly deps: BoardScanServiceDependencies) {}

  /**
   * Materialise a blueprint onto the board: one service frame and a module per
   * blueprint module — each carrying the node's summary and codebase references in
   * its description, so the board mirrors the map. Tasks are authored by people, so
   * the spawn never creates them. Used as the fallback when a reconcile target frame
   * can't be resolved.
   */
  private async spawnBlueprint(
    workspaceId: string,
    service: BlueprintService,
  ): Promise<BoardScanSpawnResult> {
    const frame = await this.deps.boardService.addFrame(workspaceId, {
      type: service.type,
      position: { x: 80, y: 80 },
    })
    await this.deps.boardService.updateBlock(workspaceId, frame.id, {
      title: service.name,
      description: describeNode(service.summary, service.references),
    })

    let modules = 0
    for (const planModule of service.modules ?? []) {
      const module = await this.deps.boardService.addModule(workspaceId, frame.id, {
        name: planModule.name,
      })
      modules += 1
      const moduleDescription = describeNode(planModule.summary, planModule.references)
      if (moduleDescription) {
        await this.deps.boardService.updateBlock(workspaceId, module.id, {
          description: moduleDescription,
        })
      }
    }
    return { frameId: frame.id, modules }
  }

  /**
   * Reconcile a blueprint onto an **existing** service frame, in place and without
   * deleting anything: the frame's modules are matched to the blueprint by name
   * (case-insensitive), missing modules are added, and matched modules have their
   * summary/code-reference description refreshed. Human-added blocks and the tasks
   * inside modules are left untouched — so re-running the Blueprinter after each
   * implementation keeps the map current without clobbering authored work.
   *
   * When `frameId` does not resolve to a frame (e.g. the repo isn't on the board
   * yet) it falls back to {@link spawnBlueprint}, creating a fresh structure.
   */
  async reconcileBlueprint(
    workspaceId: string,
    frameId: string | null,
    service: BlueprintService,
  ): Promise<BoardScanSpawnResult> {
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    const frame = frameId ? blocks.find((b) => b.id === frameId && b.level === 'frame') : undefined
    if (!frame) return this.spawnBlueprint(workspaceId, service)

    // Refresh the frame's description (its summary/entrypoints) but keep the title,
    // which a human may have renamed.
    const frameDescription = describeNode(service.summary, service.references)
    if (frameDescription && frameDescription !== frame.description) {
      await this.deps.boardService.updateBlock(workspaceId, frame.id, {
        description: frameDescription,
      })
    }

    const moduleBlocks = blocks.filter((b) => b.parentId === frame.id && b.level === 'module')
    let modules = 0
    for (const planModule of service.modules ?? []) {
      let moduleBlock = moduleBlocks.find((b) => sameName(b.title, planModule.name))
      if (!moduleBlock) {
        moduleBlock = await this.deps.boardService.addModule(workspaceId, frame.id, {
          name: planModule.name,
        })
        moduleBlocks.push(moduleBlock)
      }
      modules += 1
      const moduleDescription = describeNode(planModule.summary, planModule.references)
      if (moduleDescription && moduleDescription !== moduleBlock.description) {
        await this.deps.boardService.updateBlock(workspaceId, moduleBlock.id, {
          description: moduleDescription,
        })
      }
    }
    return { frameId: frame.id, modules }
  }

  /** Convenience for callers/tests: the module count a blueprint implies. */
  static moduleCount(service: BlueprintService): number {
    return countModules(service)
  }
}
