import type {
  Block,
  Initiative,
  InitiativeExecutionPolicy,
  InitiativeItem,
  InitiativeItemStatus,
  InitiativePhase,
  InitiativePlanDraft,
  InitiativeQa,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError, hasInitiativeKinds } from '@cat-factory/kernel'
import {
  INITIATIVE_ITEM_TERMINAL_STATUSES,
  INITIATIVE_PROSE_MAX,
  INITIATIVE_SHORT_MAX,
} from '@cat-factory/contracts'

// Pure initiative computations — no IO, no ports — reused by the InitiativeService,
// the execution engine's runnable guard, and (later slices) the execution loop.

/** Turn a title into a stable, filesystem/URL-safe slug (the tracker folder name). */
export function initiativeSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'initiative'
}

/**
 * The bidirectional pipeline ⇔ block-level guard for initiative planning: a chain
 * carrying an initiative kind may ONLY run on an `initiative`-level block, and an
 * initiative block accepts ONLY such a chain. Called from the engine's shared
 * `assertRunnable` (start + retry + restart), so the restriction can't drift
 * between entry points.
 */
export function assertInitiativeShapeAllowed(block: Block, agentKinds: readonly string[]): void {
  const initiativeShape = hasInitiativeKinds(agentKinds)
  if (initiativeShape && block.level !== 'initiative') {
    throw new ConflictError(
      'The Initiative Planning pipeline can only be started on an initiative block',
    )
  }
  if (!initiativeShape && block.level === 'initiative') {
    throw new ConflictError(
      'An initiative block only accepts the Initiative Planning pipeline (pl_initiative)',
    )
  }
}

/**
 * Validate a plan draft's internal references: unique phase/item ids, every item
 * pointing at a declared phase, dependencies pointing at declared items, and an
 * acyclic dependency graph. Throws {@link ValidationError} on the first violation.
 * The lenient coercion (`coerceInitiativePlan`) already produces a well-formed
 * draft; this re-checks at the trust boundary so a hand-supplied draft can't
 * smuggle a broken graph into the loop.
 */
export function validatePlanDraft(draft: InitiativePlanDraft): void {
  const phaseIds = new Set<string>()
  for (const phase of draft.phases) {
    if (!phase.id) continue
    if (phaseIds.has(phase.id)) throw new ValidationError(`Duplicate phase id '${phase.id}'`)
    phaseIds.add(phase.id)
  }
  const itemIds = new Set<string>()
  for (const item of draft.items) {
    if (!item.id) continue
    if (itemIds.has(item.id)) throw new ValidationError(`Duplicate item id '${item.id}'`)
    itemIds.add(item.id)
  }
  for (const item of draft.items) {
    if (item.phaseId && phaseIds.size > 0 && !phaseIds.has(item.phaseId)) {
      throw new ValidationError(
        `Item '${item.id ?? item.title}' references unknown phase '${item.phaseId}'`,
      )
    }
    for (const dep of item.dependsOn ?? []) {
      if (!itemIds.has(dep)) {
        throw new ValidationError(
          `Item '${item.id ?? item.title}' depends on unknown item '${dep}'`,
        )
      }
    }
  }
  // Cycle check over the dependency edges (DFS with a visiting set).
  const deps = new Map(draft.items.map((i) => [i.id ?? '', i.dependsOn ?? []]))
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): void => {
    if (done.has(id)) return
    if (visiting.has(id)) throw new ValidationError(`Dependency cycle through item '${id}'`)
    visiting.add(id)
    for (const dep of deps.get(id) ?? []) visit(dep)
    visiting.delete(id)
    done.add(id)
  }
  for (const id of deps.keys()) if (id) visit(id)
}

/** Assign a unique slug-derived id, suffixing `-2`, `-3`, … on collision. */
function uniqueSlugId(base: string, taken: Set<string>): string {
  const slug = initiativeSlug(base)
  let candidate = slug
  let n = 2
  while (taken.has(candidate)) candidate = `${slug}-${n++}`
  taken.add(candidate)
  return candidate
}

/**
 * Fold an approved plan draft into the persisted entity, PRESERVING runtime state:
 * an item whose id already exists keeps its `status`/`blockId`/`pr`/`note` (so a
 * durable-driver replay of the ingest — or a later re-plan — never resets settled
 * work), while its plan content (title/description/estimate/deps/phase) follows
 * the draft. An item OMITTED from the draft is dropped ONLY when it is still
 * un-materialised (`pending`, no spawned block); a re-plan that omits an item the
 * loop already spawned or settled carries it over untouched, so a mid-flight
 * re-plan never orphans a spawned task or erases completed work. New items start
 * `pending`. Draft phases/items missing an id get a deterministic slug-derived one, and
 * decisions merge by slug id keeping their original timestamps — so re-applying
 * the same draft is byte-identical (the ingest idempotency check relies on it).
 * Does NOT bump `rev`/`updatedAt` — the CAS writer owns those.
 */
export function applyPlanDraft(
  initiative: Initiative,
  draft: InitiativePlanDraft,
  now: number,
): Initiative {
  // Seed the taken-set with every EXPLICIT id up front, so an id-less phase whose
  // title slugifies to an id used by a LATER explicit phase can't silently collide
  // (a hand-supplied / re-plan draft mixing explicit and omitted ids).
  const phaseIds = new Set<string>(
    draft.phases.map((p) => p.id).filter((id): id is string => id !== undefined),
  )
  const phases: InitiativePhase[] = draft.phases.map((p) => ({
    id: p.id ?? uniqueSlugId(p.title, phaseIds),
    title: p.title,
    goal: p.goal ?? '',
    ...(p.maxConcurrent !== undefined ? { maxConcurrent: p.maxConcurrent } : {}),
  }))

  const existingItems = new Map((initiative.items ?? []).map((i) => [i.id, i]))
  const itemIds = new Set<string>(
    draft.items.map((d) => d.id).filter((id): id is string => id !== undefined),
  )
  const items: InitiativeItem[] = draft.items.map((d) => {
    const id = d.id ?? uniqueSlugId(d.title, itemIds)
    itemIds.add(id)
    const prior = existingItems.get(id)
    return {
      id,
      phaseId: d.phaseId,
      title: d.title,
      description: d.description ?? '',
      dependsOn: d.dependsOn ?? [],
      ...(d.estimate ? { estimate: d.estimate } : {}),
      ...(d.pipelineId ? { pipelineId: d.pipelineId } : {}),
      status: prior?.status ?? 'pending',
      ...(prior?.blockId != null ? { blockId: prior.blockId } : {}),
      ...(prior?.pr ? { pr: prior.pr } : {}),
      ...(prior?.note ? { note: prior.note } : {}),
    }
  })

  // A re-plan that OMITS a previously-MATERIALISED item (the loop already spawned a task
  // for it, or it already settled) must not silently drop it: that would orphan the spawned
  // block — which still carries this initiative's `initiativeId` — and erase completed work
  // from the tracker + progress rollup. Carry those items over unchanged; a still-`pending`,
  // unspawned item omitted from the re-plan is genuinely removed. On a REPLAY of the SAME
  // draft every prior item reappears by id, so `preserved` is empty and the ingest stays
  // byte-identical (the idempotency check relies on it).
  const draftItemIds = new Set(items.map((i) => i.id))
  const preserved = (initiative.items ?? []).filter(
    (i) => !draftItemIds.has(i.id) && (i.blockId != null || i.status !== 'pending'),
  )

  const existingDecisions = new Map((initiative.decisions ?? []).map((d) => [d.id, d]))
  const decisionIds = new Set<string>()
  const decisions = (draft.decisions ?? []).map((d) => {
    const id = uniqueSlugId(d.title, decisionIds)
    const prior = existingDecisions.get(id)
    return {
      id,
      at: prior?.at ?? now,
      title: d.title,
      detail: d.detail ?? '',
      source: prior?.source ?? ('planning' as const),
    }
  })

  return {
    ...initiative,
    goal: draft.goal ?? '',
    constraints: draft.constraints ?? [],
    nonGoals: draft.nonGoals ?? [],
    analysisSummary: draft.analysisSummary ?? '',
    phases,
    items: [...items, ...preserved],
    policy: draft.policy,
    decisions,
    caveats: draft.caveats ?? [],
    // A fresh/re-run planning pass parks the run at the human gate next, so the
    // entity reflects "plan drafted, awaiting approval". An already-executing
    // initiative keeps its status (a mid-flight re-plan revises content only).
    status:
      initiative.status === 'planning' || initiative.status === 'awaiting_approval'
        ? 'awaiting_approval'
        : initiative.status,
  }
}

/**
 * The DERIVED current phase: the first phase (in declared order) still holding a
 * non-terminal item. Null when every item is settled (the initiative is done).
 * Deliberately never stored — deriving it means there is no cursor to corrupt.
 */
export function deriveCurrentPhase(initiative: Initiative): InitiativePhase | null {
  const items = initiative.items ?? []
  for (const phase of initiative.phases ?? []) {
    const open = items.some(
      (i) => i.phaseId === phase.id && !INITIATIVE_ITEM_TERMINAL_STATUSES.has(i.status),
    )
    if (open) return phase
  }
  return null
}

/** Completion progress across all items (settled / total), for board rendering. */
export function initiativeProgress(initiative: Initiative): { done: number; total: number } {
  const items = initiative.items ?? []
  return {
    done: items.filter((i) => INITIATIVE_ITEM_TERMINAL_STATUSES.has(i.status)).length,
    total: items.length,
  }
}

// ---------------------------------------------------------------------------
// Interactive planning interview (slice 2) — pure state transitions over the entity's
// `qa` + `interview` fields. The interviewer LLM (InitiativeInterviewService) decides WHAT
// to ask / synthesize; these apply the decision to the entity, and the InitiativeService
// wraps each in a CAS `mutate` so answering/continuing is a single-writer, replay-safe write.
// ---------------------------------------------------------------------------

/** How many interviewer passes may run before the loop is force-converged. */
export const INITIATIVE_MAX_INTERVIEW_ROUNDS = 4
/** Upper bound on questions the interviewer may ask in one round (keeps the gate answerable). */
export const INITIATIVE_MAX_INTERVIEW_QUESTIONS = 8

const clampShort = (s: string): string => s.trim().slice(0, INITIATIVE_SHORT_MAX)

/** The interviewer LLM's decision: ask more questions, or converge with a synthesized brief. */
export type InterviewOutput =
  | { kind: 'questions'; questions: string[] }
  | { kind: 'done'; goal: string; constraints: string[]; nonGoals: string[] }

/**
 * Leniently coerce the interviewer's JSON into an {@link InterviewOutput}. `finalize` forces
 * convergence (the human proceeded, or the round cap was hit) regardless of what the model
 * returned. Empty/absent questions also mean convergence — nothing left to ask.
 */
export function coerceInterviewOutput(
  parsed: unknown,
  opts: { finalize: boolean },
): InterviewOutput {
  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >
  const questions = Array.isArray(obj.questions)
    ? obj.questions
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map(clampShort)
        .slice(0, INITIATIVE_MAX_INTERVIEW_QUESTIONS)
    : []
  const strList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(clampShort)
      : []
  const done = opts.finalize || obj.done === true || questions.length === 0
  if (done) {
    return {
      kind: 'done',
      goal: typeof obj.goal === 'string' ? clampShort(obj.goal) : '',
      constraints: strList(obj.constraints),
      nonGoals: strList(obj.nonGoals),
    }
  }
  return { kind: 'questions', questions }
}

/** Only the answered exchanges — the digest that survives onto the tracker. */
function answeredQa(initiative: Initiative): InitiativeQa[] {
  return (initiative.qa ?? []).filter((q) => (q.answer ?? '').trim().length > 0)
}

/**
 * Append a fresh round of pending questions: keep the answered digest, drop any prior-round
 * questions the human skipped, and add the new ones with stable ids. Bumps the interview
 * round and parks it `awaiting`.
 */
export function applyInterviewQuestions(
  initiative: Initiative,
  questions: string[],
  nextId: () => string,
): Initiative {
  const pending: InitiativeQa[] = questions.map((question) => ({
    id: nextId(),
    question: clampShort(question),
    answer: '',
  }))
  return {
    ...initiative,
    qa: [...answeredQa(initiative), ...pending],
    interview: {
      round: (initiative.interview?.round ?? 0) + 1,
      maxRounds: initiative.interview?.maxRounds ?? INITIATIVE_MAX_INTERVIEW_ROUNDS,
      status: 'awaiting',
    },
  }
}

/** Record the human's answer to one pending question (matched by id). No-op if unknown. */
export function applyInterviewAnswer(
  initiative: Initiative,
  questionId: string,
  answer: string,
): Initiative {
  return {
    ...initiative,
    qa: (initiative.qa ?? []).map((q) =>
      q.id === questionId ? { ...q, answer: clampShort(answer) } : q,
    ),
  }
}

/**
 * Converge the interview: keep only the answered digest, fold the synthesized brief onto the
 * entity (goal/constraints/nonGoals — a blank synthesized goal keeps the existing one), and
 * mark the interview `done`. The initiative's own `status` stays `planning` (the planner
 * ingest flips it to `awaiting_approval` later).
 */
export function applyInterviewOutcome(
  initiative: Initiative,
  outcome: { goal: string; constraints: string[]; nonGoals: string[] },
): Initiative {
  return {
    ...initiative,
    qa: answeredQa(initiative),
    goal: outcome.goal.trim() || initiative.goal || '',
    constraints: outcome.constraints,
    nonGoals: outcome.nonGoals,
    interview: {
      round: initiative.interview?.round ?? 1,
      maxRounds: initiative.interview?.maxRounds ?? INITIATIVE_MAX_INTERVIEW_ROUNDS,
      status: 'done',
    },
  }
}

/** Whether the interviewer must force-converge on the next pass (the round cap was reached). */
export function interviewAtCap(initiative: Initiative): boolean {
  const state = initiative.interview
  if (!state) return false
  return state.round >= state.maxRounds
}

/** Fold the analyst's codebase-analysis prose onto the entity. */
export function applyAnalysis(initiative: Initiative, summary: string): Initiative {
  return { ...initiative, analysisSummary: summary.trim().slice(0, INITIATIVE_PROSE_MAX) }
}

// ---------------------------------------------------------------------------
// Execution loop (slice 3) — pure item-lifecycle transitions over the entity's
// `items`/`deviations`, plus the estimate→pipeline selection. The InitiativeLoopService
// wraps each transform in InitiativeService's CAS `mutate`, so every tick-write is
// single-writer + replay-safe (a lost CAS abandons the tick; the next sweep retries).
// ---------------------------------------------------------------------------

/** Item statuses that occupy a concurrency slot (a spawned task is in flight). */
const INITIATIVE_ITEM_ACTIVE_STATUSES: ReadonlySet<InitiativeItemStatus> = new Set([
  'in_progress',
  'pr_open',
])

/** How many of the initiative's items currently hold a concurrency slot (a running/PR task). */
export function activeItemCount(initiative: Initiative): number {
  return (initiative.items ?? []).filter((i) => INITIATIVE_ITEM_ACTIVE_STATUSES.has(i.status))
    .length
}

/** Whether every item is settled (done/skipped) — the initiative's work is complete. */
export function allItemsSettled(initiative: Initiative): boolean {
  const items = initiative.items ?? []
  return items.length > 0 && items.every((i) => INITIATIVE_ITEM_TERMINAL_STATUSES.has(i.status))
}

/**
 * A phase is HALTED when it holds a `blocked` item: the loop stops spawning NEW work in
 * it until a human retries/skips the failure (the "halt the phase, notify" policy). Since
 * `blocked` is non-terminal, {@link deriveCurrentPhase} also keeps a halted phase current,
 * so the initiative never advances past it either.
 */
export function phaseIsHalted(initiative: Initiative, phaseId: string): boolean {
  return (initiative.items ?? []).some((i) => i.phaseId === phaseId && i.status === 'blocked')
}

/**
 * The effective concurrency cap for a phase: the phase's own tighter cap (when set) clamped
 * by the policy-wide cap. No policy ⇒ 1 (fail-safe to serial).
 */
export function effectiveMaxConcurrent(
  initiative: Initiative,
  phase: InitiativePhase | null,
): number {
  const policyCap = initiative.policy?.maxConcurrent ?? 1
  const phaseCap = phase?.maxConcurrent
  return phaseCap !== undefined ? Math.min(phaseCap, policyCap) : policyCap
}

/**
 * Whether all of an item's intra-initiative dependencies are settled (done/skipped). A
 * dependency that no longer exists (a re-plan dropped it) counts as satisfied.
 */
export function itemDependenciesMet(initiative: Initiative, item: InitiativeItem): boolean {
  const byId = new Map((initiative.items ?? []).map((i) => [i.id, i]))
  return (item.dependsOn ?? []).every((dep) => {
    const d = byId.get(dep)
    return !d || INITIATIVE_ITEM_TERMINAL_STATUSES.has(d.status)
  })
}

/**
 * The items eligible to spawn RIGHT NOW: `pending`, in the derived current phase, that
 * phase not halted by a blocked sibling, with every dependency met. Declared order is
 * preserved. The caller applies the concurrency cap (this returns the full eligible set,
 * not a cap-sliced one) so it can account for slots already taken by in-flight items.
 */
export function eligibleItemsToSpawn(initiative: Initiative): InitiativeItem[] {
  const phase = deriveCurrentPhase(initiative)
  if (!phase) return []
  if (phaseIsHalted(initiative, phase.id)) return []
  return (initiative.items ?? []).filter(
    (i) => i.phaseId === phase.id && i.status === 'pending' && itemDependenciesMet(initiative, i),
  )
}

/**
 * Pick the pipeline a spawned item should run: an explicit `item.pipelineId` wins; else the
 * first policy rule whose thresholds the estimate meets (OR across axes — the
 * `shouldRunGatedStep` semantics: risk ≥ minRisk OR impact ≥ minImpact OR complexity ≥
 * minComplexity; a rule with no thresholds never matches); else the policy default. An item
 * with NO estimate follows `onMissingEstimate`: `default` ⇒ `defaultPipelineId`, `strongest`
 * ⇒ the last (weakest-first-ordered) rule's pipeline, fail-safe to thoroughness.
 */
export function selectInitiativePipeline(
  item: Pick<InitiativeItem, 'estimate' | 'pipelineId'>,
  policy: InitiativeExecutionPolicy,
): string {
  if (item.pipelineId) return item.pipelineId
  const rules = policy.rules ?? []
  if (!item.estimate) {
    if ((policy.onMissingEstimate ?? 'default') === 'strongest' && rules.length > 0) {
      return rules[rules.length - 1]!.pipelineId
    }
    return policy.defaultPipelineId
  }
  const est = item.estimate
  for (const rule of rules) {
    const axes: Array<[number | undefined, number]> = [
      [rule.minComplexity, est.complexity],
      [rule.minRisk, est.risk],
      [rule.minImpact, est.impact],
    ]
    if (axes.some(([threshold, value]) => threshold !== undefined && value >= threshold)) {
      return rule.pipelineId
    }
  }
  return policy.defaultPipelineId
}

/**
 * Reconcile ONE item from its spawned block's current state. Only actively-spawned items
 * (`in_progress`/`pr_open`) are touched — a settled/blocked/un-spawned item is left alone,
 * which is what makes reconcile idempotent across durable-driver replays (the first pass
 * already moved a finished item out of the active set). An active item whose block is GONE is
 * an orphaned claim (a prior tick crashed between the CAS claim and the block insert, or the
 * block was deleted out from under us): it is reverted to `pending` with its dead link dropped,
 * so the next spawn re-materialises it. Leaving it `in_progress` would hold a concurrency slot
 * forever and the phase/initiative could never complete.
 */
export function reconcileItem(item: InitiativeItem, block: Block | undefined): InitiativeItem {
  if (!INITIATIVE_ITEM_ACTIVE_STATUSES.has(item.status)) return item
  if (!block) return { ...item, status: 'pending', blockId: null }
  const pr = block.pullRequest
    ? {
        url: block.pullRequest.url,
        ...(block.pullRequest.number !== undefined ? { number: block.pullRequest.number } : {}),
      }
    : item.pr
  switch (block.status) {
    case 'done':
      return { ...item, status: 'done', ...(pr ? { pr } : {}) }
    case 'pr_ready':
      return { ...item, status: 'pr_open', ...(pr ? { pr } : {}) }
    case 'blocked':
      return {
        ...item,
        status: 'blocked',
        note: item.note ?? 'The spawned task failed — retry or skip it to unblock the phase.',
      }
    default:
      // planned / ready / in_progress → the task is still running.
      return { ...item, status: 'in_progress', ...(pr ? { pr } : {}) }
  }
}

/** Claim a `pending` item for spawning: flip it to `in_progress` with the pre-generated block id.
 *  A no-op when the item is not `pending` (already claimed/settled), so a concurrent ticker that
 *  lost the CAS observes the winner's claim and abandons. */
export function applySpawnClaim(
  initiative: Initiative,
  itemId: string,
  spawnedBlockId: string,
): Initiative {
  return {
    ...initiative,
    items: (initiative.items ?? []).map((i) =>
      i.id === itemId && i.status === 'pending'
        ? { ...i, status: 'in_progress', blockId: spawnedBlockId }
        : i,
    ),
  }
}

/** Revert a claim we own (matched by our block id) back to `pending` — used when the run failed
 *  to start (e.g. the per-service task limit was hit; leave the item for the next sweep). */
export function applyRevertClaim(
  initiative: Initiative,
  itemId: string,
  spawnedBlockId: string,
): Initiative {
  return {
    ...initiative,
    items: (initiative.items ?? []).map((i) =>
      i.id === itemId && i.status === 'in_progress' && i.blockId === spawnedBlockId
        ? { ...i, status: 'pending', blockId: null }
        : i,
    ),
  }
}

/** Whether an item currently holds an active concurrency slot. Exported for the loop's math. */
export function itemIsActive(item: InitiativeItem): boolean {
  return INITIATIVE_ITEM_ACTIVE_STATUSES.has(item.status)
}
