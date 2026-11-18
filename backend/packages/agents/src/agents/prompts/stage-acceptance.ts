import type { StageAcceptanceSubject } from '@cat-factory/kernel'
import { FINAL_ANSWER_IN_REPLY } from './shared.js'

// The prompt behind a project stage's exit-criteria assessment. The model argues each criterion
// and quotes the passages of the result that support its claim; the platform computes the status
// from the quotes (a claim of `met` whose passages the result does not hold reads as unverified),
// and a person decides at the stage's checkpoint. So the prompt asks for verbatim quotes and
// nothing that reads as a verdict on the stage as a whole.

/** The longest result the assessment reads; a longer one is cut and the cut stated. */
export const STAGE_ACCEPTANCE_RESULT_MAX_CHARS = 40_000

export const STAGE_ACCEPTANCE_SYSTEM_PROMPT =
  "You check a project stage's result against its acceptance criteria. For each criterion you " +
  'claim `met` or `unmet` and give a one or two sentence rationale. A claim of `met` must quote, ' +
  'word for word, the passages of the result that show it: copy them exactly, each at least a ' +
  'full phrase, never paraphrased and never from anywhere but the result, at most 5 quotes per ' +
  'criterion and each under 300 characters. The platform checks ' +
  'every quote against the result and treats a claim it cannot find as unverified, so when the ' +
  'result does not show a criterion, claim `unmet` rather than stretching a passage to fit. You ' +
  'judge only what the result states, not what the work probably did. Reply with ONLY a JSON ' +
  'object of the shape {"criteria": [{"id": string, "claim": "met"|"unmet", "rationale": string, ' +
  '"evidence": [string]}]}, one entry per criterion, no prose around it and no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** The assessment prompt for one stage result. Pure, so it can be exercised without a model. */
export function renderStageAcceptancePrompt(subject: StageAcceptanceSubject): string {
  const result = subject.result.trim()
  const clipped =
    result.length > STAGE_ACCEPTANCE_RESULT_MAX_CHARS
      ? `${result.slice(0, STAGE_ACCEPTANCE_RESULT_MAX_CHARS)}\n[The result is cut here; judge only what is shown.]`
      : result
  return [
    `Stage: ${subject.stage.title}`,
    '',
    'Acceptance criteria:',
    ...subject.criteria.map((c) => `- ${c.id}: ${c.statement}`),
    '',
    '--- The stage result ---',
    clipped || '(The result is empty.)',
    '--- End of the stage result ---',
  ].join('\n')
}
