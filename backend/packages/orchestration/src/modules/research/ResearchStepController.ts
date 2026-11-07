import {
  FINDINGS_INLINE_MAX_BYTES_CEILING,
  type FindingsRevision,
  type FindingsRevisionBody,
  type ResearchDefinition,
  type ResearchMode,
  type ResearchStepState,
  adhocQuestionId,
  foldFindings,
  type FoldedFindings,
  type Project,
  parseFindingsRevisionBody,
} from '@cat-factory/contracts'
import {
  CapabilityCredentialMissingError,
  ValidationError,
  placeFindingsBody,
  redactSecrets,
  resolveFindingsStoragePolicy,
  type AgentRunResult,
  type Block,
  type BlockRepository,
  type Clock,
  type FindingsRevisionRepository,
  type FindingsRevisionRow,
  type FindingsStoragePolicyRepository,
  type PipelineStep,
  type ProjectRepository,
  type ResearchDefinitionSource,
  type ResearchProjectRepository,
  type ResearchRunContext,
  type ResolvedResearchDefinition,
  type ServiceRepository,
  type WorkspaceRepository,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The engine half of a research task's run: what the `project-researcher` step is asked when it
// starts, what it checkpoints when it stops for a credential, and the findings revision it
// records when it completes. Design: `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

export interface ResearchStepControllerDeps {
  blockRepository: Pick<BlockRepository, 'findById'>
  projectRepository: Pick<ProjectRepository, 'get'>
  serviceRepository?: Pick<ServiceRepository, 'listByIds'>
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  researchDefinitions: ResearchDefinitionSource
  researchProjectRepository: ResearchProjectRepository
  findingsRevisionRepository: FindingsRevisionRepository
  findingsStoragePolicyRepository?: FindingsStoragePolicyRepository
  clock: Clock
}

const REQUEST_TEXT_MAX = 2000

/** What a task's step resolved at start: its project, pinned definition and current fold. */
interface ResolvedTask {
  project: Project
  accountId: string | null
  definition: ResolvedResearchDefinition
  inputs: Record<string, unknown>
  revisions: FindingsRevision[]
}

export class ResearchStepController {
  constructor(private readonly deps: ResearchStepControllerDeps) {}

  /**
   * Resolve a research step at dispatch. The first dispatch claims the task's findings sequence
   * and fixes its question list on the step; a replayed or resumed dispatch reads both back, so
   * it asks the same questions and keeps its place in the fold.
   */
  async prepare(step: PipelineStep, block: Block): Promise<ResearchRunContext> {
    const task = await this.resolveTask(block)
    if (task.revisions.some((r) => r.taskId === block.id)) {
      throw new ValidationError('This research task already recorded its findings', {
        reason: 'research_task_already_recorded',
      })
    }
    const definition = task.definition.definition
    const folded = foldFindings(task.revisions)
    if (!step.research) {
      const mode =
        block.taskTypeFields?.researchMode ?? (task.revisions.length ? 'extend' : 'initial')
      const adhoc = (block.taskTypeFields?.researchQuestions ?? []).map((question, i) => ({
        id: adhocQuestionId(block.id, i + 1),
        question,
      }))
      const questionIds = [
        ...selectQuestionIds(definition, mode, folded, block.taskTypeFields?.researchQuestionIds),
        ...adhoc.map((q) => q.id),
      ]
      if (questionIds.length === 0) {
        throw new ValidationError(`A '${mode}' research task has no question left to ask`, {
          reason: 'research_nothing_to_ask',
          mode,
        })
      }
      const seq = await this.deps.researchProjectRepository.reserveTaskSeq(
        task.project.id,
        block.id,
      )
      step.research = {
        projectId: task.project.id,
        seq,
        mode,
        definitionKey: definition.key,
        definitionVersion: definition.version,
        questionIds,
        adhocQuestions: adhoc,
      }
    }
    return this.runContext(step.research, task, folded)
  }

  /**
   * The agent stopped to ask for a credential: keep what it found so far on the step and return
   * the refusal that parks it. The caller persists the step BEFORE throwing, because the park
   * reloads the run.
   */
  async checkpoint(
    step: PipelineStep,
    result: AgentRunResult,
  ): Promise<CapabilityCredentialMissingError> {
    const state = requireState(step)
    const request = result.credentialRequest!
    const partial = parseBody(result.custom)
    if (partial) {
      const prior = parseBody(state.checkpoint)
      step.research = { ...state, checkpoint: prior ? mergeBodies(prior, partial) : partial }
    }
    const declared = await this.definitionOf(state)
    const credential = declared?.credentials.find((c) => c.key === request.key)
    return new CapabilityCredentialMissingError(
      `The research run needs the credential '${request.key}'`,
      {
        key: request.key,
        declaredBy: { kind: 'research-definition', id: state.definitionKey },
        ...(credential ? { label: credential.label } : {}),
        ...(credential?.onboarding ? { onboarding: credential.onboarding } : {}),
        reason: scrub(request.reason),
        observed: scrub(request.observed),
      },
    )
  }

  /**
   * Record the task's one findings revision from the step's reply, merged over its checkpoint.
   * Its id is the task's, so a replayed completion writes nothing twice. Answers to a question the
   * task was not asked are dropped and named in the rendered output.
   */
  async record(
    workspaceId: string,
    step: PipelineStep,
    taskId: string,
    result: AgentRunResult,
  ): Promise<{ output: string; outputIsRendered: true }> {
    const state = requireState(step)
    const reply = parseBody(result.custom)
    if (!reply) {
      throw new Error('The research run returned no readable findings (malformed or empty JSON)')
    }
    const checkpoint = parseBody(state.checkpoint)
    const merged = checkpoint ? mergeBodies(checkpoint, reply) : reply
    const asked = new Set(state.questionIds)
    const dropped = merged.findings.filter((f) => !asked.has(f.questionId)).map((f) => f.questionId)
    const body: FindingsRevisionBody = {
      ...merged,
      findings: merged.findings.filter((f) => asked.has(f.questionId)),
    }
    const json = JSON.stringify(body)
    const bytes = new globalThis.TextEncoder().encode(json).byteLength
    await this.assertFitsInline(workspaceId, state.projectId, bytes)
    const row: FindingsRevisionRow = {
      id: revisionIdFor(taskId),
      projectId: state.projectId,
      taskId,
      seq: state.seq,
      mode: state.mode,
      definitionKey: state.definitionKey,
      definitionVersion: state.definitionVersion,
      createdAt: this.deps.clock.now(),
      body: { kind: 'inline', json },
      bodyBytes: bytes,
    }
    step.research = { ...state, revisionId: row.id }
    if (await this.deps.findingsRevisionRepository.insert(row)) {
      return { output: renderRevision(body, state, dropped), outputIsRendered: true }
    }
    // A replayed completion lost to the write that landed first: report the revision on record,
    // not the replay's reply, whose answers may differ from it.
    const stored = await this.deps.findingsRevisionRepository.get(state.projectId, row.id)
    if (!stored) throw new Error(`Findings revision '${row.id}' was refused but is not on record`)
    return {
      output: renderRevision(decodeRevision(stored).body, state, []),
      outputIsRendered: true,
    }
  }

  private async resolveTask(block: Block): Promise<ResolvedTask> {
    const found = await this.deps.blockRepository.findById(block.id)
    const project = found?.ownerId ? await this.deps.projectRepository.get(found.ownerId) : null
    const pin = project ? await this.deps.researchProjectRepository.get(project.id) : null
    if (!project || !pin) {
      throw new ValidationError('A research task must sit under a research project', {
        reason: 'research_project_not_pinned',
      })
    }
    const accountId = project.accountId
    const resolved = await this.deps.researchDefinitions.get(
      accountId ?? '',
      pin.definitionKey,
      pin.definitionVersion,
    )
    if (!resolved) {
      throw new ValidationError('The pinned research definition no longer exists', {
        reason: 'research_definition_not_found',
        definitionKey: pin.definitionKey,
        definitionVersion: pin.definitionVersion,
      })
    }
    if (resolved.contentHash !== pin.definitionHash) {
      throw new ValidationError(
        'The registered research definition changed since the project pinned it',
        { reason: 'research_definition_changed', definitionKey: pin.definitionKey },
      )
    }
    const rows = await this.deps.findingsRevisionRepository.listByProject(project.id)
    return {
      project,
      accountId,
      definition: resolved,
      inputs: pin.inputs,
      revisions: rows.map(decodeRevision),
    }
  }

  private async runContext(
    state: ResearchStepState,
    task: ResolvedTask,
    folded: FoldedFindings,
  ): Promise<ResearchRunContext> {
    const definition = task.definition.definition
    const byId = new Map(
      definition.topics.flatMap((topic) =>
        topic.questions.map((q) => [q.id, { topic: topic.title, question: q }] as const),
      ),
    )
    const adhoc = new Map((state.adhocQuestions ?? []).map((q) => [q.id, q.question]))
    const questions = state.questionIds.flatMap((id) => {
      const known = byId.get(id)
      if (known) {
        return [
          {
            id,
            topic: known.topic,
            question: known.question.question,
            ...(known.question.answerHint ? { answerHint: known.question.answerHint } : {}),
          },
        ]
      }
      const text = adhoc.get(id)
      return text ? [{ id, topic: 'Added for this task', question: text }] : []
    })
    const priorFindings = state.questionIds.flatMap((id) => {
      const current = folded.byQuestion[id]
      return current
        ? [{ questionId: id, status: current.finding.status, answer: current.finding.answer }]
        : []
    })
    const services = task.project.serviceIds.length
      ? ((await this.deps.serviceRepository?.listByIds(task.project.serviceIds)) ?? [])
      : []
    const checkpoint = parseBody(state.checkpoint)
    return {
      projectId: task.project.id,
      mode: state.mode,
      definition,
      inputs: task.inputs,
      questions,
      priorFindings,
      ...(checkpoint ? { checkpoint } : {}),
      linkedFrameBlockIds: services.map((s) => s.frameBlockId).filter((id): id is string => !!id),
    }
  }

  private async definitionOf(state: ResearchStepState): Promise<ResearchDefinition | undefined> {
    const project = await this.deps.projectRepository.get(state.projectId)
    const resolved = await this.deps.researchDefinitions.get(
      project?.accountId ?? '',
      state.definitionKey,
      state.definitionVersion,
    )
    return resolved?.definition
  }

  /**
   * Where the body is stored under the account, workspace and project policy tiers. Only inline
   * storage is implemented, so a body over the runtime's own row ceiling is refused loudly rather
   * than truncated; one over the policy threshold but under the ceiling stays inline.
   */
  private async assertFitsInline(workspaceId: string, projectId: string, bytes: number) {
    const policies = this.deps.findingsStoragePolicyRepository
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
    const [account, workspace, project] = await Promise.all([
      accountId && policies ? policies.get('account', accountId) : null,
      policies ? policies.get('workspace', workspaceId) : null,
      policies ? policies.get('project', projectId) : null,
    ])
    const policy = resolveFindingsStoragePolicy({
      account,
      workspace,
      project,
      facadeInlineCeilingBytes: FINDINGS_INLINE_MAX_BYTES_CEILING,
    })
    const placement = placeFindingsBody({
      bytes,
      policy,
      facadeInlineCeilingBytes: FINDINGS_INLINE_MAX_BYTES_CEILING,
      blobStoreAvailable: false,
    })
    if (placement.placement === 'refused') {
      throw new ValidationError('The findings are too large to store inline', {
        reason: placement.reason,
        bytes,
      })
    }
  }
}

/** The revision id a task writes: one per task, so a replayed write is a no-op. */
export function revisionIdFor(taskId: string): string {
  return `frv_${taskId}`
}

/**
 * The definition questions a task of `mode` asks: every one (`initial`), the ones no revision
 * has touched (`extend`), the partial or blocked ones (`clarify`), or the answered ones
 * (`refresh`). `named` narrows `clarify` and `refresh` to the questions a person picked.
 */
export function selectQuestionIds(
  definition: ResearchDefinition,
  mode: ResearchMode,
  folded: FoldedFindings,
  named?: readonly string[],
): string[] {
  const all = definition.topics.flatMap((topic) => topic.questions.map((q) => q.id))
  const status = (id: string) => folded.byQuestion[id]?.finding.status
  switch (mode) {
    case 'initial':
      return all
    case 'extend':
      return all.filter((id) => status(id) === undefined)
    case 'clarify':
      return named?.length
        ? all.filter((id) => named.includes(id))
        : all.filter((id) => status(id) === 'partial' || status(id) === 'blocked')
    case 'refresh':
      return named?.length
        ? all.filter((id) => named.includes(id))
        : all.filter((id) => status(id) !== undefined)
    default:
      return unknownMode(mode)
  }
}

function unknownMode(mode: never): never {
  throw new Error(`unknown research mode: ${String(mode)}`)
}

/** A later body's findings replace an earlier one's by question id; learnings accumulate. */
export function mergeBodies(
  earlier: FindingsRevisionBody,
  later: FindingsRevisionBody,
): FindingsRevisionBody {
  const byId = new Map(earlier.findings.map((f) => [f.questionId, f]))
  for (const finding of later.findings) byId.set(finding.questionId, finding)
  const titles = new Set(later.learnings.map((l) => l.title))
  return {
    summary: later.summary || earlier.summary,
    findings: [...byId.values()],
    learnings: [...earlier.learnings.filter((l) => !titles.has(l.title)), ...later.learnings],
  }
}

function parseBody(value: unknown): FindingsRevisionBody | undefined {
  return parseFindingsRevisionBody(value)
}

function requireState(step: PipelineStep): ResearchStepState {
  if (!step.research) {
    throw new Error('A research step completed without the state its dispatch recorded')
  }
  return step.research
}

function decodeRevision(row: FindingsRevisionRow): FindingsRevision {
  const ref = row.body
  if (ref.kind !== 'inline') {
    throw new Error(`Findings revision '${row.id}' is offloaded, which this build cannot read yet`)
  }
  const body = parseFindingsRevisionBody(JSON.parse(ref.json))
  if (!body) throw new Error(`Findings revision '${row.id}' holds an unreadable body`)
  const { body: _ref, bodyBytes: _bytes, ...meta } = row
  return { ...meta, body }
}

function scrub(text: string): string {
  return (redactSecrets(text) ?? '').slice(0, REQUEST_TEXT_MAX)
}

/** The step's readable output: the coverage this revision recorded, and what it dropped. */
function renderRevision(
  body: FindingsRevisionBody,
  state: ResearchStepState,
  dropped: readonly string[],
): string {
  const counts = { answered: 0, partial: 0, unanswered: 0, blocked: 0 }
  for (const finding of body.findings) counts[finding.status] += 1
  const missing = state.questionIds.length - body.findings.length
  const lines = [
    `Recorded findings revision ${state.seq} (${state.mode}) for ${state.questionIds.length} question(s): ` +
      `${counts.answered} answered, ${counts.partial} partial, ${counts.unanswered} unanswered, ` +
      `${counts.blocked} blocked${missing > 0 ? `, ${missing} not reported` : ''}.`,
  ]
  if (dropped.length) {
    lines.push(`Dropped answers to questions this task was not asked: ${dropped.join(', ')}.`)
  }
  if (body.summary) lines.push('', body.summary)
  return lines.join('\n')
}
