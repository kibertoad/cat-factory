import type { AgentTokenUsage, ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { ResolvedPrompt } from '../prompt-registry'
import type { PiEndpoint } from '../types'

// Common inputs/outputs for the per-task candidate runners. Each runner reuses a
// real cat-factory agent/prompt; the harness supplies the resolved model, the
// resolved (versioned) prompt and the environment.

export interface RunnerDeps {
  provider: ModelProvider
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export interface RunnerInput<Fixture> {
  fixture: Fixture
  modelRef: ModelRef
  prompt: ResolvedPrompt
  /** Pi endpoint (implementation task only). */
  endpoint?: PiEndpoint
  deps: RunnerDeps
}

export interface RunnerOutput {
  /** The candidate work product, rendered for the arbiter to read. */
  output: string
  /**
   * Kernel's {@link AgentTokenUsage} rather than a local pair of totals, because a runner
   * that reuses a real agent hands back what the agent reported, `inputClasses` included, and
   * `cost` prices per class off exactly this value. A local shape that cannot carry the split
   * would still be handed one at runtime, and would declare a lump the pricing does not use.
   */
  usage?: AgentTokenUsage & {
    /**
     * Input tokens the provider served from its prompt-prefix cache (subset of
     * inputTokens). Lets the report quantify the caching dimension: a cache-capable
     * route reports >0 on a repeated-prefix call, a cache-less route (Workers AI) 0.
     * Distinct from `inputClasses.cacheReadTokens`, which a runner only has where it went
     * through an agent that reports the split.
     */
    cachedInputTokens?: number
  }
  /** Task-specific extras surfaced in the report/grading artifact. */
  meta?: Record<string, unknown>
}
