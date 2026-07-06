import type { Block, ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import { inlineModelRef, resolveScopedModelProvider } from '@cat-factory/kernel'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
import type { TestReport } from '@cat-factory/contracts'
import { TESTER_QC_AGENT_KIND } from '@cat-factory/contracts'
import { generateText } from 'ai'
import { catFactoryObservability, TESTER_QC_SYSTEM_PROMPT } from '@cat-factory/agents'
import {
  type TesterQualityOutcome,
  buildTesterQualityPrompt,
  coerceTesterQualityVerdict,
} from './testerQuality.logic.js'

/**
 * The inline reviewer the Tester gate consults to audit a Tester report for coverage BEFORE
 * the greenlight/fixer decision. Kept as an interface so {@link TesterController} depends on
 * the behaviour, not the concrete service — and so it can be left unwired (tests / no model),
 * in which case the gate treats the report as adequate and proceeds.
 */
export interface TesterQualityReviewer {
  /**
   * Audit a Tester report. Returns the coerced verdict + the model that produced it, or
   * `null` when no model/provider resolves for the workspace (pass-through: the gate proceeds).
   */
  evaluate(
    workspaceId: string,
    block: Block,
    report: TestReport,
  ): Promise<{ outcome: TesterQualityOutcome; model: string | null } | null>
}

/** The model-resolution dependencies the QC reviewer shares with the iterative reviewers. */
export interface TesterQualityReviewDeps {
  /** Resolve a {@link ModelProvider} for a workspace's credential scope. Preferred. */
  modelProviderResolver?: ModelProviderResolver
  /** Static model provider (e.g. a fake in tests). Used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Default model ref when the block pins none — the agents' routing default. */
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

/**
 * Stateless inline reviewer for the test quality-control companion. The LLM is reached
 * through the provider-agnostic {@link ModelProvider} port (never a provider SDK / API key),
 * and the model is resolved exactly like an agent step: a model pinned on the block wins,
 * else the workspace's per-kind default, else the routing default. Mirrors the requirements
 * reviewer's resolution precedence so the QC companion behaves like every other inline review.
 */
export class TesterQualityReviewService implements TesterQualityReviewer {
  constructor(private readonly deps: TesterQualityReviewDeps) {}

  private async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const runsInline = this.deps.runsInline
    const resolve = (ref: ModelRef): ModelRef =>
      inlineModelRef(ref, fallback ?? ref, runsInline ? { runsInline } : {})
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return resolve(fromBlock)
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      TESTER_QC_AGENT_KIND,
      block.modelPresetId,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return resolve(fromDefault)
    return fallback
  }

  async evaluate(
    workspaceId: string,
    block: Block,
    report: TestReport,
  ): Promise<{ outcome: TesterQualityOutcome; model: string | null } | null> {
    const scope = await scopeForBlockRun(workspaceId, block, this.deps.resolveRunContext)
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const ref = await this.modelFor(workspaceId, block)
    // No model resolvable ⇒ pass-through (the gate proceeds), like the requirements reviewer.
    if (!modelProvider || !ref) return null
    let model: ReturnType<ModelProvider['resolve']>
    try {
      model = modelProvider.resolve(ref)
    } catch {
      // The resolved ref names a provider this deployment hasn't registered (e.g. a routing
      // default of `openrouter` on a facade whose composite has no OpenRouter key). QC is a
      // companion, never a hard dependency, so degrade to pass-through rather than throwing —
      // a raw throw here would fail the whole run, exactly the cross-runtime divergence the
      // requirements reviewer's identical guard exists to prevent.
      return null
    }
    let text: string
    try {
      const result = await generateText({
        model,
        system: TESTER_QC_SYSTEM_PROMPT,
        prompt: buildTesterQualityPrompt({
          taskTitle: block.title,
          taskDescription: block.description ?? '',
          report,
        }),
        temperature: 0.2,
        maxOutputTokens: 4000,
        providerOptions: catFactoryObservability({ agentKind: TESTER_QC_AGENT_KIND, workspaceId }),
      })
      text = result.text
    } catch {
      // The QC call itself failed (upstream error / timeout). Never block the pipeline on a
      // companion that can't run — proceed with the accept/fix decision unchanged.
      return null
    }
    return {
      outcome: coerceTesterQualityVerdict(text),
      model: `${ref.provider}:${ref.model}`,
    }
  }
}
