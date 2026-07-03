import type {
  Block,
  BlockRepository,
  Clock,
  CreateInitiativeInput,
  ExecutionEventPublisher,
  IdGenerator,
  Initiative,
  InitiativeRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError, assertFound, requireWorkspace } from '@cat-factory/kernel'
import { parseInitiativePlanDraft } from '@cat-factory/contracts'
import { initiativeContentView } from '@cat-factory/agents'
import { gridSlot } from '../board/board.logic.js'
import {
  applyAnalysis,
  applyInterviewAnswer,
  applyInterviewOutcome,
  applyInterviewQuestions,
  applyPlanDraft,
  initiativeSlug,
  validatePlanDraft,
} from './initiative.logic.js'

export interface InitiativeServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  initiativeRepository: InitiativeRepository
  events: ExecutionEventPublisher
  clock: Clock
  idGenerator: IdGenerator
}

/** How many times a CAS write is retried against a concurrent writer before giving up. */
const CAS_ATTEMPTS = 3

/**
 * The initiative entity's owner: creation (the board block + the entity in one
 * step), reads for the snapshot/controller, and the plan-ingest writes the
 * execution engine drives from the planning pipeline. Every write after the
 * insert goes through the repository's rev-guarded `compareAndSwap`, so the
 * entity has a single logical writer even across concurrent tickers.
 */
export class InitiativeService {
  constructor(private readonly deps: InitiativeServiceDependencies) {}

  /**
   * Create an initiative under a service frame: the `initiative`-level board
   * block (a structural frame child, like a module) plus its empty entity
   * (`status: 'planning'`, rev 0), returned together so the client patches both
   * caches. The planning pipeline is then started against the block.
   */
  async create(
    workspaceId: string,
    input: CreateInitiativeInput,
  ): Promise<{ initiative: Initiative; block: Block }> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const frame = assertFound(
      await this.deps.blockRepository.get(workspaceId, input.frameId),
      'Block',
      input.frameId,
    )
    if (frame.level !== 'frame') {
      throw new ValidationError('An initiative can only be created under a service frame')
    }
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    const siblings = blocks.filter(
      (b) => b.parentId === frame.id && b.level === 'initiative',
    ).length

    // A stable, unique tracker-folder slug: suffix on collision with the
    // workspace's existing initiatives (two initiatives may share a title).
    const existing = await this.deps.initiativeRepository.list(workspaceId)
    const taken = new Set(existing.map((i) => i.slug))
    const base = initiativeSlug(input.title)
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`

    const now = this.deps.clock.now()
    const block: Block = {
      id: this.deps.idGenerator.next('init'),
      title: input.title.trim(),
      type: frame.type,
      description: input.description?.trim() ?? '',
      position: gridSlot(siblings, 2, 280, 220, 16, 320),
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'initiative',
      parentId: frame.id,
    }
    const initiative: Initiative = {
      id: this.deps.idGenerator.next('initv'),
      blockId: block.id,
      slug,
      title: input.title.trim(),
      goal: input.description?.trim() ?? '',
      constraints: [],
      nonGoals: [],
      qa: [],
      analysisSummary: '',
      phases: [],
      items: [],
      policy: null,
      decisions: [],
      deviations: [],
      followUps: [],
      caveats: [],
      status: 'planning',
      rev: 0,
      createdAt: now,
      updatedAt: now,
    }
    // Insert the initiative FIRST: its `(workspace_id, slug)` unique index is the
    // backstop for the read-then-insert slug race, so a losing concurrent create throws
    // here BEFORE a dangling initiative-block is written (rather than orphaning one).
    await this.deps.initiativeRepository.insert(workspaceId, initiative)
    await this.deps.blockRepository.insert(workspaceId, block)
    await this.deps.events.boardChanged(workspaceId, 'initiative-added', block.id)
    await this.deps.events.initiativeChanged?.(workspaceId, initiative)
    return { initiative, block }
  }

  list(workspaceId: string): Promise<Initiative[]> {
    return this.deps.initiativeRepository.list(workspaceId)
  }

  async get(workspaceId: string, id: string): Promise<Initiative> {
    return assertFound(await this.deps.initiativeRepository.get(workspaceId, id), 'Initiative', id)
  }

  getByBlock(workspaceId: string, blockId: string): Promise<Initiative | null> {
    return this.deps.initiativeRepository.getByBlock(workspaceId, blockId)
  }

  /**
   * Ingest an `initiative-planner` step's plan draft into the block's entity:
   * strict-parse (the trust boundary — a malformed draft is rejected, never
   * half-applied), validate the reference graph, fold it in preserving runtime
   * state, and CAS-write. IDEMPOTENT: re-ingesting a draft that produces
   * byte-identical content (a durable-driver replay) is a no-op, so the ingest
   * is replay-safe. Returns the updated entity, or null when the block has no
   * initiative (nothing to ingest into).
   */
  async ingestPlan(
    workspaceId: string,
    blockId: string,
    rawDraft: unknown,
  ): Promise<Initiative | null> {
    const draft = parseInitiativePlanDraft(rawDraft)
    validatePlanDraft(draft)
    return this.mutate(workspaceId, blockId, (current) =>
      applyPlanDraft(current, draft, this.deps.clock.now()),
    )
  }

  /**
   * Flip an initiative to `executing` (the committer step ran: the plan is
   * approved and the tracker mirror committed), stamping the repo-doc
   * bookkeeping when a commit landed. Idempotent on replay (same status + doc
   * ⇒ content-unchanged ⇒ no write).
   */
  async markExecuting(
    workspaceId: string,
    blockId: string,
    doc: { version: number; hash: string } | null,
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) => ({
      ...current,
      status:
        current.status === 'planning' || current.status === 'awaiting_approval'
          ? 'executing'
          : current.status,
      ...(doc ? { doc: { ...doc, committedAt: this.deps.clock.now() } } : {}),
    }))
  }

  // ---- Interactive planning interview (slice 2) ---------------------------
  // Each write goes through the CAS `mutate` (single-writer, replay-safe) and emits the
  // live `initiative` event so an open planning window refreshes. The interviewer LLM +
  // the park/resume orchestration live in InitiativeInterviewService / the controller;
  // these are the entity writes they drive.

  /** Append a fresh round of pending interview questions (parks the interview `awaiting`). */
  async recordInterviewQuestions(
    workspaceId: string,
    blockId: string,
    questions: string[],
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) =>
      applyInterviewQuestions(current, questions, () => this.deps.idGenerator.next('iqa')),
    )
  }

  /** Record the human's answer to one pending question (no run resume; the controller does that). */
  async recordInterviewAnswer(
    workspaceId: string,
    blockId: string,
    questionId: string,
    answer: string,
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) =>
      applyInterviewAnswer(current, questionId, answer),
    )
  }

  /** Converge the interview: fold the synthesized goal/constraints/non-goals brief onto the entity. */
  async recordInterviewOutcome(
    workspaceId: string,
    blockId: string,
    outcome: { goal: string; constraints: string[]; nonGoals: string[] },
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) => applyInterviewOutcome(current, outcome))
  }

  /** Fold the analyst step's codebase-analysis prose onto the entity. */
  async recordAnalysis(
    workspaceId: string,
    blockId: string,
    summary: string,
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) => applyAnalysis(current, summary))
  }

  /**
   * The shared read → transform → CAS-write loop. A content-identical transform
   * result short-circuits to no write (replay/idempotency); a lost CAS reloads
   * and retries a bounded number of times before conflicting loudly.
   */
  private async mutate(
    workspaceId: string,
    blockId: string,
    transform: (current: Initiative) => Initiative,
  ): Promise<Initiative | null> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await this.deps.initiativeRepository.getByBlock(workspaceId, blockId)
      if (!current) return null
      const next = transform(current)
      if (sameContent(current, next)) return current
      const persisted: Initiative = {
        ...next,
        rev: current.rev + 1,
        updatedAt: this.deps.clock.now(),
      }
      if (
        await this.deps.initiativeRepository.compareAndSwap(workspaceId, persisted, current.rev)
      ) {
        await this.deps.events.initiativeChanged?.(workspaceId, persisted)
        return persisted
      }
    }
    throw new ConflictError('Initiative was modified concurrently; retry the operation')
  }
}

/** Whether two entities carry identical plan content (bookkeeping excluded). */
function sameContent(a: Initiative, b: Initiative): boolean {
  // `doc` is bookkeeping but IS written by mutations (markExecuting), so compare
  // it alongside the content view — only `rev`/`updatedAt` are noise.
  return (
    JSON.stringify({ ...initiativeContentView(a), doc: a.doc ?? null }) ===
    JSON.stringify({ ...initiativeContentView(b), doc: b.doc ?? null })
  )
}
