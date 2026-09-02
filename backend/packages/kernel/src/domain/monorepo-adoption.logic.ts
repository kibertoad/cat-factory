import {
  adoptionAreaSchema,
  adoptionSourceSchema,
  MAX_ADOPTION_DROP_LINES,
  type AdoptionArea,
  type AdoptionChoice,
  type AdoptionDecision,
  type AdoptionPlan,
  type AdoptionSource,
  type AdoptionSurvey,
  type ResolvedAdoption,
  type ResolvedAdoptionDecision,
} from '@cat-factory/contracts'
import * as hostMarkdown from '../shared/host-markdown.logic.js'
import { ValidationError } from './errors.js'

// ---------------------------------------------------------------------------
// The rules over a monorepo bootstrap's adoption plan: reading a model's proposal into the
// stored shape, settling a human review against it, and rendering the settled result as the
// brief the apply phase's agent works from.
//
// Pure (no repository, no model, no clock beyond what is passed), because every one of these
// is a place the flow can silently become useless, and the failure modes are only visible when
// they can be driven directly:
//
//   - a recommendation whose EVIDENCE names nothing the survey read is the model asserting a
//     monorepo convention it invented, and it is the one claim a reviewer cannot check by eye;
//   - a review that leaves a decision unanswered must be REFUSED, not defaulted onto the
//     recommendation, because "I agree" and "I did not look" are exactly what this step exists
//     to tell apart;
//   - a settled decision must reach the agent's brief in words that name a SIDE, since
//     "adopt from the monorepo" and "keep the template's" are the whole deliverable.
// ---------------------------------------------------------------------------

/** Cap on how many decisions one plan may carry, so a runaway reply can't produce a wall of them. */
export const MAX_ADOPTION_DECISIONS = 24

/**
 * A stored area this build no longer defines, named as the retired value it is.
 *
 * Deliberately NOT mapped onto a current member: nothing here knows which one was meant, and a
 * plan is PERSISTED, so a run parked before a vocabulary change is read back by exactly the
 * surface whose job is to tell a human what they are approving. Guessing would put a wrong
 * label on a decision that changes what gets built.
 */
function describeRetiredArea(area: never): string {
  return `'${String(area)}' (an area this deployment no longer defines; re-run the survey)`
}

/**
 * One convention area, in the words the review UI and the agent brief both use.
 *
 * The `default` is unreachable while the type is honoured, which is the point: adding a member
 * fails the build here, and a member RETIRED after a plan was stored still renders honestly
 * instead of splicing `undefined` into the sentence a human is deciding from.
 */
export function describeAdoptionArea(area: AdoptionArea): string {
  switch (area) {
    case 'build-tooling':
      return 'build tooling'
    case 'dependencies':
      return 'dependency versions and package management'
    case 'lint-format':
      return 'linting and formatting'
    case 'typecheck':
      return 'type checking'
    case 'testing':
      return 'test runner and test layout'
    case 'ci':
      return 'CI pipelines'
    case 'containerization':
      return 'containerization and image build'
    case 'runtime-config':
      return 'runtime configuration and secrets'
    case 'observability':
      return 'logging, metrics and tracing'
    case 'source-layout':
      return 'source layout and module structure'
    case 'docs':
      return 'documentation'
    case 'other':
      return 'other conventions'
    default:
      return describeRetiredArea(area)
  }
}

/** A stored side this build no longer defines. Same rule, same reason, as {@link describeRetiredArea}. */
function describeRetiredSource(source: never): string {
  return `'${String(source)}' (a choice this deployment no longer defines; re-run the survey)`
}

/** One side of the decision, as an instruction an agent can act on without further inference. */
export function describeAdoptionSource(source: AdoptionSource): string {
  switch (source) {
    case 'monorepo':
      return "adopt the monorepo's existing convention and drop the template's"
    case 'template':
      return "keep the reference template's version as-is"
    case 'both':
      return "compose the two: build on the monorepo's shared setup and layer the template's addition on top"
    case 'neither':
      return 'take neither: leave this out of the new service entirely'
    default:
      return describeRetiredSource(source)
  }
}

/** Whether a stored string is an area THIS build defines, narrowed from the schema's own options. */
export function isAdoptionArea(value: unknown): value is AdoptionArea {
  return (
    typeof value === 'string' && (adoptionAreaSchema.options as readonly string[]).includes(value)
  )
}

/** Whether a stored string is a choice THIS build defines, narrowed from the schema's own options. */
export function isAdoptionSource(value: unknown): value is AdoptionSource {
  return (
    typeof value === 'string' && (adoptionSourceSchema.options as readonly string[]).includes(value)
  )
}

/** What {@link parseAdoptionDecisions} produced, plus what it refused to carry through. */
export interface ParsedAdoptionDecisions {
  decisions: AdoptionDecision[]
  /** One line per dropped recommendation, naming it and why. Rendered to the reviewer. */
  dropped: string[]
}

/**
 * Every path a decision may cite: the transcript's reads that actually produced content, in the
 * prefixed form `evidence` uses.
 *
 * Deliberately NOT every path the transcript names. A read that came back `absent`, `unreadable`
 * or `refused` is in the record precisely because there was nothing behind it, so a
 * recommendation citing one is exactly the unsupported claim this check exists to drop: the
 * model would be reasoning from a file it was told it could not see.
 *
 * A survey whose transcript was WITHHELD (the list projection's `reads: null`) cites nothing, so
 * every decision is dropped. That is the safe direction and the only honest one: parsing runs
 * against the live session's own survey, and a caller reaching here with a projection has no
 * record to check a claim against.
 */
function surveyedPaths(survey: AdoptionSurvey): Set<string> {
  return new Set(
    (survey.reads ?? []).filter((read) => read.outcome === 'read').map((read) => read.path),
  )
}

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asNullableString(value: unknown, max: number): string | null {
  const text = asString(value, max)
  return text.length > 0 ? text : null
}

/**
 * Read a model's raw reply into the stored decision list, keeping only what it can support.
 *
 * The model is asked for `{ decisions: [...] }`; anything else is not a plan. Each decision has
 * to survive three checks, and each one is a way the review would otherwise mislead:
 *
 *  - a duplicate or missing `id` makes the human's answer unaddressable, so the line is dropped;
 *  - an area or recommendation outside the CURRENT vocabulary cannot be rendered or acted on;
 *  - evidence that names no path the survey actually read means the claim about the monorepo
 *    has nothing behind it. The line is dropped rather than shown unmarked, because a reviewer
 *    reads an unmarked line as something the platform checked.
 *
 * Every drop is REPORTED, never silent: a plan that lost half its lines to invention looks
 * exactly like a monorepo with few conventions, and those need opposite reactions.
 */
export function parseAdoptionDecisions(
  raw: unknown,
  survey: AdoptionSurvey,
): ParsedAdoptionDecisions {
  const dropped: string[] = []
  let unreported = 0
  /** Record a drop, or count it once the report is full (contracts' `MAX_ADOPTION_DROP_LINES`). */
  const drop = (line: string): void => {
    if (dropped.length < MAX_ADOPTION_DROP_LINES) dropped.push(line)
    else unreported += 1
  }
  const container = raw as { decisions?: unknown } | null
  const list = Array.isArray(container?.decisions) ? container.decisions : null
  if (!list) return { decisions: [], dropped: ['the reply carried no `decisions` array'] }

  const known = surveyedPaths(survey)
  const decisions: AdoptionDecision[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (decisions.length >= MAX_ADOPTION_DECISIONS) {
      drop(
        `the reply proposed more than ${MAX_ADOPTION_DECISIONS} decisions; the rest were not read`,
      )
      break
    }
    const item = entry as Record<string, unknown> | null
    if (!item || typeof item !== 'object') continue
    const id = asString(item.id, 80)
    const title = asString(item.title, 200)
    if (!id || !title) {
      drop(`a proposed decision had no id or title (${id || title || 'unnamed'})`)
      continue
    }
    if (seen.has(id)) {
      drop(`'${id}' was proposed twice; only the first was kept`)
      continue
    }
    if (!isAdoptionArea(item.area)) {
      drop(`'${title}' named an area this deployment does not define`)
      continue
    }
    if (!isAdoptionSource(item.recommended)) {
      drop(`'${title}' recommended a choice this deployment does not define`)
      continue
    }
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.filter((path): path is string => typeof path === 'string' && known.has(path))
      : []
    if (evidence.length === 0) {
      drop(`'${title}' cited no file the survey actually read, so it was not carried through`)
      continue
    }
    seen.add(id)
    decisions.push({
      id,
      area: item.area,
      title,
      monorepoPractice: asNullableString(item.monorepoPractice, 600),
      templatePractice: asNullableString(item.templatePractice, 600),
      recommended: item.recommended,
      rationale: asString(item.rationale, 600),
      evidence,
    })
  }
  if (unreported > 0) {
    dropped.push(`and ${unreported} further proposals were dropped for the same kinds of reason`)
  }
  return { decisions, dropped }
}

/**
 * Settle a human review against the plan it answers, or throw the refusal naming what is wrong.
 *
 * Refuses rather than repairs, on both sides of the mismatch. An UNANSWERED decision cannot be
 * defaulted to the recommendation without erasing the difference between agreeing with it and
 * never having read it, which is the single fact this whole step exists to record. An answer
 * naming a decision the plan does not have means the reviewer was looking at a different plan
 * (a stale tab, a re-run survey), and applying the rest of it would build under a review that
 * was never given for this proposal.
 */
export function resolveAdoptionReview(
  plan: AdoptionPlan,
  choices: readonly AdoptionChoice[],
  context: { reviewedByUserId: string | null; reviewedAt: number; notes?: string | undefined },
): ResolvedAdoption {
  // Deliberately NOT gated on `plan.status === 'ready'`. An `unavailable` plan carries no
  // decisions, so settling it answers nothing, but it is still the human's decision to make, and
  // refusing it strands the run: the review is the ONLY exit from the park, and a retry re-enters
  // the same phase. A deployment with no adoption model would then be unable to bootstrap into a
  // monorepo at all, which is the opposite of the "they just make it unaided" this flow promises.
  // The two checks below are what keep that safe: nothing to answer means nothing may be
  // answered, so a review aimed at a plan that has since been re-surveyed is still refused whole.
  const byId = new Map(choices.map((choice) => [choice.id, choice]))
  const unknown = choices.filter((choice) => !plan.decisions.some((d) => d.id === choice.id))
  if (unknown.length > 0) {
    throw new ValidationError(
      `The review answers decisions this plan does not contain: ${unknown
        .map((choice) => `'${choice.id}'`)
        .join(', ')}. Reload the plan and review it again.`,
      { reason: 'adoption_choice_unknown', ids: unknown.map((choice) => choice.id) },
    )
  }
  const missing = plan.decisions.filter((decision) => !byId.has(decision.id))
  if (missing.length > 0) {
    throw new ValidationError(
      `Every adoption decision must be answered; ${missing.length} ${
        missing.length === 1 ? 'is' : 'are'
      } still open: ${missing.map((decision) => `'${decision.title}'`).join(', ')}.`,
      { reason: 'adoption_review_incomplete', ids: missing.map((decision) => decision.id) },
    )
  }

  const decisions: ResolvedAdoptionDecision[] = plan.decisions.map((decision) => {
    // Total by construction: `missing` above already refused any decision with no answer.
    const choice = byId.get(decision.id) as AdoptionChoice
    return {
      id: decision.id,
      area: decision.area,
      title: decision.title,
      choice: choice.choice,
      overrodeRecommendation: choice.choice !== decision.recommended,
      note: choice.note?.trim() ? choice.note.trim() : null,
    }
  })
  const notes = context.notes?.trim()
  return {
    decisions,
    notes: notes ? notes : null,
    reviewedByUserId: context.reviewedByUserId,
    reviewedAt: context.reviewedAt,
  }
}

/**
 * How the settled review's model- and human-authored holes are written out.
 *
 * Two sinks, two rules, which is why this is a parameter rather than one renderer. The agent's
 * brief is a PROMPT: the text has to reach it as written, or a reviewer's instruction arrives
 * full of numeric entities and reads as noise. A pull request body is a RENDERED HOST SURFACE,
 * where the same characters are live: `#123` auto-links, a closing keyword before an issue
 * reference CLOSES that issue on merge, `@name` mentions a stranger, and an unbalanced fence
 * swallows everything after it. So the PR side neutralises every hole and the prompt side does
 * not, and neither can be mistaken for the other at the call site.
 */
interface AdoptionTextSink {
  /** A short single-line hole: a decision title, a per-decision note. */
  inline(value: string): string
  /** A multi-line hole: the reviewer's notes for the service as a whole. */
  prose(value: string): string
}

/** The prompt sink: verbatim, because the reader is a model and the text is its instruction. */
const AGENT_SINK: AdoptionTextSink = { inline: (value) => value, prose: (value) => value }

/** The host sink: every auto-link trigger neutralised, every hole capped and fence-balanced. */
const HOST_SINK: AdoptionTextSink = {
  inline: (value) => hostMarkdown.inline(value),
  prose: (value) => hostMarkdown.prose(value),
}

/** The shared body of both renderings; only the holes differ (see {@link AdoptionTextSink}). */
function renderAdoptionDecisions(
  resolved: ResolvedAdoption,
  sink: AdoptionTextSink,
  lead: string,
): string {
  const lines: string[] = [
    `## Adoption decisions (settled by a human reviewer; follow them exactly)`,
    '',
    lead,
    '',
  ]
  if (resolved.decisions.length === 0) {
    lines.push(
      '_The reviewer settled no areas: follow the surrounding monorepo wherever it has an ' +
        'established convention, and the template only where it does not._',
      '',
    )
  }
  for (const decision of resolved.decisions) {
    const override = decision.overrodeRecommendation ? ' (reviewer overrode the suggestion)' : ''
    lines.push(
      `- **${sink.inline(decision.title)}** (${describeAdoptionArea(decision.area)}): ` +
        `${describeAdoptionSource(decision.choice)}${override}.` +
        (decision.note ? `\n  Reviewer's note: ${sink.inline(decision.note)}` : ''),
    )
  }
  if (resolved.notes) {
    lines.push('', '### Reviewer notes for the service as a whole', '', sink.prose(resolved.notes))
  }
  return lines.join('\n')
}

/**
 * Render the settled review as the adoption section of the apply phase's brief.
 *
 * Every decision is stated as a SIDE plus the reviewer's own words where they left any, and the
 * overrides are called out: an agent told only "use the monorepo's test runner" cannot tell a
 * default it may reason around from a human who deliberately overruled the recommendation, and
 * the second is not negotiable. The list is exhaustive on purpose: an area the reviewer settled
 * and the brief omits is an area the agent decides again, unreviewed.
 *
 * The holes are VERBATIM here. {@link renderAdoptionPrSection} is the rendering for the pull
 * request; do not send this one to a host.
 */
export function renderAdoptionBrief(resolved: ResolvedAdoption, directory: string): string {
  return renderAdoptionDecisions(
    resolved,
    AGENT_SINK,
    `The new service lives at \`${directory}\`. For each area below, a reviewer has decided ` +
      `whether it follows the surrounding monorepo or the reference template. These are ` +
      `decisions, not suggestions: do not substitute your own judgement for one of them, and ` +
      `if a decision turns out to be impossible as stated, do the closest thing that honours it ` +
      `and say so in the pull request description rather than quietly picking the other side.`,
  )
}

/**
 * Render the settled review for the PULL REQUEST the apply phase opens.
 *
 * The same list, addressed to the human reviewing the change rather than to the agent making it:
 * what a reviewer of a bootstrap PR is being asked is whether the service fits the monorepo, and
 * what settles that is which side each area came from and who chose it, which the diff cannot
 * show. Every hole crosses {@link HOST_SINK}, because both the titles (model-authored) and the
 * notes (reviewer-authored) are untrusted text landing on a parsed surface. The caller scrubs
 * secrets at compose time, before any of this is capped.
 */
export function renderAdoptionPrSection(resolved: ResolvedAdoption, directory: string): string {
  const overrides = resolved.decisions.filter((decision) => decision.overrodeRecommendation).length
  const stance =
    resolved.decisions.length === 0
      ? 'with no suggestion to review: the platform could not produce one'
      : overrides > 0
        ? `${overrides} of which overrode the platform's suggestion`
        : "all of which accepted the platform's suggestion"
  return renderAdoptionDecisions(
    resolved,
    HOST_SINK,
    `This service was bootstrapped into \`${hostMarkdown.inline(directory)}\` under decisions ` +
      `settled by a human before any code was written, ${stance}. Each line below names the ` +
      `area, the side the new service follows for it, and anything the reviewer added.`,
  )
}

/**
 * The default branch name for a monorepo bootstrap's pull request.
 *
 * Derived from the run's own id rather than the service name so two bootstraps of similarly
 * named services can never collide on one branch, and stable per run so a retry of the SAME run
 * resumes its branch instead of opening a second pull request against the monorepo.
 */
export function monorepoBootstrapBranch(jobId: string): string {
  return `cat-factory/bootstrap-${jobId}`
}
