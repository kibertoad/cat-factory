import { generateText } from 'ai'
import type {
  EnvironmentInvestigationSubject,
  EnvironmentInvestigator,
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
import { ENVIRONMENT_INVESTIGATOR_AGENT_KIND } from '@cat-factory/contracts'
import {
  catFactoryObservability,
  composeBespokePrompt,
  ENVIRONMENT_INVESTIGATION_PROMPT,
  renderEnvironmentInvestigationPrompt,
} from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
import { type InlineBlockModelDeps, resolveInlineBlockModel } from '../../inlineBlockModel.js'

// ---------------------------------------------------------------------------
// The default {@link EnvironmentInvestigator}: the INLINE LLM call that reads a failed
// environment's evidence and says where the fault is.
//
// Structurally the `JudgeService` twin (resolve the model, run `generateText`, hand the raw JSON
// back for the caller to coerce) with two differences. It honours a per-workspace prompt OVERRIDE,
// because its prompt is a `BespokeSystemPrompt` in `INLINE_ENGINE_SYSTEM_PROMPTS` and a workspace
// that edits it in the prompt editor must get the edit at run time rather than a silently ignored
// draft. And it is deliberately NOT a container agent: the evidence is platform-side and the
// provider credentials that produced it must never ride a job body, which is the same reason the
// release-health connections stay out of containers.
//
// Stateless: every round's state rides the run's step (`step.environmentInvestigation`), so the
// runtimes cannot drift and a durable replay re-reads it from the instance.
// ---------------------------------------------------------------------------

/** What the inline investigator needs to resolve its model and reach the provider. */
export interface EnvironmentInvestigationServiceDeps extends InlineBlockModelDeps {
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Resolve the block's run/execution + initiator, folded into the inline model scope. */
  resolveRunContext?: ResolveBlockRunContext
  /** The workspace's prompt override for this kind, when the prompt store is wired. */
  resolveSystemPromptOverride?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
}

/**
 * Output budget for one verdict. Generous next to a judge's 2000 because the deliverable is a
 * paragraph plus a cited evidence list over a bundle that can carry a provider's whole fact set,
 * and a verdict truncated mid-JSON is read as no verdict at all, which spends the round and
 * reports nothing.
 */
const MAX_OUTPUT_TOKENS = 4000

export class EnvironmentInvestigationService implements EnvironmentInvestigator {
  constructor(private readonly deps: EnvironmentInvestigationServiceDeps) {}

  /** Whether an investigation can run (a provider AND a routing default are wired). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /**
   * Investigate one failed environment. Returns the raw extracted JSON value (the caller coerces
   * it) plus the model that produced it.
   *
   * Throws {@link ValidationError} on an unresolved model, a failed generation, or a reply with no
   * JSON object in it. The controller records the round as FAILED and falls through to the
   * ordinary terminal failure: an investigation that could not be read must never be presented as
   * a clean bill of health, and must never fail a run on its own either.
   */
  async investigate(
    subject: EnvironmentInvestigationSubject,
  ): Promise<{ verdict: unknown; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(subject)
    const override = await this.deps.resolveSystemPromptOverride?.(
      subject.workspaceId,
      ENVIRONMENT_INVESTIGATOR_AGENT_KIND,
    )
    let text: string
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: composeBespokePrompt(ENVIRONMENT_INVESTIGATION_PROMPT, override),
        prompt: renderEnvironmentInvestigationPrompt(subject),
        // A diagnosis over fixed evidence should not move between identical rounds: two runs
        // handed the same failure must reach the same conclusion, or the "cause" it names is
        // noise a human cannot act on.
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        providerOptions: catFactoryObservability({
          agentKind: ENVIRONMENT_INVESTIGATOR_AGENT_KIND,
          workspaceId: subject.workspaceId,
          // The run is on the tag, not left to the credential scope's fallback: a round filed
          // without it is absent from every run-scoped read of the telemetry.
          executionId: subject.executionId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The environment investigation (${ref.provider}:${ref.model}) failed: ${getErrorMessage(e)}`,
      )
    }
    const verdict = extractJson(text)
    if (verdict === null || typeof verdict !== 'object') {
      // An empty visible reply means the model answered only into its private reasoning channel
      // (seen on some reasoning models); a non-JSON reply means it ignored the contract. Either
      // way there is no verdict, which is not the same as a verdict of "stop".
      throw new ValidationError(
        `The environment investigation (${ref.provider}:${ref.model}) returned no JSON verdict`,
      )
    }
    return { verdict, model: `${ref.provider}:${ref.model}` }
  }

  /**
   * The model this investigation runs on, resolved under its OWN kind so it is its own row in the
   * workspace's model defaults and its own line in the spend rollup: the same rule each
   * registered judge follows, and for the same reason: an investigation lumped under a shared key
   * attributes its spend to whatever else shares that key.
   */
  private async resolveModel(
    subject: EnvironmentInvestigationSubject,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const scope = await scopeForBlockRun(
      subject.workspaceId,
      subject.block,
      this.deps.resolveRunContext,
    )
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const { ref } = await resolveInlineBlockModel(
      this.deps,
      subject.workspaceId,
      ENVIRONMENT_INVESTIGATOR_AGENT_KIND,
      subject.block,
    )
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the environment investigation')
    }
    return { modelProvider, ref }
  }
}
