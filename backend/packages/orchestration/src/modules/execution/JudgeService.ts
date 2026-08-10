import { generateText } from 'ai'
import type {
  JudgeAssessor,
  JudgeModelPin,
  JudgeSubject,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import {
  extractJson,
  getErrorMessage,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import {
  catFactoryObservability,
  JUDGE_SYSTEM_PROMPT,
  renderJudgePrompt,
} from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
import { type InlineBlockModelDeps, resolveInlineBlockModel } from '../../inlineBlockModel.js'

// ---------------------------------------------------------------------------
// The default {@link JudgeAssessor}: the INLINE LLM call behind every judge step.
//
// Structurally the `ForkChatService` twin (resolve the model, run `generateText`, return the
// reply) with two differences. A judge's deliverable is a JSON object the engine PARSES, so
// this returns the raw extracted value and lets the judge's registered parser own the shape;
// and the resolution keys on the JUDGE'S OWN kind and admits one more layer, the model the
// registration pinned for its rubric (see `resolveModel`).
//
// It is deliberately STATELESS: all judge state rides the run's step (`step.judge`), so there
// is no side table and the runtimes cannot drift. It is built in `createCore` from the
// model-provider dependencies every facade already wires, which is why adding judges required
// no per-facade wiring at all — and why a conformance harness can swap in a deterministic fake
// through the same `judgeAssessor` seam.
//
// `enabled === false` (no provider or no routing default) ⇒ the engine's judge steps are
// pass-throughs, so pipelines and the conformance/e2e suites run exactly as before.
// ---------------------------------------------------------------------------

/** What the inline assessor needs to resolve its model and reach the provider. */
export interface JudgeServiceDeps {
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
  /**
   * The workspace's per-kind default MODEL and the ROUTE order the preset in force states, from
   * ONE read. Absent ⇒ block pin plus the routing default, on the deployment's default order.
   */
  resolvePresetRouting?: InlineBlockModelDeps['resolvePresetRouting']
  /** Resolve the block's run/execution + initiator, folded into the inline model scope. */
  resolveRunContext?: ResolveBlockRunContext
}

export class JudgeService implements JudgeAssessor {
  constructor(private readonly deps: JudgeServiceDeps) {}

  /** Whether an assessment can run (a provider AND a routing default are wired). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /**
   * Run ONE assessment against the rubric in force. Returns the raw extracted JSON value (the
   * judge's registered parser owns the shape) plus the model that produced it.
   *
   * Throws {@link ValidationError} on an unresolved model, a failed generation, or a reply
   * with no JSON object in it. The engine catches that and records a FAILING verdict rather
   * than crashing the run — an assessment that could not be read must never be mistaken for a
   * clean one.
   */
  async assess(
    subject: JudgeSubject,
  ): Promise<{ verdict: unknown; model: string; modelPin?: JudgeModelPin }> {
    const { modelProvider, ref, pin } = await this.resolveModel(subject)
    const pinned = pin ? { modelPin: pin } : {}
    let text: string
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: JUDGE_SYSTEM_PROMPT,
        prompt: renderJudgePrompt(subject),
        // Judgement should be reproducible for the same evidence: a rubric verdict that moves
        // between identical runs is not a policy, it's noise.
        temperature: 0,
        maxOutputTokens: 2000,
        providerOptions: catFactoryObservability({
          // The JUDGE'S OWN kind, not a shared `judge` label: each rubric now resolves (and can
          // pin) its own model, so a rollup that lumped them together would attribute one
          // rubric's spend to another.
          agentKind: subject.step.agentKind,
          workspaceId: subject.workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The judge assessment (${ref.provider}:${ref.model}) failed: ${getErrorMessage(e)}`,
      )
    }
    const verdict = extractJson(text)
    if (verdict === null || typeof verdict !== 'object') {
      // An empty visible reply means the model answered only into its private reasoning
      // channel (seen on some reasoning models); a non-JSON reply means it ignored the
      // contract. Either way there is nothing to score.
      throw new ValidationError(
        `The judge assessment (${ref.provider}:${ref.model}) returned no JSON verdict`,
      )
    }
    return { verdict, model: `${ref.provider}:${ref.model}`, ...pinned }
  }

  /**
   * The model this judgement runs on, resolved under the JUDGE'S OWN kind so each registered
   * rubric is its own row in the workspace's model defaults (which is what the model-defaults
   * panel has always offered for them) rather than every judge sharing one `judge` key.
   *
   * Task pin > a preset override naming this judge's kind > the registration's own
   * {@link JudgeSubject.modelId} > the preset's base model > the routing default. The returned
   * `pin` says which of those won, so a declared model this deployment cannot serve is recorded
   * rather than silently swapped.
   */
  private async resolveModel(
    subject: JudgeSubject,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef; pin?: JudgeModelPin }> {
    const { workspaceId, block } = subject
    const scope = await scopeForBlockRun(workspaceId, block, this.deps.resolveRunContext)
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const { ref, pin } = await resolveInlineBlockModel(
      this.deps,
      workspaceId,
      subject.step.agentKind,
      block,
      subject.modelId,
    )
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the judge assessment')
    }
    return { modelProvider, ref, ...(pin ? { pin } : {}) }
  }
}
