import type { AgentKind } from '@cat-factory/kernel'
import type { ModelRef } from '@cat-factory/kernel'

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
