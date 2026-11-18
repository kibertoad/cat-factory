import {
  STAGE_ACCEPTANCE_KIND,
  type StageAcceptanceAssessor,
  type StageAcceptanceSubject,
} from '@cat-factory/kernel'
import { STAGE_ACCEPTANCE_SYSTEM_PROMPT, renderStageAcceptancePrompt } from '@cat-factory/agents'
import {
  type InlineJsonAssessmentDeps,
  inlineJsonAssessmentEnabled,
  runInlineJsonAssessment,
} from '../execution/inlineJsonAssessment.js'

/** How long an acceptance assessment may run; it holds the stage task's completion meanwhile. */
const STAGE_ACCEPTANCE_TIMEOUT_MS = 120_000

/** Room for each criterion's claim, rationale and quotes, within a ceiling. */
function outputBudget(criteria: number): number {
  return Math.min(16_000, 1000 + criteria * 700)
}

export type StageAcceptanceServiceDeps = InlineJsonAssessmentDeps

/**
 * The inline producer behind a stage's exit-criteria assessment. It runs under the stage task's
 * own credential scope and under its own kind, so a workspace can give it a model of its own and
 * its spend lands on a line of its own.
 */
export class StageAcceptanceService implements StageAcceptanceAssessor {
  constructor(private readonly deps: StageAcceptanceServiceDeps) {}

  get enabled(): boolean {
    return inlineJsonAssessmentEnabled(this.deps)
  }

  async assess(subject: StageAcceptanceSubject): Promise<{ reply: unknown; model: string }> {
    const { value, model } = await runInlineJsonAssessment(this.deps, {
      workspaceId: subject.workspaceId,
      block: subject.block,
      kind: STAGE_ACCEPTANCE_KIND,
      label: 'acceptance assessment',
      system: STAGE_ACCEPTANCE_SYSTEM_PROMPT,
      prompt: renderStageAcceptancePrompt(subject),
      maxOutputTokens: outputBudget(subject.criteria.length),
      timeoutMs: STAGE_ACCEPTANCE_TIMEOUT_MS,
    })
    return { reply: value, model }
  }
}
