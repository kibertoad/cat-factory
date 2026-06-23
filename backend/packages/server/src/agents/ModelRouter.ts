import type { AgentRunContext, ModelRef, SubscriptionVendor } from '@cat-factory/kernel'
import { isIndividualVendor, subscriptionOptionFor } from '@cat-factory/kernel'
import { type AgentRouting, resolveStepModelRef } from '@cat-factory/agents'

/** The collaborators {@link ModelRouter} needs to resolve a step's model + subscription path. */
export interface ModelRouterDependencies {
  /** Default model routing; used when the block pins no (usable) model. */
  agentRouting: AgentRouting
  /** Resolve a block's selected model id to a concrete ref (direct flavour). */
  resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
  /**
   * Resolve the workspace's per-agent-kind default model id, consulted when the
   * block pins no model. Optional: absent → the env routing for the kind is used.
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
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
  resolveRef(context: AgentRunContext): Promise<ModelRef> {
    return resolveStepModelRef(
      {
        agentRouting: this.deps.agentRouting,
        resolveBlockModel: this.deps.resolveBlockModel,
        resolveWorkspaceModelDefault: this.deps.resolveWorkspaceModelDefault,
      },
      {
        agentKind: context.agentKind,
        blockModelId: context.block.modelId,
        workspaceId: context.workspaceId,
      },
    )
  }

  /**
   * The canonical catalog model id the step resolves to (block pin > workspace
   * per-kind default), or undefined when it falls through to the env routing
   * default (a raw ref with no canonical id). Used to look up the model's
   * subscription path for the "subscriptions always win" override.
   */
  private async resolveCanonicalModelId(context: AgentRunContext): Promise<string | undefined> {
    if (context.block.modelId) return context.block.modelId
    if (this.deps.resolveWorkspaceModelDefault && context.workspaceId) {
      return (
        (await this.deps.resolveWorkspaceModelDefault(context.workspaceId, context.agentKind)) ??
        undefined
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
    context: AgentRunContext,
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
}
