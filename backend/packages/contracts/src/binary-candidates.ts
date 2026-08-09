import * as v from 'valibot'

// ---------------------------------------------------------------------------
// SIDE-BY-SIDE CANDIDATE COMPARISON for a binary-output step.
//
// A step may select several generative integrations that produce the same content type. The
// design record states the overlap to both the agent and the step's author and deliberately ranks
// nothing, because the platform has no cost model, no quality model and no view of what the step
// is for. That is the right answer while the choice has to be made BEFORE the pictures exist.
//
// It is the wrong answer when it does not. Two image APIs asked for the same sprite return two
// sprites, and a person looking at them decides in a second what no description could have
// decided in advance. So a step may instead declare a COMPARISON: generate a candidate from every
// selected integration, park, and let a human keep one, or keep several under DISTINCT ids.
//
// Two properties are load-bearing and both follow from the rest of the feature:
//
// - **The platform never holds the bytes.** Candidates are staged through the step's own storage
//   service exactly as deliverables are, and what the SPA renders is whatever preview URL that
//   service reported. A service that reports none leaves the candidate legible as metadata and
//   says the preview is unavailable, which is a different fact from a candidate that failed.
// - **The decision is DATA, and the agent executes it.** Keeping a candidate does not move a file:
//   it records which candidates survive and under which id, and the step re-runs with that
//   folded into its brief. The platform's own artifact store is for run evidence, and a product
//   asset it never touched is not something it should start touching to implement a picker.
// ---------------------------------------------------------------------------

const candidateSlug = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a plain id (letters, digits, . _ -)'),
)

/**
 * The per-step comparison declaration: this step generates candidates and PARKS for a human.
 *
 * Its presence is the switch. There is no `enabled: false`, because a step that is not comparing
 * carries nothing, and a disabled bag would be a saved configuration that describes a behaviour
 * the run does not have.
 */
export const binaryCandidateComparisonSchema = v.object({
  /**
   * How many candidates EACH selected integration should produce per subject. Defaults to one,
   * which is the case the whole feature is named for: one render from each of the integrations
   * that overlap.
   *
   * Above one it also covers the single-integration case, where the comparison is between seeds
   * rather than between vendors. That is not a lesser use: a step holding one pixel-art API and
   * asking for four candidates is exactly how a sprite gets picked, and refusing it would make
   * the feature depend on a deployment happening to have bought two vendors.
   */
  perGenerator: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4))),
  /**
   * Whether MORE THAN ONE candidate may be kept. Off by default: the ordinary case is a choice,
   * and a picker that silently allowed two would leave a step delivering an artifact count nobody
   * asked for.
   *
   * On, every kept candidate is stored under its own id (`storeAs`), which is what makes keeping
   * two a real outcome rather than a collision: two files at one location is one file.
   */
  multiSelect: v.optional(v.literal(true)),
})
export type BinaryCandidateComparison = v.InferOutput<typeof binaryCandidateComparisonSchema>

/**
 * One generated candidate, as the agent declared it in its fenced ```binary-candidates block.
 *
 * `id` is engine-minted (`cand_*`) rather than taken from the reply: the id is what a human's
 * choice names, so a model that repeats one, omits one, or writes a 4 KB one would break the
 * decision rather than its own bookkeeping. What the agent DOES supply is `label`, which is how
 * it refers to the candidate in its own prose, kept so the two records can be lined up.
 */
export const binaryCandidateSchema = v.object({
  /** Engine-minted stable id (`cand_*`), assigned when the declaration is recorded. */
  id: v.string(),
  /** The agent's own name for this candidate, retained so its prose can be matched to the row. */
  label: v.optional(v.string()),
  /**
   * The integration that produced it. Optional for the same reason the deliverable's own
   * `generator` is (a model with native image output produces without a registered integration),
   * and far more load-bearing here: with several producers in play it is the axis the human is
   * comparing along, so a candidate that omits it is rendered as unattributed rather than
   * silently attributed to the step's first integration.
   */
  generator: v.optional(v.string()),
  /**
   * What this candidate DEPICTS, in the agent's words (`product:tea-kettle`, `sprite:anvil`).
   * Candidates are grouped by it, so a step that generated forty subjects renders forty
   * comparisons rather than one wall of eighty images.
   */
  subject: v.optional(v.string()),
  /** The service the candidate was staged through, lowercased on read-back like a deliverable's. */
  service: v.string(),
  /** Where it lives in that service's addressing, verbatim. */
  location: v.string(),
  /** The media type the agent reports for it. */
  contentType: v.optional(v.string()),
  /**
   * A URL the SPA can render the candidate from, when the storage service issued one.
   *
   * ABSENT is a real and common state, not a failure: an org's asset store may be private, and
   * the platform will not invent a link into it. The surface then renders the candidate's
   * metadata and says the preview is unavailable, which is what lets a private estate use this
   * feature at all. Constrained to `https` (or loopback) at parse time, because it is rendered
   * in a browser from text a model wrote.
   */
  previewUrl: v.optional(v.string()),
  /** One line on what makes this candidate different, from the agent that made it. */
  note: v.optional(v.string()),
})
export type BinaryCandidate = v.InferOutput<typeof binaryCandidateSchema>

/**
 * Why a comparison step did NOT park, when it did not.
 *
 * Its own vocabulary rather than an absent state, because every member is a different fault with
 * a different fix and all three end with the run advancing. A comparison that wedged a run on a
 * model that forgot a fenced block would be a worse outcome than the one it exists to improve.
 */
export const binaryCandidateNoChoiceReasonSchema = v.picklist([
  /** The reply carried no ```binary-candidates block at all. A prompt/model problem. */
  'undeclared',
  /** A block was present and its body was not parseable. */
  'parse_failed',
  /**
   * The block was read and NO candidate survived it: the agent staged nothing, or every entry it
   * declared was malformed. Deliberately not "fewer than two": a single candidate is auto-kept
   * (see {@link BinaryCandidateChoice.automatic}) rather than treated as a failed comparison,
   * mirroring the fork decision's single-path escape hatch. Nobody is asked to choose between one
   * thing, and discarding a real generation because it had no rival would be the worse outcome.
   */
  'no_candidates',
])
export type BinaryCandidateNoChoiceReason = v.InferOutput<
  typeof binaryCandidateNoChoiceReasonSchema
>

/**
 * The candidate lifecycle on a comparison step:
 * - `awaiting_choice`: parked; the human is comparing.
 * - `chosen`: the human decided; the step re-runs and stores what survived.
 * - `no_choice`: nothing to choose between, for one of the reasons above. No park.
 */
export const binaryCandidateStatusSchema = v.picklist(['awaiting_choice', 'chosen', 'no_choice'])
export type BinaryCandidateStatus = v.InferOutput<typeof binaryCandidateStatusSchema>

/** One candidate the human kept, and the id it is to be stored under. */
export const binaryCandidateKeepSchema = v.object({
  candidateId: v.string(),
  /**
   * The ALTERNATE ID this candidate is stored under, which is the whole mechanism behind keeping
   * more than one: two survivors of one subject are two deliverables, and two deliverables need
   * two addresses. Absent ⇒ the step's ordinary naming applies, which is correct for the single
   * survivor and is why it is optional rather than defaulted to something invented.
   */
  storeAs: v.optional(candidateSlug),
})
export type BinaryCandidateKeep = v.InferOutput<typeof binaryCandidateKeepSchema>

/** The human's resolution, recorded on the step. */
export const binaryCandidateChoiceSchema = v.object({
  kept: v.array(binaryCandidateKeepSchema),
  /**
   * The candidate ids that were NOT kept, recorded explicitly rather than derived by subtraction
   * at read time. The surviving record must still say what was rejected once the step re-runs and
   * the candidate list is the only thing left describing a generation nobody kept.
   */
  discarded: v.array(v.string()),
  /** Why, in the human's words. Folded into the re-run's brief so the agent knows what was wrong. */
  note: v.optional(v.nullable(v.string())),
  /**
   * Set when the engine kept the only candidate rather than parking, so NOBODY reviewed it.
   *
   * Its own flag rather than an absent decider, because the two are the same record and opposite
   * facts: a surface that renders an auto-kept artifact as "chosen" is telling a reader that a
   * person looked at this and approved it, which is exactly the claim this feature exists to make
   * true. An auto-keep is a legitimate outcome and a quieter one, and it says so.
   */
  automatic: v.optional(v.literal(true)),
  at: v.number(),
})
export type BinaryCandidateChoice = v.InferOutput<typeof binaryCandidateChoiceSchema>

/**
 * Live candidate-comparison state carried on the run's step. All of it rides `PipelineStep`, no
 * side table, so D1 and Drizzle parity is free exactly as it is for `forkDecision` / `followUps`.
 *
 * The bookkeeping fields mirror `binaryOutputReportSchema`'s, and for the same reason: every way
 * a candidate was lost is COUNTED rather than absorbed, so a comparison over three images that
 * was meant to be over five does not read as a complete one.
 */
export const binaryCandidateStepStateSchema = v.object({
  status: binaryCandidateStatusSchema,
  candidates: v.optional(v.array(binaryCandidateSchema), []),
  /** Set only when `status` is `no_choice`. */
  noChoiceReason: v.optional(v.nullable(binaryCandidateNoChoiceReasonSchema)),
  /** Set once the human decides. */
  choice: v.optional(v.nullable(binaryCandidateChoiceSchema)),
  /** Whether more than one candidate may be kept, frozen from the step's config at record time
   *  so the resolver judges the request against the rule the human was actually shown. */
  multiSelect: v.optional(v.boolean()),
  /** Declared entries dropped because they were not `{ service, location }` objects. */
  invalidEntries: v.optional(v.number(), 0),
  /** Valid entries dropped past the per-step cap, so `candidates` is a PREFIX. */
  omitted: v.optional(v.number(), 0),
  /** Preview URLs dropped because they were not an `https`/loopback URL. The candidate is kept
   *  and rendered without a preview: a refused link is not a refused candidate. */
  unusablePreviews: v.optional(v.number(), 0),
})
export type BinaryCandidateStepState = v.InferOutput<typeof binaryCandidateStepStateSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Keep one or more candidates and discard the rest.
 *
 * At least one must be kept: "discard everything" is a different act (it means the generation was
 * a failure), and answering it through this verb would re-run the step to store nothing while
 * reporting a completed choice. A step whose candidates are all bad is retried or reworked
 * through the surfaces that already exist for that.
 */
export const keepBinaryCandidatesSchema = v.object({
  keep: v.pipe(v.array(binaryCandidateKeepSchema), v.minLength(1), v.maxLength(16)),
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type KeepBinaryCandidatesInput = v.InferOutput<typeof keepBinaryCandidatesSchema>
