import * as v from 'valibot'
import { brainstormStageSchema } from './brainstorm.js'
import { environmentStatusSchema } from './environments.js'
import {
  answerFollowUpSchema,
  followUpItemKindSchema,
  followUpItemStatusSchema,
} from './followUp.js'
import { stepApprovalStatusSchema } from './step-decisions.js'
import { forkDecisionStatusSchema, forkOptionSchema } from './forkDecision.js'
import { humanTestPhaseSchema, visualConfirmPhaseSchema } from './human-verdict-gates.js'
import {
  inputGateIssueSchema,
  inputGateModeSchema,
  inputGateStatusSchema,
  resolveInputGateSchema,
} from './input-gate.js'
import { iterationCapChoiceSchema } from './iteration-cap.js'
import { judgeStatusSchema, judgeVerdictSchema, resolveJudgeSchema } from './judge.js'
import {
  prReviewCategorySchema,
  prReviewResolutionSchema,
  prReviewSeveritySchema,
  prReviewStatusSchema,
} from './prReview.js'
import { publicRunStatusSchema } from './public-api.js'
import {
  requirementReviewStatusSchema,
  reviewItemCategorySchema,
  reviewItemSeveritySchema,
  reviewItemStatusSchema,
} from './requirements.js'

// ---------------------------------------------------------------------------
// Public-API wire contracts for a run's PARKED HUMAN DECISIONS (`/api/v1/runs/:runId/decisions`).
//
// The requirements-review loop is the platform's clarification machinery: the reviewer raises
// findings, the run parks on a durable decision-wait, a human answers/dismisses, an incorporation
// pass folds the answers in, and the run advances. Until now that loop was reachable only through
// the SPA, so a headless (`/api/v1`) run could not include clarification at all — the public
// surface refused any pipeline that could park.
//
// These resources are the external counterpart of that loop, and now of every OTHER way a run
// stops for a person. Each kind is deliberately a SMALL projection of the internal entity,
// following the `publicTask` / `publicService` pattern: a caller sees the question and the stable
// ids it answers by, never the engine's step internals, the recommendation machinery, or the
// reviewer's model plumbing.
//
// Answering rides the SAME service methods the SPA controllers call, so the park's CAS/approval-id
// arbitration and the task's merge-preset knobs (iteration cap, tolerated severity) apply
// identically whichever surface answers first. See
// `docs/initiatives/headless-clarification-loop.md` and
// `docs/initiatives/public-api-additions.md`.
//
// WHAT MAY BE REUSED FROM AN INTERNAL SCHEMA, AND WHAT MUST BE PROJECTED.
//
// `/api/v1` is frozen and internals explicitly are not (see the compatibility section of
// `CLAUDE.md`), so every internal schema named in a `public*` shape below silently promotes that
// internal to the stable surface. The line this file draws:
//
//  - A CLOSED PICKLIST is reused as-is (`requirementReviewStatusSchema`, `prReviewStatusSchema`,
//    `environmentStatusSchema`, …). Adding a member is additive and `/api/v1` ships those freely,
//    and RETIRING one is already governed by the closed-vocabulary rule that applies wherever the
//    value is persisted. A parallel `public*` copy of a picklist would carry no extra information
//    and would drift the first time only one side gained a member.
//  - An OBJECT is PROJECTED, always, however closely the projection resembles today's internal
//    shape. An object grows fields, nests sub-objects and gets refactored on an internal
//    timetable, so aliasing one makes an ordinary internal edit a public break that arrives as a
//    clean diff nobody reads. `publicPrReviewFindingSchema` is the worked example: it looks like
//    `prReviewFindingSchema` today, and the internal one is mid-evolution (slice reviews, resume)
//    while the published shape must not move.
//
// A projection also normalises what the internal shape leaves ambiguous: an internal
// `v.optional(v.nullable(X))` (absent OR null, a distinction that survives no round trip an SDK
// makes) becomes a plain `v.nullable(X)` that is ALWAYS present. The `to*` projection supplies the
// `?? null`, so four generated clients get one shape to check instead of two.
// ---------------------------------------------------------------------------

/**
 * Which parked decision a `publicDecision` entry describes.
 *
 * The list is the surface's own honesty check: `PUBLICLY_ANSWERABLE_PARK_SURFACES` (server-side
 * admission) names the park surfaces a `decide` key is TOLD it can answer, and a kind here with no
 * route behind it is exactly the "refusal advertising a capability we do not have" defect that set
 * builds. Add a member only together with its routes.
 */
export const publicDecisionKindSchema = v.picklist([
  'requirements-review',
  'fork',
  'judge',
  'input-gate',
  'approval-gate',
  'agent-decision',
  'clarity-review',
  'brainstorm',
  'pr-review',
  'human-test',
  'visual-confirmation',
  'follow-ups',
  'interview',
])
export type PublicDecisionKind = v.InferOutput<typeof publicDecisionKindSchema>

/**
 * One reviewer finding as exposed externally — the question, how serious it is, and where it
 * stands. `itemId` is the STABLE anchor a reply addresses (and, in slice 2, the id rendered into
 * the tracker-issue comment so a ticket reply can target a finding). The internal item's
 * `autoAnswerable` classification and the Requirement-Writer recommendation machinery are
 * deliberately not exposed: they drive in-app affordances a headless caller has no use for.
 */
export const publicReviewFindingSchema = v.object({
  itemId: v.string(),
  /** What kind of concern this raises (gap / clarification / assumption / risk / question). */
  category: reviewItemCategorySchema,
  /** How important resolving it is before implementation proceeds. */
  severity: reviewItemSeveritySchema,
  /** Short headline of the concern. */
  title: v.string(),
  /** The full question / gap / challenge, in plain prose. */
  detail: v.string(),
  /** `open` until answered or dismissed; only `open` findings block incorporation. */
  status: reviewItemStatusSchema,
  /** The recorded answer, or null while unanswered. */
  reply: v.nullable(v.string()),
})
export type PublicReviewFinding = v.InferOutput<typeof publicReviewFindingSchema>

/**
 * A parked requirements review as exposed externally. The loop a caller drives: answer or dismiss
 * every `open` finding, then `incorporate` (which folds the answers into one standard-format
 * document and re-reviews it in the background). The review converges (`incorporated` — the run
 * advances), comes back with a fresh round (`ready`), or hits its iteration cap (`exceeded`, where
 * `resolve-exceeded` picks one more round / proceed anyway / stop).
 */
export const publicRequirementsDecisionSchema = v.object({
  kind: v.literal('requirements-review'),
  reviewId: v.string(),
  /** The board task the review belongs to. */
  taskId: v.string(),
  status: requirementReviewStatusSchema,
  /** Which reviewer pass this is (the initial review is 1). */
  iteration: v.number(),
  /** The reviewer-pass budget, from the task's merge preset. */
  maxIterations: v.number(),
  findings: v.array(publicReviewFindingSchema),
  /**
   * The standardized requirements document the last incorporation produced; null until one
   * exists. Once the review settles, this is what every downstream agent implements — so a
   * caller can read exactly what its answers turned into before proceeding.
   */
  incorporatedRequirements: v.nullable(v.string()),
})
export type PublicRequirementsDecision = v.InferOutput<typeof publicRequirementsDecisionSchema>

/**
 * A parked implementation-fork choice as exposed externally: the materially different ways to
 * implement the task, surfaced before any code is written. A caller picks a `forkId` or submits
 * its own `custom` approach; the Coder then runs with the choice folded in as a binding directive.
 * The grounded chat is deliberately NOT exposed — it is an interactive deliberation affordance,
 * and a headless caller that wants to reason about the forks has the full `approach`/`tradeoffs`
 * text right here.
 */
export const publicForkDecisionSchema = v.object({
  kind: v.literal('fork'),
  /** The run's fork-decision lifecycle state; only `awaiting_choice` accepts a choice. */
  status: forkDecisionStatusSchema,
  /** The proposer's read of where the change lands (grounding for the choice). */
  seamSummary: v.nullable(v.string()),
  /** The proposed approaches, each with its id, plan, trade-offs and risk notes. */
  forks: v.array(forkOptionSchema),
})
export type PublicForkDecision = v.InferOutput<typeof publicForkDecisionSchema>

/**
 * A parked JUDGE verdict as exposed externally (the fourth step-taxonomy bucket): a rubric
 * scored the run's work below the task's threshold and the run stopped for a human. A caller
 * reads the score, the threshold it missed, and the findings behind it, then resolves it with
 * `proceed` / `bounce` / `stop` — the SAME service method the SPA's judge window calls.
 *
 * The rubric BODY is deliberately not exposed: it is deployment (or workspace) policy text, often
 * long, and a caller answering a verdict acts on the findings, not on the rubric that produced them.
 */
export const publicJudgeDecisionSchema = v.object({
  kind: v.literal('judge'),
  /** The judge step's kind (`agentKind`), which names WHICH judge is asking. */
  stepKind: v.string(),
  status: judgeStatusSchema,
  /** The rubric's stable id + human name, so a caller can tell two judges apart. */
  rubricId: v.nullable(v.string()),
  rubricName: v.nullable(v.string()),
  /** The score the verdict had to reach (from the task's merge preset). */
  threshold: v.nullable(v.number()),
  /** The latest verdict: score, summary and the findings behind it. */
  verdict: v.nullable(judgeVerdictSchema),
  /** Rework rounds spent and the ceiling, so a caller knows whether `bounce` is the last word. */
  bounces: v.number(),
  maxBounces: v.number(),
})
export type PublicJudgeDecision = v.InferOutput<typeof publicJudgeDecisionSchema>

/**
 * A run parked on the PRE-DISPATCH INPUT GATE as exposed externally: the task states nothing an
 * agent could act on, and the run stopped before its first dispatch having spent nothing.
 *
 * This one is exposed for a reason the other three do not have. The gate parks on the shape of
 * the TASK rather than the shape of the pipeline, so it can hold ANY public run, including one
 * whose pipeline carries no park at all; a caller filing title-only tasks would otherwise watch
 * them stop with `GET .../decisions` reporting `parked: true` and nothing to answer, and
 * `POST /api/v1/jobs/:id/cancel` as the only way out. The findings are the same closed codes the
 * SPA renders, so an integration can map them to its own copy or hand them back to whoever filed
 * the ticket.
 */
export const publicInputGateDecisionSchema = v.object({
  kind: v.literal('input-gate'),
  /** The disposition; only `blocked` accepts an answer. */
  status: inputGateStatusSchema,
  /** The workspace mode the evaluation ran under, so a verdict explains its own severities. */
  mode: inputGateModeSchema,
  /** Every finding, blocking and advisory alike, in a stable order. */
  issues: v.array(inputGateIssueSchema),
  /** Epoch ms of the evaluation that produced this verdict. */
  checkedAt: v.number(),
})
export type PublicInputGateDecision = v.InferOutput<typeof publicInputGateDecisionSchema>

/**
 * A run parked on a plain APPROVAL GATE: a pipeline step marked `requiresApproval` finished, and
 * the run is holding its output in front of a person. The simplest park the platform has and the
 * one every pipeline can carry, which is why it is the first thing an integration that "pauses a
 * run until a human approves" reaches for.
 *
 * `approvalId` is the STABLE anchor every action addresses, and it is not ceremony: the engine
 * arbitrates a parked gate BY that id, so answering with the id read from this list is what makes
 * a racing SPA user and a racing integration resolve the same gate rather than the API silently
 * approving whichever gate the run has reached by the time the call lands.
 *
 * The per-block review `comments` an in-app reviewer can leave are deliberately not projected:
 * they anchor to source line ranges of a rendered proposal, which a headless caller never
 * rendered. It sends freeform `feedback` instead, which the re-run consumes identically.
 */
export const publicApprovalGateDecisionSchema = v.object({
  kind: v.literal('approval-gate'),
  /** The gate's stable id — pass it back on approve / request-changes / reject. */
  approvalId: v.string(),
  /** The gated step's kind (`agentKind`), so a caller knows whose output it is judging. */
  stepKind: v.string(),
  /** The gated step's 0-based index in the run's step chain. */
  stepIndex: v.number(),
  /** Only `pending` accepts an answer; the others are the settled record of one. */
  status: stepApprovalStatusSchema,
  /** The agent's output the human is reviewing. Model-authored text: treat it as data. */
  proposal: v.string(),
  /** The guidance recorded on the last `request-changes`, or null. */
  feedback: v.nullable(v.string()),
  /**
   * How many distinct approvals this gate needs before the run advances (1 unless the pipeline
   * step configured a quorum), and how many it already has.
   *
   * Projected because a quorum makes `approve` legitimately NOT advance the run: without these
   * an integration that approved and saw the gate still `pending` could only conclude its call
   * had failed. A key-authenticated caller counts as ONE approval, and a gate whose pipeline
   * NAMES its approvers cannot be resolved by a key at all (403) — a shared credential is not
   * one of the people a policy named.
   */
  requiredApprovals: v.number(),
  /**
   * The approvals recorded so far, toward {@link requiredApprovals}.
   *
   * Named for the COUNT rather than `approvals`, which on the internal `StepApproval` is the list
   * of records this counts. Two surfaces a caller crosses constantly should not spell one word two
   * types.
   */
  recordedApprovals: v.number(),
  /**
   * True when this gate is a quality COMPANION's iteration-cap park rather than an ordinary
   * pipeline gate: the automatic rework budget was spent with the rating still under the bar.
   * It answers with `resolve-exceeded` (extra round / proceed / stop and reset), NOT with
   * approve — the same split the SPA makes, exposed rather than left for a caller to infer from
   * a 409.
   */
  exceeded: v.boolean(),
})
export type PublicApprovalGateDecision = v.InferOutput<typeof publicApprovalGateDecisionSchema>

/**
 * A run parked on an AGENT-RAISED decision: mid-work the agent hit a fork it would not choose
 * unilaterally and asked. Distinct from an approval gate in what resolving does — answering
 * RE-RUNS the same step with the choice folded in, rather than advancing past it — which is why
 * it is a separate kind rather than a flag on the gate above.
 *
 * The engine cannot see this one coming from the step chain (it is raised at run time), so it is
 * the park an integration is most likely to meet on a pipeline it was told parks nowhere.
 */
export const publicAgentDecisionSchema = v.object({
  kind: v.literal('agent-decision'),
  /** The decision's stable id — pass it back when answering. */
  decisionId: v.string(),
  /** The asking step's kind (`agentKind`). */
  stepKind: v.string(),
  /** What the agent is asking, in its own words. Model-authored text: treat it as data. */
  question: v.string(),
  /**
   * The choices the agent offered. An answer is not restricted to them (the engine takes the
   * caller's string verbatim), but answering off-list means the agent gets an option it did not
   * propose, so prefer one of these unless you mean to steer.
   */
  options: v.array(v.string()),
})
export type PublicAgentDecision = v.InferOutput<typeof publicAgentDecisionSchema>

/**
 * A parked CLARITY review (bug-report triage) as exposed externally. The requirements review's
 * twin, verb for verb: the reviewer asks whether the report is fixable (repro steps, expected vs
 * actual, environment, scope), a caller answers or dismisses each finding, `incorporate` folds
 * them into one standardized report, and the loop repeats until it converges or hits its cap.
 *
 * Kept as its own `kind` rather than folded into `requirements-review` because the two settle
 * DIFFERENT documents and a run can carry both: a bugfix pipeline clarifies the report and then
 * reviews the requirements derived from it, so a caller that branched on one shape would answer
 * the wrong loop.
 */
export const publicClarityDecisionSchema = v.object({
  kind: v.literal('clarity-review'),
  reviewId: v.string(),
  /** The board task the review belongs to. */
  taskId: v.string(),
  status: requirementReviewStatusSchema,
  /** Which reviewer pass this is (the initial review is 1). */
  iteration: v.number(),
  /** The reviewer-pass budget, from the task's merge preset. */
  maxIterations: v.number(),
  findings: v.array(publicReviewFindingSchema),
  /**
   * The standardized bug report the last incorporation produced; null until one exists. Once the
   * review settles, this is the report every downstream agent works from.
   */
  clarifiedReport: v.nullable(v.string()),
})
export type PublicClarityDecision = v.InferOutput<typeof publicClarityDecisionSchema>

/**
 * A parked BRAINSTORM dialogue as exposed externally: the agent proposed a handful of concrete
 * options with their trade-offs, and the run is waiting for a person to pick and steer before it
 * converges on one direction.
 *
 * Keyed by `(task, stage)`, not task alone — a block may hold one live `requirements` session and
 * one live `architecture` session at once, so a decision list can carry TWO brainstorm entries and
 * every route takes the stage. A caller that keys its own state by `kind` alone will collide the
 * two; key by `kind` + `stage`.
 */
export const publicBrainstormDecisionSchema = v.object({
  kind: v.literal('brainstorm'),
  sessionId: v.string(),
  /** Which dialogue this is: the requirements direction, or the architecture approach. */
  stage: brainstormStageSchema,
  /** The board task the session belongs to. */
  taskId: v.string(),
  status: requirementReviewStatusSchema,
  /** Which agent pass this is (the initial pass is 1). */
  iteration: v.number(),
  /** The agent-pass budget, from the task's merge preset. */
  maxIterations: v.number(),
  /**
   * The proposed options. Structurally the same shape as a review finding (one source of truth
   * for the item), but read it as a proposal to pick or steer, not a defect to answer.
   */
  options: v.array(publicReviewFindingSchema),
  /** The converged direction the last incorporation produced; null until one exists. */
  convergedDirection: v.nullable(v.string()),
})
export type PublicBrainstormDecision = v.InferOutput<typeof publicBrainstormDecisionSchema>

/**
 * One cohesive group of changed files the reviewer worked as a unit, as exposed externally.
 * Findings anchor to a slice by `sliceId`, so a caller can present them grouped the way the
 * reviewer actually reasoned rather than as one flat list.
 *
 * The internal `prReviewSliceReviewSchema` (each slice's verbatim in-flight subagent report, which
 * exists so a dying review can be RESUMED per slice) is deliberately absent: it is recovery
 * plumbing for the engine, and its prose is superseded by the aggregated `findings`.
 */
export const publicPrReviewSliceSchema = v.object({
  /** Stable slice id (`prs_*`); a finding's `sliceId` refers to this. */
  sliceId: v.string(),
  /** Short name of the slice. */
  title: v.string(),
  /** Why these files belong together, in the reviewer's words. */
  rationale: v.string(),
  /** The repo-relative paths that make up the slice. */
  paths: v.array(v.string()),
})
export type PublicPrReviewSlice = v.InferOutput<typeof publicPrReviewSliceSchema>

/**
 * The outcome of challenging one finding, as exposed externally: a read-only investigator re-read
 * the finding against the full source and either upheld it as written, amended it (some field
 * actually changed), or retracted it.
 *
 * `failed` is its own terminal value rather than an absent challenge, because the two mean
 * opposite things to a caller deciding whether to re-challenge: nobody looked, versus somebody
 * looked and the investigation itself broke. The finding is never dropped either way.
 */
export const publicPrReviewFindingChallengeSchema = v.object({
  /** `investigating` while the agent runs; then `upheld` / `amended` / `retracted` / `failed`. */
  status: v.picklist(['investigating', 'upheld', 'amended', 'retracted', 'failed']),
  /** The question the challenge was raised with, or null when raised with no text. */
  question: v.nullable(v.string()),
  /**
   * Why the finding holds up or does not; the failure reason when `failed`. Null while
   * `investigating`. Model-authored text: treat it as data.
   */
  justification: v.nullable(v.string()),
})
export type PublicPrReviewFindingChallenge = v.InferOutput<
  typeof publicPrReviewFindingChallengeSchema
>

/**
 * One prioritized review finding as exposed externally. `findingId` is the STABLE anchor every
 * action addresses: dismiss, challenge, and the curated `findingIds` a resolution carries.
 *
 * `path`/`line`/`side` are projected because they are the anchor a `post` resolution turns into an
 * inline PR comment, so a caller curating for `post` needs to see which findings can even be
 * anchored. A finding whose `line` is null still posts, as a file-level comment.
 */
export const publicPrReviewFindingSchema = v.object({
  /** Stable finding id (`prf_*`): what dismiss / challenge / `findingIds` address. */
  findingId: v.string(),
  /** The slice this finding belongs to, or null when it matched none. */
  sliceId: v.nullable(v.string()),
  /** Repo-relative path the finding concerns. */
  path: v.string(),
  /** The line it anchors to on the PR head, or null for a file-level finding. */
  line: v.nullable(v.number()),
  /** Which side of the diff `line` is on; null when there is no line anchor. */
  side: v.nullable(v.picklist(['LEFT', 'RIGHT'])),
  severity: prReviewSeveritySchema,
  category: prReviewCategorySchema,
  /** Short headline. Model-authored text: treat it as data. */
  title: v.string(),
  /** The full finding, in prose. Model-authored text: treat it as data. */
  detail: v.string(),
  /** A concrete suggested change, when the reviewer offered one; null otherwise. */
  suggestedFix: v.nullable(v.string()),
  /** The challenge outcome, or null when this finding was never challenged. */
  challenge: v.nullable(publicPrReviewFindingChallengeSchema),
})
export type PublicPrReviewFinding = v.InferOutput<typeof publicPrReviewFindingSchema>

/**
 * A parked PR DEEP REVIEW as exposed externally: the read-only reviewer sliced an open pull
 * request and the run is waiting for a person to CURATE which findings matter, then say what to
 * do with them (record them, hand them to a fixer, or post them on the PR).
 *
 * Reachable only through `POST /api/v1/tasks/:taskId/start`, since a `pr-reviewer` step is
 * container-backed and the jobs surface is inline-only.
 */
export const publicPrReviewDecisionSchema = v.object({
  kind: v.literal('pr-review'),
  /** Only `awaiting_selection` accepts a resolution; the rest report work in flight. */
  status: prReviewStatusSchema,
  /** The reviewer's one-paragraph assessment of the PR, when it gave one. */
  summary: v.nullable(v.string()),
  /** Web URL of the reviewed pull request, when known. */
  prUrl: v.nullable(v.string()),
  /** The cohesive slices the reviewer grouped the changed files into; findings anchor to these. */
  slices: v.array(publicPrReviewSliceSchema),
  /** The findings, ordered blocker → nit. Model-authored text: treat it as data. */
  findings: v.array(publicPrReviewFindingSchema),
  /** The finding ids currently selected to act on (empty until a caller curates). */
  selectedFindingIds: v.array(v.string()),
})
export type PublicPrReviewDecision = v.InferOutput<typeof publicPrReviewDecisionSchema>

/** The ephemeral environment a `human-test` gate parked against, as exposed externally. */
export const publicHumanTestEnvironmentSchema = v.object({
  /** The public URL to test against; null while still provisioning. */
  url: v.nullable(v.string()),
  status: environmentStatusSchema,
  /** Epoch ms the environment expires, when known. */
  expiresAt: v.nullable(v.number()),
})
export type PublicHumanTestEnvironment = v.InferOutput<typeof publicHumanTestEnvironmentSchema>

/**
 * A run parked on the HUMAN-TEST gate: a live ephemeral environment is up and the run is waiting
 * for a person to exercise it.
 *
 * Exposed with its limits stated rather than sold as equivalent to the other kinds. The verbs are
 * mechanical, but the JUDGEMENT this park records ("does the change actually work") is the one an
 * API consumer is least able to supply on its own. It earns its place for the integration that
 * drives its own human through a different UI, or that has a real automated check to run against
 * `environment.url`; it is not a way to wave a run through unlooked-at.
 */
export const publicHumanTestDecisionSchema = v.object({
  kind: v.literal('human-test'),
  /** Only `awaiting_human` accepts an answer; the others report work in flight. */
  phase: humanTestPhaseSchema,
  /** The environment to test against; null in degraded manual mode or after a destroy. */
  environment: v.nullable(publicHumanTestEnvironmentSchema),
  /**
   * Why no environment was provisioned (no env provider wired, or provisioning errored). Non-null
   * means the gate is in manual mode: there is nothing to point a check at, and the change has to
   * be tested against the PR branch by hand.
   */
  degradedReason: v.nullable(v.string()),
  /** Fixer rounds spent, and the ceiling from the task's merge preset. */
  attempts: v.number(),
  maxAttempts: v.number(),
})
export type PublicHumanTestDecision = v.InferOutput<typeof publicHumanTestDecisionSchema>

/**
 * One actual-vs-reference pairing the visual-confirmation gate is showing, as exposed externally:
 * a logical view, the screenshot captured of it, and the reference design for the same view when
 * one was uploaded.
 *
 * Either side may be null (a captured view with no reference, or a reference whose view was never
 * captured), and BOTH ids being null is meaningful rather than degenerate: it says the view is
 * known and neither image exists. That is why the fields are always-present nullables instead of
 * optional ones.
 */
export const publicVisualConfirmPairSchema = v.object({
  /** The logical view this pairing is for. */
  view: v.string(),
  /** Artifact id of the captured screenshot, or null. App-resolvable only; see below. */
  actualArtifactId: v.nullable(v.string()),
  /** Artifact id of the uploaded reference design, or null. App-resolvable only; see below. */
  referenceArtifactId: v.nullable(v.string()),
})
export type PublicVisualConfirmPair = v.InferOutput<typeof publicVisualConfirmPairSchema>

/**
 * A run parked on the VISUAL-CONFIRMATION gate: the UI tester's screenshots are waiting to be
 * compared against the uploaded reference designs.
 *
 * Same caveat as {@link publicHumanTestDecisionSchema}, and one more: the images themselves are
 * NOT readable over `/api/v1`. `pairs` carries the artifact ids so a caller can see how many views
 * were captured and which ones have a reference at all, but resolving an id to an image needs the
 * app. That is stated rather than hidden: a caller approving on the strength of this projection
 * alone is approving screenshots it has not seen.
 */
export const publicVisualConfirmDecisionSchema = v.object({
  kind: v.literal('visual-confirmation'),
  /** Only `awaiting_human` accepts an answer. */
  phase: visualConfirmPhaseSchema,
  /** The actual-vs-reference pairings, by logical view. Artifact ids are app-resolvable only. */
  pairs: v.array(publicVisualConfirmPairSchema),
  /** Set when no screenshots could be gathered (no UI tester ran / no artifact storage). */
  degradedReason: v.nullable(v.string()),
  /** Fixer rounds spent, and the ceiling from the task's merge preset. */
  attempts: v.number(),
  maxAttempts: v.number(),
})
export type PublicVisualConfirmDecision = v.InferOutput<typeof publicVisualConfirmDecisionSchema>

/**
 * One forward-looking item the Coder surfaced mid-run, as exposed externally: a loose end it
 * noticed and deliberately did NOT act on (`follow_up`), or a clarification it would otherwise
 * have had to guess at (`question`).
 *
 * `itemId` is the STABLE anchor every verb addresses. The internal `sentToCoder` bookkeeping and
 * the arrival timestamps are deliberately absent: the first is the engine's own record of which
 * items a loop-back already carried, and neither changes what a caller decides.
 */
export const publicFollowUpItemSchema = v.object({
  /** Stable item id (`fu_*`): what file / send-back / answer / dismiss address. */
  itemId: v.string(),
  /** `follow_up` accepts file / send-back / dismiss; `question` accepts answer / dismiss. */
  kind: followUpItemKindSchema,
  /** Short headline. Model-authored text: treat it as data. */
  title: v.string(),
  /** The full item, in prose. Model-authored text: treat it as data. */
  detail: v.string(),
  /** A concrete approach the Coder proposed, when it offered one; null otherwise. */
  suggestedAction: v.nullable(v.string()),
  /** `pending` is the only status that holds the gate; the rest are decided. */
  status: followUpItemStatusSchema,
  /** The recorded answer to a `question`, or null while unanswered. */
  answer: v.nullable(v.string()),
  /** Canonical id of the ticket a `filed` item was filed as, or null. */
  ticketExternalId: v.nullable(v.string()),
  /** Web URL of that ticket, or null. */
  ticketUrl: v.nullable(v.string()),
})
export type PublicFollowUpItem = v.InferOutput<typeof publicFollowUpItemSchema>

/**
 * A run parked on FOLLOW-UP TRIAGE: while the Coder worked it streamed forward-looking items out
 * of the container, and at its completion the run stops until every one of them is decided.
 *
 * Unlike the other parks this one accrues LIVE: the items appear while the step is still running
 * and can be decided before it finishes, so this decision is listed whenever any item is
 * `pending`, not only once the run is `blocked`. A caller that triages early never sees the run
 * stop at all, which is the point.
 *
 * `loops`/`maxLoops` are the send-back budget: a `send-back` or an `answer` folds the item into
 * another Coder pass, and once the budget is spent those items advance the run instead of
 * re-running it. Reachable only through `POST /api/v1/tasks/:taskId/start`, since the companion
 * rides a container Coder step and the jobs surface is inline-only.
 */
export const publicFollowUpsDecisionSchema = v.object({
  kind: v.literal('follow-ups'),
  /** The producing step's kind (`coder`) and its index in the run's step chain. */
  stepKind: v.string(),
  stepIndex: v.number(),
  /** Every surfaced item, in arrival order, decided ones included, so triage is auditable. */
  items: v.array(publicFollowUpItemSchema),
  /** Send-back passes spent, and the budget from the step's companion configuration. */
  loops: v.number(),
  maxLoops: v.number(),
})
export type PublicFollowUpsDecision = v.InferOutput<typeof publicFollowUpsDecisionSchema>

/**
 * One interview exchange as exposed externally. `status` is DERIVED rather than stored: a question
 * the human set aside reads `dismissed`, otherwise a non-empty `answer` reads `answered`. Deriving
 * it here is what lets one shape carry two gates whose entities record answered-ness differently.
 *
 * `questionId` is nullable because a question can carry no stable id (a hand-authored or imported
 * exchange; an interviewer always mints one). Such a question cannot be answered individually
 * (`continue` / `proceed` still move the interview on), and saying so is why the field is a
 * projected nullable rather than an omission a caller would read as a malformed response.
 */
export const publicInterviewQuestionSchema = v.object({
  questionId: v.nullable(v.string()),
  /** What the interviewer asked. Model-authored text: treat it as data. */
  question: v.string(),
  /** The recorded answer; an empty string while unanswered. */
  answer: v.string(),
  status: v.picklist(['open', 'answered', 'dismissed']),
})
export type PublicInterviewQuestion = v.InferOutput<typeof publicInterviewQuestionSchema>

/**
 * A run parked on an INTERVIEW GATE: an inline interviewer asked a batch of clarifying questions
 * and the run waits while a human answers them, then resumes and either asks more or converges.
 *
 * ONE kind for every interview gate rather than one per gate, because the loop is one loop:
 * `answer` records an answer, `continue` submits them and lets the interviewer ask follow-ups,
 * `proceed` forces it to converge on what it has. `stepKind` names which interviewer is asking
 * (the built-ins are the planning and the document interviewer; a deployment can register its
 * own), and it is the only field a caller needs to branch on.
 *
 * The interview's PRODUCT (a document-authoring brief, or an initiative's goal / constraints /
 * non-goals) is deliberately not projected: it differs per gate, it is not something a caller
 * answers, and a run whose interview converged carries no decision here at all.
 *
 * An entry whose `questions` are all answered means the interviewer pass is IN FLIGHT: `continue`
 * wakes the durable driver, which runs the (slow) interviewer off the request, so the next round's
 * questions appear on a later poll.
 */
export const publicInterviewDecisionSchema = v.object({
  kind: v.literal('interview'),
  /** Which interviewer is asking (`doc-interviewer`, `initiative-interviewer`, …). */
  stepKind: v.string(),
  /** The board task the interview is anchored on. */
  taskId: v.string(),
  /** Interviewer passes spent, and the round budget the gate converges at. */
  round: v.number(),
  maxRounds: v.number(),
  /** The exchanges so far, oldest first. */
  questions: v.array(publicInterviewQuestionSchema),
})
export type PublicInterviewDecision = v.InferOutput<typeof publicInterviewDecisionSchema>

export const publicDecisionSchema = v.variant('kind', [
  publicRequirementsDecisionSchema,
  publicForkDecisionSchema,
  publicJudgeDecisionSchema,
  publicInputGateDecisionSchema,
  publicApprovalGateDecisionSchema,
  publicAgentDecisionSchema,
  publicClarityDecisionSchema,
  publicBrainstormDecisionSchema,
  publicPrReviewDecisionSchema,
  publicHumanTestDecisionSchema,
  publicVisualConfirmDecisionSchema,
  publicFollowUpsDecisionSchema,
  publicInterviewDecisionSchema,
])
export type PublicDecision = v.InferOutput<typeof publicDecisionSchema>

/**
 * Why a wait this surface cannot answer is holding the run. A CLOSED vocabulary, so an
 * integration maps each cause to its own copy and its own escalation instead of parsing prose:
 *
 * - `human_wait_gate` — a shipped gate whose poll has no deadline because a PERSON is the gate
 *   (`human-review`). Its answer is that person acting on the pull request, not an API call this
 *   surface could offer, so there is nothing here to build.
 * - `unclassified_gate` — a gate the DEPLOYMENT registered. Whether it ever ends on its own is
 *   declared inside the object its factory builds, which no request-time read can reach, so this
 *   surface says what it knows (the run is sitting on this gate) rather than guessing which.
 *   Whoever registered the gate owns its answer.
 * - `unwired_interview_gate` — an interviewer this deployment REGISTERED as an agent kind but
 *   never wired a controller for. The run is genuinely parked on its questions and no surface,
 *   here or in the app, can read them; the fix belongs to the operator, not the caller.
 */
export const publicUnanswerableReasonSchema = v.picklist([
  'human_wait_gate',
  'unclassified_gate',
  'unwired_interview_gate',
])
export type PublicUnanswerableReason = v.InferOutput<typeof publicUnanswerableReasonSchema>

/** One wait holding a run that `/api/v1/runs/:runId/decisions` cannot answer. */
export const publicUnanswerableWaitSchema = v.object({
  reason: publicUnanswerableReasonSchema,
  /** The step kind holding the run: the gate's kind, or the interviewer's agent kind. */
  stepKind: v.string(),
  /** Its index in the run's step chain, so a caller can line it up with `publicRun.steps`. */
  stepIndex: v.number(),
  /** Where the answer actually lives, in prose, for a human reading a log or an alert. */
  detail: v.string(),
})
export type PublicUnanswerableWait = v.InferOutput<typeof publicUnanswerableWaitSchema>

/**
 * What a run is currently asking a human, and whether it has STOPPED to ask. The two are related
 * but not the same question, and a caller that treats `parked` as a gate on reading `decisions`
 * gets the common case right and the useful case wrong:
 *
 * - `parked: true`, non-empty list: the ordinary park. The run is `blocked` and will not move
 *   until one of these is answered.
 * - `parked: false`, non-empty list: the run is still working and asking anyway. Today only
 *   `follow-ups` does this: the Coder streams its items mid-run and they can be decided before it
 *   finishes, so an integration that polls `decisions` regardless of `parked` never sees the run
 *   stop at all. One that reads `decisions` only when `parked` is true still works, it just waits.
 * - EMPTY list: the run is either still working or waiting on something this surface cannot
 *   answer. `unanswerable` is what tells the two apart — see below.
 */

export const publicDecisionListSchema = v.object({
  runId: v.string(),
  taskId: v.string(),
  /** The run's raw status — `blocked` is the parked state. */
  status: publicRunStatusSchema,
  /**
   * Whether the run has STOPPED awaiting a human decision (`status === 'blocked'`). Not a
   * precondition for `decisions` being non-empty: see the note above.
   */
  parked: v.boolean(),
  decisions: v.array(publicDecisionSchema),
  /**
   * Waits holding the run that this surface cannot answer, each NAMED.
   *
   * This is what an empty `decisions` used to leave as a riddle: a run stopped on a surface the
   * projection does not model reported `parked: true` with nothing in it, indistinguishable from a
   * bug, and a caller's only recourse was to stop the run. Reporting the wait does not make it
   * answerable here (by construction it is not), but it turns "something is wrong" into "a person
   * has to review the pull request", which is the difference between escalating to a human and
   * cancelling the work.
   *
   * Deliberately NOT gated on `parked`. An unbounded wait GATE keeps the run `running` between
   * polls rather than `blocked` — the honest state, since the engine is still probing — so the
   * riddle's worst form is a run that reads as working and never moves. Populated whenever a wait
   * is present, so a poller reading only this field sees it either way.
   *
   * A BOUNDED built-in gate (`ci`, `conflicts`) is never listed: it resolves itself, and putting
   * it here would read as a demand for a human that nobody has to meet.
   */
  unanswerable: v.array(publicUnanswerableWaitSchema),
})
export type PublicDecisionList = v.InferOutput<typeof publicDecisionListSchema>

// ---- Request bodies -------------------------------------------------------

/** Answer one reviewer finding. Mirrors the SPA's `replyReviewItemSchema` bounds. */
export const publicReplyFindingSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type PublicReplyFindingInput = v.InferOutput<typeof publicReplyFindingSchema>

/**
 * Set a finding's status. Deliberately narrower than the SPA's full item-status patch: a headless
 * caller may `dismiss` a finding as not applicable or `reopen` one it dismissed by mistake.
 * `answered` is reached by REPLYING (which is what records the answer the incorporation folds in),
 * and `recommend_requested` drives an in-app-only affordance, so neither is settable here.
 */
export const publicSetFindingStatusSchema = v.object({
  status: v.picklist(['dismissed', 'open']),
})
export type PublicSetFindingStatusInput = v.InferOutput<typeof publicSetFindingStatusSchema>

/**
 * Incorporate the recorded answers. Optional `feedback` is the "do it differently" lever when
 * redoing a merge, exactly as in the SPA. Asynchronous: the durable driver folds and re-reviews in
 * the background, so the response is the `incorporating` review, not the finished document.
 */
export const publicIncorporateSchema = v.object({
  feedback: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type PublicIncorporateInput = v.InferOutput<typeof publicIncorporateSchema>

/**
 * Resolve an iteration cap: one more pass, proceed with what the last pass produced, or stop and
 * reset the task to an editable state. The same three choices the SPA offers — there is
 * deliberately no timed default (a parked run waits for an answer indefinitely, so a silent
 * auto-proceed would ship work nobody approved).
 *
 * Shared by every capped loop the surface exposes: the three iterative reviews and a quality
 * companion at its automatic-rework cap. They are ONE body because they are one question, and
 * minting a per-loop DTO would put four identical types in four published SDKs.
 */
export const publicResolveExceededSchema = v.object({
  choice: iterationCapChoiceSchema,
})
export type PublicResolveExceededInput = v.InferOutput<typeof publicResolveExceededSchema>

/**
 * Choose an implementation approach: EXACTLY one of a proposed `forkId` or a free-text `custom`
 * approach, optionally with a steering `note` on a picked fork. Mirrors the SPA's `chooseForkSchema`
 * (same xor rule and bounds) so both surfaces accept identical input.
 */
export const publicChooseForkSchema = v.pipe(
  v.object({
    forkId: v.optional(v.nullable(v.string())),
    custom: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8000)))),
    note: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(4000)))),
  }),
  v.check(
    (c) => (c.forkId != null && c.forkId.length > 0) !== (c.custom != null && c.custom.length > 0),
    'Provide exactly one of forkId or custom.',
  ),
)
export type PublicChooseForkInput = v.InferOutput<typeof publicChooseForkSchema>

/**
 * Resolve a parked judge verdict from a headless caller. Identical to the SPA's
 * {@link resolveJudgeSchema} — the two surfaces drive the SAME service method, so there is
 * nothing to narrow: `proceed` / `bounce` / `stop` mean exactly the same thing either way.
 */
export const publicResolveJudgeSchema = resolveJudgeSchema
export type PublicResolveJudgeInput = v.InferOutput<typeof publicResolveJudgeSchema>

/**
 * Resolve a run parked on the PRE-DISPATCH INPUT GATE from a headless caller. Identical to the
 * SPA's {@link resolveInputGateSchema} — both surfaces drive the SAME service method, so there
 * is nothing to narrow: `recheck` re-evaluates the task as it now stands (which is what actually
 * clears the park, so an integration fixes the task over `PATCH /api/v1/tasks/:taskId` first),
 * and `proceed` waives the findings and records who did it.
 */
export const publicResolveInputGateSchema = resolveInputGateSchema
export type PublicResolveInputGateInput = v.InferOutput<typeof publicResolveInputGateSchema>

/**
 * Approve a parked gate, optionally replacing the agent's proposal with an edited one. The edit
 * is what flows to every downstream step, so supplying it is how a caller corrects the output
 * rather than bouncing the whole step; omit it to approve the text as written.
 */
export const publicApproveStepSchema = v.object({
  proposal: v.optional(v.pipe(v.string(), v.maxLength(50000))),
})
export type PublicApproveStepInput = v.InferOutput<typeof publicApproveStepSchema>

/**
 * Request changes on a parked gate: the step re-runs with this guidance folded in.
 *
 * `feedback` is REQUIRED here where the SPA's twin accepts either freeform text or anchored
 * per-block comments. An anchored comment carries the source line range of a rendered proposal, so
 * a headless caller has nothing to anchor to; requiring the freeform half means a re-run always
 * has something to act on rather than looping on an empty instruction.
 */
export const publicRequestStepChangesSchema = v.object({
  feedback: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10000)),
})
export type PublicRequestStepChangesInput = v.InferOutput<typeof publicRequestStepChangesSchema>

/** Reject a parked gate: the run stops entirely (a terminal failure the board can retry). */
export const publicRejectStepSchema = v.object({
  reason: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
})
export type PublicRejectStepInput = v.InferOutput<typeof publicRejectStepSchema>

/**
 * Resolve a companion gate parked at its automatic-rework cap. The SAME body as a review at its
 * cap ({@link publicResolveExceededSchema}), aliased rather than re-declared: the two carry one
 * question, and a structurally identical twin would be a second published type in four SDKs
 * meaning exactly what the first one means.
 */
export const publicResolveStepExceededSchema = publicResolveExceededSchema
export type PublicResolveStepExceededInput = v.InferOutput<typeof publicResolveStepExceededSchema>

/**
 * Answer an agent-raised decision. The choice is taken verbatim, so it may be one of the offered
 * `options` or a steer of the caller's own — the engine re-runs the asking step with it either way.
 */
export const publicResolveAgentDecisionSchema = v.object({
  choice: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type PublicResolveAgentDecisionInput = v.InferOutput<typeof publicResolveAgentDecisionSchema>

/**
 * Resolve a parked PR deep review: the curated `findingIds` plus what to do with them. `finish`
 * records the selection and completes the read-only review; `fix` hands the selected findings to a
 * fixer that commits onto the reviewed PR's branch; `post` publishes them as inline PR review
 * comments. `fix`/`post` need at least one selected finding, and both act on the real pull
 * request — this is the one decision route with an effect outside the platform.
 *
 * Both fields are plainly OPTIONAL rather than carrying a schema `default`, unlike the internal
 * twin. A default is "always present" on the way out and "may be omitted" on the way in, and the
 * SDK emitters read a request field's default as the former — so declaring one here would emit
 * four clients whose types insist on a value the API does not require. The fallbacks are applied
 * where the call is made instead, and documented on each field so the wire contract still states
 * what omitting it means.
 */
export const publicResolvePrReviewSchema = v.object({
  /** Omitted reads as `finish`. */
  action: v.optional(prReviewResolutionSchema),
  /** Omitted reads as an empty selection, which only `finish` accepts. */
  findingIds: v.optional(v.array(v.string())),
})
export type PublicResolvePrReviewInput = v.InferOutput<typeof publicResolvePrReviewSchema>

/**
 * Challenge one parked finding: a read-only investigator digs into it against the full source and
 * either upholds, strengthens or retracts it. An omitted / blank `question` uses the generic
 * "validate this finding" prompt.
 */
export const publicChallengePrReviewFindingSchema = v.object({
  question: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type PublicChallengePrReviewFindingInput = v.InferOutput<
  typeof publicChallengePrReviewFindingSchema
>

/**
 * Submit findings against a human-verdict gate (human-test or visual-confirmation) and request a
 * fix. The findings ARE the prompt the fixer works from, so unlike the SPA's textarea there is no
 * blank-is-fine case: an empty request would dispatch an agent with nothing to fix.
 */
export const publicRequestGateFixSchema = v.object({
  findings: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10000)),
})
export type PublicRequestGateFixInput = v.InferOutput<typeof publicRequestGateFixSchema>

/**
 * Answer one `question` item the Coder surfaced. Identical to the SPA's
 * {@link answerFollowUpSchema} and aliased rather than re-declared, on the same grounds as the
 * judge and input-gate bodies: both surfaces drive the SAME service method, so there is nothing
 * to narrow, and a structurally identical twin would be a second published type in four SDKs
 * meaning exactly what the first one means.
 */
export const publicAnswerFollowUpSchema = answerFollowUpSchema
export type PublicAnswerFollowUpInput = v.InferOutput<typeof publicAnswerFollowUpSchema>

/**
 * Answer one interview question. Declared fresh rather than aliased, unlike the bodies above: two
 * gates ride this route (the planning and the document interviewer) and each declares its own
 * internal body, so aliasing either one would privilege that gate's bounds on a surface serving
 * both, and a bound that is right for one and wrong for the other refuses valid input.
 *
 * The numbers are therefore taken from what the two gates STORE rather than from what either one
 * accepts: an exchange lives in `initiativeQaSchema` / `docInterviewQaSchema`, both of which cap an
 * id at 80 and an answer at 2000, so a question this surface can name is a question these bounds
 * can address. They are stated as literals rather than derived from those constants because this
 * is a published contract: deriving it would let an internal cap SHRINK the public bound silently,
 * which is the one direction `/api/v1` may not move. `publicAnswerInterviewBounds` in
 * `public-decisions.test.ts` asserts the relation instead, so a gate that widens its own storage
 * fails a test here rather than refusing valid input in production.
 *
 * An EMPTY `answer` is accepted, because both services accept it: it clears an answer recorded by
 * mistake, where a minimum length would leave a caller no way to undo one.
 */
export const publicAnswerInterviewSchema = v.object({
  /** The `questionId` from the decision's `questions`. */
  questionId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  answer: v.pipe(v.string(), v.maxLength(2000)),
})
export type PublicAnswerInterviewInput = v.InferOutput<typeof publicAnswerInterviewSchema>
