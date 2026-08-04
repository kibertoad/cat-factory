import { generateText } from 'ai'
import type {
  Block,
  Initiative,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  ModelPresetRepository,
} from '@cat-factory/kernel'
import type { InitiativePresetRegistry } from '@cat-factory/kernel'
import {
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import {
  catFactoryObservability,
  codebaseAnalysisLines,
  renderLinkedContext,
} from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'
import type { LinkedContext } from '../execution/linked-context.js'
import { extractJson } from '../requirements/requirements.logic.js'
import {
  coerceInterviewOutput,
  type InterviewOutput,
  seedPresetInterviewQa,
} from './initiative.logic.js'

// ---------------------------------------------------------------------------
// The interactive-planning INTERVIEWER — an inline LLM (no container, no repo) that scopes a
// long-running initiative BEFORE the planner drafts. It reads the initiative brief plus the
// answers gathered so far and either asks a fresh batch of clarifying questions or converges
// with a synthesized goal / constraints / non-goals brief. The engine's
// InitiativeInterviewController drives the park/answer/resume loop around it (mirroring the
// review gate), and InitiativeService persists the questions/answers/brief onto the entity.
//
// Model resolution is the SAME precedence as an agent step / the requirements reviewer: a
// model pinned on the block wins, else the workspace's per-kind default, else the routing
// default (a pinned subscription harness ref degrades to the routing default because this is
// an INLINE call with no container harness). The provider is reached through the
// runtime-neutral ModelProvider port, so this never imports a provider SDK or a key.
// ---------------------------------------------------------------------------

/**
 * Where the interviewer's questions may come from, and what it must not spend them on.
 *
 * This is the load-bearing clause of the whole gate. The interviewer is an INLINE kind with no
 * checkout, so left to itself it reaches for the only source it has — the human — and asks them to
 * describe their own repository. `pl_initiative` runs the analyst FIRST precisely so a second
 * source exists, and the ban below is what redirects the bounded rounds onto the half a repository
 * cannot answer.
 *
 * It is therefore a rule about WHERE AN ANSWER COMES FROM, and it is only true while the code has
 * actually been read. With no analysis in hand — the analyst produced nothing, no repo is
 * reachable, or this gate is driven outside `pl_initiative` — an absolute ban would leave the
 * interviewer forbidden from asking about the code AND holding nothing that read it, which is
 * strictly worse than before the analyst ever led. So the clause degrades with the fold it depends
 * on: same predicate, one decision, no way for the prompt and the context to disagree about
 * whether the repository was read.
 */
function codebaseQuestionRule(hasAnalysis: boolean): string {
  return hasAnalysis
    ? 'NEVER ask the stakeholder about the CURRENT STATE OF THE CODE — what the codebase ' +
        'contains, which frameworks/libraries/patterns it uses, how a module is structured, where ' +
        'something lives, what test coverage exists. The repository has been READ for you and the ' +
        'analysis is above; asking anyway wastes the interview on facts the platform already ' +
        'holds. Ask ONLY about what no amount of code reading could recover: '
    : 'No codebase analysis is available for this initiative, so the repository has NOT been read ' +
        'for you. Still spend your questions first on what no amount of code reading could ' +
        'recover, and ask about the current state of the code only where the plan genuinely turns ' +
        'on it and the brief leaves it open. What only a human can settle: '
}

/**
 * Whether this initiative carries a usable codebase analysis. The SINGLE predicate behind both the
 * fold ({@link InitiativeInterviewService.analysisLines}) and the two system prompts, so a prompt
 * can never promise an analysis the prompt body does not carry, or ban codebase questions on the
 * strength of a reading that never happened. Deliberately shares
 * `codebaseAnalysisLines`' whitespace-only-is-absent rule by construction rather than by
 * restating it.
 */
function hasCodebaseAnalysis(initiative: Initiative): boolean {
  return codebaseAnalysisLines(initiative.analysisSummary).length > 0
}

/** The facts a human is genuinely the authority on — the interview's proper subject, always. */
const HUMAN_ONLY_FACTS =
  'intent and desired outcome, priorities and sequencing preferences, risk and downtime ' +
  'tolerance, deadlines and external commitments, scope boundaries, and choices between options ' +
  'the code permits equally. '

/**
 * Role prompt the interviewer runs under. Returns ONLY a JSON decision object. Composed rather than
 * constant so {@link codebaseQuestionRule} can key off whether an analysis was actually folded in.
 */
function initiativeInterviewSystemPrompt(hasAnalysis: boolean): string {
  return (
    'You are a staff engineer INTERVIEWING a stakeholder to scope a long-running initiative (a ' +
    'cross-cutting refactor, a migration, a strangler conversion) BEFORE it is planned. You are ' +
    'given the initiative brief, ' +
    (hasAnalysis ? 'a codebase analysis of the target repository, ' : '') +
    'and the answers gathered so far. Decide whether you understand ' +
    'the goal, scope boundaries, constraints and success criteria well enough to plan. If NOT, ' +
    'ask a small batch of focused, high-leverage clarifying questions — each answerable in a ' +
    'sentence or two, no yes/no trivia, no questions the brief already answers. ' +
    codebaseQuestionRule(hasAnalysis) +
    HUMAN_ONLY_FACTS +
    'If you have ' +
    'enough (or you are told this is the final round), STOP asking and synthesize the agreed ' +
    'goal, the constraints to honour, and the explicit non-goals. Respond with ONLY a JSON ' +
    'object of shape {"done": boolean, "questions": string[], "goal": string, "constraints": ' +
    'string[], "nonGoals": string[]}. When done is false, `questions` is non-empty; when done ' +
    'is true, `questions` is empty and you MUST fill `goal` (and `constraints`/`nonGoals` where ' +
    'they apply). No prose, no code fences.'
  )
}

/**
 * Role prompt for the per-question answer RECOMMENDER — the interviewer's "recommend something"
 * action. Given the brief + answers so far + one specific question, it drafts a concrete answer
 * the stakeholder can adopt or edit (the planning analogue of the requirements Writer). Returns
 * ONLY the suggested answer prose — no preamble, no JSON.
 *
 * Keyed on the same predicate as the interview prompt: promising an analysis this call was not
 * given invites a recommendation invented to fill the gap, which a stakeholder then adopts as if
 * the platform had read the code.
 */
function initiativeRecommendSystemPrompt(hasAnalysis: boolean): string {
  return (
    'You are a staff engineer helping scope a long-running initiative. You are given the ' +
    'initiative brief, ' +
    (hasAnalysis ? 'a codebase analysis of the target repository, ' : '') +
    'the answers gathered so far, and ONE clarifying question the stakeholder ' +
    'wants a suggested answer for. Propose the most sensible answer you can, grounded in the ' +
    (hasAnalysis ? 'brief, the codebase analysis and prior answers' : 'brief and prior answers') +
    ', stated as a concrete recommendation the stakeholder ' +
    'can accept or edit. Be ' +
    'specific and concise (a sentence or two). Reply with ONLY the suggested answer — no preamble, ' +
    'no restating the question, no JSON, no code fences.'
  )
}

/**
 * Whether this initiative's preset FORM actually seeded any `qa` at create (T3). Re-derived from
 * the SAME seeder the create flow ran (`seedPresetInterviewQa` over the frozen `presetInputs`), so
 * the gate can never disagree with what was seeded: `preset_generic` (empty form), a preset-less
 * initiative, and a preset whose visible fields were all left blank/false (present in
 * `presetInputs` but rendering to nothing, e.g. a cleared optional field) all read `false` — their
 * interviewer prompt stays byte-for-byte unchanged. Checking `presetInputs` cardinality alone
 * would wrongly fire the steering below for that all-blank case once later rounds add real answers.
 */
function formSeeded(initiative: Initiative, registry: InitiativePresetRegistry): boolean {
  if (!initiative.presetId || !initiative.presetInputs) return false
  const preset = registry.get(initiative.presetId)
  if (!preset) return false
  // Only the COUNT matters here, so the id generator is irrelevant.
  return seedPresetInterviewQa(preset.descriptor, initiative.presetInputs, () => '').length > 0
}

/**
 * The registered preset's INTERVIEWER steering (its `promptAdditions[INITIATIVE_INTERVIEWER_AGENT_KIND]`),
 * plus the preset label to head it. Generic and preset-less initiatives register none, so this
 * returns undefined and the interviewer prompt stays byte-for-byte unchanged. This is the interviewer
 * half of the same generic seam the analyst/planner already consume via `AgentContextBuilder` →
 * `initiativeContextLines` — needed here because the interviewer is an INLINE service that builds its
 * own prompt (it never passes through the context builder), and the technological-migration preset is
 * the first FULL-interview preset to steer its interviewer. Never branches on a preset id.
 */
function presetInterviewerSteering(
  initiative: Initiative,
  registry: InitiativePresetRegistry,
): { label: string; promptAddition: string } | undefined {
  if (!initiative.presetId) return undefined
  const preset = registry.get(initiative.presetId)
  const promptAddition = preset?.promptAdditions?.[INITIATIVE_INTERVIEWER_AGENT_KIND]?.trim()
  if (!preset || !promptAddition) return undefined
  return { label: preset.descriptor.presentation.label, promptAddition }
}

/** What the interviewer needs to resolve its inline model + reach the provider. */
export interface InitiativeInterviewDeps {
  /** The app-owned initiative-preset registry (resolve a preset's interviewer steering by id). */
  initiativePresetRegistry: InitiativePresetRegistry
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Routing-default model ref when the block pins none. */
  modelRef?: ModelRef
  /** Resolve a block's selected model id to a ref, under the preset's route order. */
  resolveBlockModel?: InlineBlockModelDeps['resolveBlockModel']
  /** Keep an ambient-eligible harness ref inline (local mode) instead of degrading it. */
  runsInline?: (ref: ModelRef) => boolean
  /** Resolve the workspace's per-agent-kind default model id (block pins none). */
  resolveWorkspaceModelDefault?: InlineBlockModelDeps['resolveWorkspaceModelDefault']
  /**
   * The workspace's model-preset library, read for the ROUTE order the block's preset states.
   * Absent ⇒ the deployment's default order.
   */
  modelPresets?: ModelPresetRepository
  /** Resolve the block's run/execution + initiator, folded into the inline model scope. */
  resolveRunContext?: ResolveBlockRunContext
  /**
   * Resolve the initiative block's linked context (attached requirements / RFCs / PRDs / tracker
   * issues, plus anything the brief names outright). Needed explicitly because this service is
   * INLINE and assembles its own prompt — it never passes through `AgentContextBuilder`, which is
   * what puts the same attachments in front of the analyst and planner that follow.
   *
   * Absent (or unwired document/task sources) ⇒ the prompts are byte-for-byte their previous
   * shape, so a deployment without the documents/tasks integrations is unaffected.
   */
  resolveLinkedContext?: (
    workspaceId: string,
    blockId: string,
    description: string,
  ) => Promise<LinkedContext>
}

export class InitiativeInterviewService {
  constructor(private readonly deps: InitiativeInterviewDeps) {}

  /** Whether the inline interviewer is available (a provider AND a routing default are wired). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /**
   * Run one interviewer pass over the initiative. `finalize` forces convergence (the human
   * proceeded, or the round cap was hit) so the model is asked only to synthesize the brief.
   */
  async runInterview(
    workspaceId: string,
    block: Block,
    initiative: Initiative,
    opts: { finalize: boolean },
  ): Promise<InterviewOutput> {
    const [{ modelProvider, ref }, linked] = await Promise.all([
      this.resolveModel(workspaceId, block),
      this.linkedSection(workspaceId, block),
    ])
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: initiativeInterviewSystemPrompt(hasCodebaseAnalysis(initiative)),
        prompt: this.buildPrompt(block, initiative, opts.finalize, linked),
        temperature: 0.2,
        maxOutputTokens: 3000,
        providerOptions: catFactoryObservability({
          agentKind: INITIATIVE_INTERVIEWER_AGENT_KIND,
          workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The initiative interviewer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    return coerceInterviewOutput(extractJson(text), { finalize: opts.finalize })
  }

  /**
   * Draft a suggested answer for ONE pending question (the "recommend something" action). Returns
   * the suggestion text; the controller persists it onto the question. A single short inline call —
   * deliberately simpler than the requirements Writer's batched/async fill, since the initiative
   * interviewer is already inline and there is only ever one question in play.
   */
  async recommendAnswer(
    workspaceId: string,
    block: Block,
    initiative: Initiative,
    question: string,
  ): Promise<string> {
    const [{ modelProvider, ref }, linked] = await Promise.all([
      this.resolveModel(workspaceId, block),
      this.linkedSection(workspaceId, block),
    ])
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: initiativeRecommendSystemPrompt(hasCodebaseAnalysis(initiative)),
        prompt: this.buildRecommendPrompt(block, initiative, question, linked),
        temperature: 0.3,
        maxOutputTokens: 800,
        providerOptions: catFactoryObservability({
          agentKind: INITIATIVE_INTERVIEWER_AGENT_KIND,
          workspaceId,
        }),
      })
      return result.text.trim()
    } catch (e) {
      throw new ValidationError(
        `The initiative interviewer (${ref.provider}:${ref.model}) could not recommend an answer: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
  }

  /**
   * The initiative's attached requirements / RFCs / issues, rendered for the prompt, or '' when
   * nothing is attached (or no resolver is wired). INLINE rendering — the interviewer has no
   * checkout to materialise files into, so the bodies are injected, clamped by the shared
   * `CONTEXT_BUDGET` the container path also honours.
   *
   * A read failure PROPAGATES rather than degrading to '', matching how the analyst and planner
   * resolve the same attachments through `AgentContextBuilder`: interviewing a stakeholder about
   * a document the platform silently failed to open is worse than failing the round outright.
   */
  private async linkedSection(workspaceId: string, block: Block): Promise<string> {
    if (!this.deps.resolveLinkedContext) return ''
    const { docs, tasks } = await this.deps.resolveLinkedContext(
      workspaceId,
      block.id,
      block.description ?? '',
    )
    return renderLinkedContext(docs, tasks)
  }

  /**
   * The analyst's codebase analysis as prompt lines, or [] when there is none. On `pl_initiative`
   * the analyst runs BEFORE this gate and its prose is folded onto the entity by the engine's
   * analyst post-completion resolver, so by the time an interview pass runs the summary is this
   * run's own reading of the repository.
   *
   * Empty when the analyst produced nothing, when no repo is reachable, or when the interviewer is
   * driven outside `pl_initiative` — the prompt then degrades to its previous, un-grounded shape
   * rather than claiming an analysis it does not have. {@link hasCodebaseAnalysis} is the SAME
   * predicate the system prompt keys off, so the two halves can never disagree about whether the
   * repository was read.
   *
   * The section itself is rendered by `@cat-factory/agents` — the analyst's and planner's prompts
   * present it too, and one owner of the heading keeps a model from meeting it in two shapes. Only
   * the steering below it is this gate's own.
   */
  private analysisLines(initiative: Initiative): string[] {
    const section = codebaseAnalysisLines(initiative.analysisSummary)
    if (!section.length) return []
    return [
      ...section,
      '',
      'The analysis above was produced by an agent that READ THE TARGET REPOSITORY for this ' +
        'initiative. Treat everything it establishes as already known — do NOT ask the ' +
        'stakeholder to describe, confirm or restate any of it. Where it lists open questions, ' +
        'those are the facts the code could not settle: start there.',
    ]
  }

  /** Assemble the interviewer prompt: the brief + the analysis + the answered digest + the intent. */
  private buildPrompt(
    block: Block,
    initiative: Initiative,
    finalize: boolean,
    linked: string,
  ): string {
    const lines: string[] = [`Initiative: ${block.title || '(untitled initiative)'}`]
    const brief = block.description?.trim()
    if (brief) lines.push('', 'Brief:', brief)
    // Preset steering FIRST (after the brief): a full-interview preset's interviewer promptAddition
    // frames what this interview must probe (e.g. the migration's fuzzy, form-uncapturable facts).
    // Rendered under the same `## Initiative preset: <label>` heading the analyst/planner fold uses.
    // Generic / preset-less initiatives register none, so the prompt is unchanged for them.
    const steering = presetInterviewerSteering(initiative, this.deps.initiativePresetRegistry)
    if (steering) {
      lines.push('', `## Initiative preset: ${steering.label}`, '', steering.promptAddition)
    }
    // The stakeholder's own attached source material, before the answers gathered so far: it is
    // part of the BRIEF, so the interviewer must read it before deciding what is still unclear.
    // The instruction is what makes attaching a PRD worth doing — without it the model treats the
    // document as background and still asks the questions the document already answers, which is
    // precisely the interrogation the attachment was meant to spare the stakeholder.
    if (linked) {
      lines.push(linked)
      lines.push(
        '',
        'The linked context above was attached to this initiative by the stakeholder. Read it ' +
          'as part of the brief and treat everything it settles as ALREADY ANSWERED: do NOT ask ' +
          'about anything it states. Ask only about what it leaves genuinely open or ambiguous.',
      )
    }
    // The analyst's first-hand reading of the repository, after the stakeholder's own material and
    // before the answers gathered so far: it is the other half of the BRIEF, and the half that
    // decides which questions are worth a human's time at all.
    lines.push(...this.analysisLines(initiative))
    const answered = (initiative.qa ?? []).filter((q) => (q.answer ?? '').trim().length > 0)
    if (answered.length) {
      lines.push('', 'Answers gathered so far:')
      for (const { question, answer } of answered) lines.push(`- Q: ${question}`, `  A: ${answer}`)
    }
    // Questions the stakeholder explicitly marked not-relevant. Surface them so the interviewer
    // treats them as settled (out of scope) and does NOT re-ask — mirroring how a dismissed
    // requirements finding stays dismissed across a re-review.
    const dismissed = (initiative.qa ?? []).filter((q) => q.status === 'dismissed')
    if (dismissed.length) {
      lines.push('', 'The stakeholder marked these questions NOT RELEVANT — do not ask them again:')
      for (const { question } of dismissed) lines.push(`- ${question}`)
    }
    // A FORM-backed preset (T3) pre-answers the enumerable facts at create; those answers are the
    // seeded qa above. Tell the interviewer they are SETTLED so it builds on them and digs into the
    // fuzzy, judgment-dependent aspects the form could not capture, instead of re-asking the form.
    // `formSeeded` re-derives this from the actual seeder, so `preset_generic` (empty form), a
    // preset-less initiative, and a preset whose visible fields were all left blank never trigger
    // it — their interviews stay byte-for-byte unchanged.
    if (answered.length && formSeeded(initiative, this.deps.initiativePresetRegistry)) {
      lines.push(
        '',
        'The answers above include the intake-form responses the stakeholder already provided at ' +
          'create time. Treat every one of them as SETTLED: do NOT re-ask what the form already ' +
          'covers. Build on them and probe only the fuzzy, judgment-dependent aspects the form ' +
          'could not capture.',
      )
    }
    if (initiative.goal?.trim()) lines.push('', `Current goal statement: ${initiative.goal.trim()}`)
    lines.push(
      '',
      finalize
        ? 'This is the FINAL round: do NOT ask more questions. Synthesize the agreed goal, ' +
            'constraints and non-goals from the brief and the answers above.'
        : 'Ask your next batch of clarifying questions, or converge if you have enough. ' +
            'Respond with ONLY the JSON decision object.',
    )
    return lines.join('\n')
  }

  /** Assemble the recommend prompt: the brief + answered digest + the ONE question to answer. */
  private buildRecommendPrompt(
    block: Block,
    initiative: Initiative,
    question: string,
    linked: string,
  ): string {
    const lines: string[] = [`Initiative: ${block.title || '(untitled initiative)'}`]
    const brief = block.description?.trim()
    if (brief) lines.push('', 'Brief:', brief)
    // The attached material is the best source a suggested answer can be grounded in — this is
    // the action a stakeholder reaches for precisely when they would rather the platform read
    // the document than answer from it themselves.
    if (linked) lines.push(linked)
    // The codebase analysis is the single best source a suggested answer can be grounded in — a
    // stakeholder reaches for "recommend something" precisely when they would rather the platform
    // work the answer out than supply it themselves.
    lines.push(...this.analysisLines(initiative))
    if (initiative.goal?.trim()) lines.push('', `Goal so far: ${initiative.goal.trim()}`)
    const answered = (initiative.qa ?? []).filter((q) => (q.answer ?? '').trim().length > 0)
    if (answered.length) {
      lines.push('', 'Answers gathered so far:')
      for (const { question: q, answer } of answered) lines.push(`- Q: ${q}`, `  A: ${answer}`)
    }
    lines.push('', `Suggest an answer to this question:`, question)
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
      throw new ValidationError('No model is configured for the initiative interviewer')
    }
    return { modelProvider, ref }
  }

  /** Block pin > workspace per-kind default > routing default (subscription refs degrade). */
  private modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    return resolveInlineBlockModelRef(
      this.deps,
      workspaceId,
      INITIATIVE_INTERVIEWER_AGENT_KIND,
      block,
    )
  }
}
