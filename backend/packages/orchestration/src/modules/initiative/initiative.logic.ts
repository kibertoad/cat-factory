import type {
  Block,
  ExecutionInstance,
  Initiative,
  InitiativeExecutionPolicy,
  InitiativeFollowUp,
  InitiativeItem,
  InitiativeItemStatus,
  InitiativePhase,
  InitiativePlanDraft,
  InitiativeQa,
  InitiativeQaStatus,
  PromoteInitiativeFollowUpInput,
  UpdateInitiativeItemInput,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError, hasInitiativeKinds } from '@cat-factory/kernel'
import type {
  InitiativePresetDescriptor,
  InitiativePresetInputs,
  InitiativePresetPhaseTemplate,
} from '@cat-factory/contracts'
import {
  INITIATIVE_ITEM_TERMINAL_STATUSES,
  INITIATIVE_PROSE_MAX,
  INITIATIVE_SHORT_MAX,
  INITIATIVE_TITLE_MAX,
  isPresetFieldVisible,
  renderInitiativePresetValue,
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
 * Assert the item dependency graph is acyclic (DFS with a visiting set). Shared by the
 * plan-draft validation and the mid-flight item edit ({@link applyItemEdit}) so a re-scoped
 * `dependsOn` can't smuggle a cycle past the trust boundary — two mutually-dependent items
 * would each fail {@link itemDependenciesMet} forever, deadlocking the phase (and the whole
 * initiative, which can then never settle). Throws {@link ValidationError} on the first cycle.
 */
function assertAcyclicItems(
  items: ReadonlyArray<{ id: string; dependsOn?: readonly string[] }>,
): void {
  const deps = new Map(items.map((i) => [i.id, i.dependsOn ?? []]))
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

/**
 * Validate a plan draft's internal references: unique phase/item ids, every item
 * pointing at a declared phase, dependencies pointing at declared items, no
 * dependency crossing FORWARD into a later phase, and an acyclic dependency graph.
 * Throws {@link ValidationError} on the first violation. The lenient coercion
 * (`coerceInitiativePlan`) already produces a well-formed draft; this re-checks at
 * the trust boundary so a hand-supplied draft can't smuggle a broken graph into the
 * loop.
 */
export function validatePlanDraft(draft: InitiativePlanDraft): void {
  // Phase array order IS execution order — `deriveCurrentPhase` advances phase-by-phase in this
  // order — so we track each phase's index, not just its presence, to reject later-phase deps below.
  const phaseOrder = new Map<string, number>()
  draft.phases.forEach((phase, idx) => {
    if (!phase.id) return
    if (phaseOrder.has(phase.id)) throw new ValidationError(`Duplicate phase id '${phase.id}'`)
    phaseOrder.set(phase.id, idx)
  })
  const itemPhase = new Map<string, string | undefined>()
  for (const item of draft.items) {
    if (!item.id) continue
    if (itemPhase.has(item.id)) throw new ValidationError(`Duplicate item id '${item.id}'`)
    itemPhase.set(item.id, item.phaseId)
  }
  for (const item of draft.items) {
    if (item.phaseId && phaseOrder.size > 0 && !phaseOrder.has(item.phaseId)) {
      throw new ValidationError(
        `Item '${item.id ?? item.title}' references unknown phase '${item.phaseId}'`,
      )
    }
    const here = item.phaseId ? phaseOrder.get(item.phaseId) : undefined
    for (const dep of item.dependsOn ?? []) {
      if (!itemPhase.has(dep)) {
        throw new ValidationError(
          `Item '${item.id ?? item.title}' depends on unknown item '${dep}'`,
        )
      }
      // An item may only depend on items in its own phase or an EARLIER one. A dependency pointing
      // at a LATER phase can never resolve — the depended-on phase never becomes current while this
      // item keeps its own (earlier) phase current — so the whole initiative deadlocks. This is a
      // general loop invariant, but the phase-template reorder at ingest can turn a
      // planner-consistent draft into a violating one, so it's enforced here at the trust boundary
      // rather than left to surface as a silent run-time stall.
      const depPhaseId = itemPhase.get(dep)
      const there = depPhaseId ? phaseOrder.get(depPhaseId) : undefined
      if (here !== undefined && there !== undefined && there > here) {
        throw new ValidationError(
          `Item '${item.id ?? item.title}' depends on '${dep}' in a later phase '${depPhaseId}' — a dependency must not point at a later phase (it would deadlock the loop)`,
        )
      }
    }
  }
  // Cycle check over the dependency edges (shared with the mid-flight item edit).
  assertAcyclicItems(draft.items.map((i) => ({ id: i.id ?? '', dependsOn: i.dependsOn })))
}

/**
 * Normalize a planner draft's phases against a preset's declarative {@link
 * InitiativePresetPhaseTemplate} (slice T2), run at ingest BEFORE the preset's own `seedPlan`
 * hook. This enforces PLAN SHAPE only — which phases the plan presents, and in what order — and
 * is deliberately kept separate from `seedPlan`'s per-item decoration (T7): the generic template
 * machinery owns shape, the preset hook owns content, and neither re-does the other's job.
 *
 * - **Reorder, don't reject, for ordering.** Draft phases whose `id` matches a template phase are
 *   reordered into template order — matched by id VERBATIM, the same contract the planner prompt
 *   fold renders. The planner-authored `title`/`goal` are preserved untouched; the template
 *   dictates presence + order, never content.
 * - **Extra phases** — a draft phase with no id, or an id not in the template — are appended AFTER
 *   the template phases (in their original relative order) when `allowAdditionalPhases` is set,
 *   and are a hard error otherwise (the template is exhaustive).
 * - **A missing `required` phase** is a hard error; an optional (`required !== true`) template
 *   phase the planner omitted is fine.
 *
 * Rejection is a {@link ValidationError} at the ingest trust boundary (the landed
 * `assertPipelinesExist` / strict-re-parse pattern), surfacing as a planner retry / human fix at
 * the plan-approval gate — never a silent draft mutation for a missing-required phase. Pure +
 * total, and deterministic: a draft already in an exhaustive template's order (no extras) returns
 * an equal phase list, so re-ingesting the same draft stays byte-identical (the ingest idempotency
 * check relies on it). A draft repeating a template id lands both copies in template order and is
 * caught downstream by {@link validatePlanDraft}'s duplicate-id check — we don't silently drop it.
 */
export function normalizeDraftAgainstPhaseTemplate(
  template: InitiativePresetPhaseTemplate,
  draft: InitiativePlanDraft,
): InitiativePlanDraft {
  const templateIds = new Set(template.phases.map((p) => p.id))
  // Template ids are unique (the contract enforces it), so each template slot matches its draft
  // phase(s) exactly once — iterating the template preserves template order.
  const matched = template.phases.flatMap((tp) => draft.phases.filter((p) => p.id === tp.id))
  const extras = draft.phases.filter((p) => !p.id || !templateIds.has(p.id))

  const missing = template.phases.filter(
    (tp) => tp.required === true && !draft.phases.some((p) => p.id === tp.id),
  )
  if (missing.length > 0) {
    throw new ValidationError(
      `Plan is missing required phase(s): ${missing.map((p) => `'${p.id}'`).join(', ')}`,
    )
  }
  if (extras.length > 0 && !template.allowAdditionalPhases) {
    const labels = extras.map((p) => `'${p.id ?? p.title}'`).join(', ')
    throw new ValidationError(
      `Plan introduces phase(s) not allowed by the preset's phase template: ${labels}`,
    )
  }

  return { ...draft, phases: [...matched, ...extras] }
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
      // Preset-authored spawn decoration (a `seedPlan` may have stamped it at ingest). Follows
      // the draft like the other content fields — the loop's `buildTaskBlock` folds it onto the
      // spawned block. A re-plan refreshing an already-materialised item is harmless: its block
      // was decorated when it spawned, so re-stamping the item's `spawn` never re-touches it.
      ...(d.spawn ? { spawn: d.spawn } : {}),
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

/** Only the answered exchanges — the digest that survives onto the tracker at convergence. */
function answeredQa(initiative: Initiative): InitiativeQa[] {
  return (initiative.qa ?? []).filter((q) => (q.answer ?? '').trim().length > 0)
}

/**
 * Questions that survive into the NEXT interview round: the answered digest PLUS any the human
 * marked `dismissed`. Keeping the dismissed ones (rather than dropping unanswered questions
 * wholesale) is what lets the interviewer see they were deemed not-relevant and not re-ask them.
 */
function retainedQa(initiative: Initiative): InitiativeQa[] {
  return (initiative.qa ?? []).filter(
    (q) => (q.answer ?? '').trim().length > 0 || q.status === 'dismissed',
  )
}

/**
 * Whether a planning question still needs a human answer: not dismissed, and no answer yet.
 * The single source of truth shared by the window (`pending`/`allAnswered`), the interviewer,
 * and {@link retainedQa}, so a `dismissed` question never counts as blocking.
 */
export function isPendingQuestion(q: InitiativeQa): boolean {
  return q.status !== 'dismissed' && (q.answer ?? '').trim().length === 0
}

/**
 * Append a fresh round of pending questions: keep the answered + dismissed digest, drop any
 * prior-round questions the human left neither answered nor dismissed, and add the new ones with
 * stable ids. Bumps the interview round and parks it `awaiting`.
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
    status: 'open',
  }))
  return {
    ...initiative,
    qa: [...retainedQa(initiative), ...pending],
    interview: {
      round: (initiative.interview?.round ?? 0) + 1,
      maxRounds: initiative.interview?.maxRounds ?? INITIATIVE_MAX_INTERVIEW_ROUNDS,
      status: 'awaiting',
    },
  }
}

/**
 * Mark one question `dismissed` ("not relevant") or reopen it. Dismissing clears any drafted
 * answer + AI recommendation (the question is being set aside, not answered). Matched by id;
 * no-op if unknown. Part of the shared clarification surface the planning window borrows from
 * requirements review.
 */
export function applyQuestionStatus(
  initiative: Initiative,
  questionId: string,
  status: InitiativeQaStatus,
): Initiative {
  return {
    ...initiative,
    qa: (initiative.qa ?? []).map((q) => {
      if (q.id !== questionId) return q
      return status === 'dismissed'
        ? { ...q, status, answer: '', recommendation: null }
        : { ...q, status }
    }),
  }
}

/** Attach an AI-suggested answer to one question (the recommend action). No-op if unknown. */
export function applyQuestionRecommendation(
  initiative: Initiative,
  questionId: string,
  recommendation: string,
): Initiative {
  return {
    ...initiative,
    qa: (initiative.qa ?? []).map((q) =>
      q.id === questionId ? { ...q, recommendation: clampShort(recommendation) } : q,
    ),
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
// Preset form → qa seeding (slice 3; extended to full-interview presets in T3). The FORM the user
// filled at create is folded into the `qa` log as one answered exchange per filled, VISIBLE field
// (label → rendered value). For a SKIP-interview preset the form IS the interview (no interviewer
// step); for a FULL-interview preset the seeded answers are the interviewer's STARTING POINT (it
// builds on them rather than re-asking). Either way the existing tracker digest + planning-prompt
// path (`initiativeContextLines`) surface the form. Pure + total.
// ---------------------------------------------------------------------------

/**
 * Seed the `qa` digest from a preset's filled form: one answered exchange (`question` = the field
 * label, `answer` = the rendered value) per VISIBLE field carrying a non-empty value. Hidden
 * (`showWhen`-failed) and blank fields are skipped. The result feeds the entity's `qa` at create,
 * so the analyst / planner prompts (and the committed tracker digest) read the form — and a
 * full-interview preset's interviewer builds on it. Interview-mode-agnostic: the caller decides
 * whether the form IS the interview (skip) or SEEDS it (full). Ids come from the caller's generator.
 */
export function seedPresetInterviewQa(
  descriptor: InitiativePresetDescriptor,
  inputs: InitiativePresetInputs,
  nextId: () => string,
): InitiativeQa[] {
  const qa: InitiativeQa[] = []
  for (const field of descriptor.fields) {
    if (!isPresetFieldVisible(field, inputs)) continue
    const value = inputs[field.key]
    // An UNSET field is skipped — mirroring the create-time "present" notion in
    // `validateInitiativePresetInputs`: an undefined value, an unchecked (`false`) checkbox, and
    // (via the blank `answer` guard below) an empty string / empty multi-select are all "not filled".
    if (value === undefined || value === false) continue
    const answer = renderInitiativePresetValue(field, value).trim()
    if (!answer) continue
    qa.push({
      id: nextId(),
      question: field.label.trim(),
      answer: clampShort(answer),
      status: 'open',
    })
  }
  return qa
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

// ---------------------------------------------------------------------------
// Follow-up harvest + human curation (slice 4) — pure transforms over the entity's
// `followUps`/`deviations`/`items`/`policy`. A settling child run's forward-looking
// follow-ups (and, on failure, its cause) are HARVESTED onto the initiative; a human then
// PROMOTES a follow-up into a real item or DISMISSES it, and can retry/skip/re-scope items or
// retune the policy. The InitiativeService wraps each in the CAS `mutate`, and the harvest is
// idempotent (stable follow-up ids) so a durable-driver replay of the settling run's poke folds
// nothing twice.
// ---------------------------------------------------------------------------

const clampTitle = (s: string): string => s.trim().slice(0, INITIATIVE_TITLE_MAX)
const clampProse = (s: string): string => s.trim().slice(0, INITIATIVE_PROSE_MAX)

/**
 * Guard: mid-flight human curation (promote / dismiss / item edit / policy edit) is only valid
 * while the initiative is still `executing` — the same status gate `pause`/`resume`/`cancel`
 * enforce and the tracker UI's `editable` reflects. Checked inside the CAS transform (on the
 * freshly-read entity) so a concurrent cancel/pause can't be raced past. Curating a settled
 * (`done`/`cancelled`) or not-yet-approved initiative would append items the loop never spawns
 * and flip completion invariants on an already-terminal entity.
 */
function assertCurationAllowed(initiative: Initiative): void {
  if (initiative.status !== 'executing') {
    throw new ConflictError(
      `Initiative is ${initiative.status}; curation is only allowed while it is executing`,
    )
  }
}

/** One forward-looking follow-up lifted off a settling child run, before it becomes a tracker entry. */
export interface HarvestedFollowUp {
  /** Stable id of the child run's follow-up item — the harvest id derives from it, for idempotency. */
  sourceId: string
  title: string
  detail: string
  /** The coder's optional proposed approach, folded into the harvested detail. */
  suggestedAction?: string | null
}

/** Everything the loop folds onto the initiative when a spawned child run settles. */
export interface InitiativeRunHarvest {
  /** The spawned child task block whose run settled — maps to the item via `item.blockId`. */
  childBlockId: string
  /** Forward-looking follow-ups the run surfaced (from its coder step). */
  followUps: HarvestedFollowUp[]
  /** The run's failure cause, when it failed — enriches the item's note (the deviation reads it). */
  failure?: { kind: string; detail: string } | null
}

/**
 * Extract the harvest payload from a settling child run: every `follow_up`-kind item its coder
 * step surfaced (questions are per-task clarifications, not initiative work) plus the failure
 * cause when it failed. Pure over the instance already in hand at the terminal emit, so the
 * harvest costs no extra read.
 */
export function extractRunHarvest(instance: ExecutionInstance): InitiativeRunHarvest {
  const followUps: HarvestedFollowUp[] = []
  for (const step of instance.steps) {
    for (const item of step.followUps?.items ?? []) {
      if (item.kind !== 'follow_up') continue
      followUps.push({
        sourceId: item.id,
        title: item.title,
        detail: item.detail ?? '',
        suggestedAction: item.suggestedAction ?? null,
      })
    }
  }
  const failure =
    instance.status === 'failed' && instance.failure
      ? { kind: instance.failure.kind, detail: instance.failure.message }
      : null
  return { childBlockId: instance.blockId, followUps, failure }
}

/** A stable, idField-valid id for a harvested follow-up, so re-harvesting the same run is a no-op. */
export function harvestFollowUpId(childBlockId: string, sourceId: string): string {
  return `ifu-${initiativeSlug(`${childBlockId}-${sourceId}`)}`
}

/**
 * Fold a settling child run's harvest onto the initiative: append each not-yet-seen follow-up as
 * an `open` tracker follow-up (idempotent by {@link harvestFollowUpId}), and — when the run
 * failed — stamp the owning item's `note` with the real cause so the reconcile-driven deviation
 * records WHY it blocked. Content-identical ⇒ returns the input unchanged (the CAS short-circuits).
 */
export function applyRunHarvest(
  initiative: Initiative,
  harvest: InitiativeRunHarvest,
  now: number,
): Initiative {
  const item = (initiative.items ?? []).find((i) => i.blockId === harvest.childBlockId)
  const sourceItemId = item?.id ?? null
  const seen = new Set((initiative.followUps ?? []).map((f) => f.id))
  const additions: InitiativeFollowUp[] = []
  for (const fu of harvest.followUps) {
    const id = harvestFollowUpId(harvest.childBlockId, fu.sourceId)
    if (seen.has(id)) continue
    seen.add(id)
    const detail = [fu.detail, fu.suggestedAction ? `Suggested: ${fu.suggestedAction}` : '']
      .filter((s) => s.trim().length > 0)
      .join('\n\n')
    additions.push({
      id,
      at: now,
      sourceItemId,
      title: clampTitle(fu.title),
      detail: detail.slice(0, INITIATIVE_SHORT_MAX),
      status: 'open',
    })
  }
  let items = initiative.items ?? []
  if (item && harvest.failure) {
    const note = `Run failed (${harvest.failure.kind}): ${harvest.failure.detail}`
      .trim()
      .slice(0, INITIATIVE_SHORT_MAX)
    if (item.note !== note) items = items.map((i) => (i.id === item.id ? { ...i, note } : i))
  }
  if (additions.length === 0 && items === (initiative.items ?? [])) return initiative
  return {
    ...initiative,
    items,
    followUps: [...(initiative.followUps ?? []), ...additions],
  }
}

/**
 * Promote an `open` follow-up into a real `pending` tracker item under `input.phaseId` (the loop
 * spawns it like any other), flipping the follow-up `promoted` with a `promotedItemId`
 * back-reference. A follow-up that is already promoted/dismissed is a no-op (returns unchanged, so
 * a double-submit is harmless). Throws {@link ValidationError} on an unknown follow-up / phase /
 * dependency.
 */
export function applyPromoteFollowUp(
  initiative: Initiative,
  followUpId: string,
  input: PromoteInitiativeFollowUpInput,
): Initiative {
  assertCurationAllowed(initiative)
  const followUp = (initiative.followUps ?? []).find((f) => f.id === followUpId)
  if (!followUp) throw new ValidationError(`Unknown follow-up '${followUpId}'`)
  if (followUp.status !== 'open') return initiative
  if (!(initiative.phases ?? []).some((p) => p.id === input.phaseId)) {
    throw new ValidationError(`Unknown phase '${input.phaseId}'`)
  }
  const itemIds = new Set((initiative.items ?? []).map((i) => i.id))
  for (const dep of input.dependsOn ?? []) {
    if (!itemIds.has(dep)) throw new ValidationError(`Depends on unknown item '${dep}'`)
  }
  const newId = uniqueSlugId(input.title ?? followUp.title, new Set(itemIds))
  const newItem: InitiativeItem = {
    id: newId,
    phaseId: input.phaseId,
    title: clampTitle(input.title ?? followUp.title),
    description: clampProse(input.description ?? followUp.detail ?? ''),
    dependsOn: input.dependsOn ?? [],
    ...(input.estimate ? { estimate: input.estimate } : {}),
    ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}),
    status: 'pending',
  }
  return {
    ...initiative,
    items: [...(initiative.items ?? []), newItem],
    followUps: (initiative.followUps ?? []).map((f) =>
      f.id === followUpId ? { ...f, status: 'promoted' as const, promotedItemId: newId } : f,
    ),
  }
}

/** Dismiss an `open` follow-up (waved off, not worth an item). A no-op once already settled. */
export function applyDismissFollowUp(initiative: Initiative, followUpId: string): Initiative {
  assertCurationAllowed(initiative)
  const followUp = (initiative.followUps ?? []).find((f) => f.id === followUpId)
  if (!followUp) throw new ValidationError(`Unknown follow-up '${followUpId}'`)
  if (followUp.status !== 'open') return initiative
  return {
    ...initiative,
    followUps: (initiative.followUps ?? []).map((f) =>
      f.id === followUpId ? { ...f, status: 'dismissed' as const } : f,
    ),
  }
}

/**
 * Edit one tracker item and/or drive its status. Content edits apply only to a not-yet-settled,
 * not-in-flight item (`pending`/`blocked`) — an in-flight/settled item's spawned task already
 * carries its own copy, so editing it here would silently diverge. `action` unsticks a halted
 * phase: `retry` returns a `blocked` item to `pending` (clearing its dead block link + note),
 * `skip` settles a `pending`/`blocked` item `skipped`. Throws on an unknown item / illegal edit.
 */
export function applyItemEdit(
  initiative: Initiative,
  itemId: string,
  input: UpdateInitiativeItemInput,
): Initiative {
  assertCurationAllowed(initiative)
  const item = (initiative.items ?? []).find((i) => i.id === itemId)
  if (!item) throw new ValidationError(`Unknown item '${itemId}'`)

  const hasContentEdit =
    input.title !== undefined ||
    input.description !== undefined ||
    input.estimate !== undefined ||
    input.pipelineId !== undefined ||
    input.dependsOn !== undefined
  const editable = item.status === 'pending' || item.status === 'blocked'
  if (hasContentEdit && !editable) {
    throw new ConflictError(
      `Item '${itemId}' is ${item.status}; only a pending or blocked item can be edited`,
    )
  }
  if (input.dependsOn) {
    const itemIds = new Set((initiative.items ?? []).map((i) => i.id))
    for (const dep of input.dependsOn) {
      if (dep === itemId) throw new ValidationError(`Item '${itemId}' cannot depend on itself`)
      if (!itemIds.has(dep)) throw new ValidationError(`Depends on unknown item '${dep}'`)
    }
  }

  let next: InitiativeItem = {
    ...item,
    ...(input.title !== undefined ? { title: clampTitle(input.title) } : {}),
    ...(input.description !== undefined ? { description: clampProse(input.description) } : {}),
    ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
    ...(input.pipelineId !== undefined ? { pipelineId: input.pipelineId } : {}),
    ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
  }

  if (input.action === 'skip') {
    if (!editable) {
      throw new ConflictError(
        `Item '${itemId}' is ${item.status}; only pending/blocked can be skipped`,
      )
    }
    next = { ...next, status: 'skipped' }
  } else if (input.action === 'retry') {
    if (item.status !== 'blocked') {
      throw new ConflictError(
        `Only a blocked item can be retried (item '${itemId}' is ${item.status})`,
      )
    }
    next = { ...next, status: 'pending', blockId: null, note: undefined }
  }

  const items = (initiative.items ?? []).map((i) => (i.id === itemId ? next : i))
  // A re-scoped `dependsOn` must keep the graph acyclic — same guard the plan draft enforces,
  // so an edit can't introduce a mutual dependency that would deadlock the phase.
  if (input.dependsOn) assertAcyclicItems(items)
  return { ...initiative, items }
}

/** Replace the execution policy (concurrency + pipeline rules). Pipeline-id existence is validated
 *  by the service against the pipeline repository before this runs. */
export function applyPolicyEdit(
  initiative: Initiative,
  policy: InitiativeExecutionPolicy,
): Initiative {
  assertCurationAllowed(initiative)
  return { ...initiative, policy }
}
