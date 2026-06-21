import type { AgentKind } from '@cat-factory/kernel'
import type { ModelRef } from '@cat-factory/kernel'
import { inlineModelRef } from '@cat-factory/kernel'

// "Which LLM, with what configuration, for what." Routing maps each agent kind
// to a model and generation settings, with a mandatory default fallback. The
// worker builds an AgentRouting from environment configuration, so operators can
// point e.g. the architect at a strong reasoning model and the documenter at a
// cheap one without any code change.

export interface AgentModelConfig {
  ref: ModelRef
  temperature?: number
  maxOutputTokens?: number
  /** Overrides the built-in role system prompt for this agent kind. */
  system?: string
}

export interface AgentRouting {
  /** Used for any agent kind without a specific entry (incl. custom agents). */
  default: AgentModelConfig
  byKind: Partial<Record<AgentKind, AgentModelConfig>>
}

/** Resolve the effective config for an agent kind, falling back to the default. */
export function resolveAgentConfig(routing: AgentRouting, kind: AgentKind): AgentModelConfig {
  return routing.byKind[kind] ?? routing.default
}

/** The resolvers a caller supplies so a step's model is picked the same way everywhere. */
export interface StepModelResolvers {
  agentRouting: AgentRouting
  /** Resolve a model catalog id to a concrete ref; unknown/absent ids return undefined. */
  resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
  /**
   * Resolve a workspace's per-agent-kind default model id, consulted when the block
   * pins no usable model. Optional: absent → the env routing for the kind is used.
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
}

/** What a step needs to resolve its model: which kind, the block's pin, the workspace. */
export interface StepModelInputs {
  agentKind: string
  /** The model catalog id pinned on the block, if any. */
  blockModelId: string | undefined
  /** The workspace the step runs in; required to consult a per-kind default. */
  workspaceId?: string
}

/**
 * Resolve the concrete model ref for a pipeline step with the ONE canonical
 * precedence used across every executor (the inline LLM executor, the container
 * executor and the requirements reviewer): a block's pinned model wins, else the
 * workspace's per-agent-kind default, else the env routing for the kind. Each
 * candidate id is run through {@link StepModelResolvers.resolveBlockModel}, so an
 * unresolvable pin (e.g. a stale id) falls through to the next source rather than
 * silently skipping the workspace default.
 */
export async function resolveStepModelRef(
  resolvers: StepModelResolvers,
  inputs: StepModelInputs,
): Promise<ModelRef> {
  const fromBlock = resolvers.resolveBlockModel(inputs.blockModelId)
  if (fromBlock) return fromBlock
  if (resolvers.resolveWorkspaceModelDefault && inputs.workspaceId) {
    const defaultId = await resolvers.resolveWorkspaceModelDefault(
      inputs.workspaceId,
      inputs.agentKind,
    )
    const fromDefault = resolvers.resolveBlockModel(defaultId)
    if (fromDefault) return fromDefault
  }
  return resolveAgentConfig(resolvers.agentRouting, inputs.agentKind).ref
}

/**
 * Resolve the model ref for an INLINE LLM call (one that runs through the
 * {@link ModelProvider}, not a container harness). Identical precedence to
 * {@link resolveStepModelRef}, but a pinned subscription model — one whose ref
 * carries a container-only `claude-code` / `codex` harness, for which no provider
 * key exists — is degraded to the kind's env-routing default (a provider model the
 * ModelProvider can serve). This is the single place every inline executor routes a
 * block's model through, so a task pinned to a subscription model for its container
 * steps still runs its inline steps instead of hard-failing. See {@link inlineModelRef}.
 */
export async function resolveInlineModelRef(
  resolvers: StepModelResolvers,
  inputs: StepModelInputs,
): Promise<ModelRef> {
  const ref = await resolveStepModelRef(resolvers, inputs)
  return inlineModelRef(ref, resolveAgentConfig(resolvers.agentRouting, inputs.agentKind).ref)
}
