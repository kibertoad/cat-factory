import type { PipelineStep, ValidationReport } from '@cat-factory/kernel'
import { parseValidationReport, summarizeValidationFailure } from '@cat-factory/contracts'

// Pure helpers for the PRE-PR VALIDATION report the executor-harness produces (see
// docs/initiatives/pre-pr-validation.md). NO repository access — the engine's only job here is
// to fold the harness's verdict onto the step; the loop itself runs in the container, because
// the commands must EXECUTE against a checkout.

/**
 * Fold a harness-produced validation report onto a step, returning whether anything changed.
 *
 * Applied on all three poll paths — the live `running` republish (so the repair loop is visible
 * while it runs), the successful terminal result (the captured proof the checkout was green
 * before the PR opened), and the failed terminal result (the evidence behind an exhausted
 * budget). Lenient by construction: a malformed/absent payload leaves the step untouched rather
 * than failing the run, since the report is observability, never a control signal — the harness
 * already decided whether to open the PR.
 */
export function applyValidationReport(step: PipelineStep, raw: unknown): boolean {
  const report = coerceValidationReport(raw)
  if (!report) return false
  if (sameValidationReport(step.validation ?? null, report)) return false
  step.validation = report
  return true
}

/** Parse a harness report defensively; `null` for absent/unparseable payloads. */
export function coerceValidationReport(raw: unknown): ValidationReport | null {
  if (raw === undefined || raw === null) return null
  try {
    return parseValidationReport(raw)
  } catch {
    return null
  }
}

/**
 * Whether two reports are the same publish. Compared on the attempt identity + verdict rather
 * than deep-equality of the (potentially 40 KB of) output tails, so an idle poll re-offering the
 * same attempt doesn't churn storage or the event stream.
 */
function sameValidationReport(a: ValidationReport | null, b: ValidationReport): boolean {
  if (!a) return false
  return (
    a.attempts === b.attempts &&
    a.passed === b.passed &&
    a.at === b.at &&
    a.outcomes.length === b.outcomes.length &&
    a.outcomes.every((o, i) => {
      const other = b.outcomes[i]
      return other !== undefined && o.label === other.label && o.exitCode === other.exitCode
    })
  )
}

/**
 * The failure detail for a step whose run died because pre-PR validation never went green:
 * the one-line summary (which checks failed, with exit codes) followed by the last failing
 * command's captured output. This is what the board's failure card shows, so the operator sees
 * WHY without opening the run — the whole reason the output is captured rather than asserted.
 * `null` when the report describes no failure (nothing to explain).
 */
export function validationFailureDetail(report: ValidationReport): string | null {
  if (report.passed) return null
  const failed = report.outcomes.filter((o) => !o.passed)
  if (failed.length === 0) return summarizeValidationFailure(report)
  const last = failed[failed.length - 1]
  const tail = last?.outputTail?.trim()
  return tail
    ? `${summarizeValidationFailure(report)}\n\n$ ${last?.command}\n${tail}`
    : summarizeValidationFailure(report)
}
