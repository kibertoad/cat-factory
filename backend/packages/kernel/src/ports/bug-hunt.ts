import type { BugCandidate } from '../domain/types.js'

// The bug hunt's ranking seam. A hunt reads a tracker board's open, unassigned bugs and
// asks a model which ones are worth picking up — best impact for the effort. The read is
// deterministic (a provider query); the JUDGEMENT is the one part that needs an LLM, so it
// sits behind this port exactly as the judge steps sit behind `JudgeAssessor`.
//
// Injecting it keeps `BugHuntService` provider- and model-neutral: the facades wire the
// inline implementation from the model dependencies they already supply, and the
// conformance harness swaps in a deterministic fake through the same seam.

/** The candidate set to rank, plus the workspace whose model + credential scope to use. */
export interface BugHuntSubject {
  workspaceId: string
  candidates: BugCandidate[]
}

export interface BugHuntAssessor {
  /** Whether an assessment can run (a model provider AND a routing default are wired). */
  readonly enabled: boolean
  /**
   * Rank one candidate set. Returns the raw extracted JSON value — the caller owns the
   * shape (`parseBugHuntVerdicts`), mirroring `JudgeAssessor.assess`, so a model that
   * invents fields or ids can't reach the domain unvalidated.
   *
   * Throws on an unresolved model, a failed generation, or a reply carrying no JSON. The
   * hunt catches that and returns the candidates UNRANKED with a stated reason — an
   * analysis that could not be read must never be presented as "these are the best bugs".
   */
  assess(subject: BugHuntSubject): Promise<{ verdicts: unknown; model: string }>
}
