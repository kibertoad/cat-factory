import type { JudgeSubject } from '@cat-factory/kernel'
import { FINAL_ANSWER_IN_REPLY } from './shared.js'
import { anchoredQualityScale, PRIOR_ROUNDS_DIRECTIVE } from './review-rounds.js'

// ---------------------------------------------------------------------------
// The JUDGE assessment prompt — the inline LLM call behind the fourth step-taxonomy bucket
// (see `docs/initiatives/judge-registry.md`).
//
// A judge grades the run's work against a RUBRIC the registration supplies (optionally
// overridden per workspace by a prompt-library fragment) and returns a structured verdict:
// a 0..1 score, a prose summary, and the concrete findings behind it. The ENGINE — never
// this prompt — owns what happens next: the score is compared to the task's merge-preset
// threshold and the run advances, parks, bounces the producing step, or fails.
//
// The rubric is authored by the deployment (or the workspace), so it is the ONLY part of the
// prompt that varies. Everything here is the fixed framing that makes a rubric's verdict
// comparable across judges: the scale, the "evidence, not vibes" rule, and the JSON shape.
// ---------------------------------------------------------------------------

// There is deliberately no `JUDGE_AGENT_KIND` constant: an assessment runs under the REGISTERED
// judge's own kind, both for model resolution and for observability, so each rubric is its own
// row in the workspace's model defaults and its own line in the spend rollup. A shared `judge`
// key would silently collapse every registered rubric onto one model default again.

/**
 * The role prompt every judge assessment runs under. Its deliverable IS a JSON object the
 * platform PARSES, so it carries the shared {@link FINAL_ANSWER_IN_REPLY} directive: a
 * reasoning model that answers only into its private channel returns an empty visible reply,
 * which the engine can only read as a failing verdict.
 *
 * The scale is stated explicitly and anchored, because an unanchored 0..1 score is the one
 * thing that makes thresholds meaningless across rubrics: two judges must mean the same thing
 * by `0.7` or a workspace cannot set one number in its merge preset. It comes from
 * {@link anchoredQualityScale}, SHARED with the companion prompt, because the same argument
 * holds across the two grading buckets and not merely across rubrics.
 *
 * It deliberately does NOT carry `REVIEW_SUMMARY_LAYOUT`, which asks a reviewer to lay its
 * `summary` out as grouped bullets. A judge already returns its points as `findings`, and
 * `JudgeResultView` renders that array as its own list directly below the summary — so the layout
 * would have every point written twice, in two orderings that can disagree. The same reasoning
 * excludes the `pr-reviewer` and the tester; the fragment is for a reviewer whose one string IS
 * the whole review (the companions). What the judge needs is the RENDER half, which it has: the
 * summary goes through the same markdown reader, so a short verdict paragraph reads properly.
 */
export const JUDGE_SYSTEM_PROMPT =
  'You are an impartial reviewer scoring a piece of work against a RUBRIC you are given. You ' +
  'assess only — you never edit code, never open pull requests, and never decide what happens ' +
  "next; the platform compares your score against the team's threshold and acts on it. " +
  'Ground every judgement in the evidence you were given: quote or name the specific thing ' +
  'that satisfies or violates the rubric, and never invent a problem you cannot point at. If ' +
  'the evidence is too thin to judge a rubric point, say so in the summary rather than ' +
  'guessing — an unverifiable concern is a finding of its own, not a low score in disguise. ' +
  `${anchoredQualityScale('the rubric')} Reply with ONLY a JSON object of ` +
  'the shape {"score": number 0..1, "summary": string, "findings": [{"title": string, ' +
  '"detail": string, "severity": "low"|"medium"|"high"|"critical", "where": string}]} — no ' +
  'prose around it, no code fences. Report `findings` for everything that pulled the score ' +
  'below 1.0, worst first; return an empty array when the work is clean. Keep `summary` to a ' +
  'few sentences on the verdict as a whole — what the work is, what holds it back, what would ' +
  'raise the score — and do NOT restate the findings there: they are shown to the reader as ' +
  'their own list beside it. ' +
  FINAL_ANSWER_IN_REPLY

/** Trim + cap one prior step's output so a long transcript can't blow the assessment prompt. */
const MAX_PRIOR_OUTPUT_CHARS = 6_000

function renderPriorOutput(entry: { agentKind: string; output: string }): string {
  const body = entry.output.trim()
  const clipped =
    body.length > MAX_PRIOR_OUTPUT_CHARS
      ? `${body.slice(0, MAX_PRIOR_OUTPUT_CHARS)}\n…[truncated]`
      : body
  return `--- Output of the "${entry.agentKind}" step ---\n${clipped}`
}

/**
 * Assemble one judge assessment prompt from the rubric in force plus the work under review.
 * Pure, so a registration's rubric can be exercised without a model.
 *
 * `previousFindings` is present only on a RE-judgement after a bounce: naming what the last
 * round asked for is what lets the judge tell "they fixed it" from "they never touched it",
 * which a fresh-eyes prompt cannot do and which is exactly the question a bounce budget is
 * spent to answer.
 */
export function renderJudgePrompt(subject: JudgeSubject): string {
  const lines: string[] = [
    'Rubric — this is what you are scoring against:',
    '',
    subject.rubric.trim(),
    '',
  ]
  const title = subject.block.title.trim()
  if (title) lines.push(`Task: ${title}`)
  const description = (subject.block.description ?? '').trim()
  if (description) lines.push('', 'Task brief:', description)
  lines.push('')
  if (subject.priorOutputs.length > 0) {
    lines.push('The work under review (the outputs the run produced so far):', '')
    for (const entry of subject.priorOutputs) lines.push(renderPriorOutput(entry), '')
  } else {
    lines.push('The run produced no step output to review yet.', '')
  }
  const previous = subject.previousFindings
  if (previous) {
    lines.push(
      'You reviewed an earlier revision of this work and asked for changes. Your previous ' +
        `verdict scored ${previous.score.toFixed(2)}:`,
    )
    if (previous.summary.trim()) lines.push(previous.summary.trim())
    for (const f of previous.findings ?? []) {
      lines.push(`- [${f.severity}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`)
    }
    lines.push('', PRIOR_ROUNDS_DIRECTIVE, '')
  }
  lines.push(
    `Score this work against the "${subject.rubricName}" rubric and reply with the JSON object.`,
  )
  return lines.join('\n')
}
