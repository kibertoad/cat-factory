import type { AdoptionSurvey } from '@cat-factory/contracts'

// The monorepo bootstrap's SUGGESTION seam. The survey itself is deterministic (the platform
// lists the monorepo's root config, the target directory's nearest sibling service, and the
// reference template's own files through the `RepoFiles` port), and only the JUDGEMENT over
// what to adopt needs a model. So it sits behind this port exactly as `BugHuntAssessor` and
// `JudgeAssessor` do: the facades wire the inline implementation from the model dependencies
// they already supply, and the conformance harness swaps in a deterministic fake, which is what
// lets the whole rest of the flow (survey, park, review, refusals, apply) be asserted on every
// runtime with no model wired.
//
// `enabled === false` (no provider, or no routing default) is NOT a failure: the run still
// parks for review, with a plan that says `unavailable` and why. A human bootstrapping into a
// monorepo on a deployment with no model still gets the decision, they just make it unaided.

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
