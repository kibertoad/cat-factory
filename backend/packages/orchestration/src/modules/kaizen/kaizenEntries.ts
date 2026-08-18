import type {
  KaizenGrading,
  KaizenGradingStatus,
  PublicKaizenEntry,
  PublicKaizenEntryTask,
} from '@cat-factory/contracts'
import {
  isSettledKaizenStatus,
  KAIZEN_ENTRY_NOT_FOUND_REASON,
  KAIZEN_ENTRY_NOT_SETTLED_REASON,
} from '@cat-factory/contracts'
import type {
  Block,
  Clock,
  KaizenGradingRepository,
  KaizenVerifiedCombo,
  KaizenVerifiedComboRepository,
  Service,
} from '@cat-factory/kernel'
import { ConflictError, NotFoundError } from '@cat-factory/kernel'

// The public KAIZEN-ENTRY reads and the acknowledgement write, extracted from `KaizenService` as
// a cohesive collaborator: it shares none of the service's grading machinery (no model, no
// telemetry, no prompt) and all of its own concern is the JOIN that turns a stored grading into
// something a person can act on without opening the app.
//
// Two things shape it:
//
//  1. **The context is resolved in BATCHES, never per entry.** A page is up to 100 gradings, and
//     the board coordinates each one needs (its task, that task's service, the service's title)
//     are three chunked reads for the whole page rather than three per row, with the combo library
//     a fourth (its size is bounded by the kinds and models a workspace has actually run). The
//     alternative that looks simpler, loading the workspace's whole block list and walking each
//     entry's ancestry in memory, is what `getServiceTask` does for ONE task and is an unbounded
//     read here.
//  2. **A resolved fact that is gone is NULL, never a substitute.** A task deleted since the run
//     answers `task: null`, and a combo nothing has recorded answers `combo: null`, rather than an
//     empty title or a zeroed streak that would read as a task with no name and a combo that has
//     never scored well.

/** What the entry surface needs from its stores, bound by the service that owns them. */
export interface KaizenEntryDeps {
  gradings: Pick<KaizenGradingRepository, 'get' | 'listPage' | 'setAcknowledgement'>
  combos: Pick<KaizenVerifiedComboRepository, 'listByWorkspace'>
  /** Resolve blocks by id across workspaces, with the account service each belongs to. */
  findBlocks: (
    blockIds: string[],
  ) => Promise<Array<{ workspaceId: string; serviceId: string | null; block: Block }>>
  /** Resolve account services by id (for the frame block each one owns). */
  listServices: (serviceIds: string[]) => Promise<Service[]>
  clock: Clock
}

/** The filters `GET /api/v1/kaizen/entries` pushes into SQL, plus its page bound. */
export interface KaizenEntryQuery {
  limit: number
  cursor?: { createdAt: number; id: string }
  acknowledged?: boolean
  status?: KaizenGradingStatus
  agentKind?: string
  since?: number
}

/** What an acknowledgement records: the new state, the note, and who is asking. */
export interface KaizenAcknowledgement {
  /** `true` records the acknowledgement, `false` clears it and returns the entry to the backlog. */
  acknowledged: boolean
  note: string | null
  /** The user id or API key id to attribute it to; null when the caller has no identity to name. */
  actor: string | null
}

export class KaizenEntryReader {
  constructor(private readonly deps: KaizenEntryDeps) {}

  /** One page of entries, newest first, each joined to its board and combo context. */
  async listEntries(workspaceId: string, query: KaizenEntryQuery): Promise<PublicKaizenEntry[]> {
    const gradings = await this.deps.gradings.listPage(workspaceId, query)
    return this.project(workspaceId, gradings)
  }

  /** One entry by id, or null when this workspace holds no such grading. */
  async getEntry(workspaceId: string, entryId: string): Promise<PublicKaizenEntry | null> {
    const grading = await this.deps.gradings.get(workspaceId, entryId)
    if (!grading) return null
    const [entry] = await this.project(workspaceId, [grading])
    return entry ?? null
  }

  /**
   * Record or clear an entry's acknowledgement and answer with the entry as it now stands.
   *
   * The refusals are two different facts and stay two: an id this workspace does not hold is a
   * 404, while an entry the grader has not settled is a 409 the caller can retry once it has. The
   * settled check is also carried by the repository's own conditional write, so a grading that
   * settles between the read and the write cannot be missed and one that starts re-running cannot
   * be acknowledged behind the check.
   */
  async acknowledge(
    workspaceId: string,
    entryId: string,
    input: KaizenAcknowledgement,
  ): Promise<PublicKaizenEntry> {
    const grading = await this.deps.gradings.get(workspaceId, entryId)
    if (!grading) throw entryNotFound(entryId)
    if (input.acknowledged && !isSettledKaizenStatus(grading.status)) {
      throw new ConflictError(
        `Kaizen entry '${entryId}' has not been graded yet (status '${grading.status}'), so there is nothing to acknowledge`,
        KAIZEN_ENTRY_NOT_SETTLED_REASON,
        { entryId, status: grading.status },
      )
    }
    const updated = await this.deps.gradings.setAcknowledgement(
      workspaceId,
      entryId,
      input.acknowledged ? { at: this.deps.clock.now(), by: input.actor, note: input.note } : null,
    )
    // Null here means the row went away between the read above and the write: the same fact the
    // read refuses, answered the same way rather than as a write that silently did nothing.
    if (!updated) throw entryNotFound(entryId)
    const [entry] = await this.project(workspaceId, [updated])
    if (!entry) throw entryNotFound(entryId)
    return entry
  }

  /** Join a set of gradings to their board + combo context in a bounded number of reads. */
  private async project(
    workspaceId: string,
    gradings: KaizenGrading[],
  ): Promise<PublicKaizenEntry[]> {
    if (gradings.length === 0) return []
    const [tasks, combos] = await Promise.all([
      this.resolveTasks(gradings.map((g) => g.blockId)),
      this.deps.combos.listByWorkspace(workspaceId),
    ])
    const comboByKey = new Map(combos.map((combo) => [combo.comboKey, combo]))
    return gradings.map((grading) => toPublicEntry(grading, tasks, comboByKey))
  }

  /**
   * The board context per task id: the task block, its enclosing service frame and that frame's
   * title, in three chunked reads for the whole page.
   *
   * The frame is reached through the block's OWN account service rather than by walking parents,
   * because `Service.frameBlockId` states it directly and an ancestry walk would need every
   * intermediate block. A task whose block carries no service (a headless job's anchor, a board
   * block older than services) resolves to a task with a null service, which is the truth about it.
   */
  private async resolveTasks(blockIds: string[]): Promise<Map<string, PublicKaizenEntryTask>> {
    const wanted = [...new Set(blockIds)]
    const blocks = await this.deps.findBlocks(wanted)
    const serviceIds = [...new Set(blocks.map((b) => b.serviceId).filter(isNonEmpty))]
    const services = serviceIds.length ? await this.deps.listServices(serviceIds) : []
    const frameBlockIdByService = new Map(services.map((s) => [s.id, s.frameBlockId]))
    // The frames the page's tasks live under, minus the ones the first read already returned (a
    // grading anchored on the frame itself, which is how a blueprint or bootstrap run is graded).
    const knownBlocks = new Map(blocks.map((b) => [b.block.id, b.block]))
    const missingFrameIds = [...new Set(frameBlockIdByService.values())].filter(
      (id) => !knownBlocks.has(id),
    )
    const frames = missingFrameIds.length ? await this.deps.findBlocks(missingFrameIds) : []
    for (const frame of frames) knownBlocks.set(frame.block.id, frame.block)

    const out = new Map<string, PublicKaizenEntryTask>()
    for (const { block, serviceId } of blocks) {
      const frameBlockId = serviceId ? (frameBlockIdByService.get(serviceId) ?? null) : null
      out.set(block.id, {
        title: block.title,
        status: block.status,
        serviceId: frameBlockId,
        serviceTitle: frameBlockId ? (knownBlocks.get(frameBlockId)?.title ?? null) : null,
      })
    }
    return out
  }
}

/** The 404 both the point read and the acknowledge write answer for an id this workspace lacks. */
function entryNotFound(entryId: string): NotFoundError {
  return new NotFoundError('KaizenEntry', entryId, { reason: KAIZEN_ENTRY_NOT_FOUND_REASON })
}

function isNonEmpty(value: string | null): value is string {
  return !!value
}

/** Project one grading plus its resolved context onto the wire entry. */
function toPublicEntry(
  grading: KaizenGrading,
  tasks: Map<string, PublicKaizenEntryTask>,
  combos: Map<string, KaizenVerifiedCombo>,
): PublicKaizenEntry {
  const combo = combos.get(grading.comboKey)
  return {
    entryId: grading.id,
    runId: grading.executionId,
    stepIndex: grading.stepIndex,
    taskId: grading.blockId,
    task: tasks.get(grading.blockId) ?? null,
    agentKind: grading.agentKind,
    model: grading.model,
    promptVersion: grading.promptVersion,
    comboKey: grading.comboKey,
    combo: combo
      ? {
          consecutiveHighGrades: combo.consecutiveHighGrades,
          verified: combo.verified,
          verifiedAt: combo.verifiedAt,
        }
      : null,
    status: grading.status,
    grade: grading.grade,
    summary: grading.summary,
    recommendations: grading.recommendations,
    graderModel: grading.graderModel,
    error: grading.error,
    acknowledged: grading.acknowledgedAt !== null,
    acknowledgedAt: grading.acknowledgedAt,
    acknowledgedBy: grading.acknowledgedBy,
    acknowledgementNote: grading.acknowledgementNote,
    createdAt: grading.createdAt,
    updatedAt: grading.updatedAt,
  }
}
