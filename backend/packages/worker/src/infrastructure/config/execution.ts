import type { Env } from '../env'

export type ExecutionMode = 'workflow' | 'tick'

export interface ExecutionConfig {
  /** 'workflow' drives runs durably; 'tick' keeps the legacy polling engine. */
  mode: ExecutionMode
  /** Human-decision park timeout passed to the workflow's waitForEvent. */
  decisionTimeout: string
}

export function loadExecutionConfig(env: Env): ExecutionConfig {
  return {
    // Default to 'tick' so behaviour is unchanged until an operator opts in,
    // mirroring the AGENTS_ENABLED default-off convention.
    mode: env.EXECUTION_MODE === 'workflow' ? 'workflow' : 'tick',
    decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
  }
}
