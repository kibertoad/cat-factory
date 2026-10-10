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
} from '@cat-factory/kernel'
import { ConflictError, NotFoundError } from '@cat-factory/kernel'

// The public KAIZEN-ENTRY reads and the acknowledgement write, extracted from `KaizenService` as
// a cohesive collaborator: it shares none of the service's grading machinery (no model, no
// telemetry, no prompt) and all of its own concern is the JOIN that turns a stored grading into
// something a person can act on without opening the app.
//
// Two things shape it:
//
//  1. **The context is resolved in BATCHES, never per entry, and never workspace-wide.** A page is
//     up to 100 gradings, and everything it needs comes back in a bounded handful of chunked
//     reads: one per LEVEL of the board hierarchy to walk the graded blocks up to their service
//     frames, plus one for exactly the combo keys the page names. Neither of the shapes it
//     replaces is affordable at this scale: a per-row lookup is the N+1 this codebase bans, and a
//     whole-workspace read (every block, or the entire combo library) makes a single-entry point
//     read pay for the size of the board.
//  2. **The service is resolved by board ANCESTRY**, the same walk `getServiceTask` and
//     `resolveRepoTarget` do, because that is what `serviceId` means everywhere else on
//     `/api/v1`. It is done with batched reads per level rather than by loading the workspace's
//     blocks: containment is at most `task` under `module` under `frame`, so the walk terminates
//     in a bounded number of reads over exactly the ids it still needs.
//  3. **A resolved fact that is gone is NULL, never a substitute.** A task deleted since the run
//     answers `task: null`, and a combo nothing has recorded answers `combo: null`, rather than an
//     empty title or a zeroed streak that would read as a task with no name and a combo that has
//     never scored well.

/** What the entry surface needs from its stores, bound by the service that owns them. */
export interface KaizenEntryDeps {
  gradings: Pick<KaizenGradingRepository, 'get' | 'listPage' | 'setAcknowledgement'>
  combos: Pick<KaizenVerifiedComboRepository, 'listByKeys'>
  /**
   * Resolve blocks by id in one batched read, across workspaces: a graded task can live on a
   * service another workspace owns and this board only mounts, so the lookup is by id rather than
   * scoped to the entry's own workspace. Ids with no block come back absent.
   */
  findBlocks: (blockIds: string[]) => Promise<Block[]>
  clock: Clock
}

/** The filters `GET /api/v1/kaizen/entries` pushes into SQL, plus its page bound. */
export interface KaizenEntryQuery {
  limit: number
  cursor?: { createdAt: number; id: string }
  acknowledged?: boolean
  settled?: boolean
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
    // One clock read stamps both `acknowledgedAt` and `updatedAt`, so the row cannot claim to have
    // been acknowledged after the last time it changed.
    const updated = await this.deps.gradings.setAcknowledgement(
      workspaceId,
      entryId,
      input.acknowledged ? { by: input.actor, note: input.note } : null,
      this.deps.clock.now(),
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
    // The combo read names exactly the keys on this page. `listByWorkspace` would answer the same
    // question by reading the workspace's whole combo library, which a one-entry point read pays
    // in full and which grows with every kind, model and prompt version the workspace has run.
    const [tasks, combos] = await Promise.all([
      this.resolveTasks(gradings.map((g) => g.blockId)),
      this.deps.combos.listByKeys(workspaceId, [...new Set(gradings.map((g) => g.comboKey))]),
    ])
    const comboByKey = new Map(combos.map((combo) => [combo.comboKey, combo]))
    return gradings.map((grading) => toPublicEntry(grading, tasks, comboByKey))
  }

  /**
   * The board context per graded block: the block itself, its enclosing service frame and that
   * frame's title, walked up the containment tree in batched reads (one per level).
   *
   * Ancestry rather than the block's own account-service stamp, because ancestry is what
   * `serviceId` MEANS on this API: `GET /api/v1/services/{id}/tasks` and `GET /api/v1/tasks/{id}`
   * both resolve it that way (`serviceOf`), and a board block that carries no service stamp (one
   * predating services, or a workspace-local board) still sits under a frame. Reading the stamp
   * instead made the same task report a service on one endpoint and null here.
   *
   * The walk is batched rather than done over the workspace's whole block list: each pass resolves
   * exactly the parent ids it does not yet hold, and containment bottoms out at `frame`, so it
   * settles within {@link MAX_ANCESTRY_HOPS} reads. Already-resolved ids are never re-read, which
   * is also what stops a cycle in stored data from looping.
   */
  private async resolveTasks(blockIds: string[]): Promise<Map<string, PublicKaizenEntryTask>> {
    const wanted = [...new Set(blockIds)]
    if (wanted.length === 0) return new Map()
    const resolved = new Map<string, Block>()
    let frontier = wanted
    for (let hop = 0; hop <= MAX_ANCESTRY_HOPS && frontier.length > 0; hop++) {
      const found = await this.deps.findBlocks(frontier)
      for (const block of found) resolved.set(block.id, block)
      frontier = [
        ...new Set(
          found
            .filter((block) => block.level !== 'frame')
            .map((block) => block.parentId)
            .filter(isUnresolvedParent(resolved)),
        ),
      ]
    }

    const out = new Map<string, PublicKaizenEntryTask>()
    for (const id of wanted) {
      const block = resolved.get(id)
      if (!block) continue
      // Id and title come off the SAME resolved frame, so a caller is never handed a `serviceId`
      // that `GET /api/v1/services/{serviceId}` cannot answer for. A chain that reaches no frame
      // (a block outside any service, or one whose parent has been deleted) answers null for both.
      const frame = frameOf(block, resolved)
      out.set(block.id, {
        title: block.title,
        status: block.status,
        serviceId: frame?.id ?? null,
        serviceTitle: frame?.title ?? null,
      })
    }
    return out
  }
}

/**
 * How many batched reads the ancestry walk may take before it stops.
 *
 * Containment is `task` under `module` under `frame` (`canReparent` admits nothing deeper), so two
 * hops reach a frame from the deepest block and the third is headroom against a level added later.
 * It bounds the READS; termination itself comes from never re-reading an id already resolved.
 */
const MAX_ANCESTRY_HOPS = 3

/** The service frame a block sits under, walked over already-resolved blocks; undefined if none. */
function frameOf(block: Block, resolved: Map<string, Block>): Block | undefined {
  let cur: Block | undefined = block
  const seen = new Set<string>()
  while (cur && cur.level !== 'frame') {
    if (seen.has(cur.id)) return undefined
    seen.add(cur.id)
    cur = cur.parentId ? resolved.get(cur.parentId) : undefined
  }
  return cur
}

/** The parent ids a walk pass still has to read: present, and not already resolved. */
function isUnresolvedParent(
  resolved: Map<string, Block>,
): (parentId: string | null | undefined) => parentId is string {
  return (parentId): parentId is string => !!parentId && !resolved.has(parentId)
}

/** The 404 both the point read and the acknowledge write answer for an id this workspace lacks. */
function entryNotFound(entryId: string): NotFoundError {
  return new NotFoundError('KaizenEntry', entryId, { reason: KAIZEN_ENTRY_NOT_FOUND_REASON })
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
