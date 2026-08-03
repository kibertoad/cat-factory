// The cross-SDK comparison: the part of this harness that is not "does the SDK work" but "do the
// four SDKs agree".
//
// Each SDK's smoketest program drives the same scenario and writes the same observation report.
// Comparing those reports catches a class of bug a per-SDK test structurally cannot: one language
// decoding a field differently, mapping a refusal to the wrong error class, collapsing a null into
// an absence, or paginating one page short. Those show up as a DISAGREEMENT between reports even
// when nobody wrote down what the right answer was — which matters here because the four clients
// are generated from one spec and are supposed to be interchangeable.

/** One SDK's report, as written by its smoketest program. */
export interface SdkReport {
  sdk: string
  sdkVersion: string
  observations: Record<string, unknown>
  failures: string[]
}

export interface ParityProblem {
  kind: 'failure' | 'disagreement' | 'missing' | 'expectation'
  detail: string
}

/**
 * Observations that are ENVIRONMENTAL rather than behavioural, and so may legitimately differ
 * between SDKs.
 *
 * The list is deliberately tiny and each entry has to earn its place: every exclusion is a place
 * where a real divergence would go unreported, so "these numbers move around" is not a reason —
 * only "these two SDKs cannot be expected to observe the same value" is.
 */
const ENVIRONMENTAL = new Set([
  // Each SDK creates its own task, so the workspace's task count grows as the four run in
  // sequence. The invariant that matters (each SDK sees ITS OWN task in the paged results) is
  // asserted separately, below, as `pagedContainsCreated`.
  'pagedTaskCount',
  'notificationCount',
  'pageHasCursor',
  // A run's progress at the moment each SDK looked. How many SSE frames arrived before the
  // scenario's own cap, and which state the run had reached, are timing-dependent — what must
  // agree is that every frame was a KNOWN frame and that the run status was a known one.
  'sseEventCount',
  'sseFirstEvent',
  'startedStatus',
  'stoppedStatus',
  'fetchedStatus',
  'runHasSteps',
])

/**
 * Observations that must hold in EVERY SDK, regardless of what the others saw.
 *
 * These are the absolute claims — a 404 is a 404 — as opposed to the relative ones the
 * disagreement check covers. Both matter: an absolute check catches all four SDKs being wrong the
 * same way, which a purely comparative check cannot see.
 */
const EXPECTED: Record<string, unknown> = {
  firstServiceHasId: true,
  createdStatus: 'planned',
  createdTaskType: 'feature',
  // The required-but-nullable pair. Reported as an explicit boolean by every SDK, because
  // "the server said null" and "the server said nothing" must not collapse into one another.
  createdExecutionIdIsNull: true,
  createdPullRequestUrlIsNull: true,
  updatedTitle: 'SDK smoketest task (edited)',
  fetchedTitle: 'SDK smoketest task (edited)',
  pageSize: 1,
  pagedContainsCreated: true,
  pagedHasDuplicates: false,
  usageRowsIsArray: true,
  notFoundIsTypedClass: true,
  notFoundStatus: 404,
  notFoundCode: 'not_found',
  notFoundHasRequestId: true,
  unauthorizedIsTypedClass: true,
  unauthorizedStatus: 401,
  forbiddenIsTypedClass: true,
  forbiddenStatus: 403,
  // The surface-specific code the SDKs deliberately do NOT narrow to an enum. All four must
  // surface it verbatim rather than flattening it to the status class.
  forbiddenCode: 'insufficient_scope',
  startedHasExecutionId: true,
  sseFramesAreKnown: true,
  runStatusIsKnown: true,
  deletedThenGone: true,
}

/**
 * Compare the reports.
 *
 * Returns every problem found rather than the first: a run that reports "the Go SDK disagrees on
 * `notFoundCode`" and stops is markedly less useful than one that reports all four divergences at
 * once, because they are usually one root cause and reading them together is what shows it.
 */
export function compareReports(reports: SdkReport[]): ParityProblem[] {
  const problems: ParityProblem[] = []

  for (const report of reports) {
    for (const failure of report.failures) {
      problems.push({ kind: 'failure', detail: `[${report.sdk}] ${failure}` })
    }
  }

  // Every key any SDK observed. Using the UNION rather than one SDK's keys is what makes a key
  // that a single SDK failed to record show up as `missing` instead of silently narrowing the
  // comparison to whatever the first report happened to contain.
  const keys = [...new Set(reports.flatMap((report) => Object.keys(report.observations)))].sort()

  for (const key of keys) {
    const absent = reports.filter((report) => !(key in report.observations))
    if (absent.length > 0 && absent.length < reports.length) {
      problems.push({
        kind: 'missing',
        detail: `'${key}' was observed by ${reports.length - absent.length}/${reports.length} SDKs; ${absent
          .map((report) => report.sdk)
          .join(', ')} did not record it`,
      })
      continue
    }

    if (key in EXPECTED) {
      for (const report of reports) {
        const actual = report.observations[key]
        if (!sameValue(actual, EXPECTED[key])) {
          problems.push({
            kind: 'expectation',
            detail: `[${report.sdk}] '${key}' is ${render(actual)}, expected ${render(EXPECTED[key])}`,
          })
        }
      }
      continue
    }

    if (ENVIRONMENTAL.has(key)) continue

    const first = reports[0]
    if (!first) continue
    const disagreeing = reports.filter(
      (report) => !sameValue(report.observations[key], first.observations[key]),
    )
    if (disagreeing.length > 0) {
      const rendered = reports
        .map((report) => `${report.sdk}=${render(report.observations[key])}`)
        .join(', ')
      problems.push({ kind: 'disagreement', detail: `'${key}' differs across SDKs: ${rendered}` })
    }
  }

  return problems
}

/**
 * Structural equality across languages.
 *
 * JSON is the common denominator, but the languages do not all round-trip a number the same way:
 * Go writes an integer count as `3` while a JS `JSON.stringify` of the same value is also `3`, yet
 * Python's float-typed model fields can surface `3.0`. Comparing numbers numerically (rather than
 * by their JSON text) is what keeps that from reading as a behavioural divergence.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

function render(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value)
}
