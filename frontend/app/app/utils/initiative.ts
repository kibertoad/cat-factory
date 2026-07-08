import type {
  InitiativeFollowUp,
  InitiativeItem,
  InitiativeItemStatus,
  InitiativePhase,
  InitiativePresetDescriptor,
  InitiativePresetInputs,
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

/** Item statuses that count as settled — mirrors the backend terminal-status set. */
const SETTLED: ReadonlySet<InitiativeItemStatus> = new Set(['done', 'skipped'])

/** Completion rollup across an initiative's items, or null when there are none. */
export function initiativeProgress(
  items: InitiativeItem[] | undefined,
): { settled: number; total: number } | null {
  if (!items || items.length === 0) return null
  return { settled: items.filter((i) => SETTLED.has(i.status)).length, total: items.length }
}

/**
 * The phase whose completed checkpoint (D2) is awaiting a human, or null. Mirrors the backend
 * `pendingCheckpoint` (orchestration `initiative.logic.ts`) so the SPA recomputes the pending
 * checkpoint from the live entity — the same shape the loop pauses on — rather than reading a
 * derived flag off the wire: the FIRST phase, in declared order, flagged `checkpoint`, NOT yet
 * cleared (`checkpointClearedAt`), holding at least one item, with every item settled. An open
 * tracker window then follows the checkpoint as items settle without a reload.
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
    if (phaseItems.every((i) => SETTLED.has(i.status))) return phase
  }
  return null
}
