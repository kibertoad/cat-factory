import type { TaskEstimate, TaskEstimateBasis } from '@cat-factory/kernel'
import { isTaskEstimateBasis } from '@cat-factory/contracts'
import { extractJson } from '../requirements/requirements.logic.js'

// Pure helpers for the two steps that write a task's triage scores: the inline `task-estimator`,
// which FORECASTS them before any design work, and the container `task-reassessor`, which MEASURES
// them afterwards against the change that landed. Both hand their reply here to be coerced into a
// {@link TaskEstimate}; `reviseTaskEstimate` then decides what the block should hold, and
// `summarizeEstimate` renders the readable summary the board shows in place of the raw JSON.
//
// Kept pure (no I/O) for unit testing. The tolerant JSON extraction is the shared `extractJson`
// helper (same package).

/** Clamp a finite number into [0,1]; null for anything non-numeric. */
function clamp01(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

/**
 * Coerce a triage reply into a {@link TaskEstimate}. Tolerant: accepts a JSON object embedded in
 * prose (both producers return the JSON as their reply TEXT, which is what lets an unreadable one
 * cost nothing), clamps the three axes to [0,1], and defaults a missing rationale to empty.
 *
 * Returns null when no usable scores are present, and the CALLER then leaves the block's estimate
 * untouched. That is the cautious reading for this record: unlike a merge assessment, whose absence
 * has to resolve to something the engine can act on, nothing acts on an estimate structurally, so
 * an unreadable reply must record nothing rather than invent a maximally severe task and quietly
 * change what every estimate gate decides.
 *
 * `basis` says what the scores were formed on and is supplied by the CALLER, never read off the
 * reply: it follows from which step ran, and a model cannot promote its own forecast to a
 * measurement by claiming one.
 */
export function coerceTaskEstimate(
  output: string,
  model: string | null,
  now: number,
  basis: TaskEstimateBasis = 'predicted',
): TaskEstimate | null {
  const raw = extractJson(output)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const complexity = clamp01(obj.complexity)
  const risk = clamp01(obj.risk)
  const impact = clamp01(obj.impact)
  if (complexity === null || risk === null || impact === null) return null
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : ''
  return { complexity, risk, impact, rationale, model, createdAt: now, basis }
}

/**
 * What the block should hold once `next` is produced: `next` itself, carrying the last reading of
 * the OTHER basis, so a forecast survives the measurement that corrected it and stays readable
 * beside it.
 *
 * Three cases, and the third is the one worth stating:
 *
 *  - No prior reading: nothing was superseded, so nothing is recorded.
 *  - A prior reading of the other basis: it becomes `next.supersedes`, ONE level deep (its own
 *    `supersedes` is dropped), so a board row carries the pair rather than an unbounded chain.
 *  - A prior reading of the SAME basis: it is `next`'s predecessor, not its counterpart, so
 *    recording it would render a forecast/measurement comparison that never happened. The pair it
 *    was already carrying is INHERITED instead. Without that, a retried step (or a second
 *    measurement) would delete the forecast the comparison exists for, which is the opposite of
 *    what re-measuring is for.
 */
export function reviseTaskEstimate(
  prior: TaskEstimate | null | undefined,
  next: TaskEstimate,
): TaskEstimate {
  if (!prior) return next
  const priorBasis = prior.basis ?? 'predicted'
  if (priorBasis === next.basis) {
    return prior.supersedes ? { ...next, supersedes: prior.supersedes } : next
  }
  return {
    ...next,
    supersedes: {
      complexity: prior.complexity,
      risk: prior.risk,
      impact: prior.impact,
      basis: priorBasis,
      model: prior.model ?? null,
      createdAt: prior.createdAt,
    },
  }
}

/** The three axes, in the order every surface reads them. */
const AXES = ['complexity', 'risk', 'impact'] as const

/**
 * How each basis titles itself for a human: a forecast and a measurement read differently, and a
 * summary that called both "estimate" would leave a reader with no way to tell which one they are
 * looking at.
 *
 * An exhaustive `Record`, so a third basis fails the build here rather than rendering as
 * `undefined`. What it cannot cover is the other direction: `basis` is PERSISTED, read back with a
 * plain `JSON.parse` (no schema pass), and both absent and RETIRED values reach this function. See
 * {@link basisTitle} for what each of those means.
 */
const BASIS_TITLE: Record<TaskEstimateBasis, string> = {
  predicted: 'Task estimate (predicted)',
  observed: 'Task assessment (from the change that landed)',
}

/**
 * A basis this build cannot name. Said out loud rather than guessed onto a current member: the
 * scores are still real and worth showing, and nothing here knows which basis a retired member
 * meant.
 */
const UNKNOWN_BASIS_TITLE = 'Task triage (basis no longer recognised)'

/**
 * The title for a stored basis. Three cases, deliberately distinct:
 *   - ABSENT: a row written before the vocabulary existed, and every one of those came from the
 *     estimator, so `predicted` is a fact about it rather than a default standing in for one.
 *     `null` is the SAME case, not the unrecognised one: the field is optional on the schema but
 *     the record round-trips through JSON, where an absent value is routinely written back as
 *     `null`, and reporting an old forecast as "recorded by another version" would be a louder
 *     lie than the silence it replaced.
 *   - a member this build knows: its own title.
 *   - anything else: {@link UNKNOWN_BASIS_TITLE}.
 */
function basisTitle(basis: string | null | undefined): string {
  if (basis === undefined || basis === null) return BASIS_TITLE.predicted
  return isTaskEstimateBasis(basis) ? BASIS_TITLE[basis] : UNKNOWN_BASIS_TITLE
}

const pct = (n: number): string => `${Math.round(n * 100)}%`

/**
 * A concise markdown summary of an estimate for the step's reviewable output, and (via
 * `step.output`) the text later steps read as prior context.
 *
 * When the record superseded one of the other basis, the summary states the movement between them.
 * That delta is DERIVED here from the two records rather than read off any reply: what changed
 * between a forecast and a measurement is arithmetic, and a model asked to report it would be
 * reporting on a number it was deliberately never shown.
 */
export function summarizeEstimate(estimate: TaskEstimate): string {
  const scores = AXES.map(
    (axis) => `${axis[0]!.toUpperCase()}${axis.slice(1)} ${pct(estimate[axis])}`,
  ).join(' · ')
  const header = `**${basisTitle(estimate.basis)}**: ${scores}`
  const prior = estimate.supersedes
  const movement = prior
    ? `Was ${basisTitle(prior.basis)}: ` +
      AXES.map((axis) => `${axis} ${pct(prior[axis])} → ${pct(estimate[axis])}`).join(', ')
    : null
  return [header, movement, estimate.rationale || null].filter(Boolean).join('\n\n')
}
