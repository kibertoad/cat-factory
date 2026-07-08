import { generateText } from 'ai'
import type {
  Block,
  Initiative,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import type { InitiativePresetRegistry } from '@cat-factory/kernel'
import {
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  inlineModelRef,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
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

/** Role prompt the interviewer runs under. Returns ONLY a JSON decision object. */
const INITIATIVE_INTERVIEW_SYSTEM_PROMPT =
  'You are a staff engineer INTERVIEWING a stakeholder to scope a long-running initiative (a ' +
  'cross-cutting refactor, a migration, a strangler conversion) BEFORE it is planned. You are ' +
  'given the initiative brief and the answers gathered so far. Decide whether you understand ' +
  'the goal, scope boundaries, constraints and success criteria well enough to plan. If NOT, ' +
  'ask a small batch of focused, high-leverage clarifying questions — each answerable in a ' +
  'sentence or two, no yes/no trivia, no questions the brief already answers. If you have ' +
  'enough (or you are told this is the final round), STOP asking and synthesize the agreed ' +
  'goal, the constraints to honour, and the explicit non-goals. Respond with ONLY a JSON ' +
  'object of shape {"done": boolean, "questions": string[], "goal": string, "constraints": ' +
  'string[], "nonGoals": string[]}. When done is false, `questions` is non-empty; when done ' +
  'is true, `questions` is empty and you MUST fill `goal` (and `constraints`/`nonGoals` where ' +
  'they apply). No prose, no code fences.'

/**
 * Role prompt for the per-question answer RECOMMENDER — the interviewer's "recommend something"
 * action. Given the brief + answers so far + one specific question, it drafts a concrete answer
 * the stakeholder can adopt or edit (the planning analogue of the requirements Writer). Returns
 * ONLY the suggested answer prose — no preamble, no JSON.
 */
const INITIATIVE_RECOMMEND_SYSTEM_PROMPT =
  'You are a staff engineer helping scope a long-running initiative. You are given the ' +
  'initiative brief, the answers gathered so far, and ONE clarifying question the stakeholder ' +
  'wants a suggested answer for. Propose the most sensible answer you can, grounded in the brief ' +
  'and prior answers, stated as a concrete recommendation the stakeholder can accept or edit. Be ' +
  'specific and concise (a sentence or two). Reply with ONLY the suggested answer — no preamble, ' +
  'no restating the question, no JSON, no code fences.'

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
    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: INITIATIVE_INTERVIEW_SYSTEM_PROMPT,
        prompt: this.buildPrompt(block, initiative, opts.finalize),
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
    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: INITIATIVE_RECOMMEND_SYSTEM_PROMPT,
        prompt: this.buildRecommendPrompt(block, initiative, question),
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

  /** Assemble the interviewer prompt: the brief + the answered digest + the round intent. */
  private buildPrompt(block: Block, initiative: Initiative, finalize: boolean): string {
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
  private buildRecommendPrompt(block: Block, initiative: Initiative, question: string): string {
    const lines: string[] = [`Initiative: ${block.title || '(untitled initiative)'}`]
    const brief = block.description?.trim()
    if (brief) lines.push('', 'Brief:', brief)
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
  private async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const runsInline = this.deps.runsInline
    const resolve = (ref: ModelRef): ModelRef =>
      inlineModelRef(ref, fallback ?? ref, runsInline ? { runsInline } : {})
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return resolve(fromBlock)
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      INITIATIVE_INTERVIEWER_AGENT_KIND,
      block.modelPresetId,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return resolve(fromDefault)
    return fallback
  }
}
