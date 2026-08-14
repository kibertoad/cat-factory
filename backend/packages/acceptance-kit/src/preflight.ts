// The PREREQUISITE GATE: what must be true before a suite is allowed to spend anything.
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
//      throws on the first missing thing sends an operator round the loop once per problem. It is
//      the rule a configuration resolver follows for environment variables, applied to a deployment.
//   2. **"Unmet" and "could not be read" are different answers.** A probe that fails is not
//      evidence that the prerequisite is unsatisfied, and reporting it as one sends someone to
//      fix a model catalog when the real problem is that the deployment refused the request. So a
//      verdict is one of THREE states and an `unknown` on a required prerequisite blocks with a
//      message about the PROBE, not about the thing probed.
//   3. **A remedy travels with every negative verdict, and it is INSTRUCTIONS.** The value here is
//      not the refusal, it is that the refusal can be ACTED on without a second search: ordered
//      steps, and the exact command where a command exists. See `Remedy` for what that costs a
//      check to build and why a fix with no CLI states its screen rather than inventing one.
//
// The checks themselves belong to the SUITE: what a deployment must have wired to run a pass is a
// fact about the pass, and a kit that shipped a fixed list would be refusing over things a
// deployment testing its own agent kinds has no use for. This file holds the vocabulary, the runner
// and the pure reductions a report is rendered through. What a THROWN probe means (rule 2's
// `unknown` branch) lives in `probeFailure.ts`, which reads the whole cause chain through kernel
// rather than the one link `error.message` exposes.

import type { ConnectionFailureContext } from '@cat-factory/kernel'
import { probeFailureVerdict } from './probeFailure.js'
import type { SuiteIdentity } from './suiteIdentity.js'

/**
 * One command an operator can paste, with what it does.
 *
 * `purpose` is not decoration. Half of these reach a live cluster or a live deployment, and a
 * command whose effect a person cannot judge before running it is worse than the sentence it
 * replaced: they either run it blind or go and read the docs anyway.
 */
export type RemedyCommand = {
  run: string
  purpose: string
}

/**
 * How to fix ONE unmet prerequisite: what to do, what to run, and where to read the long version.
 *
 * **Commands are RENDERED, never illustrative.** A remedy is built by the check that just failed,
 * so it carries the values that check read (the workspace the key actually names, the account the
 * workspace is actually connected to, the template that failed to render) instead of an
 * `<angle-bracket>` the reader has to go and resolve. That is the whole difference between
 * instructions and a description of instructions.
 *
 * **A fix with no CLI names the screen instead.** `commands` is optional because minting an API
 * token, raising a budget and re-connecting a VCS account are console actions, and a
 * plausible-looking invented command sends someone to a shell that will refuse them. Where the
 * fix is done in the UI, a read-only command that CONFIRMS it landed is still worth carrying:
 * it is the half a terminal can do.
 */
export type Remedy = {
  /** Ordered, imperative, one action each. Never empty: a remedy with no step is not one. */
  steps: readonly string[]
  commands?: readonly RemedyCommand[]
  /** A repo-relative doc path or a URL that deepens the steps, which stay sufficient without it. */
  docs?: string
}

/** What one prerequisite check concluded. See rule 2 above for why `unknown` is its own state. */
export type PrerequisiteVerdict =
  | { status: 'satisfied'; detail: string }
  | { status: 'unsatisfied'; problem: string; remedy: Remedy }
  | { status: 'unknown'; probeFailure: string; remedy: Remedy }

/**
 * `required` refuses the pass; `advisory` is reported and never blocks.
 *
 * Advisory is for a condition a pass can genuinely proceed through (a pipeline the board has not
 * adopted yet materialises on first start), NOT for one nobody has got round to enforcing.
 * A prerequisite whose failure ends the pass an hour later is required, however awkward.
 */
export type PrerequisiteDisposition = 'required' | 'advisory'

export type Prerequisite<Context> = {
  /** Stable id, used as the step name in a preflight REPORT and as the journal event's subject. */
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

/**
 * The two verdict constructors, beside the type they build rather than private to whichever module
 * holds most of a suite's checks: those are routinely written across several (one that reads only
 * the CONFIG needs no client at all), and a second spelling of `{ status: … }` is how a verdict
 * shape drifts.
 */
export const satisfied = (detail: string): PrerequisiteVerdict => ({ status: 'satisfied', detail })

export const unsatisfied = (problem: string, remedy: Remedy): PrerequisiteVerdict => ({
  status: 'unsatisfied',
  problem,
  remedy,
})

export type PreflightReport = {
  results: readonly PrerequisiteResult[]
}

export type PreflightOptions = {
  /**
   * Who is running, for the refusal's closing line and for a thrown probe's remedy.
   *
   * Optional, because the runner itself needs nothing from it: what it costs to omit is the
   * suite-specific half of a refusal (which file holds the base URL, how a pass is resumed), and
   * `probeFailure.ts` states each of those only when it has been told.
   */
  identity?: SuiteIdentity
  /**
   * What a thrown probe REACHED, so it can be described against an address.
   *
   * Supplied as data rather than derived, because the runner is generic over `Context` and has no
   * business knowing that a suite's checks speak HTTP. Omitting it costs the target-naming half of
   * the remedy, never the cause.
   *
   * **It names ONE host, and that host is the deployment.** A check that reaches a DIFFERENT one (a
   * VCS provider's own API, a cluster addressed directly) cannot be described against this context,
   * because a value cannot be true for two hosts. Such a check describes its own failures where it
   * MAKES the call, through the same kernel describer, and answers an `unknown` verdict rather than
   * throwing: a context used for both halves would misattribute one of them, which is exactly what
   * `probeFailure.ts` exists to remove.
   */
  probe?: ConnectionFailureContext
  /** Called as each result lands, so a slow probe is not a silent one. */
  onResult?: (result: PrerequisiteResult) => void
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
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const results: PrerequisiteResult[] = []
  for (const prerequisite of prerequisites) {
    const verdict = await evaluate(prerequisite, context, options.probe, options.identity)
    const result = {
      id: prerequisite.id,
      what: prerequisite.what,
      disposition: prerequisite.disposition,
      verdict,
    }
    results.push(result)
    options.onResult?.(result)
  }
  return { results }
}

async function evaluate<Context>(
  prerequisite: Prerequisite<Context>,
  context: Context,
  probe: ConnectionFailureContext | undefined,
  identity: SuiteIdentity | undefined,
): Promise<PrerequisiteVerdict> {
  try {
    return await prerequisite.check(context)
  } catch (error) {
    // `probeFailure.ts` owns what a thrown value means, and the reason it is not three lines
    // inlined here is the whole point of that module: read as `error.message`, every transport
    // failure this gate can hit renders as undici's contentless `fetch failed`, so the remedy had
    // to list the causes it could not tell apart. It now names the one that happened.
    return probeFailureVerdict(error, probe, identity)
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
 * The instructions block: numbered steps, then the commands, then the doc.
 *
 * Commands are indented under a heading of their own rather than folded into the step that needs
 * them, so a whole block can be selected and pasted. Each is preceded by its purpose as a shell
 * comment, which means a paste of the block is itself a valid (and self-documenting) script.
 */
export function formatRemedy(remedy: Remedy, indent = ''): string {
  const lines = remedy.steps.map((step, index) => `${indent}  ${index + 1}. ${step}`)
  for (const [index, command] of (remedy.commands ?? []).entries()) {
    if (index === 0) lines.push(`${indent}  Run:`)
    lines.push(`${indent}    # ${command.purpose}`, `${indent}    ${command.run}`)
  }
  if (remedy.docs) lines.push(`${indent}  Docs: ${remedy.docs}`)
  return lines.join('\n')
}

/**
 * One failing prerequisite, in full: what it guarantees, what is wrong, and how to fix it.
 *
 * A preflight REPORT hands this to its per-prerequisite assertion and `formatPreflightFailure`
 * stacks it, so the instructions reach BOTH readers. Those are different people in practice: the one
 * reading one red claim in the report, and the one reading the one-error refusal the gate throws
 * before a resumed pass's first scenario.
 */
export function formatPrerequisiteFailure(result: PrerequisiteResult): string {
  const verdict = result.verdict
  if (verdict.status === 'satisfied') return `${result.id} (${result.what})\n  ${verdict.detail}`
  const cause =
    verdict.status === 'unsatisfied'
      ? `  ${verdict.problem}`
      : `  The check could not read an answer: ${verdict.probeFailure}\n` +
        `  This is NOT a verdict that the prerequisite is unmet; the probe itself failed.`
  return `${result.id} (${result.what})\n${cause}\n  Fix:\n${formatRemedy(verdict.remedy, '  ')}`
}

/**
 * The refusal, with every blocking prerequisite and its remedy.
 *
 * Returns null when nothing blocks, so the caller reads as `const failure = format(...); if
 * (failure) throw` rather than needing to ask two questions. Advisory notes ride along in the
 * message because a pass that is about to be refused for one reason is exactly when the other
 * five things worth knowing are cheapest to say.
 */
export function formatPreflightFailure(
  report: PreflightReport,
  identity?: SuiteIdentity,
): string | null {
  const blocking = blockingResults(report)
  if (blocking.length === 0) return null

  const lines = blocking.map((result) => `- ${formatPrerequisiteFailure(result)}`)

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
    `${lines.join('\n\n')}${noteBlock}` +
    // The suite's own doc, and only when it has one: an invented path is a reader sent to a file
    // that is not there, which is worse than a refusal that ends on its own instructions.
    (identity?.docs ? `\n\nSee ${identity.docs}.` : '')
  )
}

/** The pass's prerequisite gate: the driver's `assert`, and the report scenario's `evaluate`. */
export type PrerequisiteGate = {
  /**
   * Every prerequisite, evaluated FRESH, for the scenario that RENDERS them one claim at a time.
   *
   * What it also does is stand the result down for the next {@link PrerequisiteGate.assert}, which
   * is the whole reason the report scenario does not simply call the evaluation itself.
   */
  evaluate: () => Promise<PreflightReport>
  /** Refuse the pass unless every required prerequisite is satisfied. Throws the whole refusal. */
  assert: () => Promise<void>
}

/**
 * The gate the driver runs before every gated scenario, over a fresh evaluation, EXCEPT where one
 * was made for this pass a moment ago and nothing has happened since.
 *
 * Freshness is rule 0 and the reason there is no memo here: a pass takes an afternoon, so a
 * workspace that went over budget during the feature runs, or a model unwired between them, must be
 * refused before the next scenario spends rather than discovered as a run that stalls. A
 * pass-scoped memo would quietly turn the per-scenario gate into a once-per-pass one, which is also
 * what a resumed pass would skip entirely.
 *
 * The ONE exception is the seam between a preflight REPORT scenario and the first gated scenario,
 * and it is an exception because they are the same evaluation twice with nothing in between. The
 * report evaluates every prerequisite to render them as named claims; the next scenario's gate then
 * re-evaluated the identical set seconds later, which is a dozen duplicate round trips, every
 * verdict line printed to the operator twice, and two copies of each `prerequisite` entry in the
 * journal a status report reduces. So an evaluation is OFFERED to the next `assert` and consumed by it: exactly
 * once, whatever happens next, because the second gate of a pass is separated from the first by a
 * scenario that spent an afternoon and is precisely the one that must not reuse anything.
 */
export function createPrerequisiteGate(
  evaluate: () => Promise<PreflightReport>,
  identity?: SuiteIdentity,
): PrerequisiteGate {
  let standing: PreflightReport | null = null
  return {
    evaluate: async () => {
      const report = await evaluate()
      standing = report
      return report
    },
    assert: async () => {
      // Consumed BEFORE the verdict is read, so a refusal cannot leave a stale report standing for
      // whatever asks next.
      const report = standing ?? (await evaluate())
      standing = null
      const failure = formatPreflightFailure(report, identity)
      if (failure) throw new Error(failure)
    },
  }
}
