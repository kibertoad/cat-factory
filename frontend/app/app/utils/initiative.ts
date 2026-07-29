import { INITIATIVE_ITEM_TERMINAL_STATUSES } from '@cat-factory/contracts'
import type {
  InitiativeFollowUp,
  InitiativeItem,
  InitiativeItemStatus,
  InitiativePhase,
  InitiativePresetDescriptor,
  InitiativePresetInputs,
  InitiativeQa,
  InitiativeStatus,
} from '~/types/domain'

// Shared initiative presentation vocabulary, so the board card, the inspector body and
// the tracker window render statuses/progress from ONE source. The exhaustive
// `Record<Enum, …>` maps keep the tier-2 typecheck guard live (a new status without
// a label/chip fails the build) without triplicating it across the components.

/** Nuxt UI badge/chip colour names — mirrors `UBadge`'s `color` prop union, so a chip map
 *  types its values against it and the `:color` binding needs no cast. */
type BadgeColor = 'error' | 'info' | 'primary' | 'secondary' | 'success' | 'warning' | 'neutral'

/** Initiative lifecycle status → i18n label key. */
export const INITIATIVE_STATUS_LABEL_KEYS: Record<InitiativeStatus, string> = {
  planning: 'initiative.status.planning',
  awaiting_approval: 'initiative.status.awaiting_approval',
  executing: 'initiative.status.executing',
  paused: 'initiative.status.paused',
  done: 'initiative.status.done',
  cancelled: 'initiative.status.cancelled',
}

/** Initiative lifecycle status → Nuxt UI badge colour. */
export const INITIATIVE_STATUS_CHIPS: Record<InitiativeStatus, BadgeColor> = {
  planning: 'neutral',
  awaiting_approval: 'warning',
  executing: 'info',
  paused: 'neutral',
  done: 'success',
  cancelled: 'neutral',
}

/** Tracker item status → i18n label key. */
export const INITIATIVE_ITEM_STATUS_LABEL_KEYS: Record<InitiativeItemStatus, string> = {
  pending: 'initiative.itemStatus.pending',
  in_progress: 'initiative.itemStatus.in_progress',
  pr_open: 'initiative.itemStatus.pr_open',
  done: 'initiative.itemStatus.done',
  blocked: 'initiative.itemStatus.blocked',
  skipped: 'initiative.itemStatus.skipped',
}

/** Tracker item status → Nuxt UI badge colour. */
export const INITIATIVE_ITEM_STATUS_CHIPS: Record<InitiativeItemStatus, BadgeColor> = {
  pending: 'neutral',
  in_progress: 'info',
  pr_open: 'warning',
  done: 'success',
  blocked: 'error',
  skipped: 'neutral',
}

/** Follow-up triage status → i18n label key. Exhaustive so a new status fails the build. */
export const INITIATIVE_FOLLOWUP_STATUS_LABEL_KEYS: Record<InitiativeFollowUp['status'], string> = {
  open: 'initiative.followUpStatus.open',
  promoted: 'initiative.followUpStatus.promoted',
  dismissed: 'initiative.followUpStatus.dismissed',
}

/** Follow-up triage status → Nuxt UI badge colour. */
export const INITIATIVE_FOLLOWUP_STATUS_CHIPS: Record<InitiativeFollowUp['status'], BadgeColor> = {
  open: 'warning',
  promoted: 'success',
  dismissed: 'neutral',
}

/**
 * The initial, typed create-form values a preset descriptor implies — its field DEFAULTS folded
 * into the `InitiativePresetInputs` shape the renderer + wire contract expect (`checkbox-group` →
 * `string[]`, `checkbox` → boolean, `number` → number, everything else a string). Only fields with
 * a meaningful default are seeded, so unfilled optional fields stay absent (equivalent to unset for
 * validation) and never freeze an empty value. The probe prefill and the user's edits layer on top.
 */
export function defaultPresetInputs(
  descriptor: InitiativePresetDescriptor,
): InitiativePresetInputs {
  const inputs: InitiativePresetInputs = {}
  for (const field of descriptor.fields) {
    if (field.type === 'checkbox-group') {
      if (field.defaultValues?.length) inputs[field.key] = [...field.defaultValues]
    } else if (field.type === 'checkbox') {
      if (field.default === 'true') inputs[field.key] = true
    } else if (field.type === 'number') {
      const parsed = Number(field.default)
      if (field.default !== undefined && field.default !== '' && Number.isFinite(parsed)) {
        inputs[field.key] = parsed
      }
    } else if (field.default) {
      inputs[field.key] = field.default
    }
  }
  return inputs
}

/** Completion rollup across an initiative's items, or null when there are none. */
export function initiativeProgress(
  items: InitiativeItem[] | undefined,
): { settled: number; total: number } | null {
  if (!items || items.length === 0) return null
  return {
    settled: items.filter((i) => INITIATIVE_ITEM_TERMINAL_STATUSES.has(i.status)).length,
    total: items.length,
  }
}

/**
 * Whether a planning-interview question still needs a human answer: not dismissed, and no answer
 * yet. Mirrors the backend `isPendingQuestion` (orchestration `initiative.logic.ts`) — the rule the
 * interviewer, the retained-across-rounds digest and the continue gate all key off — so the window's
 * pending list, its unanswered counter and its render order can never disagree with the engine
 * about what is still open.
 */
export function isPendingQuestion(q: Partial<Pick<InitiativeQa, 'answer' | 'status'>>): boolean {
  return q.status !== 'dismissed' && (q.answer ?? '').trim().length === 0
}

/**
 * Interview questions in the order the planning window renders them: everything still pending
 * first, everything already settled (answered, or dismissed as not relevant) after, each group
 * keeping the interviewer's own chronological order.
 *
 * Each round APPENDS its new questions after the digest retained from the previous ones (backend
 * `applyInterviewQuestions`: `[...retainedQa, ...pending]`), so from round two onwards the only
 * questions the human still has to act on sit below a growing wall of ones they already settled —
 * on a long interview, below the fold entirely. This reorders the RENDER only; the stored `qa`
 * order, which the interviewer prompt and the in-repo tracker digest read, is untouched.
 */
export function orderInterviewQuestions<T extends Partial<Pick<InitiativeQa, 'answer' | 'status'>>>(
  qa: readonly T[],
): T[] {
  const pending: T[] = []
  const settled: T[] = []
  for (const q of qa) (isPendingQuestion(q) ? pending : settled).push(q)
  return [...pending, ...settled]
}

/**
 * The phase whose completed checkpoint (D2) is awaiting a human, or null. Mirrors the backend
 * `pendingCheckpoint` (orchestration `initiative.logic.ts`) so the SPA recomputes the pending
 * checkpoint from the live entity — the same shape the loop pauses on — rather than reading a
 * derived flag off the wire: the FIRST phase, in declared order, flagged `checkpoint`, NOT yet
 * cleared (`checkpointClearedAt`), holding at least one item, with every item terminal. Uses the
 * canonical `INITIATIVE_ITEM_TERMINAL_STATUSES` (the SAME set the backend gates on) so the
 * terminal-status membership cannot drift from the engine, not just the ordering. An open tracker
 * window then follows the checkpoint as items settle without a reload.
 */
export function pendingCheckpointPhase(
  phases: InitiativePhase[] | undefined,
  items: InitiativeItem[] | undefined,
): InitiativePhase | null {
  const all = items ?? []
  for (const phase of phases ?? []) {
    if (phase.checkpoint !== true || phase.checkpointClearedAt !== undefined) continue
    const phaseItems = all.filter((i) => i.phaseId === phase.id)
    if (phaseItems.length === 0) continue
    if (phaseItems.every((i) => INITIATIVE_ITEM_TERMINAL_STATUSES.has(i.status))) return phase
  }
  return null
}

/**
 * The index of the planning run's step parked on the PLANNER's human approval gate, or null.
 *
 * The planner step is `gate: true` in every planning pipeline, so it parks on the generic
 * `step.approval` — the second and last thing a planning run asks a human for, after the
 * interview. Both surfaces that offer the review (the board card and the inspector) resolve it
 * through here so neither can drift on which step the gate is, and so the rule is unit-testable
 * without standing up five stores.
 *
 * Keyed on the planner kind rather than "any pending approval" on purpose: the INTERVIEWER parks
 * on `step.approval` too, and the backend refuses to resolve that one through the generic approve
 * resolver (it belongs to the interview window). Matching it here would offer a review that
 * cannot be given.
 */
export function parkedPlanReviewStepIndex(
  steps: { agentKind: string; approval?: { status: string } | null }[] | undefined,
): number | null {
  const index = (steps ?? []).findIndex(
    (s) => s.agentKind === 'initiative-planner' && s.approval?.status === 'pending',
  )
  return index >= 0 ? index : null
}
