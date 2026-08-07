import type { AgentRunResult, RunnerJobResult } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The structured-result mappings for the BUILT-IN container kinds whose reply the engine reads
// through a typed channel it acts on (`mergeAssessment` gates the real merge; `testReport`
// greenlights the run or loops the fixer; `onCallAssessment` decides whether a human is woken).
//
// These are the conservative coercions the bespoke harness handlers used to apply, moved
// backend-side when the harness collapsed to one generic `agent` kind, and moved HERE — beside
// the kind definitions — when the built-ins became real `registerAgentKind` entries. They hang
// off `AgentKindDefinition.mapStructuredResult`, which is what let the executor's parallel
// `agentKind === …` coercion chain collapse into one registry lookup.
//
// The property every one of them holds: **an unreadable reply lands on the CAUTIOUS side.** A
// garbage merge score reads as maximally severe (a human decides, never a silent auto-merge); a
// missing on-call confidence reads as 0 (do not imply a PR is at fault without evidence) with a
// `hold` recommendation; a tester greenlight is honoured only when no blocking concern is open.
// A judgement the platform could not read is not a judgement, and must not be spent as one.
// ---------------------------------------------------------------------------

/** The job summary trimmed, or a kind-specific fallback when the model returned none. */
export function summaryOr(result: RunnerJobResult, fallback: string): string {
  return result.summary?.trim() || fallback
}

/**
 * Clamp a value to a 0..1 number, defaulting to `fallback` for anything that is not a
 * finite number (or a non-empty numeric string). Crucially, `null`, `''`, `false` and `[]`
 * fall back rather than coercing to `0` — `Number()` turns all of them into a finite `0`,
 * which would silently make a garbage merger score read as "trivial/safe" and defeat the
 * conservative-on-garbage default that replaces the harness's old `diffExaminable` guard.
 */
function clamp01(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** First non-empty of the agent's rationale or run summary (capped), else a stable default. */
function coerceRationale(rationale: unknown, summary: string | undefined): string {
  if (typeof rationale === 'string' && rationale.trim()) return rationale
  if (summary?.trim()) return summary.slice(0, 2000)
  return 'No rationale provided.'
}

/** Narrow an unknown reply to an indexable object, so every read below is a plain lookup. */
function asObject(raw: unknown): Record<string, unknown> {
  return (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
}

/**
 * The `merger`'s structured JSON as the engine's merge assessment. A missing or garbage score
 * defaults to 1 (severe → routes to human review rather than a silent auto-merge) and the
 * rationale falls back to the agent's summary. The harness's old container-side `diffExaminable`
 * guard (force 1/1/1 when the base diff was unreadable) is not reproducible backend-side; the
 * conservative-on-garbage default covers the same risk.
 */
export function mergerResult(result: RunnerJobResult): AgentRunResult {
  const o = asObject(result.custom)
  return {
    output: summaryOr(result, 'Pull request assessed.'),
    mergeAssessment: {
      complexity: clamp01(o.complexity, 1),
      risk: clamp01(o.risk, 1),
      impact: clamp01(o.impact, 1),
      rationale: coerceRationale(o.rationale, result.summary),
    },
  }
}

/**
 * The `on-call` agent's structured JSON as the engine's release-regression assessment: a missing
 * confidence defaults to 0 (don't imply the PR is at fault without evidence) and a missing
 * recommendation to `hold` (a human decides). It never auto-reverts.
 */
export function onCallResult(result: RunnerJobResult): AgentRunResult {
  const o = asObject(result.custom)
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.filter((e): e is string => typeof e === 'string')
    : []
  return {
    output: summaryOr(result, 'Release regression investigated.'),
    onCallAssessment: {
      culpritConfidence: clamp01(o.culpritConfidence, 0),
      recommendation:
        o.recommendation === 'revert' || o.recommendation === 'monitor' ? o.recommendation : 'hold',
      rationale: coerceRationale(o.rationale, result.summary),
      evidence,
    },
  }
}

const TEST_SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
const TEST_STATUSES = new Set(['passed', 'failed', 'skipped'])

/** The per-test outcomes of a tester reply, every field defaulted safely. */
function coerceOutcomes(raw: unknown): { name: string; status: string; detail?: string }[] {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      name: typeof x.name === 'string' ? x.name : '(unnamed)',
      status: TEST_STATUSES.has(x.status as string) ? (x.status as string) : 'skipped',
      ...(typeof x.detail === 'string' && x.detail ? { detail: x.detail } : {}),
    }))
}

/** The concerns of a tester reply, defaulting an unrecognised severity to `medium`. */
function coerceConcerns(raw: unknown): { title: string; detail: string; severity: string }[] {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      title: typeof x.title === 'string' ? x.title : '(concern)',
      detail: typeof x.detail === 'string' ? x.detail : '',
      severity: TEST_SEVERITIES.has(x.severity as string) ? (x.severity as string) : 'medium',
    }))
}

/**
 * The screenshots a UI tester captured + uploaded (artifact ids): only the well-formed entries
 * (a view name AND an artifact id), passing the optionals through. Empty for the API tester.
 */
function coerceScreenshots(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .filter((x) => typeof x.view === 'string' && typeof x.artifactId === 'string')
    .map((x) => ({
      view: x.view as string,
      artifactId: x.artifactId as string,
      ...(typeof x.hash === 'string' && x.hash ? { hash: x.hash } : {}),
      ...(typeof x.width === 'number' ? { width: x.width } : {}),
      ...(typeof x.height === 'number' ? { height: x.height } : {}),
      ...(typeof x.referenceArtifactId === 'string' && x.referenceArtifactId
        ? { referenceArtifactId: x.referenceArtifactId }
        : {}),
    }))
}

/**
 * The Tester's ABORT reason: it reported it could not run a meaningful test at all (its env never
 * came up, a dependency is missing). The PRESENCE of the `abort` object is the signal, so a
 * blank/oversized `reason` must never downgrade that intent back into a (pointless) fixer loop:
 * fall back to a generic reason and cap it like `summary`, since it is shown to the human and
 * stored on the step verbatim.
 */
function coerceAbortReason(raw: unknown): string | undefined {
  const abort = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  if (!abort) return undefined
  const reason =
    typeof abort.reason === 'string' && abort.reason.trim()
      ? abort.reason.trim()
      : 'the Tester could not run a meaningful test'
  return reason.slice(0, 2000)
}

/**
 * A tester's structured JSON as the engine's `testReport`, defaulting every field safely so a
 * malformed reply still parses (the engine strict-validates it). Crucially a greenlight is
 * honoured ONLY when no BLOCKING (high/critical) concern is open and the run did not abort, so a
 * model that greenlights with an open blocker cannot auto-pass; low/medium concerns are advisory.
 * The engine's `TesterController` re-applies this rule defensively.
 *
 * The in-container docker-compose stand-up record (`infraSetup`) rides along so the engine can
 * persist its captured logs on the Tester step. Harness-produced, so no coercion; the controller
 * validates it defensively before persisting.
 */
export function testerResult(result: RunnerJobResult): AgentRunResult {
  const o = asObject(result.custom)
  const concerns = coerceConcerns(o.concerns)
  const blocking = concerns.some((c) => c.severity === 'high' || c.severity === 'critical')
  const environment =
    o.environment === 'local' || o.environment === 'ephemeral' ? o.environment : undefined
  const screenshots = coerceScreenshots(o.screenshots)
  const abortReason = coerceAbortReason(o.abort)
  return {
    output: summaryOr(result, 'Testing complete.'),
    testReport: {
      greenlight: o.greenlight === true && !blocking && !abortReason,
      summary:
        typeof o.summary === 'string' && o.summary
          ? o.summary
          : (result.summary?.slice(0, 2000) ?? ''),
      tested: Array.isArray(o.tested)
        ? (o.tested as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
      outcomes: coerceOutcomes(o.outcomes),
      concerns,
      ...(environment ? { environment } : {}),
      ...(screenshots.length ? { screenshots } : {}),
      ...(abortReason ? { abort: { reason: abortReason } } : {}),
    },
    ...(result.infraSetup ? { infraSetup: result.infraSetup } : {}),
  }
}
