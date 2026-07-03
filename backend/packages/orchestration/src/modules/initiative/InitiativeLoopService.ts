import type {
  Block,
  BlockRepository,
  Clock,
  ExecutionEventPublisher,
  IdGenerator,
  Initiative,
  InitiativeItem,
  InitiativeRepository,
  PipelineRepository,
  ResolveRunRepoContext,
  ServiceRepository,
  TaskEstimate,
} from '@cat-factory/kernel'
import { ConflictError, DomainError } from '@cat-factory/kernel'
import { commitInitiativeTracker } from '@cat-factory/agents'
import type { ExecutionService } from '../execution/ExecutionService.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { InitiativeService } from './InitiativeService.js'
import {
  activeItemCount,
  allItemsSettled,
  applyRevertClaim,
  applySpawnClaim,
  deriveCurrentPhase,
  effectiveMaxConcurrent,
  eligibleItemsToSpawn,
  reconcileItem,
  selectInitiativePipeline,
} from './initiative.logic.js'

export interface InitiativeLoopServiceDependencies {
  initiativeRepository: InitiativeRepository
  initiativeService: InitiativeService
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionService: ExecutionService
  events: ExecutionEventPublisher
  clock: Clock
  idGenerator: IdGenerator
  /** Raises the `initiative` notification (blocked item / completion). Absent ⇒ no cards. */
  notificationService?: NotificationService
  /** Resolves the initiative's repo for the best-effort tracker re-commit. Absent ⇒ mirror skipped. */
  resolveRunRepoContext?: ResolveRunRepoContext
  /** Stamps a spawned task with the frame's service (in-org sharing). Absent ⇒ no service link. */
  serviceRepository?: ServiceRepository
}

/** What one tick did, for the sweeper's aggregate log. */
interface TickResult {
  spawned: number
  completed: boolean
}

/** The outcome of trying to spawn ONE eligible item. */
type SpawnOutcome =
  | { outcome: 'spawned'; entity: Initiative }
  | { outcome: 'skipped'; entity: Initiative }
  | { outcome: 'conflict'; entity: Initiative }

/**
 * The initiative EXECUTION LOOP (slice 3): the driver that turns an approved plan into a
 * running body of work. The cron/interval sweepers call {@link runDue}; a settling child run
 * pokes {@link pokeForInitiativeBlock} so the loop advances immediately instead of waiting for
 * the next sweep. Each per-initiative {@link tick}:
 *
 *   1. RECONCILE — reads the spawned task blocks (one list read, indexed — no N+1) and folds
 *      each block's status back onto its item (done + PR link / pr_open / blocked + deviation).
 *   2. COMPLETE — when every item is settled, flip the initiative + its anchor block `done`,
 *      re-commit the tracker, and notify.
 *   3. SPAWN — creates task blocks for the eligible `pending` items (current phase, deps met,
 *      phase not halted by a blocked sibling) up to the concurrency cap, picking each task's
 *      pipeline from the policy rules. Spawning is CLAIM-FIRST: a CAS write records the
 *      pre-generated block id BEFORE any side effect, so a concurrent ticker that lost the CAS
 *      created nothing (single-writer by construction, exactly like the rest of the entity).
 *
 * Every entity write goes through {@link InitiativeService}'s rev-guarded CAS, so a lost tick is
 * simply abandoned; the next sweep retries. A per-service task-limit `ConflictError` leaves the
 * item `pending` for the next sweep (never `blocked`); a missing pipeline (deleted after ingest)
 * records a deviation + notification and blocks the item — the sweep NEVER throws.
 */
export class InitiativeLoopService {
  /** In-process re-entrancy guard so a cron sweep + a terminal poke don't double-tick one initiative. */
  private readonly ticking = new Set<string>()

  constructor(private readonly deps: InitiativeLoopServiceDependencies) {}

  /**
   * Tick every `executing` initiative across all workspaces. The cron (Worker) / interval
   * (Node) sweepers call this. Never throws — a per-initiative failure is isolated so one bad
   * initiative can't stall the others. Returns aggregate counts for logging.
   */
  async runDue(_now: number): Promise<{ ticked: number; spawned: number; completed: number }> {
    const executing = await this.deps.initiativeRepository.listExecuting()
    let spawned = 0
    let completed = 0
    for (const { workspaceId, initiative } of executing) {
      try {
        const result = await this.tick(workspaceId, initiative)
        spawned += result.spawned
        if (result.completed) completed++
      } catch {
        // Isolate a bad initiative; the next sweep retries it. (Each entity write is already
        // CAS-guarded, so a partial tick left the entity consistent.)
      }
    }
    return { ticked: executing.length, spawned, completed }
  }

  /**
   * Best-effort single tick for one initiative, triggered when a spawned child run settles (a
   * terminal run / a merge). Fire-and-forget from the caller; swallow errors (the sweep is the
   * backstop). `initiativeBlockId` is the block the settled child carries in its `initiativeId`.
   */
  async pokeForInitiativeBlock(workspaceId: string, initiativeBlockId: string): Promise<void> {
    try {
      const initiative = await this.deps.initiativeRepository.getByBlock(
        workspaceId,
        initiativeBlockId,
      )
      if (initiative && initiative.status === 'executing') await this.tick(workspaceId, initiative)
    } catch {
      // Swallow — the periodic sweep will pick the initiative up.
    }
  }

  private async tick(workspaceId: string, seed: Initiative): Promise<TickResult> {
    const key = seed.id
    if (this.ticking.has(key)) return { spawned: 0, completed: false }
    this.ticking.add(key)
    try {
      // Re-read the freshest entity (the seed may be stale — from listExecuting or a poke).
      let initiative = await this.deps.initiativeRepository.getByBlock(workspaceId, seed.blockId)
      if (!initiative || initiative.status !== 'executing') return { spawned: 0, completed: false }

      // 1. Reconcile spawned tasks from their blocks (one list read, indexed — no N+1).
      const blocksById = new Map(
        (await this.deps.blockRepository.listByWorkspace(workspaceId)).map((b) => [b.id, b]),
      )
      initiative = (await this.reconcile(workspaceId, initiative, blocksById)) ?? initiative

      // 2. Complete when every item is settled.
      if (allItemsSettled(initiative)) {
        await this.complete(workspaceId, initiative)
        return { spawned: 0, completed: true }
      }

      // 3. Spawn eligible items up to the effective concurrency cap.
      const spawned = await this.spawn(workspaceId, initiative)

      // 4. Best-effort mirror the tracker (never before a DB CAS wins; hash-short-circuited).
      await this.recommitTracker(workspaceId, initiative.blockId).catch(() => {})

      return { spawned, completed: false }
    } finally {
      this.ticking.delete(key)
    }
  }

  // ---- Reconcile ----------------------------------------------------------

  private async reconcile(
    workspaceId: string,
    initiative: Initiative,
    blocksById: Map<string, Block>,
  ): Promise<Initiative | null> {
    // Nothing to reconcile unless an actively-spawned item exists.
    const hasActive = (initiative.items ?? []).some(
      (i) => i.blockId && (i.status === 'in_progress' || i.status === 'pr_open'),
    )
    if (!hasActive) return null

    let newlyBlocked = false
    const updated = await this.deps.initiativeService.update(
      workspaceId,
      initiative.blockId,
      (current) => {
        const items = (current.items ?? []).map((it) =>
          it.blockId ? reconcileItem(it, blocksById.get(it.blockId)) : it,
        )
        const deviations = [...(current.deviations ?? [])]
        for (let i = 0; i < items.length; i++) {
          const before = current.items![i]!
          const after = items[i]!
          if (after.status === 'blocked' && before.status !== 'blocked') {
            newlyBlocked = true
            deviations.push({
              id: this.deps.idGenerator.next('idev'),
              at: this.deps.clock.now(),
              itemId: after.id,
              description: `Task for "${after.title}" was blocked; the phase is halted until it is retried or skipped.`,
            })
          }
        }
        return { ...current, items, deviations }
      },
    )
    if (newlyBlocked && updated) await this.notify(workspaceId, updated, 'item_blocked')
    return updated
  }

  // ---- Complete -----------------------------------------------------------

  private async complete(workspaceId: string, initiative: Initiative): Promise<void> {
    const done = await this.deps.initiativeService.update(
      workspaceId,
      initiative.blockId,
      (current) =>
        allItemsSettled(current) && current.status === 'executing'
          ? { ...current, status: 'done' }
          : current,
    )
    if (!done || done.status !== 'done') return
    await this.deps.blockRepository.update(workspaceId, done.blockId, {
      status: 'done',
      progress: 1,
    })
    await this.deps.events.boardChanged(workspaceId, 'initiative-complete', done.blockId)
    await this.recommitTracker(workspaceId, done.blockId).catch(() => {})
    await this.notify(workspaceId, done, 'complete')
  }

  // ---- Spawn --------------------------------------------------------------

  private async spawn(workspaceId: string, initiative: Initiative): Promise<number> {
    const phase = deriveCurrentPhase(initiative)
    if (!phase) return 0
    let slots = effectiveMaxConcurrent(initiative, phase) - activeItemCount(initiative)
    if (slots <= 0) return 0
    const eligible = eligibleItemsToSpawn(initiative)
    if (eligible.length === 0) return 0

    // Resolve the host frame ONCE (invariant across items): spawned tasks live under the
    // initiative's parent service frame (structural containment), linked to the initiative via
    // `initiativeId` (epic-style membership). No frame ⇒ nothing to host the work.
    const anchor = await this.deps.blockRepository.get(workspaceId, initiative.blockId)
    const frame = anchor?.parentId
      ? await this.deps.blockRepository.get(workspaceId, anchor.parentId)
      : null
    if (!frame) return 0
    const serviceId = this.deps.serviceRepository
      ? ((await this.deps.serviceRepository.getByFrameBlock(frame.id))?.id ?? null)
      : null

    let spawned = 0
    let entity = initiative
    for (const item of eligible) {
      if (slots <= 0) break
      const result = await this.spawnItem(workspaceId, entity, item, frame, serviceId)
      entity = result.entity
      if (result.outcome === 'spawned') {
        spawned++
        slots--
      } else if (result.outcome === 'conflict') {
        // Lost a CAS, or the per-service task limit was hit — abandon the rest of this tick.
        break
      }
      // 'skipped' (item no longer pending, or blocked on a config problem) — try the next item.
    }
    return spawned
  }

  private async spawnItem(
    workspaceId: string,
    entity: Initiative,
    item: InitiativeItem,
    frame: Block,
    serviceId: string | null,
  ): Promise<SpawnOutcome> {
    const policy = entity.policy
    if (!policy) return { outcome: 'skipped', entity }

    // Pick the pipeline first; a missing one is a config problem (a pipeline deleted after
    // ingest) → block the item + deviation + notify, NEVER throw inside the sweep.
    const pipelineId = selectInitiativePipeline(item, policy)
    if (!(await this.deps.pipelineRepository.get(workspaceId, pipelineId))) {
      const blocked = await this.blockItem(
        workspaceId,
        entity.blockId,
        item.id,
        `Pipeline "${pipelineId}" no longer exists — pick another in the initiative policy.`,
      )
      return { outcome: 'skipped', entity: blocked ?? entity }
    }

    // Claim the item BEFORE any side effect: a CAS write records the pre-generated block id, so
    // a concurrent ticker whose CAS lost created nothing (the winner's claim short-circuits the
    // loser's transform to a no-op).
    const spawnedBlockId = this.deps.idGenerator.next('blk')
    const claimed = await this.deps.initiativeService.update(
      workspaceId,
      entity.blockId,
      (current) => applySpawnClaim(current, item.id, spawnedBlockId),
    )
    if (!claimed) return { outcome: 'skipped', entity }
    const claimedItem = (claimed.items ?? []).find((i) => i.id === item.id)
    if (!claimedItem || claimedItem.blockId !== spawnedBlockId) {
      // Another ticker already claimed it (a different block id), or it moved on — skip.
      return { outcome: 'skipped', entity: claimed }
    }

    // The claim won: insert the task block, then start its run.
    const block = this.buildTaskBlock(spawnedBlockId, item, frame, entity.blockId)
    try {
      await this.deps.blockRepository.insert(workspaceId, block, serviceId)
      await this.deps.events.boardChanged(workspaceId, 'block-added', block.id)
      await this.deps.executionService.start(workspaceId, block.id, pipelineId)
      return { outcome: 'spawned', entity: claimed }
    } catch (error) {
      // Roll back the block, then decide on the item. A per-service task-limit ConflictError is
      // transient → revert the item to `pending` for the next sweep and stop spawning this tick.
      // Any OTHER failure is (likely) a persistent config problem → block + notify so it isn't
      // retried forever.
      await this.deps.blockRepository.deleteMany(workspaceId, [block.id]).catch(() => {})
      const reason = error instanceof DomainError ? error.details?.reason : undefined
      if (error instanceof ConflictError && reason === 'task_limit_reached') {
        const reverted = await this.deps.initiativeService.update(
          workspaceId,
          entity.blockId,
          (current) => applyRevertClaim(current, item.id, spawnedBlockId),
        )
        return { outcome: 'conflict', entity: reverted ?? claimed }
      }
      const message = error instanceof Error ? error.message : 'Failed to start the task.'
      const blocked = await this.blockItem(
        workspaceId,
        entity.blockId,
        item.id,
        `Could not start the task: ${message}`,
        spawnedBlockId,
      )
      return { outcome: 'skipped', entity: blocked ?? claimed }
    }
  }

  /** Build the task block a spawned item runs as (item estimate stamped, `initiativeId` linked). */
  private buildTaskBlock(
    blockId: string,
    item: InitiativeItem,
    frame: Block,
    initiativeBlockId: string,
  ): Block {
    const estimate = estimateForItem(item, this.deps.clock.now())
    return {
      id: blockId,
      title: item.title,
      // Inherit the host frame's (behavioural) repo type, like BoardService.addTask.
      type: frame.type,
      description: item.description,
      position: { x: 24, y: 96 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: frame.id,
      // Epic-style membership so the loop reconciles from the block and the board badges it. The
      // loop OWNS sequencing, so NEVER opt into `autoStartDependents` on a spawned block.
      initiativeId: initiativeBlockId,
      ...(estimate ? { estimate } : {}),
    }
  }

  /**
   * Block an item that could not be spawned (a missing pipeline / a start failure): mark it
   * `blocked`, drop its dangling block link, record a deviation, and raise the notification.
   * The blocked item halts its phase (see `phaseIsHalted`) until a human intervenes.
   */
  private async blockItem(
    workspaceId: string,
    initiativeBlockId: string,
    itemId: string,
    note: string,
    ownedBlockId?: string,
  ): Promise<Initiative | null> {
    const updated = await this.deps.initiativeService.update(
      workspaceId,
      initiativeBlockId,
      (current) => {
        const items = (current.items ?? []).map((i) =>
          i.id === itemId ? { ...i, status: 'blocked' as const, note, blockId: null } : i,
        )
        const deviations = [
          ...(current.deviations ?? []),
          {
            id: this.deps.idGenerator.next('idev'),
            at: this.deps.clock.now(),
            itemId,
            description: note,
          },
        ]
        return { ...current, items, deviations }
      },
    )
    void ownedBlockId
    if (updated) await this.notify(workspaceId, updated, 'item_blocked')
    return updated
  }

  // ---- Tracker mirror + notifications -------------------------------------

  private async recommitTracker(workspaceId: string, initiativeBlockId: string): Promise<void> {
    if (!this.deps.resolveRunRepoContext) return
    const initiative = await this.deps.initiativeRepository.getByBlock(
      workspaceId,
      initiativeBlockId,
    )
    if (!initiative) return
    const runRepo = await this.deps.resolveRunRepoContext(workspaceId, initiativeBlockId)
    if (!runRepo) return
    const doc = await commitInitiativeTracker(
      runRepo.repo,
      runRepo.baseBranch,
      initiative,
      new Date(this.deps.clock.now()),
    )
    // Stamp the committed version/hash back (a content-unchanged tick commits nothing, so the
    // no-change short-circuit means a replay skips this write too). `markExecuting` leaves an
    // already-`executing` status untouched and only writes the `doc` bookkeeping.
    if (doc) await this.deps.initiativeService.markExecuting(workspaceId, initiativeBlockId, doc)
  }

  private async notify(
    workspaceId: string,
    initiative: Initiative,
    reason: 'item_blocked' | 'complete',
  ): Promise<void> {
    if (!this.deps.notificationService) return
    const items = initiative.items ?? []
    const blocked = items.filter((i) => i.status === 'blocked')
    const input =
      reason === 'complete'
        ? {
            title: `Initiative "${initiative.title}" complete`,
            body: `Every planned task is resolved (${items.length} item${items.length === 1 ? '' : 's'}).`,
          }
        : {
            title: `Initiative "${initiative.title}" needs attention`,
            body:
              blocked.length === 1
                ? `A task was blocked (${blocked[0]!.title}). Retry or skip it to unblock the phase.`
                : `${blocked.length} tasks are blocked. Retry or skip them to unblock the phase.`,
          }
    await this.deps.notificationService
      .raise(workspaceId, {
        type: 'initiative',
        blockId: initiative.blockId,
        executionId: null,
        title: input.title,
        body: input.body,
        payload: { initiativeReason: reason },
      })
      .catch(() => {})
  }
}

/** Build a {@link TaskEstimate} from an item's planner estimate, stamped for the spawned block. */
export function estimateForItem(item: InitiativeItem, now: number): TaskEstimate | undefined {
  if (!item.estimate) return undefined
  return {
    complexity: item.estimate.complexity,
    risk: item.estimate.risk,
    impact: item.estimate.impact,
    rationale: item.estimate.rationale ?? '',
    model: 'initiative-planner',
    createdAt: now,
  }
}
