import type {
  Block,
  BlockRepository,
  Clock,
  CreateInitiativeInput,
  ExecutionEventPublisher,
  IdGenerator,
  Initiative,
  InitiativeExecutionPolicy,
  InitiativeRepository,
  PipelineRepository,
  PromoteInitiativeFollowUpInput,
  UpdateInitiativeItemInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError, assertFound, requireWorkspace } from '@cat-factory/kernel'
import type {
  InitiativePresetRegistry,
  InitiativeQa,
  InitiativeQaStatus,
} from '@cat-factory/kernel'
import type { InitiativePresetInputs } from '@cat-factory/contracts'
import {
  parseInitiativePlanDraft,
  sanitizeInitiativePresetInputs,
  validateInitiativePresetInputs,
} from '@cat-factory/contracts'
import { initiativeContentView } from '@cat-factory/agents'
import { gridSlot } from '../board/board.logic.js'
import {
  applyAnalysis,
  applyCheckpointCleared,
  applyDismissFollowUp,
  applyInterviewAnswer,
  applyInterviewOutcome,
  applyInterviewQuestions,
  applyItemEdit,
  applyPlanDraft,
  applyPolicyEdit,
  applyPromoteFollowUp,
  applyQuestionRecommendation,
  applyQuestionStatus,
  initiativeSlug,
  normalizeDraftAgainstPhaseTemplate,
  pendingCheckpoint,
  seedPresetInterviewQa,
  validatePlanDraft,
} from './initiative.logic.js'

export interface InitiativeServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  initiativeRepository: InitiativeRepository
  /** The app-owned initiative-preset registry (resolve a preset's descriptor + code hooks by id). */
  initiativePresetRegistry: InitiativePresetRegistry
  events: ExecutionEventPublisher
  clock: Clock
  idGenerator: IdGenerator
  /**
   * Pipelines, used ONLY to validate the plan's `defaultPipelineId` at ingest (fail the
   * planning run loudly on a plan that names a non-existent pipeline, rather than surfacing
   * it later as a per-item spawn deviation). Optional so a deployment/test without pipelines
   * wired still ingests. A pipeline deleted AFTER ingest is handled by the loop at spawn.
   */
  pipelineRepository?: PipelineRepository
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
    // Resolve + validate the initiative preset. Absent `presetId` ⇒ the preset-less generic
    // behaviour, byte-for-byte today's. An unknown preset / invalid form is a create-time
    // ValidationError, so nothing is written.
    const preset = input.presetId
      ? this.deps.initiativePresetRegistry.get(input.presetId)
      : undefined
    if (input.presetId && !preset) {
      throw new ValidationError(`Unknown initiative preset '${input.presetId}'`)
    }
    // Only a resolved preset yields persisted `presetInputs`, and only its SANITIZED subset (known,
    // currently-visible fields) is frozen — so a form posted with no `presetId`, or an unsafe value
    // on a hidden (`showWhen`-failed) field the validator skips, never lands on the entity.
    let presetInputs: InitiativePresetInputs | undefined
    if (preset) {
      const problems = validateInitiativePresetInputs(preset.descriptor, input.presetInputs ?? {})
      if (problems.length > 0) throw new ValidationError(problems.join(' '))
      presetInputs = sanitizeInitiativePresetInputs(preset.descriptor, input.presetInputs ?? {})
    }
    // Seed the qa digest from the filled FORM for ANY preset (T3): for a SKIP-interview preset the
    // form IS the interview; for a FULL-interview preset the seeded answers are the interviewer's
    // STARTING POINT so it builds on them (see InitiativeInterviewService) rather than re-asking the
    // enumerable facts the form already captured. `seedPresetInterviewQa` reads the filled fields, so
    // `preset_generic` (no fields) seeds nothing and stays byte-for-byte unchanged; an absent preset
    // seeds nothing (today's free-form behaviour).
    const skipInterview = preset?.descriptor.interview === 'skip'
    const seededQa: InitiativeQa[] = preset
      ? seedPresetInterviewQa(preset.descriptor, presetInputs ?? {}, () =>
          this.deps.idGenerator.next('iqa'),
        )
      : []
    // Only a SKIP-interview preset templates the goal from its stated purpose (the form is the whole
    // scoping step). A FULL-interview preset's goal is synthesized by the interviewer, so it stays
    // the human's description (or blank until the interview converges).
    const goal =
      input.description?.trim() ||
      (skipInterview ? preset!.descriptor.presentation.description.trim() : '')

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
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(presetInputs && Object.keys(presetInputs).length ? { presetInputs } : {}),
      goal,
      constraints: [],
      nonGoals: [],
      qa: seededQa,
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
   * half-applied), run the initiative preset's `seedPlan` hook (slice 5), validate
   * the reference graph, fold it in preserving runtime state, and CAS-write.
   * IDEMPOTENT: re-ingesting a draft that produces byte-identical content (a
   * durable-driver replay) is a no-op, so the ingest is replay-safe. Returns the
   * updated entity, or null when the block has no initiative (nothing to ingest into).
   */
  async ingestPlan(
    workspaceId: string,
    blockId: string,
    rawDraft: unknown,
  ): Promise<Initiative | null> {
    const draft = await this.seedPlanDraft(workspaceId, blockId, parseInitiativePlanDraft(rawDraft))
    if (!draft) return null
    validatePlanDraft(draft)
    await this.assertPipelinesExist(workspaceId, draft)
    return this.mutate(workspaceId, blockId, (current) =>
      applyPlanDraft(current, draft, this.deps.clock.now()),
    )
  }

  /**
   * Shape + decorate the parsed draft against the entity's resolved preset, run at ingest before
   * the reference-graph validation. Two ordered, separable steps (the preset is resolved from the
   * entity's FROZEN `presetId`/`presetInputs`, so reading it outside the CAS `mutate` is race-free):
   *
   * 1. **Phase-template normalization (slice T2)** — when the preset declares a `phaseTemplate`,
   *    `normalizeDraftAgainstPhaseTemplate` reorders the planned phases into template order and
   *    rejects a missing-`required` / disallowed-extra phase with a `ValidationError`. Generic,
   *    preset-id-agnostic SHAPE enforcement, run FIRST so the `seedPlan` hook sees template-ordered
   *    phases. No template ⇒ the draft passes through unchanged.
   * 2. **`seedPlan` post-processor (slice 5)** — the preset's own per-item DECORATION hook, pure so
   *    its output is a deterministic function of the (shaped) draft + frozen inputs and stays
   *    replay-safe. Its output is RE-PARSED through the strict schema: a hook bug can't persist a
   *    malformed draft, and an unsafe spawn `targetPath` a hook (or the planner) emitted is rejected
   *    here by `taskTypeFieldsSchema`'s `isSafeDocPath` check — it can never escape the repo. It is
   *    then RE-NORMALIZED against the template (idempotent, so a phase-untouching hook is a no-op):
   *    exactly as the re-parse stops a hook smuggling an unsafe path, this stops a hook that touched
   *    phases from bypassing the plan SHAPE the template enforces.
   *
   * Returns null when the block has no initiative (mirroring the null the caller returns), or the
   * (shaped) draft unchanged when the preset has no `seedPlan` / is absent.
   */
  private async seedPlanDraft(
    workspaceId: string,
    blockId: string,
    draft: ReturnType<typeof parseInitiativePlanDraft>,
  ): Promise<ReturnType<typeof parseInitiativePlanDraft> | null> {
    const initiative = await this.deps.initiativeRepository.getByBlock(workspaceId, blockId)
    if (!initiative) return null
    const preset = initiative.presetId
      ? this.deps.initiativePresetRegistry.get(initiative.presetId)
      : undefined
    const template = preset?.descriptor.phaseTemplate
    const normalize = (
      d: ReturnType<typeof parseInitiativePlanDraft>,
    ): ReturnType<typeof parseInitiativePlanDraft> =>
      template ? normalizeDraftAgainstPhaseTemplate(template, d) : d
    const shaped = normalize(draft)
    if (!preset?.seedPlan) return shaped
    return normalize(
      parseInitiativePlanDraft(preset.seedPlan(shaped, initiative.presetInputs ?? {})),
    )
  }

  /**
   * Fail a plan ingest whose policy names a pipeline that doesn't exist (the default, or a
   * rule/item override) — a plan the loop could never execute. No-op when no pipeline
   * repository is wired (tests/conformance). The loop still guards a pipeline deleted AFTER
   * ingest at spawn time (a deviation + notification, never a throw inside the sweep).
   */
  private async assertPipelinesExist(
    workspaceId: string,
    draft: ReturnType<typeof parseInitiativePlanDraft>,
  ): Promise<void> {
    const repo = this.deps.pipelineRepository
    if (!repo) return
    const ids = new Set<string>([draft.policy.defaultPipelineId])
    for (const rule of draft.policy.rules ?? []) ids.add(rule.pipelineId)
    for (const item of draft.items) if (item.pipelineId) ids.add(item.pipelineId)
    for (const id of ids) {
      if (!(await repo.get(workspaceId, id))) {
        throw new ValidationError(`Plan references unknown pipeline '${id}'`)
      }
    }
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

  // ---- Execution loop (slice 3) -------------------------------------------
  // The loop drives the entity through the same CAS `mutate` path. `update` is the generic
  // transform seam the loop passes its (pure) item-lifecycle closures to; the lifecycle
  // transitions below are the human-driven controls (pause / resume / cancel).

  /**
   * Apply a CAS-guarded transform to the block's initiative — the execution loop's write
   * path. A content-identical transform short-circuits to no write (replay/idempotency);
   * a lost CAS reloads and retries a bounded number of times. Returns the persisted entity,
   * or null when the block has no initiative.
   */
  update(
    workspaceId: string,
    blockId: string,
    transform: (current: Initiative) => Initiative,
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, transform)
  }

  /** Pause an executing initiative (the sweep skips it; in-flight tasks finish naturally). */
  pause(workspaceId: string, blockId: string): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) =>
      current.status === 'executing' ? { ...current, status: 'paused' } : current,
    )
  }

  /**
   * Resume a paused initiative back to `executing` (the next sweep picks it up). When it was paused
   * at a phase checkpoint (D2), resume IS the acknowledgment: stamp `checkpointClearedAt` on that
   * phase in the SAME CAS transform, so the checkpoint never re-fires and the loop advances past the
   * reviewed phase. Doing it here (not a separate write) means a lagging sweep can't re-pause the run
   * between the resume and a distinct ack write.
   *
   * Resume is a BLANKET acknowledgment by design: it clears whatever checkpoint is currently pending,
   * regardless of WHY the run was paused. So if a human {@link pause}d manually and the checkpoint
   * phase's in-flight items then settled, resuming clears that checkpoint rather than immediately
   * re-pausing at it on the next tick. There is deliberately no pause-reason bookkeeping — the two
   * pause sources converge on "resume = continue past the reviewed phase".
   */
  resume(workspaceId: string, blockId: string): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) => {
      if (current.status !== 'paused') return current
      const checkpoint = pendingCheckpoint(current)
      const cleared = checkpoint
        ? applyCheckpointCleared(current, checkpoint.id, this.deps.clock.now())
        : current
      return { ...cleared, status: 'executing' }
    })
  }

  /**
   * Cancel an initiative: stop spawning further work. Terminal from the loop's view. In-flight
   * spawned tasks are left to finish on their own (cascading their teardown is slice 4).
   */
  cancel(workspaceId: string, blockId: string): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) =>
      current.status === 'done' || current.status === 'cancelled'
        ? current
        : { ...current, status: 'cancelled' },
    )
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

  /** Mark one planning question `dismissed` (not relevant) or reopen it (no run resume). */
  async recordQuestionStatus(
    workspaceId: string,
    blockId: string,
    questionId: string,
    status: InitiativeQaStatus,
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) =>
      applyQuestionStatus(current, questionId, status),
    )
  }

  /** Attach an AI-suggested answer to one pending question (the recommend action). */
  async recordQuestionRecommendation(
    workspaceId: string,
    blockId: string,
    questionId: string,
    recommendation: string,
  ): Promise<Initiative | null> {
    return this.mutate(workspaceId, blockId, (current) =>
      applyQuestionRecommendation(current, questionId, recommendation),
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

  // ---- Follow-up triage + item/policy editing (slice 4) -------------------
  // Mid-flight human curation, keyed by initiative id (the tracker window / inspector operate
  // on the loaded entity). Each resolves the id → block, then rides the same CAS `mutate` the
  // loop uses, so a human edit and a live tick are serialised by the single-writer rev guard.
  // The pure transforms throw ValidationError/ConflictError for illegal edits (unknown phase,
  // editing an in-flight item) — mutate propagates them before any write.

  /** Promote an `open` harvested follow-up into a new `pending` tracker item under a phase. */
  async promoteFollowUp(
    workspaceId: string,
    initiativeId: string,
    followUpId: string,
    input: PromoteInitiativeFollowUpInput,
  ): Promise<Initiative> {
    if (input.pipelineId) await this.assertPipelineExists(workspaceId, input.pipelineId)
    return this.mutateById(workspaceId, initiativeId, (current) =>
      applyPromoteFollowUp(current, followUpId, input),
    )
  }

  /** Dismiss a harvested follow-up without acting on it. */
  async dismissFollowUp(
    workspaceId: string,
    initiativeId: string,
    followUpId: string,
  ): Promise<Initiative> {
    return this.mutateById(workspaceId, initiativeId, (current) =>
      applyDismissFollowUp(current, followUpId),
    )
  }

  /** Edit one tracker item and/or drive its status (retry a blocked item / skip it). */
  async updateItem(
    workspaceId: string,
    initiativeId: string,
    itemId: string,
    input: UpdateInitiativeItemInput,
  ): Promise<Initiative> {
    if (input.pipelineId) await this.assertPipelineExists(workspaceId, input.pipelineId)
    return this.mutateById(workspaceId, initiativeId, (current) =>
      applyItemEdit(current, itemId, input),
    )
  }

  /** Replace an executing initiative's execution policy (concurrency + pipeline rules). */
  async updatePolicy(
    workspaceId: string,
    initiativeId: string,
    policy: InitiativeExecutionPolicy,
  ): Promise<Initiative> {
    await this.assertPipelineExists(workspaceId, policy.defaultPipelineId)
    for (const rule of policy.rules ?? [])
      await this.assertPipelineExists(workspaceId, rule.pipelineId)
    return this.mutateById(workspaceId, initiativeId, (current) => applyPolicyEdit(current, policy))
  }

  /** Fail loudly when an edit names a pipeline that doesn't exist. No-op without a repo (tests). */
  private async assertPipelineExists(workspaceId: string, pipelineId: string): Promise<void> {
    const repo = this.deps.pipelineRepository
    if (!repo) return
    if (!(await repo.get(workspaceId, pipelineId))) {
      throw new ValidationError(`Unknown pipeline '${pipelineId}'`)
    }
  }

  /** Resolve an initiative id → its block, then apply a CAS transform (the id-keyed edit path).
   *  Non-null by construction: the entity is asserted to exist, so the block-keyed mutate that
   *  follows always finds it. */
  private async mutateById(
    workspaceId: string,
    initiativeId: string,
    transform: (current: Initiative) => Initiative,
  ): Promise<Initiative> {
    const initiative = assertFound(
      await this.deps.initiativeRepository.get(workspaceId, initiativeId),
      'Initiative',
      initiativeId,
    )
    return assertFound(
      await this.mutate(workspaceId, initiative.blockId, transform),
      'Initiative',
      initiativeId,
    )
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
