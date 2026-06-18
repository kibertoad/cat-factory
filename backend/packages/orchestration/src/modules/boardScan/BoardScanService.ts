import type {
  BlueprintService,
  BoardScanSpawnResult,
  RepoBlueprint,
  ScanRepoInput,
  ScanRepoResult,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { BlockRepository, WorkspaceRepository } from '@cat-factory/kernel'
import type { RepoBlueprintRecord, RepoBlueprintRepository } from '@cat-factory/kernel'
import type { RepoProjectionRepository } from '@cat-factory/kernel'
import type { RepoScanner } from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { BoardService } from '../board/BoardService'
import { countFeatures, describeNode } from './board-scan.logic'

// ---------------------------------------------------------------------------
// BoardScanService: owns the "scan repository" command and the persisted
// blueprints it produces. Reading the blueprints always works; running a scan
// additionally needs the RepoScanner port (the GitHub + sandbox-container
// machinery) to be wired — when it is absent, `canScan` is false and the
// controller surfaces "unavailable" rather than attempting a run.
//
// A scan decomposes one repository into the canonical service → modules →
// features tree (anchored to codebase paths), persists it as the single current
// blueprint for that repo, and optionally materialises it onto the board so the
// structure is visible and future work can be scoped against it.
// ---------------------------------------------------------------------------

export interface BoardScanServiceDependencies {
  repoBlueprintRepository: RepoBlueprintRepository
  workspaceRepository: WorkspaceRepository
  boardService: BoardService
  /** Read board blocks directly, to reconcile a blueprint onto an existing frame. */
  blockRepository: BlockRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Performs the side-effecting repo read + decomposition; optional. */
  repoScanner?: RepoScanner
  /**
   * Links a freshly-spawned service frame to its backing repo projection, so the
   * scanned service is repo-addressable out of the box (execution resolves the
   * repo by walking up to the linked frame). Optional — when absent the frame is
   * still created, just unlinked.
   */
  repoProjectionRepository?: RepoProjectionRepository
}

/** Case-insensitive, whitespace-tolerant name match used to pair board ↔ blueprint nodes. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function toRepoBlueprint(record: RepoBlueprintRecord): RepoBlueprint {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    source: record.source,
    service: record.service,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export class BoardScanService {
  constructor(private readonly deps: BoardScanServiceDependencies) {}

  /** True when a scan can actually be performed (the scanner is wired). */
  get canScan(): boolean {
    return this.deps.repoScanner !== undefined
  }

  // ---- blueprint reads ----------------------------------------------------

  async listBlueprints(workspaceId: string): Promise<RepoBlueprint[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const records = await this.deps.repoBlueprintRepository.listByWorkspace(workspaceId)
    return records.map(toRepoBlueprint)
  }

  async getBlueprint(workspaceId: string, id: string): Promise<RepoBlueprint> {
    return toRepoBlueprint(
      assertFound(await this.deps.repoBlueprintRepository.get(workspaceId, id), 'Blueprint', id),
    )
  }

  async deleteBlueprint(workspaceId: string, id: string): Promise<void> {
    assertFound(await this.deps.repoBlueprintRepository.get(workspaceId, id), 'Blueprint', id)
    await this.deps.repoBlueprintRepository.delete(workspaceId, id)
  }

  // ---- scanning -----------------------------------------------------------

  /**
   * Scan a repository into a blueprint and persist it as the single current
   * decomposition for that `owner/name` (a re-scan replaces it in place, keeping
   * its id and original `createdAt`). When `input.spawn` is set the blueprint is
   * also materialised onto the board. Requires {@link canScan}.
   */
  async scan(workspaceId: string, input: ScanRepoInput): Promise<ScanRepoResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const scanner = this.deps.repoScanner
    if (!scanner) {
      throw new Error('Repository scanning is not configured')
    }

    const scanned = await scanner.scan({
      workspaceId,
      repo: { owner: input.repoOwner, name: input.repoName },
      instructions: input.instructions,
    })

    const now = this.deps.clock.now()
    const existing = await this.deps.repoBlueprintRepository.getByRepo(
      workspaceId,
      input.repoOwner,
      input.repoName,
    )
    const record: RepoBlueprintRecord = {
      id: existing?.id ?? this.deps.idGenerator.next('blueprint'),
      workspaceId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      source: scanned.source,
      service: scanned.service,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.deps.repoBlueprintRepository.upsert(record)

    const blueprint = toRepoBlueprint(record)
    if (!input.spawn) return { blueprint }
    const spawn = await this.spawnBlueprint(workspaceId, blueprint.service, {
      owner: input.repoOwner,
      name: input.repoName,
    })
    return { blueprint, spawn }
  }

  /**
   * Materialise a blueprint onto the board: one service frame, a module per
   * blueprint module, and a task per feature — each carrying the node's summary
   * and codebase references in its description, so the board mirrors the map.
   *
   * When `repo` is given the new frame is linked to that repo's projection, so
   * tasks under it resolve to the right repository instead of being unaddressable.
   */
  private async spawnBlueprint(
    workspaceId: string,
    service: BlueprintService,
    repo?: { owner: string; name: string },
  ): Promise<BoardScanSpawnResult> {
    const frame = await this.deps.boardService.addFrame(workspaceId, {
      type: service.type,
      position: { x: 80, y: 80 },
    })
    await this.deps.boardService.updateBlock(workspaceId, frame.id, {
      title: service.name,
      description: describeNode(service.summary, service.references),
    })
    if (repo) await this.linkRepoToFrame(workspaceId, repo, frame.id)

    let modules = 0
    let features = 0
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
      for (const feature of planModule.features ?? []) {
        const task = await this.deps.boardService.addTask(workspaceId, module.id, {
          title: feature.title,
        })
        features += 1
        const taskDescription = describeNode(feature.summary, feature.references)
        if (taskDescription) {
          await this.deps.boardService.updateBlock(workspaceId, task.id, {
            description: taskDescription,
          })
        }
      }
    }
    return { frameId: frame.id, modules, features }
  }

  /**
   * Reconcile a blueprint onto an **existing** service frame, in place and without
   * deleting anything: the frame's modules/tasks are matched to the blueprint by
   * name (case-insensitive), missing nodes are added, and matched nodes have their
   * summary/code-reference description refreshed. Human-added blocks and tasks a
   * pipeline is running against are left untouched — so re-running the Blueprinter
   * after each implementation keeps the board current without clobbering edits.
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
    let features = 0
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

      const taskBlocks = blocks.filter((b) => b.parentId === moduleBlock!.id && b.level === 'task')
      for (const feature of planModule.features ?? []) {
        let task = taskBlocks.find((b) => sameName(b.title, feature.title))
        if (!task) {
          task = await this.deps.boardService.addTask(workspaceId, moduleBlock.id, {
            title: feature.title,
          })
          taskBlocks.push(task)
        }
        features += 1
        const taskDescription = describeNode(feature.summary, feature.references)
        if (taskDescription && taskDescription !== task.description) {
          await this.deps.boardService.updateBlock(workspaceId, task.id, {
            description: taskDescription,
          })
        }
      }
    }
    return { frameId: frame.id, modules, features }
  }

  /**
   * Link a spawned frame to its backing repo projection (by `owner/name`), so
   * execution resolves the repo by walking up to this frame. Best-effort: a no-op
   * when the projection port is unwired or the repo isn't projected yet.
   */
  private async linkRepoToFrame(
    workspaceId: string,
    repo: { owner: string; name: string },
    frameId: string,
  ): Promise<void> {
    const projection = this.deps.repoProjectionRepository
    if (!projection) return
    const repos = await projection.list(workspaceId)
    const match = repos.find((r) => sameName(r.owner, repo.owner) && sameName(r.name, repo.name))
    if (match) await projection.linkBlock(workspaceId, match.githubId, frameId)
  }

  /** Convenience for callers/tests: the unit-of-work count a blueprint implies. */
  static featureCount(service: BlueprintService): number {
    return countFeatures(service)
  }
}
