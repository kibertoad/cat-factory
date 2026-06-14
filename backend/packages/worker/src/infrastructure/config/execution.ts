import type { Env } from '../env'

export interface ExecutionConfig {
  /** Human-decision park timeout passed to the workflow's waitForEvent. */
  decisionTimeout: string
}

export function loadExecutionConfig(env: Env): ExecutionConfig {
  return {
    decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
  }
}
