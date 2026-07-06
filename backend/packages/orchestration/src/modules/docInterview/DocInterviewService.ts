import { generateText } from 'ai'
import type {
  Block,
  Clock,
  DocInterviewSession,
  DocInterviewRepository,
  IdGenerator,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import {
  DOC_INTERVIEWER_AGENT_KIND,
  extractJson,
  inlineModelRef,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import { catFactoryObservability, FINAL_ANSWER_IN_REPLY } from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
import {
  answeredDigest,
  applyDocInterviewAnswer,
  applyDocInterviewOutcome,
  applyDocInterviewQuestions,
  coerceDocInterviewOutput,
  DOC_INTERVIEW_MAX_ROUNDS,
  type DocInterviewOutput,
  newDocInterviewSession,
} from './doc-interview.logic.js'

// ---------------------------------------------------------------------------
// The interactive document-review INTERVIEWER (WS5). Self-contained (owns its
// session repository AND the inline LLM), mirroring RequirementReviewService's
// self-containment but with the interview Q&A shape of the initiative
// interviewer — a document task has no owning entity to hang the transcript on,
// so the session lives in its own `doc_interview_sessions` table.
//
// It reads the block brief + the outline (and research) produced by the earlier
// steps plus the answers gathered so far, and either asks a fresh batch of
// clarifying questions or converges with a synthesized authoring brief the
// doc-writer starts from. The engine's DocInterviewController drives the
// park/answer/resume loop; this service decides content AND persists it.
//
// Model resolution is the SAME precedence as an agent step / the requirements
// reviewer: a model pinned on the block wins, else the workspace's per-kind
// default, else the routing default (a pinned subscription harness ref degrades
// to the routing default because this is an INLINE call with no container).
// ---------------------------------------------------------------------------

/** Role prompt the interviewer runs under. Returns ONLY a JSON decision object. */
export const DOC_INTERVIEW_SYSTEM_PROMPT =
  'You are a documentation lead INTERVIEWING a stakeholder to refine a document BEFORE it is ' +
  'written. You are given the document brief, its proposed outline, and the answers gathered so ' +
  'far. Decide whether you understand the intended scope, audience, depth, structure and the ' +
  'key points to cover well enough for an author to write a strong draft. If NOT, ask a small ' +
  'batch of focused, high-leverage clarifying questions — each answerable in a sentence or two, ' +
  'no yes/no trivia, no questions the brief or outline already answer. If you have enough (or ' +
  'you are told this is the final round), STOP asking and synthesize a concise authoring brief: ' +
  'the agreed scope and audience, the structure to follow, the specific points/decisions each ' +
  'section must cover, and anything explicitly out of scope. Respond with ONLY a JSON object of ' +
  'shape {"done": boolean, "questions": string[], "brief": string}. When done is false, ' +
  '`questions` is non-empty; when done is true, `questions` is empty and you MUST fill `brief`. ' +
  'No prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** What the interviewer needs to resolve its inline model, reach the provider, and persist. */
export interface DocInterviewDeps {
  /** The session store (mandatory — WS5 persists the transcript). */
  docInterviewRepository: DocInterviewRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Routing-default model ref when the block pins none. */
  modelRef?: ModelRef
  /** Resolve a block's selected model id to a ref (the deployment-aware resolver). */
  resolveBlockModel?: (modelId: string | undefined) => ModelRef | undefined
  /** Keep an ambient-eligible harness ref inline (local mode) instead of degrading it. */
  runsInline?: (ref: ModelRef) => boolean
  /** Resolve the workspace's per-agent-kind default model id (block pins none). */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /** Resolve the block's run/execution + initiator, folded into the inline model scope. */
  resolveRunContext?: ResolveBlockRunContext
}

/** A prior step's output, threaded in so the interviewer can read the outline / research. */
export interface DocInterviewPriorOutput {
  agentKind: string
  output: string
}

export class DocInterviewService {
  constructor(private readonly deps: DocInterviewDeps) {}

  /** Whether the inline interviewer is available (a provider AND a routing default are wired). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /** The current live session for a block, or null. */
  getByBlock(workspaceId: string, blockId: string): Promise<DocInterviewSession | null> {
    return this.deps.docInterviewRepository.getByBlock(workspaceId, blockId)
  }

  /**
   * Drop the block's session(s) so the next run starts a clean interview. Called by the gate on a
   * fresh run (mirrors `IterativeReviewService.review` clearing the block before iteration 1) — a
   * re-run must not reuse the prior run's converged / at-cap session and its stale answers.
   */
  clearForBlock(workspaceId: string, blockId: string): Promise<void> {
    return this.deps.docInterviewRepository.deleteByBlock(workspaceId, blockId)
  }

  /**
   * Run one interviewer pass over the document. `finalize` forces convergence (the human
   * proceeded, or the round cap was hit) so the model is asked only to synthesize the brief.
   */
  async runInterview(
    workspaceId: string,
    block: Block,
    session: DocInterviewSession,
    opts: { finalize: boolean; priorOutputs?: DocInterviewPriorOutput[] },
  ): Promise<{ output: DocInterviewOutput; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: DOC_INTERVIEW_SYSTEM_PROMPT,
        prompt: this.buildPrompt(block, session, opts.finalize, opts.priorOutputs ?? []),
        temperature: 0.2,
        maxOutputTokens: 3000,
        providerOptions: catFactoryObservability({
          agentKind: DOC_INTERVIEWER_AGENT_KIND,
          workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The document interviewer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const output = coerceDocInterviewOutput(extractJson(text), { finalize: opts.finalize })
    // A non-final pass that yields neither questions nor a brief means the model returned
    // empty / unparseable output (e.g. a reasoning model that emitted only into its private
    // thinking channel, or prose with no JSON). Fail loudly instead of silently converging with an
    // empty brief and skipping the whole interview — the run surfaces the failure and can retry.
    if (!opts.finalize && output.kind === 'done' && !output.brief.trim()) {
      throw new ValidationError(
        `The document interviewer (${ref.provider}:${ref.model}) returned no questions and no brief`,
      )
    }
    return { output, model: `${ref.provider}:${ref.model}` }
  }

  /**
   * Persist a fresh batch of pending questions (creating the session on first entry). Returns
   * the parked session, `awaiting` the human's answers.
   */
  async recordQuestions(
    workspaceId: string,
    blockId: string,
    questions: string[],
    model: string,
  ): Promise<DocInterviewSession> {
    const now = this.deps.clock.now()
    const existing = await this.deps.docInterviewRepository.getByBlock(workspaceId, blockId)
    const base =
      existing ??
      newDocInterviewSession(
        this.deps.idGenerator.next('dis'),
        blockId,
        now,
        DOC_INTERVIEW_MAX_ROUNDS,
      )
    const next = applyDocInterviewQuestions(
      { ...base, model: base.model ?? model },
      questions,
      () => this.deps.idGenerator.next('diq'),
      now,
    )
    await this.deps.docInterviewRepository.upsert(workspaceId, next)
    return next
  }

  /** Record the human's answer to one pending question. Returns null when there is no session. */
  async recordAnswer(
    workspaceId: string,
    blockId: string,
    questionId: string,
    answer: string,
  ): Promise<DocInterviewSession | null> {
    const existing = await this.deps.docInterviewRepository.getByBlock(workspaceId, blockId)
    if (!existing) return null
    const next = applyDocInterviewAnswer(existing, questionId, answer, this.deps.clock.now())
    await this.deps.docInterviewRepository.upsert(workspaceId, next)
    return next
  }

  /** Fold the synthesized brief onto the session and mark it `done`. */
  async recordOutcome(
    workspaceId: string,
    blockId: string,
    brief: string,
    model: string,
  ): Promise<DocInterviewSession | null> {
    const now = this.deps.clock.now()
    const existing =
      (await this.deps.docInterviewRepository.getByBlock(workspaceId, blockId)) ??
      newDocInterviewSession(
        this.deps.idGenerator.next('dis'),
        blockId,
        now,
        DOC_INTERVIEW_MAX_ROUNDS,
      )
    const next = applyDocInterviewOutcome(
      { ...existing, model: existing.model ?? model },
      brief,
      now,
    )
    await this.deps.docInterviewRepository.upsert(workspaceId, next)
    return next
  }

  /** Assemble the interviewer prompt: the brief + the outline/research + the answered digest. */
  private buildPrompt(
    block: Block,
    session: DocInterviewSession,
    finalize: boolean,
    priorOutputs: DocInterviewPriorOutput[],
  ): string {
    const lines: string[] = [`Document: ${block.title || '(untitled document)'}`]
    const fields = block.taskTypeFields
    if (fields?.docKind) lines.push(`Type: ${fields.docKind}`)
    if (fields?.audience) lines.push(`Audience: ${fields.audience}`)
    const brief = block.description?.trim()
    if (brief) lines.push('', 'Brief:', brief)
    const outline = priorOutputs.find((o) => o.agentKind === 'doc-outliner')?.output?.trim()
    if (outline) lines.push('', 'Proposed outline:', outline)
    const research = priorOutputs.find((o) => o.agentKind === 'doc-researcher')?.output?.trim()
    if (research) lines.push('', 'Research brief:', research)
    const digest = answeredDigest(session)
    if (digest.length) lines.push('', ...digest)
    lines.push(
      '',
      finalize
        ? 'This is the FINAL round: do NOT ask more questions. Synthesize the agreed authoring ' +
            'brief from the material and answers above.'
        : 'Ask your next batch of clarifying questions, or converge if you have enough. ' +
            'Respond with ONLY the JSON decision object.',
    )
    return lines.join('\n')
  }

  private async resolveModel(
    workspaceId: string,
    block: Block,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const scope = await scopeForBlockRun(workspaceId, block, this.deps.resolveRunContext)
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the document interviewer')
    }
    return { modelProvider, ref }
  }

  /** Block pin > workspace per-kind default > routing default (subscription refs degrade). */
  private async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const runsInline = this.deps.runsInline
    const resolve = (ref: ModelRef): ModelRef =>
      inlineModelRef(ref, fallback ?? ref, runsInline ? { runsInline } : {})
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return resolve(fromBlock)
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      DOC_INTERVIEWER_AGENT_KIND,
      block.modelPresetId,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return resolve(fromDefault)
    return fallback
  }
}
