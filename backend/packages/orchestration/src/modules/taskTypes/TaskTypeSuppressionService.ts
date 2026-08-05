import type {
  Clock,
  CustomTaskType,
  Logger,
  TaskTypeRegistry,
  TaskTypeSuppressionRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { NotFoundError, requireWorkspace, runBestEffort } from '@cat-factory/kernel'

export interface TaskTypeSuppressionServiceDependencies {
  taskTypeSuppressionRepository: TaskTypeSuppressionRepository
  workspaceRepository: WorkspaceRepository
  /** The app-owned registry the deployment registers its operations on. */
  taskTypeRegistry?: TaskTypeRegistry
  clock: Clock
  logger?: Logger
}

/** What the settings screen renders: every registered operation, and whether this board hides it. */
export interface TaskTypeSuppressionView {
  /** The registered descriptor, exactly as the snapshot projects it. */
  taskType: CustomTaskType
  suppressed: boolean
}

/**
 * Which deployment-registered custom task types (REUSABLE OPERATIONS) a workspace offers, and the
 * admin surface for hiding one (`backend/docs/reusable-operations.md`).
 *
 * The store is a set of tombstones and the REGISTRY is the catalog, so this service is the join:
 * the settings screen needs both halves at once (a suppressed id is by construction absent from the
 * projected catalog, so nothing else could offer the way back), while the snapshot and the creation
 * check need only the id set.
 *
 * BUILT-IN task types are not suppressible, and the refusal is here rather than left to the
 * repository's happy indifference: they carry hardcoded creation affordances (the document-frame
 * restriction, the per-type form sections), so hiding one would take a capability away with no
 * descriptor stating what was lost.
 */
export class TaskTypeSuppressionService {
  private readonly suppressions: TaskTypeSuppressionRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly registry: TaskTypeRegistry | undefined
  private readonly clock: Clock

  constructor(deps: TaskTypeSuppressionServiceDependencies) {
    this.suppressions = deps.taskTypeSuppressionRepository
    this.workspaceRepository = deps.workspaceRepository
    this.registry = deps.taskTypeRegistry
    this.clock = deps.clock
  }

  /**
   * The ids this workspace suppresses. One query; the snapshot filter and the creation check both
   * read it, so neither point-reads per registered type.
   */
  async suppressedIds(workspaceId: string): Promise<string[]> {
    return this.suppressions.list(workspaceId)
  }

  /**
   * Every registered operation with its current state, in REGISTRATION order: the settings
   * screen's whole read.
   *
   * A suppressed id the registry no longer knows is NOT listed and NOT silently dropped from the
   * store: an operation whose registration was withdrawn has nothing to render (no label, no
   * description, no fields), and deleting its tombstone as a tidy-up would un-hide it for a
   * deployment that later restores the registration. It is simply a row nothing matches.
   */
  async list(workspaceId: string): Promise<TaskTypeSuppressionView[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const suppressed = new Set(await this.suppressions.list(workspaceId))
    return (this.registry?.all() ?? []).map((taskType) => ({
      taskType,
      suppressed: suppressed.has(taskType.taskType),
    }))
  }

  /** Hide one registered operation from this workspace. Idempotent. */
  async suppress(workspaceId: string, taskType: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    this.assertRegistered(taskType)
    await this.suppressions.suppress(workspaceId, taskType, this.clock.now())
  }

  /**
   * Offer one operation on this workspace again, by deleting its tombstone. Idempotent.
   *
   * Unlike {@link suppress} this does NOT require the type to be registered: a deployment can
   * withdraw a registration while a board still holds the tombstone, and refusing the restore would
   * leave a row only a database edit could clear.
   */
  async restore(workspaceId: string, taskType: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.suppressions.restore(workspaceId, taskType)
  }

  /**
   * Refuse an id the deployment does not register, so a typo cannot leave a tombstone that hides
   * nothing and appears nowhere (the settings screen renders the registry, not the store).
   */
  private assertRegistered(taskType: string): void {
    if (this.registry?.get(taskType)) return
    throw new NotFoundError('Custom task type', taskType, { reason: 'task_type_unregistered' })
  }
}

/**
 * The suppressed-id set for a workspace, or an EMPTY set when the store is unwired or unreadable:
 * the read the BOARD SNAPSHOT does on every load.
 *
 * Degrading to "nothing suppressed" is the deliberate direction, and it is the opposite of the
 * "absent ≠ empty" rule only in appearance. The two failures are not symmetric: a picker offering
 * one operation too many is a visible surplus a user can ignore, while failing the board load (or
 * blanking the catalog) over an unreadable preference takes the whole board down for a cosmetic
 * setting. The creation door does NOT share this posture: it re-reads and lets the failure
 * propagate, because there the answer decides whether a row is written.
 */
export async function suppressedTaskTypeIds(
  service: TaskTypeSuppressionService | undefined,
  workspaceId: string,
  logger: Logger,
): Promise<Set<string>> {
  if (!service) return new Set()
  const ids = await runBestEffort(
    logger,
    'snapshot.taskTypeSuppressions',
    () => service.suppressedIds(workspaceId),
    { workspaceId },
  )
  return new Set(ids ?? [])
}
