import { generateText } from 'ai'
import type { Block, ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import { inlineModelRef, resolveScopedModelProvider, ValidationError } from '@cat-factory/kernel'
import {
  catFactoryObservability,
  FORK_CHAT_AGENT_KIND,
  type ForkChatGrounding,
  FORK_CHAT_SYSTEM_PROMPT,
  renderForkChatPrompt,
} from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'

// ---------------------------------------------------------------------------
// The grounded fork-decision CHAT responder (PR 2). After the read-only
// `fork-proposer` surfaces the materially different implementation approaches and
// the run parks, the human can chat about the forks before deciding. Each human
// turn is answered by an INLINE LLM call in the durable driver (no container
// re-dispatch) — this service owns that call: resolve the block's model (block pin
// → workspace per-kind default → routing default, exactly like the requirements
// reviewer / doc interviewer), run `generateText` over the fixed proposal grounding
// + the thread, and return the assistant reply text.
//
// It is deliberately STATELESS — the whole chat rides the run's coder step
// (`step.forkDecision.chat`), so there is no side table to persist, mirroring how
// `followUps` / `testerQuality` ride the step. The engine's ForkDecisionController
// appends the returned reply onto the step and re-parks. When no model is wired the
// service is `enabled === false` and the controller degrades gracefully (a canned
// "chat unavailable" assistant turn), so pick / custom still work.
// ---------------------------------------------------------------------------

/** What the chat responder needs to resolve its inline model and reach the provider. */
export interface ForkChatDeps {
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

export class ForkChatService {
  constructor(private readonly deps: ForkChatDeps) {}

  /** Whether the inline chat responder is available (a provider AND a routing default are wired). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /**
   * Answer one human turn about the surfaced forks. Runs the inline responder over the fixed
   * proposal grounding + the thread and returns the assistant reply plus the model that produced
   * it. Throws {@link ValidationError} on an unresolved model or an empty/failed generation, so
   * the driver can record a graceful fallback instead of wedging the parked run.
   */
  async respond(
    workspaceId: string,
    block: Block,
    grounding: ForkChatGrounding,
  ): Promise<{ text: string; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: FORK_CHAT_SYSTEM_PROMPT,
        prompt: renderForkChatPrompt(grounding),
        temperature: 0.3,
        maxOutputTokens: 1200,
        providerOptions: catFactoryObservability({
          agentKind: FORK_CHAT_AGENT_KIND,
          workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The fork-decision chat responder (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const reply = text.trim()
    // An empty visible reply means the model answered only into its private reasoning channel
    // (seen on some reasoning models) — fail loudly so the driver records the canned fallback
    // rather than appending an empty assistant bubble.
    if (!reply) {
      throw new ValidationError(
        `The fork-decision chat responder (${ref.provider}:${ref.model}) returned an empty reply`,
      )
    }
    return { text: reply, model: `${ref.provider}:${ref.model}` }
  }

  private async resolveModel(
    workspaceId: string,
    block: Block,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const scope = await scopeForBlockRun(workspaceId, block, this.deps.resolveRunContext)
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the fork-decision chat')
    }
    return { modelProvider, ref }
  }

  /** Block pin > workspace per-kind default > routing default (subscription refs degrade inline). */
  private async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const runsInline = this.deps.runsInline
    const resolve = (ref: ModelRef): ModelRef =>
      inlineModelRef(ref, fallback ?? ref, runsInline ? { runsInline } : {})
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return resolve(fromBlock)
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      FORK_CHAT_AGENT_KIND,
      block.modelPresetId,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return resolve(fromDefault)
    return fallback
  }
}
