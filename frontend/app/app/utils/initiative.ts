import { INITIATIVE_ITEM_TERMINAL_STATUSES } from '@cat-factory/contracts'
import type {
  InitiativeFollowUp,
  InitiativeItem,
  InitiativeItemStatus,
  InitiativePhase,
  InitiativeQa,
  InitiativeStatus,
} from '~/types/domain'
import type { BadgeColor } from '~/utils/badge'

// Shared initiative presentation vocabulary, so the board card, the inspector body and
// the tracker window render statuses/progress from ONE source. The exhaustive
// `Record<Enum, …>` maps keep the tier-2 typecheck guard live (a new status without
// a label/chip fails the build) without triplicating it across the components.

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

/**
 * The two ways an initiative's planning run parks for a human: an agent-raised `decision`, or a
 * pending step `approval` (the plan-approval gate the `initiative-planner` step carries). Resolved
 * per block by `useInitiativePlanning().attention`.
 */
export type InitiativeAttentionKind = 'decision' | 'approval'

/** Park kind → i18n label key for the card/inspector button that opens the resolving window. */
export const INITIATIVE_ATTENTION_LABEL_KEYS: Record<InitiativeAttentionKind, string> = {
  decision: 'initiative.inspector.resolveDecision',
  approval: 'initiative.inspector.reviewPlan',
}

/** Park kind → button icon, so the board card and the inspector can't diverge on one park. */
export const INITIATIVE_ATTENTION_ICONS: Record<InitiativeAttentionKind, string> = {
  decision: 'i-lucide-circle-help',
  approval: 'i-lucide-clipboard-check',
}

/**
 * The result view the INTERVIEW gate owns. Its park rides the same `step.approval` mechanism as
 * every other gate, so anything offering "there is a plan to review here" has to exclude it: the
 * interview park is already owned by the planning window, behind the differently-worded "Answer
 * planning questions".
 */
const INTERVIEW_GATE_RESULT_VIEW = 'initiative-planning'

/**
 * The block's parked approval that is a PLAN REVIEW — the planner's human gate (`pl_initiative`
 * declares `{ kind: 'initiative-planner', gate: true }`), or any other gated step of a custom
 * planning pipeline — as opposed to the interviewer's park.
 *
 * Discriminated by the step's own result view, the seam `dispatchStepView` routes on, rather than
 * by an agent-kind list or by the interview phase: the affordance's ACTION is that dispatch, so
 * keying the offer on the same fact guarantees the button opens a window that can resolve what it
 * offered — and that the interview and plan affordances can never both claim one park.
 */
export function selectPlanApproval<A extends { agentKind: string }>(
  approvals: readonly A[],
  resultViewOf: (agentKind: string) => string | undefined,
): A | undefined {
  return approvals.find((a) => resultViewOf(a.agentKind) !== INTERVIEW_GATE_RESULT_VIEW)
}

/**
 * The plan DOCUMENT a parked gate offers for review — its proposal, but only once the step says
 * that proposal IS the plan rendering (`outputIsRendered`); `''` otherwise.
 *
 * A step that rendered nothing parks on the planner's transcript SUMMARY, which is a perfectly
 * non-empty string, so an emptiness check alone would present one sentence under a table of
 * contents as though it were the plan. `''` is what routes such a gate to the compact notice
 * instead — and the SAME value decides the tracker window's layout (a document review takes the
 * whole window; a notice sits above the tracker's own sections), so the surface and its host can
 * never disagree about which shape is on screen.
 *
 * Rendered-but-blank counts as no document. The proposal comes back VERBATIM, never trimmed: the
 * review anchors comments to source LINE numbers, so dropping a leading newline would shift every
 * anchor off the block it quotes.
 */
export function planReviewDocument(
  gate: { approval: { proposal?: string | null }; outputIsRendered: boolean } | null | undefined,
): string {
  if (!gate?.outputIsRendered) return ''
  const proposal = gate.approval.proposal ?? ''
  return proposal.trim() ? proposal : ''
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
