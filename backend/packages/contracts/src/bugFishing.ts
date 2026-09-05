import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Bug-fishing expedition wire contracts. A `bug-fishing` task runs the read-only
// `bug-fisher` container agent over the service's codebase REPEATEDLY — once per
// ANGLE (a "phase") — hunting for genuine logic gaps, real defects, footguns and
// unhandled edge cases rather than style opinions. The engine drives the phases as
// successive dispatches of the SAME step (a container job cannot pause mid-run, the
// same reason the fork decision splits into two dispatches), recording each phase's
// findings onto `step.bugFishing` the moment it lands. So a human can triage a
// finished phase's findings while the later angles are still being fished.
//
// Triage is the point of the flow: a human MARKS the findings worth acting on, and
// each marked finding spawns its OWN bug-fix task (a separate block + run) linked
// back to the expedition. The pipeline those spawned tasks run is the workspace's
// `bugFishingFixPipelineId` setting, overridable per marking request, defaulting to
// the built-in `pl_bugfix`.
//
// All expedition state rides the run's `bug-fisher` step (`PipelineStep.bugFishing`)
// — no side table — so it is runtime-symmetric by construction, exactly like
// `prReview` / `forkDecision`. See docs/initiatives/bug-fishing-expedition.md.
// ---------------------------------------------------------------------------

/**
 * The ANGLES an expedition fishes from, each one pass of the read-only agent over the
 * codebase. They are deliberately disjoint LENSES rather than a difficulty ladder: one pass
 * asked to find everything returns the shallow half of everything, whereas a pass told to
 * think only about concurrency reads the same files with a question that makes the race
 * visible.
 *
 * A PERSISTED closed vocabulary: a phase id is written onto the step's recorded phases and
 * onto every finding, so a value retired here still comes back out of stored runs. Nothing
 * renders a phase by looking its id up — {@link bugFishingPhaseSchema} carries the title and
 * goal it ran under — and {@link describeBugFishingPhase} names an unrecognised id as retired
 * rather than guessing at a current member or rendering `undefined`.
 */
export const BUG_FISHING_PHASE_IDS = [
  'control-flow',
  'error-handling',
  'boundaries',
  'concurrency',
  'state-lifecycle',
  'contracts',
  'footguns',
  'requirements',
] as const

export const bugFishingPhaseIdSchema = v.picklist(BUG_FISHING_PHASE_IDS)
export type BugFishingPhaseId = v.InferOutput<typeof bugFishingPhaseIdSchema>

/** What one angle is, and what the pass fishing it is told to look for. */
export interface BugFishingPhaseDescriptor {
  id: string
  /** Short human label (the window's phase header, the create form's checkbox). */
  title: string
  /** One line saying what this pass is hunting — rendered to the human AND to the agent. */
  goal: string
  /** The concrete prompt focus the agent is given for this pass. */
  focus: string
  /** True for an id this build no longer ships (a stored run naming a retired angle). */
  retired?: boolean
}

/**
 * The shipped angle catalog, in the order an expedition fishes them. Ordered so the angles
 * that most often hide a real defect run first, because an expedition a human stops early has
 * then still covered the ground worth covering.
 */
export const BUG_FISHING_PHASES: readonly BugFishingPhaseDescriptor[] = [
  {
    id: 'control-flow',
    title: 'Logic & control flow',
    goal: 'Find branches that do the wrong thing, or that are missing entirely.',
    focus:
      'Read the decision points: conditionals, loops, early returns, switch/match arms and the ' +
      'code paths that fall through them. Look for an inverted or short-circuited condition, a ' +
      'case nobody handled, an off-by-one bound, a branch that cannot be reached, and a value ' +
      'computed but never used where its absence changes the outcome.',
  },
  {
    id: 'error-handling',
    title: 'Failure handling',
    goal: 'Find failures that are swallowed, mis-attributed, or left half-applied.',
    focus:
      'Read every failure path: caught exceptions, rejected promises, non-zero exits, error ' +
      'returns. Look for a catch that discards the cause, a failure reported as a success, a ' +
      'retry over a non-idempotent effect, a partially-applied write with no compensation, and ' +
      'cleanup that only runs on the happy path.',
  },
  {
    id: 'boundaries',
    title: 'Inputs & boundary conditions',
    goal: 'Find inputs the code does not actually survive.',
    focus:
      'Read the entry points and the values that cross them. Look for the empty collection, the ' +
      'zero / negative / maximum number, the absent optional, the very long or non-ASCII string, ' +
      'the duplicate key, and untrusted text that reaches a parsed surface (a shell argument, a ' +
      'query, a rendered template) without being neutralised for it.',
  },
  {
    id: 'concurrency',
    title: 'Concurrency, ordering & idempotency',
    goal: 'Find what breaks when two callers race, or when the same work arrives twice.',
    focus:
      'Read the shared state and the write paths. Look for a read-modify-write with no guard, a ' +
      'check-then-act window, a delete-then-insert standing in for a uniqueness constraint, an ' +
      'external side effect a retry or replay would perform twice, and ordering the code assumes ' +
      'but nothing enforces.',
  },
  {
    id: 'state-lifecycle',
    title: 'State & resource lifecycle',
    goal: 'Find state that outlives its purpose, or dies before it is finished with.',
    focus:
      'Read construction, mutation and teardown. Look for a resource never released on some ' +
      'path, an unbounded cache or queue, a cached value nothing invalidates on the write that ' +
      'moves it, a state machine that admits a transition it should refuse, and state left ' +
      'inconsistent when an operation aborts halfway.',
  },
  {
    id: 'contracts',
    title: 'Interface contracts',
    goal: 'Find places where a caller and a callee disagree about the deal.',
    focus:
      'Read the boundaries between modules, services and stored shapes. Look for a documented ' +
      'guarantee the implementation does not hold, nullability the caller does not expect, a ' +
      'unit or timezone mismatch, a persisted or wire shape a newer reader can no longer parse, ' +
      'and an enum value that exists in stored data but has no arm in the current code.',
  },
  {
    id: 'footguns',
    title: 'Footguns',
    goal: 'Find code that is correct today and will be broken by the next honest change.',
    focus:
      'Read as the next maintainer. Look for an API that is easy to call incorrectly, a silent ' +
      'default that hides a missing decision, a name that misdescribes what the code does, two ' +
      'sources of truth for one fact, and an invariant held only by convention with no test or ' +
      'type enforcing it.',
  },
  {
    id: 'requirements',
    title: 'Requirements conformance',
    goal: 'Find where the code disagrees with the product requirements and rules you were given.',
    focus:
      'Read the supplied requirement, specification and rules documents against the code that ' +
      'implements them. Look for a stated rule with no implementation, an implementation that ' +
      'contradicts a stated rule, and a requirement implemented on one path but not on its ' +
      'siblings. Cite the document and the code side by side. If no such documents were ' +
      'supplied, say exactly that in the summary and return no findings rather than inventing ' +
      'requirements to measure the code against.',
  },
] as const

const PHASE_BY_ID = new Map(BUG_FISHING_PHASES.map((p) => [p.id, p]))

/**
 * The descriptor for a phase id, including one this build no longer ships.
 *
 * A retired angle is NAMED as retired rather than dropped or guessed onto a current member:
 * stored runs keep the id they ran under, and the reader that hits it first is the window
 * telling a human what an expedition actually covered. Answering `undefined` there would put
 * an empty header over real findings.
 */
export function describeBugFishingPhase(id: string): BugFishingPhaseDescriptor {
  const known = PHASE_BY_ID.get(id)
  if (known) return known
  return {
    id,
    title: `Retired angle (${id})`,
    goal: 'This angle is no longer part of the shipped expedition.',
    focus: '',
    retired: true,
  }
}

/** How serious a finding is, ordered critical → low. The window groups and colours by this. */
export const bugFishingSeveritySchema = v.picklist(['critical', 'high', 'medium', 'low'])
export type BugFishingSeverity = v.InferOutput<typeof bugFishingSeveritySchema>

/** Severity order (most severe first) — the one place the ranking is stated. */
export const BUG_FISHING_SEVERITY_ORDER: readonly BugFishingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
]

/**
 * What KIND of defect a finding is. Distinct from severity: an expedition is explicitly
 * fishing for more than crashes, and a `footgun` that will cost a week next quarter is a
 * different decision from an `edge-case` that fires today.
 */
export const bugFishingFindingKindSchema = v.picklist([
  'bug',
  'logic-gap',
  'edge-case',
  'footgun',
  'requirement-gap',
  'other',
])
export type BugFishingFindingKind = v.InferOutput<typeof bugFishingFindingKindSchema>

/** How sure the agent is that the finding is real — its own judgement, never platform-derived. */
export const bugFishingConfidenceSchema = v.picklist(['high', 'medium', 'low'])
export type BugFishingConfidence = v.InferOutput<typeof bugFishingConfidenceSchema>

/** A phase's lifecycle across the expedition's successive dispatches. */
export const bugFishingPhaseStatusSchema = v.picklist(['pending', 'fishing', 'completed', 'failed'])
export type BugFishingPhaseStatus = v.InferOutput<typeof bugFishingPhaseStatusSchema>

/**
 * One planned angle of the expedition, as recorded on the step.
 *
 * `title` and `goal` are COPIED from the catalog when the expedition is planned rather than
 * looked up at render time, so a run keeps naming the angle it actually fished even after that
 * angle is retired or reworded.
 */
export const bugFishingPhaseSchema = v.object({
  /** The angle's id (a {@link BUG_FISHING_PHASE_IDS} member when it was planned). */
  id: v.string(),
  /** The angle's label as it stood when this expedition planned it. */
  title: v.string(),
  /** What this pass was told to hunt, as it stood when this expedition planned it. */
  goal: v.string(),
  status: bugFishingPhaseStatusSchema,
  /** The agent's one-paragraph account of what it covered; null until the pass settles. */
  summary: v.optional(v.nullable(v.string())),
  /** Epoch ms the pass settled (completed or failed); null while pending / fishing. */
  settledAt: v.optional(v.nullable(v.number())),
  /** Why the pass failed, when it did. Null otherwise. */
  failureReason: v.optional(v.nullable(v.string())),
})
export type BugFishingPhase = v.InferOutput<typeof bugFishingPhaseSchema>

/**
 * How far a marked finding's spawn has got.
 *
 * - `pending`: the CLAIM. Written BEFORE the task exists, which is what makes marking safe
 *   against two people (or a retried request) marking one finding at the same time: the second
 *   claim finds the first and is refused, rather than both creating a task and a run.
 * - `spawned`: terminal. The task exists and its run was started.
 * - `failed`: the claim was taken and the work behind it did not land, carrying the cause. The
 *   finding is markable again, because nothing was created for it.
 */
export const bugFishingSpawnStatusSchema = v.picklist(['pending', 'spawned', 'failed'])
export type BugFishingSpawnStatus = v.InferOutput<typeof bugFishingSpawnStatusSchema>

/**
 * The record of a finding a human MARKED to be addressed: the bug-fix task the platform
 * spawned for it, and the pipeline that task runs.
 *
 * It is what links the expedition to the work it caused: the window reads the spawned task's
 * live status through it, and the spawned block carries the expedition's own block id back the
 * other way (`Block.expeditionId`).
 *
 * Written TWICE, and the first write is the point. A spawn creates a board task and starts a run,
 * so it is an external side effect in a path two callers can enter at once; the record is
 * therefore taken as a `pending` CLAIM before any of that happens and settled to `spawned` or
 * `failed` after. Reading it as "there is a fix task" means reading {@link
 * bugFishingSpawnStatusSchema}, never merely the presence of this record.
 */
export const bugFishingSpawnSchema = v.object({
  /** How far the spawn has got; see {@link bugFishingSpawnStatusSchema}. */
  status: bugFishingSpawnStatusSchema,
  /** The spawned task block's id, minted with the claim so the claimer can recognise its own. */
  taskId: v.string(),
  /**
   * The run started on the task. Null while the claim is `pending`, and on a `spawned` record
   * whose task was created but whose run reported no id.
   */
  executionId: v.optional(v.nullable(v.string())),
  /** The pipeline the spawned task runs (the resolved default, or the caller's override). */
  pipelineId: v.string(),
  /** Who marked the finding. Null for a system-initiated marking. */
  requestedBy: v.optional(v.nullable(v.string())),
  /** Epoch ms the claim was taken. */
  requestedAt: v.number(),
  /** Why the spawn failed, on a `failed` record. Null otherwise. */
  failureReason: v.optional(v.nullable(v.string())),
})
export type BugFishingSpawn = v.InferOutput<typeof bugFishingSpawnSchema>

/**
 * How long a `pending` spawn claim holds a finding before another marking may take it.
 *
 * The claim is held across a board insert and a run start, so it is normally seconds. The window
 * exists for the one case the claimer cannot clean up after itself: a process killed between
 * taking the claim and settling it, which would otherwise leave the finding claimed by nobody,
 * forever, with no fix task to show for it. Generous enough that it can never expire under a
 * merely slow start, which would be exactly the double spawn the claim exists to prevent.
 */
export const BUG_FISHING_SPAWN_CLAIM_TTL_MS = 5 * 60_000

/**
 * Whether a finding is still OPEN: nothing is being done about it, so it may be marked (or
 * dismissed) right now.
 *
 * Here rather than in the engine because both sides have to agree about it and neither owns the
 * answer: the engine refuses a second marking with it, and the window counts "N left to triage"
 * and decides which rows the working list shows with it. Stated once, the two cannot drift into
 * a window that offers a mark the engine will refuse.
 *
 * Three ways to be open: nothing has been claimed, the last attempt `failed` (nothing was created,
 * so there is nothing to collide with), or a `pending` claim has outlived
 * {@link BUG_FISHING_SPAWN_CLAIM_TTL_MS} and its claimer is gone. A `spawned` record is terminal:
 * the task exists, and marking again would file the same bug twice.
 */
export function bugFishingSpawnIsClaimable(
  spawn: BugFishingSpawn | null | undefined,
  now: number,
): boolean {
  if (!spawn) return true
  if (spawn.status === 'spawned') return false
  if (spawn.status === 'failed') return true
  return now - spawn.requestedAt >= BUG_FISHING_SPAWN_CLAIM_TTL_MS
}

/**
 * One finding, id-stamped by the engine and anchored to the phase that surfaced it.
 *
 * `evidence` is kept apart from `detail` on purpose: an expedition that cannot point at the
 * code it is describing is speculating, and separating the two makes that visible to the human
 * triaging it rather than something they have to infer from the prose.
 */
export const bugFishingFindingSchema = v.object({
  /** Engine-minted stable id (`bff_*`); the marking requests carry these ids. */
  id: v.string(),
  /** The phase that surfaced it (a phase id; see {@link describeBugFishingPhase}). */
  phaseId: v.string(),
  /** Repo-relative path the finding concerns; empty when it is not anchored to one file. */
  path: v.string(),
  /** The line the finding anchors to, or null. */
  line: v.optional(v.nullable(v.number())),
  severity: bugFishingSeveritySchema,
  kind: bugFishingFindingKindSchema,
  confidence: bugFishingConfidenceSchema,
  /** Short headline. */
  title: v.string(),
  /** The full finding, in prose: what is wrong and what happens because of it. */
  detail: v.string(),
  /** How the defect manifests: the concrete inputs / interleaving / state that triggers it. */
  failureScenario: v.optional(v.nullable(v.string())),
  /** What the agent actually read that supports the claim (code it can point at). */
  evidence: v.optional(v.nullable(v.string())),
  /** A concrete suggested change, when the agent offered one. */
  suggestedFix: v.optional(v.nullable(v.string())),
  /**
   * The bug-fix task spawned for this finding, when a human marked it. Null when nobody has.
   * A record with a `failed` status is a mark that did not land: the finding is markable again,
   * so a reader deciding whether this finding is being worked on reads the STATUS, not the
   * presence of the record.
   */
  spawn: v.optional(v.nullable(bugFishingSpawnSchema)),
  /** Set when a human dismissed the finding: it stays on the record, struck through. */
  dismissed: v.optional(v.boolean(), false),
})
export type BugFishingFinding = v.InferOutput<typeof bugFishingFindingSchema>

/**
 * The expedition lifecycle on a `bug-fisher` step:
 * - `fishing`: a phase's read-only container job is in flight (or the next one is about to be).
 * - `awaiting_triage`: every phase settled; parked for the human to finish triaging.
 * - `done`: the human finished the expedition (the run advances past it).
 *
 * There is deliberately no `skipped`: an expedition with no angles cannot be asked for, because
 * an empty selection means "fish every angle" (see `planBugFishingPhases`).
 *
 * There is deliberately no `triaging` state: marking a finding is available from the moment
 * its phase lands, INCLUDING while later phases are still fishing, which is the whole reason
 * the angles run as separate passes.
 */
export const bugFishingStatusSchema = v.picklist(['fishing', 'awaiting_triage', 'done'])
export type BugFishingStatus = v.InferOutput<typeof bugFishingStatusSchema>

/**
 * Live bug-fishing state carried on the run's `bug-fisher` step. Created by the engine when
 * the step first runs (planning the phases from the task's selection), extended by each
 * phase's completion, and mutated by the human's markings.
 */
export const bugFishingStepStateSchema = v.object({
  status: bugFishingStatusSchema,
  /** The planned angles, in the order they are fished. */
  phases: v.optional(v.array(bugFishingPhaseSchema), []),
  /**
   * Index into {@link bugFishingStepStateSchema}'s `phases` of the pass currently being fished
   * (or about to be). Equal to `phases.length` once every angle has settled, which is what the
   * `awaiting_triage` status says in the other direction; an index rather than a pointer so an
   * empty phase list still has an unambiguous value.
   */
  currentPhaseIndex: v.optional(v.number(), 0),
  /** Every finding surfaced so far, oldest phase first, severity-ordered within a phase. */
  findings: v.optional(v.array(bugFishingFindingSchema), []),
  /** Identifier of the model that fished, for transparency. */
  model: v.optional(v.nullable(v.string())),
  /**
   * The pipeline a marked finding's spawned task runs when the marking names none: the
   * workspace's `bugFishingFixPipelineId`, else the built-in bug-fix preset. Resolved when the
   * expedition is planned and recorded here, so the window can state the default it will use
   * without a second read and the record says which default a spawn actually took.
   */
  defaultFixPipelineId: v.optional(v.nullable(v.string())),
})
export type BugFishingStepState = v.InferOutput<typeof bugFishingStepStateSchema>

// ---- Agent output (lenient) ----------------------------------------------

/**
 * The LENIENT structured shape the read-only `bug-fisher` container agent returns as
 * `result.custom` for ONE phase (the engine mints the finding ids and stamps the phase).
 * Every field falls back to a safe default (`v.fallback`) — exactly like
 * `prReviewAgentOutputSchema` — so a partially-malformed reply degrades sensibly rather than
 * failing a pass whose other findings are fine.
 */
export const bugFishingAgentOutputSchema = v.object({
  /** What this pass covered and what it concluded, in one paragraph. */
  summary: v.fallback(v.optional(v.string()), undefined),
  /** The findings this pass surfaced. */
  findings: v.fallback(
    v.array(
      v.fallback(
        v.object({
          path: v.fallback(v.string(), ''),
          line: v.fallback(v.optional(v.number()), undefined),
          severity: v.fallback(bugFishingSeveritySchema, 'medium'),
          kind: v.fallback(bugFishingFindingKindSchema, 'other'),
          confidence: v.fallback(bugFishingConfidenceSchema, 'medium'),
          title: v.fallback(v.string(), ''),
          detail: v.fallback(v.string(), ''),
          failureScenario: v.fallback(v.optional(v.string()), undefined),
          evidence: v.fallback(v.optional(v.string()), undefined),
          suggestedFix: v.fallback(v.optional(v.string()), undefined),
        }),
        {
          path: '',
          severity: 'medium' as const,
          kind: 'other' as const,
          confidence: 'medium' as const,
          title: '',
          detail: '',
        },
      ),
    ),
    [],
  ),
})
export type BugFishingAgentOutput = v.InferOutput<typeof bugFishingAgentOutputSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Mark findings to be addressed: each one spawns its OWN bug-fix task, linked back to the
 * expedition. Accepted while the expedition is still fishing later phases as well as once it
 * has parked, because a completed phase's findings are actionable the moment they land.
 *
 * `pipelineId` overrides, for THIS request only, the pipeline the spawned tasks run; omitted
 * ⇒ the expedition's resolved default (the workspace's `bugFishingFixPipelineId`, else the
 * built-in bug-fix preset).
 */
export const addressBugFishingFindingsSchema = v.object({
  /** The findings to act on. At least one; an unknown or already-spawned id is refused. */
  findingIds: v.pipe(v.array(v.string()), v.minLength(1)),
  /** Pipeline the spawned tasks run; omitted ⇒ the expedition's default. */
  pipelineId: v.optional(v.string()),
})
export type AddressBugFishingFindingsInput = v.InferOutput<typeof addressBugFishingFindingsSchema>

/**
 * Finish a parked expedition: the human is done triaging and the run advances past the step.
 * Takes no fields — every marking already happened through its own request, so there is no
 * curated selection left to carry here.
 */
export const resolveBugFishingSchema = v.object({})
export type ResolveBugFishingInput = v.InferOutput<typeof resolveBugFishingSchema>
