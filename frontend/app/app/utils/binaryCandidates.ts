import { platformAssetIdOf } from '@cat-factory/contracts'
import type { BinaryCandidate, BinaryCandidateStepState, PipelineStep } from '~/types/execution'

// ---------------------------------------------------------------------------
// The read model behind the candidate-comparison surface
// (docs/initiatives/binary-output-foundational-storage.md).
//
// A step whose selection declares a `comparison` generates a candidate from each of its selected
// integrations, stages them, and parks. This module turns that record into what the window
// renders: the candidates GROUPED BY SUBJECT (which is what a person actually compares), the
// preview each one does or does not have, and every loss the parse counted.
//
// Pure, and reads only the step's own record, which is the rule the sibling binary-output read
// model follows and for the same reason: the join a human wants is answerable from the step alone, so
// the surface needs no fetch and reads identically for a finished run.
// ---------------------------------------------------------------------------

/** One candidate as the window renders it, with the two facts the raw record does not carry. */
export interface BinaryCandidateRow extends BinaryCandidate {
  /**
   * The human kept this one. Meaningful only once a choice exists, which is what lets the window
   * double as the RECORD of a settled comparison rather than only its control surface.
   */
  kept: boolean
  /** The id it is to be stored under, when the person who kept it assigned one. */
  storeAs?: string
  /**
   * The platform's own artifact id, when this candidate was staged through the platform's asset
   * storage rather than an org's own service.
   *
   * It is the OTHER way a candidate gets a preview, and the one that works on a private estate:
   * `previewUrl` needs the storage service to have issued a public link, which ours never does
   * (its bytes are behind the workspace's own authenticated blob route). Without this a
   * deployment using the shipped storage would compare candidates it could not see, which is the
   * one thing this window exists to make possible.
   */
  assetId: string | null
}

/** The candidates for one subject, which is the unit a person compares. */
export interface BinaryCandidateGroup {
  /**
   * What these candidates depict, or null when the agent declared no subject. Null is its own
   * group rather than being merged into another: an unlabelled candidate is not "the same thing"
   * as any labelled one, and quietly filing it under the first subject would put a picture of
   * something else into a comparison.
   */
  subject: string | null
  rows: BinaryCandidateRow[]
}

/** The whole surface's read model. */
export interface BinaryCandidateView {
  state: BinaryCandidateStepState
  /** Candidates grouped by subject, in first-appearance order. */
  groups: BinaryCandidateGroup[]
  /** Whether the run is parked on this decision right now (as opposed to showing the record). */
  awaiting: boolean
  /** Whether more than one candidate may be kept. */
  multiSelect: boolean
  /**
   * True when the engine kept the only candidate without asking. Its own flag rather than an
   * absent decider, because a surface that renders it as a choice claims a person looked at this.
   */
  automatic: boolean
  /** How many candidates carry no renderable preview, so the window can say so once. */
  withoutPreview: number
}

/**
 * The step's candidate read model, or null when the step has no comparison story at all.
 *
 * A step that never compared renders nothing, exactly as the binary-output section does for a step
 * that never generated: a row saying "no comparison was configured here" would ride every step of
 * every run.
 */
export function binaryCandidateView(
  step: PipelineStep | null | undefined,
): BinaryCandidateView | null {
  const state = step?.binaryCandidates
  if (!state) return null
  const kept = new Map((state.choice?.kept ?? []).map((entry) => [entry.candidateId, entry]))
  const groups: BinaryCandidateGroup[] = []
  const bySubject = new Map<string | null, BinaryCandidateGroup>()
  for (const candidate of state.candidates) {
    const subject = candidate.subject ?? null
    let group = bySubject.get(subject)
    if (!group) {
      group = { subject, rows: [] }
      bySubject.set(subject, group)
      groups.push(group)
    }
    const choice = kept.get(candidate.id)
    group.rows.push({
      ...candidate,
      assetId: platformAssetIdOf(candidate),
      kept: choice !== undefined,
      ...(choice?.storeAs ? { storeAs: choice.storeAs } : {}),
    })
  }
  return {
    state,
    groups,
    awaiting: state.status === 'awaiting_choice',
    multiSelect: state.multiSelect === true,
    automatic: state.choice?.automatic === true,
    // Counts a candidate with NEITHER kind of preview: a service-issued link, or bytes the
    // platform holds itself. Reading only `previewUrl` here would report every candidate of every
    // run on the shipped storage as unviewable while the window was rendering all of them.
    withoutPreview: state.candidates.filter(
      (candidate) => !candidate.previewUrl && !platformAssetIdOf(candidate),
    ).length,
  }
}

/**
 * Whether anything about this comparison needs saying beside the candidates: entries the parse
 * dropped, a truncated list, or preview links it refused.
 *
 * Drives the window's warning strip, so a comparison made over three of five candidates cannot
 * read as one made over all of them. A missing PREVIEW is deliberately not one of these: it is
 * ordinary (a private asset store issues no public link) and it is stated per candidate, where
 * the reader can see exactly which one they are judging blind.
 */
export function binaryCandidateHasWarnings(view: BinaryCandidateView): boolean {
  const { invalidEntries = 0, omitted = 0, unusablePreviews = 0 } = view.state
  return invalidEntries > 0 || omitted > 0 || unusablePreviews > 0
}

/**
 * Why the window has no comparison to render. Four different facts that a single blank body
 * conflated (UX-80), each needing a different reaction from the reader: nothing to read from, wait,
 * retry, or accept that the run compared nothing. `nothing_compared` is a CLAIM about the run, so
 * it is only ever the answer once a read of that run has settled and not failed.
 */
export type BinaryCandidateAbsence = 'no_run' | 'loading' | 'load_failed' | 'nothing_compared'

/**
 * The absence to render when {@link binaryCandidateView} produced nothing.
 *
 * Precedence is the point, and it is stated here rather than in the template's branch order:
 *
 *  - No RUN outranks everything. The window is keyed to an execution and the warm-up read is
 *    skipped without one, so `loading`/`error` can only be describing some other window's read;
 *    reporting either would attribute a state to a run nobody asked about, and reporting emptiness
 *    would claim this run compared nothing on the strength of never having looked.
 *  - An in-flight read outranks a stale error from the previous attempt, so a Retry does not keep
 *    showing the failure it is busy clearing.
 *  - A recorded error outranks emptiness, so a request that never landed cannot render as "this run
 *    generated nothing to compare".
 */
export function binaryCandidateAbsence(
  loading: boolean,
  error: string | null | undefined,
  executionId: string | null | undefined,
): BinaryCandidateAbsence {
  if (!executionId) return 'no_run'
  if (loading) return 'loading'
  if (error) return 'load_failed'
  return 'nothing_compared'
}

/**
 * State → the i18n key for the line explaining why no choice was offered.
 *
 * An exhaustive `Record` over the reason vocabulary, so a fourth reason fails the typecheck here
 * rather than rendering a missing key. Every member is a different fault with a different fix,
 * which is exactly why the engine records the reason instead of leaving the step blank.
 */
export const BINARY_CANDIDATE_NO_CHOICE_KEYS: Record<
  NonNullable<BinaryCandidateStepState['noChoiceReason']>,
  string
> = {
  undeclared: 'binaryCandidates.noChoice.undeclared',
  parse_failed: 'binaryCandidates.noChoice.parseFailed',
  no_candidates: 'binaryCandidates.noChoice.noCandidates',
}
