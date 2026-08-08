import type {
  Block,
  DocKind,
  DocumentBoardPlan,
  DocumentLinkRole,
  DocumentRecord,
  DocumentRef,
  SourceDocument,
  DocumentOrigin,
  PlanFrame,
} from '@cat-factory/kernel'
import type { BlockEditAuthority } from '@cat-factory/contracts'
import { assertFound, ConflictError, ValidationError } from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { BoardWritePort } from '@cat-factory/kernel'
import { toSourceDocument } from './DocumentImportService.js'
import type { PlanTarget } from './documents.logic.js'

/** The `(origin, externalId)` key a document is addressed by, as one string for `Map` indexing. */
function refKey(ref: DocumentRef): string {
  return `${ref.source}:${ref.externalId}`
}

// DocumentLinkService: the write side that connects an imported document to the
// board. `spawn` materialises a planned structure into real frames, modules and
// tasks via the existing BoardService operations; `linkToBlock` attaches an
// imported document to a block so the execution engine feeds it to agents as
// extra context. Source-agnostic — it works on the projected document records.

export interface DocumentLinkServiceDependencies {
  boardService: BoardWritePort
  blockRepository: BlockRepository
  documentRepository: DocumentRepository
}

/** Counts of blocks created by a spawn, for the API response. */
export interface SpawnResult {
  frames: number
  modules: number
  tasks: number
  /**
   * Planned modules whose tasks went into a module the frame ALREADY had, rather than into a new
   * one (see {@link DocumentLinkService.spawnInto}).
   *
   * Reported rather than folded into `modules`, because the two answer different questions and
   * only one of them is about what changed. Without it a spawn that reused every module reports
   * "0 modules · 12 tasks" against a preview that showed three, which reads as three modules
   * having failed; and counting a reuse as a creation would claim a write that never happened.
   */
  reusedModules: number
}

/**
 * The key a planned module name is matched against an existing one by.
 *
 * Case- and whitespace-insensitive on purpose: the planner is TOLD to reuse the names it was
 * shown, but the thing being asked is a language model, and "Checkout" against "checkout" is a
 * duplicate module on the board either way. Matching exactly would make the reuse work in testing
 * and fail on the drift it exists to absorb.
 */
function moduleKey(name: string): string {
  return name.trim().toLowerCase()
}

export class DocumentLinkService {
  constructor(private readonly deps: DocumentLinkServiceDependencies) {}

  /**
   * Describe an existing service frame as a {@link PlanTarget}, so a plan can be authored FOR it.
   *
   * It lives here rather than in the planner because it is a fact about the BOARD: the planner is
   * a pure document→structure translator and must not learn to query blocks for a prompt detail.
   * It refuses exactly what {@link spawn} refuses, one step earlier, so a preview cannot be
   * rendered against a target the write would then reject.
   */
  async resolvePlanTarget(workspaceId: string, frameId: string): Promise<PlanTarget> {
    const frame = assertFound(
      await this.deps.blockRepository.get(workspaceId, frameId),
      'Block',
      frameId,
    )
    if (frame.level !== 'frame') {
      throw new ValidationError('Document structure can only be planned into a service frame', {
        reason: 'plan_target_not_a_frame',
      })
    }
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    return {
      frameId,
      title: frame.title,
      type: frame.type,
      // The names the frame ALREADY holds, so the plan adds beside them instead of proposing a
      // second module meaning the same thing. One board read rather than a per-module lookup.
      existingModules: blocks
        .filter((b) => b.parentId === frameId && b.level === 'module')
        .map((b) => b.title),
    }
  }

  /**
   * Apply a board plan to a workspace. Without `frameId` each planned frame
   * becomes a new top-level frame; with it, the plan's modules and tasks are
   * added inside that existing frame (the planned frames are flattened into it).
   *
   * `editor` is whose authority every block below is written under. The STRUCTURE comes from an
   * imported document, but the write is still made by whoever asked for the spawn, so the tier
   * comes from the caller rather than being decided here (see {@link BlockEditAuthority}).
   */
  async spawn(
    workspaceId: string,
    plan: DocumentBoardPlan,
    editor: BlockEditAuthority,
    frameId?: string,
  ): Promise<SpawnResult> {
    const result: SpawnResult = { frames: 0, modules: 0, tasks: 0, reusedModules: 0 }

    if (frameId) {
      const target = assertFound(
        await this.deps.blockRepository.get(workspaceId, frameId),
        'Block',
        frameId,
      )
      if (target.level !== 'frame') {
        throw new ValidationError('Document structure can only be spawned into a service frame')
      }
      // The frame's existing modules, read ONCE for the whole spawn and indexed by name. This is
      // the write half of what `resolvePlanTarget` showed the planner: the prompt asks the model to
      // reuse the names it was given, and until this existed nothing acted on the answer, so a plan
      // that obeyed produced a second "Checkout" beside the first. A model's cooperation is not an
      // implementation — the platform has to COMPUTE the reuse.
      const existing = new Map(
        (await this.deps.blockRepository.listByWorkspace(workspaceId))
          .filter((block) => block.parentId === frameId && block.level === 'module')
          .map((block) => [moduleKey(block.title), block.id]),
      )
      for (const frame of plan.frames) {
        await this.spawnInto(workspaceId, target.id, frame, result, editor, existing)
      }
      return result
    }

    let column = 0
    for (const frame of plan.frames) {
      const created = await this.deps.boardService.addFrame(workspaceId, {
        type: frame.type,
        position: { x: 80 + column * 380, y: 80 },
      })
      column += 1
      result.frames += 1
      await this.deps.boardService.updateBlock(
        workspaceId,
        created.id,
        { title: frame.title, ...(frame.description ? { description: frame.description } : {}) },
        editor,
      )
      // A frame created a line ago holds nothing, so its index starts empty; it still travels,
      // because two planned modules within ONE frame can name the same thing.
      await this.spawnInto(workspaceId, created.id, frame, result, editor, new Map())
    }
    return result
  }

  /**
   * Add a planned frame's modules and tasks inside an existing frame.
   *
   * `modulesByName` is the frame's modules indexed by {@link moduleKey}, and it is both the input
   * and the running record: a module created here is registered in it, so two planned modules that
   * name the same thing converge on one block exactly as a planned name matching a pre-existing
   * module does. A freshly created frame passes an empty map and every module is new.
   */
  private async spawnInto(
    workspaceId: string,
    frameId: string,
    frame: PlanFrame,
    result: SpawnResult,
    editor: BlockEditAuthority,
    modulesByName: Map<string, string>,
  ): Promise<void> {
    for (const task of frame.tasks) {
      await this.addTask(workspaceId, frameId, task, result, editor)
    }
    for (const planModule of frame.modules) {
      const key = moduleKey(planModule.name)
      // A module with nothing but whitespace for a name is not a module to reuse OR to key on: it
      // would collapse every such module onto one block. Treated as its own new module each time.
      const reused = key ? modulesByName.get(key) : undefined
      let moduleId = reused
      if (moduleId === undefined) {
        const created = await this.deps.boardService.addModule(workspaceId, frameId, {
          name: planModule.name,
        })
        moduleId = created.id
        result.modules += 1
        if (key) modulesByName.set(key, moduleId)
      } else {
        result.reusedModules += 1
      }
      for (const task of planModule.tasks) {
        await this.addTask(workspaceId, moduleId, task, result, editor)
      }
    }
  }

  private async addTask(
    workspaceId: string,
    containerId: string,
    task: { title: string; description?: string },
    result: SpawnResult,
    editor: BlockEditAuthority,
  ): Promise<void> {
    const created = await this.deps.boardService.addTask(
      workspaceId,
      containerId,
      { title: task.title },
      editor,
    )
    result.tasks += 1
    if (task.description) {
      await this.deps.boardService.updateBlock(
        workspaceId,
        created.id,
        { description: task.description },
        editor,
      )
    }
  }

  // Everything below addresses a document by its stored `(source, externalId)` key and asks
  // nothing of a provider, so it takes the WIDE `DocumentOrigin`: an uploaded spec is attachable,
  // and usable as a doc-kind template, on exactly the same terms as an imported page.

  /** Attach an imported (or uploaded) document to a board block as extra agent context. */
  async linkToBlock(
    workspaceId: string,
    blockId: string,
    source: DocumentOrigin,
    externalId: string,
  ): Promise<SourceDocument> {
    const [linked] = await this.linkManyToBlock(workspaceId, blockId, [{ source, externalId }])
    return linked!
  }

  /**
   * Attach SEVERAL documents to one block, in the order given, as one bounded unit of work.
   *
   * The batch form is the primitive and {@link linkToBlock} delegates to it, rather than the
   * other way round: a caller with a list (a task created with its requirements corpus, and the
   * rollback that detaches it) would otherwise re-read the same block once per document and issue
   * one write per document. Here the block is asserted ONCE, the documents resolve in one
   * `listByRefs` read, and the links land in one batched write.
   */
  async linkManyToBlock(
    workspaceId: string,
    blockId: string,
    refs: readonly DocumentRef[],
  ): Promise<SourceDocument[]> {
    if (refs.length === 0) return []
    const block: Block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const found = new Map(
      (await this.deps.documentRepository.listByRefs(workspaceId, refs)).map((doc) => [
        refKey(doc),
        doc,
      ]),
    )
    // Resolve every ref against the batch read before writing anything, so a list naming one
    // document that does not exist refuses whole rather than attaching the rest of it.
    const documents = refs.map((ref) =>
      assertFound(found.get(refKey(ref)) ?? null, 'Document', ref.externalId),
    )
    await this.assertNotHeldElsewhere(workspaceId, block.id, documents)
    await this.deps.documentRepository.linkBlockMany(workspaceId, refs, block.id)
    return documents.map((doc) => toSourceDocument({ ...doc, linkedBlockId: block.id }))
  }

  /** Every document attached to one block, in the order the agents read them. */
  async listBlockLinks(workspaceId: string, blockId: string): Promise<SourceDocument[]> {
    const rows = await this.deps.documentRepository.listByBlock(workspaceId, blockId)
    return rows.map(toSourceDocument)
  }

  /**
   * Detach ONE document from ONE block, naming the document by its `(source, externalId)` key.
   *
   * Scoped to the block on purpose, unlike the repository's own by-ref detach: a document row
   * carries exactly one attachment, so clearing it by ref alone would strip the document from
   * whichever task is holding it, which need not be the one the caller named. Asking "does this
   * block hold it" first means the worst case is a no-op.
   *
   * Idempotent, and that is the same decision the guard above forces: a document this block does
   * not hold is left alone and reported as detached, because a caller retrying after a timeout
   * should converge rather than have to tell "it was never attached" from "I already detached it".
   * Nothing is deleted either way: the document stays in the workspace, so re-attaching it later
   * costs no re-import.
   */
  async detachFromBlock(
    workspaceId: string,
    blockId: string,
    source: DocumentOrigin,
    externalId: string,
  ): Promise<void> {
    const document = await this.deps.documentRepository.get(workspaceId, source, externalId)
    if (!document || document.linkedBlockId !== blockId) return
    await this.deps.documentRepository.linkBlock(workspaceId, source, externalId, null)
  }

  /**
   * Detach every document attached to one block, in a single write.
   *
   * The undo of {@link linkManyToBlock}, keyed by BLOCK rather than by the refs that were being
   * attached, and that distinction is the whole point: a rollback runs after a partial or refused
   * attach, so the refs it was given include documents that are still attached to SOMEONE ELSE.
   * Clearing those by ref would strip a document from the task that legitimately holds it, which
   * is the exact silent loss the attach guard exists to prevent — committed by the cleanup path
   * instead. Asking "what is attached to the block being removed" can only ever clear links this
   * creation made.
   *
   * Nothing is deleted: the documents stay in the workspace, only their block link goes.
   */
  async detachBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.deps.documentRepository.detachBlocks(workspaceId, [blockId])
  }

  /**
   * Refuse to attach a document that a DIFFERENT live block already holds.
   *
   * A document row carries a single `linkedBlockId`, so attaching an already-attached document
   * does not copy the link, it MOVES it: the earlier task silently loses a document it was
   * created with, and nothing in its next run reports the absence. That is the same failure the
   * one-task-per-ticket rule refuses for tracker issues, so it refuses the same way, naming the
   * holder so the caller can follow it instead of guessing.
   *
   * A link naming a block that no longer exists is NOT a holder. A block delete now detaches its
   * documents (the board's removal cascade), but rows left by deletes made before it did would
   * otherwise be wedged forever, so a dangling link is treated as free and heals on first use.
   */
  private async assertNotHeldElsewhere(
    workspaceId: string,
    blockId: string,
    documents: readonly DocumentRecord[],
  ): Promise<void> {
    const holders = documents
      .map((doc) => doc.linkedBlockId)
      .filter((held): held is string => !!held && held !== blockId)
    if (!holders.length) return
    // One batched read for every candidate holder, so the guard costs one query however many
    // documents are being attached.
    const live = new Set(
      (await this.deps.blockRepository.findByIds([...new Set(holders)])).map((hit) => hit.block.id),
    )
    const conflict = documents.find(
      (doc) => doc.linkedBlockId && doc.linkedBlockId !== blockId && live.has(doc.linkedBlockId),
    )
    if (!conflict) return
    throw new ConflictError(
      `Document '${conflict.title}' is already attached to task ${conflict.linkedBlockId}. ` +
        `Detach it there first, or attach a separate copy.`,
      'document_already_linked',
      { taskId: conflict.linkedBlockId },
    )
  }

  /**
   * Tag an already-imported document as the workspace's `template` or `exemplar` for a document
   * kind (WS1 items 2–4). A `template` role is singular per kind — any prior template for the
   * kind is cleared first, so linking a new one replaces the override. `exemplar` is additive.
   * Reuses the same projected-document read path as {@link linkToBlock}; the only new surface is
   * the role/`docKind` tag on the row.
   */
  async linkForKind(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<SourceDocument> {
    const document = assertFound(
      await this.deps.documentRepository.get(workspaceId, source, externalId),
      'Document',
      externalId,
    )
    if (role === 'template') {
      await this.deps.documentRepository.clearRoleForKind(workspaceId, 'template', docKind)
    }
    await this.deps.documentRepository.setRole(workspaceId, source, externalId, role, docKind)
    return toSourceDocument({ ...document, role, docKind })
  }

  /** Clear a document's workspace+`DocKind` role tag (built-in template resumes / exemplar drops). */
  async unlinkForKind(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
  ): Promise<void> {
    await this.deps.documentRepository.clearRole(workspaceId, source, externalId)
  }

  /** Every role-tagged document in the workspace (drives the template/exemplar management UI). */
  async listRoleLinks(workspaceId: string): Promise<SourceDocument[]> {
    const rows = await this.deps.documentRepository.listRoleLinksByWorkspace(workspaceId)
    return rows.map(toSourceDocument)
  }
}
