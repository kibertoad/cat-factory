import type { TestReport } from '@cat-factory/contracts'
import { extractJson } from '../requirements/requirements.logic.js'

// ---------------------------------------------------------------------------
// Pure helpers for the test quality-control companion (see TesterQualityReviewService
// + TesterController). No I/O: prompt assembly, verdict coercion, and the rendering of
// the prior report + reviewer feedback folded into the Tester's re-run context.
// ---------------------------------------------------------------------------

/** The QC reviewer's coerced verdict on a Tester report. */
export interface TesterQualityOutcome {
  /** Whether the report is complete + coherent enough to proceed (no QC re-run needed). */
  adequate: boolean
  /** Concrete coverage gaps the Tester must still address (empty when adequate). */
  gaps: string[]
  /** The reviewer's prose challenge, folded into the Tester's re-run context. */
  feedback: string
}

/** Render a Tester report as the read-only material the QC reviewer audits. */
export function renderReportForQuality(report: TestReport): string {
  const lines: string[] = []
  if (report.summary) lines.push(`Summary: ${report.summary}`, '')
  lines.push(`Greenlight: ${report.greenlight ? 'yes' : 'no'}`)
  lines.push('')
  lines.push('Areas the Tester says it exercised (`tested`):')
  if (report.tested.length) for (const t of report.tested) lines.push(`- ${t}`)
  else lines.push('- (none listed)')
  lines.push('')
  lines.push('Recorded outcomes:')
  if (report.outcomes.length)
    for (const o of report.outcomes)
      lines.push(`- [${o.status}] ${o.name}${o.detail ? `: ${o.detail}` : ' (no detail)'}`)
  else lines.push('- (no discrete outcomes recorded)')
  if (report.concerns.length) {
    lines.push('')
    lines.push('Concerns raised:')
    for (const c of report.concerns) lines.push(`- [${c.severity}] ${c.title}: ${c.detail}`)
  }
  return lines.join('\n')
}

/** Build the QC reviewer's user prompt from the task context + the report under audit. */
export function buildTesterQualityPrompt(input: {
  taskTitle: string
  taskDescription: string
  report: TestReport
}): string {
  const parts: string[] = []
  parts.push(`Task: ${input.taskTitle}`)
  if (input.taskDescription.trim()) {
    parts.push('', 'Task description / requirements:', input.taskDescription.trim())
  }
  parts.push('', 'The Tester report to audit:', '', renderReportForQuality(input.report))
  parts.push(
    '',
    'Audit this report per your instructions and return the JSON verdict. Remember: every area listed in `tested` should have a matching recorded outcome; a shallow report that claims broad coverage but records only a happy-path check is not adequate.',
  )
  return parts.join('\n')
}

/** Coerce the QC reviewer's raw model text into a verdict, defaulting safely on garbage. */
export function coerceTesterQualityVerdict(text: string): TesterQualityOutcome {
  const raw = extractJson(text) as Record<string, unknown> | null
  const o = raw && typeof raw === 'object' ? raw : {}
  const gaps = Array.isArray(o.gaps)
    ? (o.gaps as unknown[])
        .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
        .map((g) => g.trim())
    : []
  const feedback = typeof o.feedback === 'string' ? o.feedback.trim() : ''
  // Defensive: only treat the report as adequate when the model says so AND lists no gaps.
  // A verdict that claims `adequate` while naming gaps is contradictory — the gaps win, so
  // the Tester is looped rather than silently concluding on an incomplete report.
  const adequate = o.adequate === true && gaps.length === 0
  return { adequate, gaps, feedback }
}

/**
 * Render the QC reviewer's verdict as the resolved-context block handed to the Tester on its
 * QC-driven re-run: it asks for a FOCUSED additional pass that closes the gaps only, carrying
 * the already-covered outcomes forward, then attaches the prior report for reference.
 */
export function renderQualityFeedbackForTester(
  outcome: TesterQualityOutcome,
  report: TestReport,
): string {
  const lines: string[] = [
    'Test quality review — your previous report did not adequately cover everything this task needed tested.',
    'Do a FOCUSED additional pass that closes the gaps below, then return an UPDATED report that still lists every area (carry forward, unchanged, the outcomes you already recorded with a passing result and no concern — do NOT re-run those).',
    '',
    'Gaps to close:',
  ]
  if (outcome.gaps.length) for (const g of outcome.gaps) lines.push(`- ${g}`)
  else lines.push('- (see reviewer notes below)')
  if (outcome.feedback) {
    lines.push('', `Reviewer notes: ${outcome.feedback}`)
  }
  lines.push('', 'Your previous report (for reference):', '', renderReportForQuality(report))
  return lines.join('\n').trim()
}
