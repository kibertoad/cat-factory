import { integrationTestOutcome } from '@cat-factory/agents'

// Pure rendering for the `integration-test` post-completion resolver: fold its STRUCTURED outcome
// (`result.custom`, the `integrationTestOutcome` schema) into a short prose digest that lands on
// `step.output`. Downstream steps read only `step.output` via `priorOutputs`, so this digest is how
// the coverage verdict reaches the merger (which weighs it in the merge assessment) and a human at
// the merge gate; the raw structured object stays on `step.custom` for the `generic-structured`
// result view. Returns `undefined` for an unparseable/empty result, so the resolver leaves the
// agent's raw reply on `step.output`.

/** Human-readable heading for each coverage outcome. */
const OUTCOME_LABEL: Record<string, string> = {
  covered: 'Covered by committed tests',
  partial: 'Partially covered',
  uncovered: 'Not covered: no test was committed',
}

/**
 * Render an integration-test step's structured outcome into a human-readable digest, or
 * `undefined`.
 *
 * The `Not covered` section is rendered whenever the agent named a gap, INCLUDING under a
 * `covered` verdict: the two are not in tension (the reported behaviour can be covered while a
 * neighbouring case is not), and a gap the reply stated is the one thing a reader cannot recover
 * from anywhere else. Dropping it under a green heading is how "covered" comes to mean more than
 * the step ever claimed.
 */
export function renderIntegrationTestDigest(custom: unknown): string | undefined {
  const parsed = integrationTestOutcome.safeParse(custom)
  if (!parsed) return undefined
  const lines: string[] = [
    '## Integration tests',
    '',
    OUTCOME_LABEL[parsed.outcome] ?? parsed.outcome,
  ]

  const section = (heading: string, values: readonly string[], bullet: (v: string) => string) => {
    const kept = values.map((value) => value.trim()).filter((value) => value.length > 0)
    if (kept.length) lines.push('', `### ${heading}`, '', ...kept.map(bullet))
  }

  section('Tests', parsed.testPaths, (path) => `- \`${path}\``)
  section('Test doubles', parsed.mocks, (mock) => `- \`${mock}\``)
  section('Not covered', parsed.uncovered, (gap) => `- ${gap}`)

  const notes = parsed.notes?.trim()
  if (notes) lines.push('', '### Notes', '', notes)

  return lines.join('\n')
}

/**
 * The `tests` section's absent NOTE for a run that verified through COMMITTED tests instead of a
 * tester step, or `undefined` when this run has nothing of the sort to report.
 *
 * It exists because the plain no-tester note ("no test run was performed by the platform") is a
 * claim, not an absence, and on `pl_bugfix_tested` it is the wrong one: a suite did run, and the
 * tests it ran are in the diff the reviewer is reading. A reviewer told only that no tester ran
 * concludes the change is unverified, which is the exact misreading the report exists to prevent.
 *
 * The counts are COMPUTED from the step's own stated lists rather than read off a claim, and the
 * note carries no model-authored prose, so it stays an engine statement about the run: which is
 * what lets it be interpolated into the rendered section like every other note.
 */
export function integrationTestVerificationNote(custom: unknown): string | undefined {
  const parsed = integrationTestOutcome.safeParse(custom)
  if (!parsed) return undefined
  const tests = parsed.testPaths.filter((path) => path.trim().length > 0).length
  const gaps = parsed.uncovered.filter((gap) => gap.trim().length > 0).length
  const counts = [
    `${tests} test ${tests === 1 ? 'file' : 'files'}`,
    `${gaps} stated ${gaps === 1 ? 'gap' : 'gaps'}`,
  ].join(', ')
  return (
    'No tester step in this pipeline: this run verified the change from the repository instead. ' +
    `The integration-test step reported "${OUTCOME_LABEL[parsed.outcome] ?? parsed.outcome}" ` +
    `(${counts}), and the CI gate is what runs those tests. See the step's own report for the ` +
    'detail.'
  )
}
