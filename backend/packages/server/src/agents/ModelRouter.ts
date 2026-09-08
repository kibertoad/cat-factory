import type {
  LocalModelDeclarations,
  ModelFlavor,
  ModelRef,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import type { HarnessKind } from '@cat-factory/kernel'
import { isIndividualVendor, subscriptionOptionFor } from '@cat-factory/kernel'
import { type AgentRouting, isProxyableProvider, resolveStepModelRef } from '@cat-factory/agents'

/**
 * Everything the router reads to pick a model: the agent kind, the workspace, whatever the block
 * pins, and who started the work.
 *
 * A structural SUBSET of {@link import('@cat-factory/kernel').AgentRunContext}, which is what the
 * pipeline path still passes. The point is the callers that have no run context to pass: a
 * single-job container flow (the agent dry run, the config repairer) is not an
 * `ExecutionInstance`: it has a workspace, a frame and an initiator, and nothing else the run
 * context describes. Asking those callers for a whole `AgentRunContext` would have them fabricate
 * a pipeline name, a step index and a final-step flag, and a fabricated run context is a thing
 * later code reads as one. Taking the subset instead is what lets every dispatch, pipeline step
 * or not, resolve its model through THIS precedence rather than reaching for the deployment's env
 * routing directly, which is a model nobody's preset chose.
 */
export interface StepModelSelection {
  agentKind: string
  /** Absent ⇒ no workspace defaults are consulted and the env routing decides. */
  workspaceId?: string
  /** Whoever started the work: whose personal (individual-usage) subscription may be leased. */
  initiatedByUserId?: string
  /** The route order the preset in force states; absent ⇒ the deployment's default order. */
  providerPreference?: readonly ModelFlavor[]
  /** The initiator's local-runner declarations, folded onto the resolved ref. */
  localModelDeclarations?: readonly LocalModelDeclarations[]
  /** What the block itself pins, if anything. `{}` for a caller whose subject pins nothing. */
  block: { modelId?: string; modelPresetId?: string }
}

/** The collaborators {@link ModelRouter} needs to resolve a step's model + subscription path. */
export interface ModelRouterDependencies {
  /** Default model routing; used when the block pins no (usable) model. */
  agentRouting: AgentRouting
  /** Resolve a block's selected model id to a concrete ref, under a preset's route order. */
  resolveBlockModel: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  /**
   * Resolve the workspace's per-agent-kind default model id, consulted when the
   * block pins no model. Optional: absent → the env routing for the kind is used.
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /**
   * Whether the workspace has a pooled token for a vendor. Drives "subscriptions
   * always win" for POOLABLE vendors: a step pinned to a dual-mode model (Kimi/DeepSeek
   * with a Cloudflare base) is auto-routed to its subscription flavour when this returns
   * true.
   */
  hasSubscriptionToken?: (workspaceId: string, vendor: SubscriptionVendor) => Promise<boolean>
  /**
   * Whether the run-initiator has their OWN personal subscription for an INDIVIDUAL-usage
   * vendor. Individual vendors (e.g. GLM) are never pooled, so a dual-mode individual
   * model is auto-routed to the user's personal subscription when this returns true, and
   * otherwise stays on its Cloudflare base — so a subscriber runs GLM on their plan while
   * a non-subscriber on the same workspace falls back to Cloudflare GLM.
   */
  hasPersonalSubscription?: (userId: string, vendor: SubscriptionVendor) => Promise<boolean>
}

/**
 * Resolves which model — and which subscription path — a pipeline step runs on,
 * decoupling routing POLICY from the container executor's job dispatch. Holds the one
 * canonical step precedence (block pin > workspace per-kind default > env routing) plus
 * the "subscriptions always win" override, so the dispatch path and the spend gate can't
 * disagree on what a step will run. Side-effect-free.
 */
export class ModelRouter {
  constructor(private readonly deps: ModelRouterDependencies) {}

  /**
   * Resolve the step's model ref with the shared step precedence (block pin >
   * workspace per-kind default > env routing). Side-effect-free and dispatch-free,
   * so it backs both the up-front `resolveModel` preview and `buildJobBody`.
   */
  resolveRef(context: StepModelSelection): Promise<ModelRef> {
    return resolveStepModelRef(
      {
        agentRouting: this.deps.agentRouting,
        resolveBlockModel: this.deps.resolveBlockModel,
        resolveWorkspaceModelDefault: this.deps.resolveWorkspaceModelDefault,
      },
      {
        agentKind: context.agentKind,
        blockModelId: context.block.modelId,
        modelPresetId: context.block.modelPresetId,
        workspaceId: context.workspaceId,
        // The route order the preset in force states, resolved once per dispatch by the engine.
        // Read off the CONTEXT rather than re-derived here, so this router, the inline executor
        // and the consensus panel cannot disagree about which provider a step ran on.
        ...(context.providerPreference ? { providerPreference: context.providerPreference } : {}),
        // Likewise the initiator's local-model declarations, folded onto the ref by the shared
        // resolver. Nothing on the CONTAINER path reads the modality today: a local ref names no
        // harness, so this dispatch runs it on Pi, and `dispatchDesignImageDelivery` answers
        // `harness_no_image_input` before it ever asks the ref (the inline executor is the reader
        // that benefits). Threaded here anyway because ONE resolution serving every path is what
        // stops them disagreeing about what a step ran on, so the day an image-carrying harness
        // serves a local model this is a `HARNESS_IMAGE_INPUT` edit rather than new plumbing.
        ...(context.localModelDeclarations
          ? { localModelDeclarations: context.localModelDeclarations }
          : {}),
      },
    )
  }

  /**
   * The canonical catalog model id the step resolves to (block pin > workspace
   * per-kind default), or undefined when it falls through to the env routing
   * default (a raw ref with no canonical id). Used to look up the model's
   * subscription path for the "subscriptions always win" override.
   */
  private async resolveCanonicalModelId(context: StepModelSelection): Promise<string | undefined> {
    if (context.block.modelId) return context.block.modelId
    if (this.deps.resolveWorkspaceModelDefault && context.workspaceId) {
      return (
        (await this.deps.resolveWorkspaceModelDefault(
          context.workspaceId,
          context.agentKind,
          context.block.modelPresetId,
        )) ?? undefined
      )
    }
    return undefined
  }

  /**
   * Resolve the step's EFFECTIVE model ref plus the subscription vendor (if any) it
   * will run on, applying the "subscriptions always win" override:
   *  - a subscription-only model carries its harness already (always its subscription);
   *  - a dual-mode POOLABLE model (Kimi/DeepSeek) switches to its subscription flavour
   *    when the WORKSPACE has a pooled token for the vendor;
   *  - a dual-mode INDIVIDUAL model (GLM — never pooled) switches to the RUN-INITIATOR's
   *    own personal subscription when they have one, and otherwise stays on its Cloudflare
   *    base. So a subscriber runs GLM on their plan while a non-subscriber on the same
   *    workspace falls back to Cloudflare GLM.
   */
  async resolveEffectiveRef(
    context: StepModelSelection,
    workspaceId: string,
  ): Promise<{ ref: ModelRef; subscriptionVendor?: SubscriptionVendor }> {
    let ref = await this.resolveRef(context)
    let subscriptionVendor: SubscriptionVendor | undefined
    const subOption = subscriptionOptionFor(await this.resolveCanonicalModelId(context))
    if (subOption) {
      if (ref.harness) {
        subscriptionVendor = subOption.vendor
      } else if (isIndividualVendor(subOption.vendor)) {
        // Dual-mode individual vendor (GLM): use the initiator's OWN personal subscription
        // when they have one; else leave `ref` on the Cloudflare base (ungated fallback).
        if (
          context.initiatedByUserId &&
          this.deps.hasPersonalSubscription &&
          (await this.deps.hasPersonalSubscription(context.initiatedByUserId, subOption.vendor))
        ) {
          ref = subOption.ref
          subscriptionVendor = subOption.vendor
        }
      } else if (
        this.deps.hasSubscriptionToken &&
        (await this.deps.hasSubscriptionToken(workspaceId, subOption.vendor))
      ) {
        ref = subOption.ref
        subscriptionVendor = subOption.vendor
      }
    }
    return { ref, ...(subscriptionVendor ? { subscriptionVendor } : {}) }
  }

  /**
   * The model this dispatch runs and the harness that will run it, resolved together because
   * the second is a property of the first. "Subscriptions always win": a subscription-only model
   * carries its harness; a dual-mode GLM/Kimi step pinned to its Cloudflare base is auto-routed
   * to Claude Code when the workspace has a pooled token for the vendor. Shared with
   * `isQuotaBased` so the dispatch and the spend gate agree on what the step runs.
   *
   * The Pi harness reaches models through the LLM proxy, so its model must be a provider the
   * proxy can serve; locking it here stops the container choosing another. The subscription
   * harnesses (Claude Code / Codex) talk direct to the vendor with a pooled token, so the
   * proxyable guard does not apply to them.
   */
  async resolveDispatchRef(
    context: StepModelSelection,
    workspaceId: string,
  ): Promise<{ ref: ModelRef; harness: HarnessKind; subscriptionVendor?: SubscriptionVendor }> {
    const { ref, subscriptionVendor } = await this.resolveEffectiveRef(context, workspaceId)
    const harness: HarnessKind = ref.harness ?? 'pi'
    if (harness === 'pi' && !isProxyableProvider(ref.provider)) {
      throw new Error(
        `A container dispatch needs a model the LLM proxy can serve ` +
          `(Workers AI, a direct OpenAI-compatible provider, or a local runner); ` +
          `'${ref.provider}' is not supported. Pick a Workers AI model, configure a ` +
          `provider key (QWEN_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY), or add a local ` +
          `runner (Ollama / LM Studio / …) and pick that model.`,
      )
    }
    return { ref, harness, ...(subscriptionVendor ? { subscriptionVendor } : {}) }
  }
}
