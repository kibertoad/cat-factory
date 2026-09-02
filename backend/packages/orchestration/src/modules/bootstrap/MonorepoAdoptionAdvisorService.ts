import { generateText, stepCountIs } from 'ai'
import type {
  Logger,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  MonorepoAdoptionAdvisor,
  MonorepoAdoptionSubject,
} from '@cat-factory/kernel'
import {
  extractJson,
  getErrorMessage,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import {
  catFactoryObservability,
  MONOREPO_ADOPTION_AGENT_KIND,
  monorepoAdoptionSystemPrompt,
  monorepoExplorationTools,
  renderMonorepoAdoptionPrompt,
} from '@cat-factory/agents'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'

// ---------------------------------------------------------------------------
// The default {@link MonorepoAdoptionAdvisor}: the INLINE LLM call behind a monorepo
// bootstrap's adoption suggestion, run as a bounded TOOL LOOP over the survey's explorer.
//
// Structurally the `BugHuntAssessorService` twin (resolve the model, generate, hand back the
// extracted JSON for the caller's parser), with one difference that is the whole point: the
// evidence set is not rendered in advance. The platform seeds the opening context and owns every
// budget, and the model chooses what else to read, so a recommendation cites what was actually
// fetched rather than what the platform predicted it would need.
//
// A survey has NO BLOCK, like a hunt: it runs before the service exists, so nothing pins a
// model and the workspace's default preset supplies both the model and the route order.
//
// `enabled === false` (no provider or no routing default) ⇒ the run still parks for review,
// with a plan recorded `unavailable`/`model_unavailable`. A deployment with no model configured
// does not lose the human decision, only the suggestion.
// ---------------------------------------------------------------------------

export interface MonorepoAdoptionAdvisorServiceDeps {
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Routing-default model ref. */
  modelRef?: ModelRef
  /** Resolve a model catalog id to a ref, under the preset's route order. */
  resolveBlockModel?: InlineBlockModelDeps['resolveBlockModel']
  /** Keep an ambient-eligible harness ref inline (local mode) instead of degrading it. */
  runsInline?: (ref: ModelRef) => boolean
  /** The workspace's per-kind default MODEL and the preset's ROUTE order, from ONE read. */
  resolvePresetRouting?: InlineBlockModelDeps['resolvePresetRouting']
  /** Facade logger; a survey that could not run and left no trace is an unowned bug. */
  logger?: Logger
}

/**
 * The suggestion must be reproducible for the same two repositories: a plan whose
 * recommendations flip between two identical surveys is not advice, and a human who re-opens a
 * parked run to a different set of decisions has no reason to trust either. Same value and same
 * reasoning as the judge and bug-hunt assessments.
 */
const TEMPERATURE = 0

/**
 * Output budget. A decision runs ~150 tokens and the prompt caps the list at 15, so this leaves
 * real headroom: a truncated reply is unparseable JSON, which costs the whole plan rather than
 * its tail, and the run then parks with nothing for the reviewer to act on.
 */
const MAX_OUTPUT_TOKENS = 8_000

/**
 * How many model round trips the loop may take, above the explorer's own call budget.
 *
 * A structural backstop rather than the real bound: the explorer refuses reads past its call
 * ceiling and TELLS the model so, which is what makes an exhausted survey produce a plan that
 * names the areas it ran short on. This only stops a model that keeps calling tools after being
 * told to stop. Sized for the worst case of one tool call per turn, plus the turns that read the
 * refusals and answer.
 */
const MAX_LOOP_STEPS = 30

/**
 * The last step is answer-only.
 *
 * Without it a loop stopped by {@link MAX_LOOP_STEPS} ends ON a tool call, so `result.text` is
 * empty and the whole survey reports `analysis_unusable` after paying for thirty round trips.
 * Withdrawing the tools for the final step instead forces the model to spend it on the reply it
 * was asked for.
 */
const FINAL_STEP = MAX_LOOP_STEPS - 1

export class MonorepoAdoptionAdvisorService implements MonorepoAdoptionAdvisor {
  constructor(private readonly deps: MonorepoAdoptionAdvisorServiceDeps) {}

  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  async advise(subject: MonorepoAdoptionSubject): Promise<{ plan: unknown; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(subject.workspaceId)
    let text: string
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        // The SAME sides the tool set is built from, so the prompt cannot promise a repository
        // the model has no tool for.
        system: monorepoAdoptionSystemPrompt(subject.explorer.sides),
        prompt: renderMonorepoAdoptionPrompt({
          directory: subject.directory,
          instructions: subject.instructions,
          survey: subject.survey,
          files: subject.files,
        }),
        tools: monorepoExplorationTools(subject.explorer),
        stopWhen: stepCountIs(MAX_LOOP_STEPS),
        prepareStep: ({ stepNumber }) =>
          stepNumber >= FINAL_STEP ? { toolChoice: 'none' as const } : {},
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // ONE tag for the whole loop, so every step's call is filed under this kind and the
        // per-call metrics roll up as one survey rather than as N of them.
        providerOptions: catFactoryObservability({
          agentKind: MONOREPO_ADOPTION_AGENT_KIND,
          workspaceId: subject.workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw this.fail(subject, ref, `generation failed: ${getErrorMessage(e)}`)
    }
    const plan = extractJson(text)
    if (plan === null || typeof plan !== 'object') {
      // An empty visible reply means the model answered only into its private reasoning channel;
      // a non-JSON reply means it ignored the contract. Either way there is no suggestion, and
      // the run must park saying so rather than park with an empty plan, which a reviewer would
      // read as "the two repositories had nothing to decide between".
      throw this.fail(subject, ref, 'the reply contained no JSON adoption plan')
    }
    return { plan, model: `${ref.provider}:${ref.model}` }
  }

  /**
   * Build the error AND log it. The caller deliberately turns a failure here into a parked run
   * with an `unavailable` plan, so this is the only place the cause is recorded. Without it a
   * revoked key would reach an operator as nothing but a run that never suggests anything.
   */
  private fail(subject: MonorepoAdoptionSubject, ref: ModelRef, reason: string): ValidationError {
    const message = `The monorepo adoption survey (${ref.provider}:${ref.model}) ${reason}`
    this.deps.logger?.warn(message, {
      workspaceId: subject.workspaceId,
      directory: subject.directory,
      seededFiles: Object.keys(subject.files).length,
    })
    return new ValidationError(message)
  }

  private async resolveModel(
    workspaceId: string,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const modelProvider = await resolveScopedModelProvider({ workspaceId }, this.deps)
    const ref = await resolveInlineBlockModelRef(
      this.deps,
      workspaceId,
      MONOREPO_ADOPTION_AGENT_KIND,
      // An EMPTY selection: a survey precedes the service, so nothing pins a model or picks a
      // preset and the workspace DEFAULT preset supplies both the model and the route order.
      {},
    )
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the monorepo adoption survey')
    }
    return { modelProvider, ref }
  }
}
