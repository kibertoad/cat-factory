import { generateText } from 'ai'
import type {
  Block,
  Initiative,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import {
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  inlineModelRef,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/agents'
import { extractJson } from '../requirements/requirements.logic.js'
import { coerceInterviewOutput, type InterviewOutput } from './initiative.logic.js'

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
export const INITIATIVE_INTERVIEW_SYSTEM_PROMPT =
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

/** What the interviewer needs to resolve its inline model + reach the provider. */
export interface InitiativeInterviewDeps {
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

  /** Assemble the interviewer prompt: the brief + the answered digest + the round intent. */
  private buildPrompt(block: Block, initiative: Initiative, finalize: boolean): string {
    const lines: string[] = [`Initiative: ${block.title || '(untitled initiative)'}`]
    const brief = block.description?.trim()
    if (brief) lines.push('', 'Brief:', brief)
    const answered = (initiative.qa ?? []).filter((q) => (q.answer ?? '').trim().length > 0)
    if (answered.length) {
      lines.push('', 'Answers gathered so far:')
      for (const { question, answer } of answered) lines.push(`- Q: ${question}`, `  A: ${answer}`)
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

  private async resolveModel(
    workspaceId: string,
    block: Block,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const modelProvider = await resolveScopedModelProvider(workspaceId, this.deps)
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
