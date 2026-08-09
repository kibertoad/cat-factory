// The PREREQUISITE GATE: what must be true before this suite is allowed to spend anything.
//
// A pass costs an afternoon and real model spend, and almost every setup mistake it can make is
// discovered LATE and wearing a misleading face: an unwired model looks like a broken dispatcher,
// a connection without `workflows: write` looks like a repository whose CI never triggers, and a
// preset that holds every merge for a person looks like a run that stalled at the last step. Each
// of those is one cheap read away from being stated correctly before anything is created.
//
// Three rules shape this module, and each is the reason for a piece of its vocabulary:
//
//   1. **Every prerequisite is evaluated, and every failure is reported together.** A gate that
//      throws on the first missing thing sends an operator round the loop once per problem. This
//      is the same rule `config.ts` follows for environment variables, applied to the deployment.
//   2. **"Unmet" and "could not be read" are different answers.** A probe that fails is not
//      evidence that the prerequisite is unsatisfied, and reporting it as one sends someone to
//      fix a model catalog when the real problem is that the app API refused the request. So a
//      verdict is one of THREE states and an `unknown` on a required prerequisite blocks with a
//      message about the PROBE, not about the thing probed.
//   3. **A remedy travels with every negative verdict.** The value here is not the refusal, it is
//      that the refusal names the next action.
//
// The checks themselves live in `prerequisites.ts`. This file holds the vocabulary, the runner and
// the pure reductions the specs and `test/preflight.test.ts` assert on.

/** What one prerequisite check concluded. See rule 2 above for why `unknown` is its own state. */
export type PrerequisiteVerdict =
  | { status: 'satisfied'; detail: string }
  | { status: 'unsatisfied'; problem: string; remedy: string }
  | { status: 'unknown'; probeFailure: string; remedy: string }

/**
 * `required` refuses the pass; `advisory` is reported and never blocks.
 *
 * Advisory is for a condition the suite can genuinely proceed through (a pipeline the board has
 * not adopted yet materialises on first start), NOT for one nobody has got round to enforcing.
 * A prerequisite whose failure ends the pass an hour later is required, however awkward.
 */
export type PrerequisiteDisposition = 'required' | 'advisory'

export type Prerequisite<Context> = {
  /** Stable id, used as the test name in spec 00 and as the journal event's subject. */
  id: string
  /** What holding this prerequisite guarantees, phrased for the person reading a failure. */
  what: string
  disposition: PrerequisiteDisposition
  check: (context: Context) => Promise<PrerequisiteVerdict>
}

export type PrerequisiteResult = {
  id: string
  what: string
  disposition: PrerequisiteDisposition
  verdict: PrerequisiteVerdict
}

export type PreflightReport = {
  results: readonly PrerequisiteResult[]
}

/**
 * Run every prerequisite, never short-circuiting.
 *
 * Sequential rather than concurrent on purpose: these probe a deployment that is about to be
 * asked to do real work, and the reads are cheap enough that ordering them costs nothing while
 * making the streamed output readable top to bottom.
 *
 * A check that THROWS becomes an `unknown` verdict rather than escaping: one probe blowing up
 * must not cost the report of the other seven, which is rule 1.
 */
export async function runPreflight<Context>(
  prerequisites: readonly Prerequisite<Context>[],
  context: Context,
  onResult?: (result: PrerequisiteResult) => void,
): Promise<PreflightReport> {
  const results: PrerequisiteResult[] = []
  for (const prerequisite of prerequisites) {
    const verdict = await evaluate(prerequisite, context)
    const result = {
      id: prerequisite.id,
      what: prerequisite.what,
      disposition: prerequisite.disposition,
      verdict,
    }
    results.push(result)
    onResult?.(result)
  }
  return { results }
}

async function evaluate<Context>(
  prerequisite: Prerequisite<Context>,
  context: Context,
): Promise<PrerequisiteVerdict> {
  try {
    return await prerequisite.check(context)
  } catch (error) {
    return {
      status: 'unknown',
      probeFailure: `the check threw: ${error instanceof Error ? error.message : String(error)}`,
      remedy:
        'Fix the probe failure above, then re-run. This is not a verdict on the prerequisite.',
    }
  }
}

/** The results that must stop the pass: a required prerequisite that is not `satisfied`. */
export function blockingResults(report: PreflightReport): readonly PrerequisiteResult[] {
  return report.results.filter(
    (result) => result.disposition === 'required' && result.verdict.status !== 'satisfied',
  )
}

/** Advisory results worth printing: anything not `satisfied`. */
export function advisoryNotes(report: PreflightReport): readonly PrerequisiteResult[] {
  return report.results.filter(
    (result) => result.disposition === 'advisory' && result.verdict.status !== 'satisfied',
  )
}

/** One line per prerequisite, for the live output. */
export function formatPreflightLine(result: PrerequisiteResult): string {
  const mark = { satisfied: 'ok  ', unsatisfied: 'FAIL', unknown: '????' }[result.verdict.status]
  return `  ${mark} ${result.id}: ${describeVerdict(result.verdict)}`
}

function describeVerdict(verdict: PrerequisiteVerdict): string {
  if (verdict.status === 'satisfied') return verdict.detail
  if (verdict.status === 'unsatisfied') return verdict.problem
  return `could not be checked: ${verdict.probeFailure}`
}

/**
 * The refusal, with every blocking prerequisite and its remedy.
 *
 * Returns null when nothing blocks, so the caller reads as `const failure = format(...); if
 * (failure) throw` rather than needing to ask two questions. Advisory notes ride along in the
 * message because a pass that is about to be refused for one reason is exactly when the other
 * five things worth knowing are cheapest to say.
 */
export function formatPreflightFailure(report: PreflightReport): string | null {
  const blocking = blockingResults(report)
  if (blocking.length === 0) return null

  const lines = blocking.map((result) => {
    const verdict = result.verdict
    // `blockingResults` already excluded `satisfied`, but the narrowing has to be re-stated for
    // the compiler; doing it as an early return keeps the two negative branches exhaustive, so a
    // fourth verdict status could not be added without failing here.
    if (verdict.status === 'satisfied')
      return `- ${result.id} (${result.what})\n  ${verdict.detail}`
    const cause =
      verdict.status === 'unsatisfied'
        ? `  ${verdict.problem}`
        : `  The check could not read an answer: ${verdict.probeFailure}\n` +
          `  This is NOT a verdict that the prerequisite is unmet; the probe itself failed.`
    return `- ${result.id} (${result.what})\n${cause}\n  Fix: ${verdict.remedy}`
  })

  const notes = advisoryNotes(report)
  const noteBlock =
    notes.length === 0
      ? ''
      : `\n\nAlso worth knowing (these do not block):\n` +
        notes.map((note) => `- ${note.id}: ${describeVerdict(note.verdict)}`).join('\n')

  return (
    `The deployment is not ready for an acceptance pass: ` +
    `${blocking.length} of ${report.results.length} prerequisite(s) are not satisfied.\n\n` +
    `Nothing was created. Every one of these would otherwise surface much later in the pass, ` +
    `after real model spend, wearing a failure that names something else.\n\n` +
    `${lines.join('\n\n')}${noteBlock}\n\n` +
    `See backend/internal/acceptance/README.md#prerequisites.`
  )
}
