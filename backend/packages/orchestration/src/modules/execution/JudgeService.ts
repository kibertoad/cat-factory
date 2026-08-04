import { generateText } from 'ai'
import type {
  Block,
  JudgeAssessor,
  JudgeSubject,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import { extractJson, resolveScopedModelProvider, ValidationError } from '@cat-factory/kernel'
import {
  catFactoryObservability,
  JUDGE_AGENT_KIND,
  JUDGE_SYSTEM_PROMPT,
  renderJudgePrompt,
} from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'

// ---------------------------------------------------------------------------
// The default {@link JudgeAssessor}: the INLINE LLM call behind every judge step.
//
// Structurally the `ForkChatService` twin — resolve the block's model (block pin → workspace
// per-kind default → routing default), run `generateText`, return the reply — with one
// difference: a judge's deliverable is a JSON object the engine PARSES, so this returns the
// raw extracted value and lets the judge's registered parser own the shape.
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
  async assess(subject: JudgeSubject): Promise<{ verdict: unknown; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(subject.workspaceId, subject.block)
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
          agentKind: JUDGE_AGENT_KIND,
          workspaceId: subject.workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The judge assessment (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
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
    return { verdict, model: `${ref.provider}:${ref.model}` }
  }

  private async resolveModel(
    workspaceId: string,
    block: Block,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const scope = await scopeForBlockRun(workspaceId, block, this.deps.resolveRunContext)
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the judge assessment')
    }
    return { modelProvider, ref }
  }

  /** Block pin > workspace per-kind default > routing default (subscription refs degrade inline). */
  private modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    return resolveInlineBlockModelRef(this.deps, workspaceId, JUDGE_AGENT_KIND, block)
  }
}
