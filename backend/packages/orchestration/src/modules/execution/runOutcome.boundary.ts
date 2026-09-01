import type {
  OutcomeConcern,
  OutcomeEnvironments,
  OutcomeRequirement,
  OutcomeRequirements,
  OutcomeSources,
  OutcomeTests,
  OutcomeVisuals,
  RunOutcome,
} from '@cat-factory/contracts'
import { redactSecrets } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The BOUNDARY treatment for the run outcome summary on its way out over
// `GET /api/v1/runs/:runId/outcome`.
//
// `composeRunOutcome` lives in `@cat-factory/contracts` because the SPA composes the same
// reduction live off its own store, and it is deliberately un-scrubbed and un-clamped for the
// same reason `run-evidence.ts` says its join is: handing the SPA escaped entities and elided
// prose would degrade the surface that renders into a DOM for a member who is already inside the
// workspace. What crosses the wire to an API key is a different exposure, and it is the one the
// verification report has always treated as such: the same tester summary, the same per-verdict
// evidence and the same spec titles are scrubbed and clamped on their way onto a pull request
// body and out of `GET /api/v1/runs/:runId/report`. Serving them verbatim beside that endpoint
// would have made the weaker of the two the one an integration reads.
//
// Two things happen here, in this order, and the order is the point:
//
//  1. **Scrub, at COMPOSE time, before any truncation** (the repo-wide rule): a model routinely
//     echoes a request URL or an auth header into its prose, and clamping first would leave half
//     a token in the payload with nothing to say it had been cut.
//  2. **BOUND what is unbounded**, recording every drop in `truncations`. A response whose size
//     is set by how much a model chose to write is not a contract a consumer can hold; a
//     response that says what it withheld is.
//
// Nothing here decides anything. Every count in the payload is computed over the WHOLE join
// before this function sees it, so a bounded rendering still reports the true totals: the caps
// touch what is SHOWN, never what is COUNTED.
// ---------------------------------------------------------------------------

/**
 * How much of one free-text field survives. Sized for a field a person reads whole (a tester's
 * observation against one requirement, its session summary), not for a transcript: a producer
 * that wrote more than this has written a document, and the endpoint that serves documents is
 * `/report`.
 */
const MAX_TEXT_CHARS = 2_000

/**
 * How many requirement rows one response carries. Above any real service's `spec/` (the largest
 * in this repo's own fixtures is two orders below it), so the cap is a ceiling on a pathological
 * case rather than a routine truncation, and `truncations` names it on the runs that hit it.
 */
const MAX_REQUIREMENT_ENTRIES = 500

/** How many tester areas and concerns one response carries. Same reasoning as the rows. */
const MAX_TESTER_LIST = 200

/**
 * How many environment rows one response carries. A run stands one up per involved service
 * frame, so this is the same pathological ceiling as the rows above, and the run's own frame
 * order is what a cap keeps.
 */
const MAX_ENVIRONMENT_ROWS = 50

/**
 * How many linked-source rows one response carries. A task links a handful of pages; the cap is
 * the same pathological ceiling the rows above are, and the run's own reading ORDER is what a cap
 * keeps, so the note needs no ordering caveat.
 */
const MAX_SOURCE_ROWS = 200

/** Scrub, then clamp. Null in, null out: an absent value is not an empty one. */
function text(value: string | null): string | null {
  const scrubbed = redactSecrets(value) ?? null
  if (scrubbed == null) return null
  return scrubbed.length <= MAX_TEXT_CHARS ? scrubbed : `${scrubbed.slice(0, MAX_TEXT_CHARS - 1)}…`
}

/** The same treatment where the field is non-nullable. */
function required(value: string): string {
  return text(value) ?? ''
}

/** The ONE shape a truncation note takes, matching the verification report's own vocabulary. */
function note(label: string, kept: number, total: number, detail?: string): string {
  return `${label}: showing ${kept} of ${total}${detail ? ` (${detail})` : ''}`
}

/** Cap a list, recording what it dropped. */
function cap<T>(
  items: readonly T[],
  label: string,
  truncations: string[],
  max: number,
  detail?: string,
): T[] {
  if (items.length <= max) return [...items]
  truncations.push(note(label, max, items.length, detail))
  return items.slice(0, max)
}

function boundRequirement(entry: OutcomeRequirement): OutcomeRequirement {
  return {
    id: required(entry.id),
    title: text(entry.title),
    verdict: entry.verdict,
    detail: text(entry.detail),
    state: entry.state,
    regression: entry.regression,
  }
}

function boundRequirements(
  requirements: OutcomeRequirements,
  truncations: string[],
): OutcomeRequirements {
  if (requirements.status === 'absent') return requirements
  return {
    status: 'reported',
    spec: requirements.spec,
    met: requirements.met,
    notMet: requirements.notMet,
    notCovered: requirements.notCovered,
    regressions: requirements.regressions,
    total: requirements.total,
    unmatchedVerdicts: requirements.unmatchedVerdicts,
    // The rows arrive ordered by SEVERITY, so a cap keeps the regressions and failures and drops
    // the least severe tail. Said in the note, because a reader who assumed the spec's own order
    // would conclude the missing requirements were never ruled on.
    entries: cap(
      requirements.entries,
      'requirements.entries',
      truncations,
      MAX_REQUIREMENT_ENTRIES,
      'ordered by severity, so the rows dropped are the least severe',
    ).map(boundRequirement),
  }
}

function boundConcern(concern: OutcomeConcern): OutcomeConcern {
  return { title: required(concern.title), severity: concern.severity }
}

function boundTests(tests: OutcomeTests, truncations: string[]): OutcomeTests {
  if (tests.status === 'absent') return tests
  return {
    status: 'reported',
    verdict: tests.verdict,
    summary: text(tests.summary),
    abortReason: text(tests.abortReason),
    areas: cap(tests.areas, 'tests.areas', truncations, MAX_TESTER_LIST).map(required),
    passed: tests.passed,
    failed: tests.failed,
    skipped: tests.skipped,
    concerns: cap(tests.concerns, 'tests.concerns', truncations, MAX_TESTER_LIST).map(boundConcern),
    // The environment is a closed shape of platform-recorded identifiers, not model prose.
    environment: tests.environment,
  }
}

function boundVisuals(visuals: OutcomeVisuals): OutcomeVisuals {
  if (visuals.status === 'absent') {
    return { status: 'absent', gap: visuals.gap, detail: text(visuals.detail) }
  }
  return {
    status: 'reported',
    source: visuals.source,
    phase: visuals.phase,
    // Bounded by the capture path, which caps how many views one run may store.
    views: visuals.views.map((view) => ({
      view: required(view.view),
      artifactId: view.artifactId,
      referenceArtifactId: view.referenceArtifactId,
    })),
  }
}

function boundEnvironments(
  environments: OutcomeEnvironments,
  truncations: string[],
): OutcomeEnvironments {
  if (environments.status === 'absent') return environments
  return {
    status: 'reported',
    entries: cap(environments.entries, 'environments', truncations, MAX_ENVIRONMENT_ROWS).map(
      (entry) => ({
        // The URL is supplied by the org's own provisioning API through the manifest's response
        // mapping, and an environment handed out with a token in its query string is a shape that
        // API is free to have. Scrubbed like any other provider-supplied string.
        url: text(entry.url),
        state: entry.state,
        origin: entry.origin,
        expiresAt: entry.expiresAt,
        retained: entry.retained,
        // Ids the platform minted, not authored text.
        frameId: entry.frameId,
        environmentId: entry.environmentId,
        // The provider's verbatim stderr, which is where a leaked credential comes from.
        detail: text(entry.detail),
        // Which claim that text is, from a closed pair the platform assigns: nothing to scrub, and
        // it travels WITH the text because a detail whose kind was dropped in scrubbing would be
        // rendered unlabelled, which is what the field exists to stop.
        detailKind: entry.detailKind,
      }),
    ),
  }
}

function boundSources(sources: OutcomeSources, truncations: string[]): OutcomeSources {
  if (sources.status === 'absent') return sources
  return {
    status: 'reported',
    sources: cap(sources.sources, 'sources', truncations, MAX_SOURCE_ROWS).map((source) => ({
      // Title and URL are authored on the SOURCE, by whoever owns the page, so they are the same
      // untrusted text the verification report scrubs before writing this row onto a PR body. A
      // document URL routinely carries a query string, which is where a share token would ride.
      title: required(source.title),
      url: text(source.url),
      origin: source.origin,
      // `version` is the source's own opaque revision token (a Figma file version, a git sha):
      // short, machine-shaped, and the one field a reviewer opens the source WITH, so it is
      // scrubbed like any other source-supplied string but never clamped away. The rest of the
      // variant is a closed vocabulary.
      freshness:
        source.freshness?.status === 'confirmed'
          ? { ...source.freshness, version: required(source.freshness.version) }
          : source.freshness,
      movedDuringRun: source.movedDuringRun,
    })),
  }
}

/**
 * The outcome summary as a public response body: scrubbed, clamped, bounded, and honest about
 * every drop.
 *
 * Rebuilt field by field rather than spread over the composed value, so a section added to
 * {@link RunOutcome} fails THIS build until someone has decided what its boundary treatment is.
 * A spread would have carried it out unscrubbed and compiled.
 */
export function boundOutcomeForApi(outcome: RunOutcome): RunOutcome {
  const truncations: string[] = [...outcome.truncations]
  return {
    version: outcome.version,
    disposition: outcome.disposition,
    title: required(outcome.title),
    ask: text(outcome.ask),
    pullRequests: outcome.pullRequests.map((pr) => ({
      url: required(pr.url),
      number: pr.number,
      branch: text(pr.branch),
      repo: text(pr.repo),
    })),
    requirements: boundRequirements(outcome.requirements, truncations),
    tests: boundTests(outcome.tests, truncations),
    visuals: boundVisuals(outcome.visuals),
    environments: boundEnvironments(outcome.environments, truncations),
    sources: boundSources(outcome.sources, truncations),
    // A closed vocabulary of enum members and one nullable enum: nothing here is authored text.
    checks: outcome.checks.map((check) => ({
      kind: check.kind,
      state: check.state,
      reproduction: check.reproduction,
    })),
    truncations,
  }
}
