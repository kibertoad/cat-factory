import type { ObservabilityConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { ObservabilityConfig }

/**
 * LLM observability config. Recording the complete prompts is on by default; an
 * operator opts out with `LLM_RECORD_PROMPTS=false` (any other value keeps it on),
 * which drops the prompt body from the sink while keeping the numeric telemetry.
 */
export function loadObservabilityConfig(env: Env): ObservabilityConfig {
  return {
    recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false',
  }
}
