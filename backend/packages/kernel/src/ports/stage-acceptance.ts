import type { StageAcceptanceCriterion } from '@cat-factory/contracts'
import type { Block } from '../domain/types.js'

// The seam that argues whether a project stage's result meets the stage's acceptance criteria.
// The engine's implementation is an inline model call; a test harness injects a deterministic
// fake through the same seam. It only ARGUES: the status of each criterion is computed by the
// platform from what it quotes (`computeStageAcceptance`). Design:
// `backend/docs/adr/0070-staged-project-definitions.md`.

/** The kind an assessment runs under, for model resolution and its spend rollup line. */
export const STAGE_ACCEPTANCE_KIND = 'stage-acceptance'

/** What an assessment is given. */
export interface StageAcceptanceSubject {
  workspaceId: string
  /** The stage task whose result is assessed: its run's credentials and model pins apply. */
  block: Block
  stage: { id: string; title: string }
  criteria: readonly StageAcceptanceCriterion[]
  /** The stage's result, rendered for a reader by the handler of its task type. */
  result: string
}

export interface StageAcceptanceAssessor {
  /** Whether an assessment can run at all (a model provider and a routing default are wired). */
  readonly enabled: boolean
  /** The raw reply (the caller reads it) and the model that produced it. Throws when it fails. */
  assess(subject: StageAcceptanceSubject): Promise<{ reply: unknown; model: string }>
}
