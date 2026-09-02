import type { AdoptionReadOutcome, AdoptionSurvey } from '@cat-factory/contracts'

// The monorepo bootstrap's SUGGESTION seam. The platform seeds an opening context (each side's
// root listing and convention files, plus the sibling services beside the target) through the
// checkout-free `RepoFiles` port, and the model then WIDENS it through a bounded tool loop over
// the same port before judging what to adopt. So it sits behind this port exactly as
// `BugHuntAssessor` and `JudgeAssessor` do: the facades wire the inline implementation from the
// model dependencies they already supply, and the conformance harness swaps in a deterministic
// fake, which is what lets the whole rest of the flow (survey, park, review, refusals, apply) be
// asserted on every runtime with no model wired.
//
// What the platform keeps is the BOOKKEEPING, not the choice of what to read: every read is
// budgeted and recorded by the {@link MonorepoAdoptionExplorer} below, so a recommendation is
// still checkable against a transcript the model could not have written.
//
// `enabled === false` (no provider, or no routing default) is NOT a failure: the run still
// parks for review, with a plan that says `unavailable` and why. A human bootstrapping into a
// monorepo on a deployment with no model still gets the decision, they just make it unaided.

/** Which repository a read is aimed at. Bound per tool, so a path can never be ambiguous. */
export type MonorepoAdoptionSide = 'monorepo' | 'template'

/** One read the model asks the platform to perform on its behalf. */
export interface MonorepoExplorationRequest {
  side: MonorepoAdoptionSide
  /** A directory LISTING or a file READ; the two produce differently shaped evidence. */
  kind: 'list' | 'read'
  /** The repository-relative path, as the model wrote it (validated by the implementation). */
  path: string
}

/**
 * What one read produced, in the form the model is shown it.
 *
 * NEVER an exception. A provider failure, an absent file, a path the platform will not fetch and
 * an exhausted budget are all things the model has to be TOLD so it can adapt its next read and
 * say in its rationale what it could not see. A thrown error would instead abort the whole
 * generation, turning one unreadable file into a survey that produced nothing.
 */
export interface MonorepoExplorationAnswer {
  outcome: AdoptionReadOutcome
  /** The content the model is shown; empty when the read produced nothing. */
  body: string
  /** Why there is no content, in a sentence for the model; null when the read succeeded. */
  note: string | null
  /** The `monorepo:`/`template:`-prefixed key this read may be cited by; null when there is none. */
  key: string | null
}

/**
 * The bounded reader a survey's model explores through.
 *
 * The point of the seam is WHO writes the record. The explorer performs the read, charges it
 * against the survey's budget, and appends it to the transcript the plan carries, so the evidence
 * set is what was actually fetched rather than a list the platform predicted in advance. An
 * advisor (or a model) therefore cannot claim a read it did not make: the transcript is read back
 * off the explorer by the caller that built it, never returned by {@link MonorepoAdoptionAdvisor}.
 */
export interface MonorepoAdoptionExplorer {
  /** The sides that can be read. A run with no linked reference template has only `monorepo`. */
  readonly sides: readonly MonorepoAdoptionSide[]
  /** Perform one bounded read. Never throws (see {@link MonorepoExplorationAnswer}). */
  explore(request: MonorepoExplorationRequest): Promise<MonorepoExplorationAnswer>
}

/** The two sides a survey read, rendered for the model, plus the workspace whose model to use. */
export interface MonorepoAdoptionSubject {
  workspaceId: string
  /** The new service's subdirectory in the monorepo (e.g. `services/billing`). */
  directory: string
  /** What the run is bootstrapping, in the operator's own words (the composed instructions). */
  instructions: string
  /** What the survey managed to read, and what it could not. */
  survey: AdoptionSurvey
  /**
   * The read files themselves, keyed by the SAME prefixed path the survey lists and a decision's
   * evidence cites (`monorepo:package.json`, `template:Dockerfile`). One map rather than two so
   * the prefix is the single place either side is named, and a decision's evidence can be checked
   * against it without knowing which side a path came from.
   */
  files: Record<string, string>
  /**
   * The reader the model widens the survey through, beyond the seeded opening context.
   *
   * Everything it fetches lands on the SAME transcript `survey` is a snapshot of, so the caller
   * re-reads the survey after {@link MonorepoAdoptionAdvisor.advise} returns rather than trusting
   * what came back with the plan.
   */
  explorer: MonorepoAdoptionExplorer
}

export interface MonorepoAdoptionAdvisor {
  /** Whether a suggestion can be produced (a model provider AND a routing default are wired). */
  readonly enabled: boolean
  /**
   * Propose what the new service should adopt from the monorepo and what it should keep from the
   * template. Returns the raw extracted JSON; the caller owns the shape
   * (`parseAdoptionDecisions`), mirroring `BugHuntAssessor.assess`, so a model that invents areas,
   * ids or evidence cannot reach the stored plan unvalidated.
   *
   * Throws on an unresolved model, a failed generation, or a reply carrying no JSON. The caller
   * catches that and parks the run with an `unavailable` plan stating the cause. An analysis that
   * could not be read must never be presented to a reviewer as "there was nothing to decide".
   */
  advise(subject: MonorepoAdoptionSubject): Promise<{ plan: unknown; model: string }>
}
