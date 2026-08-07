import type { Block, BlockPatch, TaskTypeFields } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type { UpdateBlockInput } from '@cat-factory/contracts'
import type { ResolvedTaskType } from './taskTypeCreationDefaults.js'
import { buildReviewDescription, refoldReviewDescription } from './reviewTaskTarget.js'

// Turning a per-type FIELDS patch into the `taskTypeFields` a block row stores: the one narrowing
// that changes the patch's SHAPE (the request names two halves of a bag the row keeps whole), and
// the only one with a side effect of its own.
//
// It is a collaborator rather than another method on `blockPatchNarrowing` because the built-in
// half brought both an outbound call and a second field to write. The narrowings there are
// drop-or-keep decisions about one key; this resolves a pull request against the provider and can
// rewrite the description, which is a different kind of thing to be doing in the same place.
//
// The two halves are separate request keys and stay separate all the way down:
//
//   `customTaskTypeFields`  — the deployment-declared answers, checked against the descriptor its
//                             registry holds. Long patchable; unchanged here.
//   `builtinTaskTypeFields` — the platform's own per-type keys, schema-typed at the request
//                             boundary. Newly patchable, and the whole of what this file adds.
//
// Each REPLACES its half and leaves the other alone, so a caller that names one cannot silently
// clear the other. Merging a partial bag over what is stored is a surface ERGONOMIC and belongs
// to whichever door offers it (the public API does, because its callers cannot read the bag
// back); the rule this file enforces is the same either way.

/** What the per-type fields patch needs from the service. */
export interface TaskTypeFieldsPatchDeps {
  /**
   * The create form's own validator for a custom task type's collected values
   * (`TaskTypeCreationDefaults.validatedFields`), passed in rather than re-implemented: the doors
   * agreeing is the whole reason the patch path is allowed to write this bag at all.
   */
  validatedFields: (
    taskType: ResolvedTaskType,
    fields: TaskTypeFields | undefined,
  ) => TaskTypeFields | undefined
  /**
   * Creation's own review-target resolution (`resolveReviewTaskTarget`, bound to the service's
   * repo seam): validate the referenced pull request against the provider and canonicalise it to
   * the provider's own URL. The SAME call creation makes, so a reference this patch lands is one
   * creation would have accepted.
   */
  resolveReviewTarget: (
    workspaceId: string,
    blockId: string,
    taskType: Block['taskType'],
    fields: Block['taskTypeFields'],
  ) => Promise<Block['taskTypeFields']>
}

/** The stored bag with its BUILT-IN half replaced, keeping the custom half untouched. */
function replaceBuiltinHalf(
  stored: TaskTypeFields | null | undefined,
  builtin: UpdateBlockInput['builtinTaskTypeFields'],
): TaskTypeFields {
  const custom = stored?.custom
  return { ...(custom ? { custom } : {}), ...builtin }
}

/** The stored bag with its CUSTOM half replaced, keeping every built-in key untouched. */
function replaceCustomHalf(
  stored: TaskTypeFields | null | undefined,
  custom: NonNullable<UpdateBlockInput['customTaskTypeFields']>,
): TaskTypeFields {
  return { ...stored, custom }
}

/**
 * Apply a `customTaskTypeFields` / `builtinTaskTypeFields` patch to the block's stored bag, and
 * return the repository patch to write: the rest of the request, the whole `taskTypeFields`, and
 * (for a review task whose target moved) the re-folded description.
 *
 * Runs LAST of the narrowings, because this is where the REQUEST type becomes the REPOSITORY's.
 *
 * The built-in half is what makes a task's own input REPAIRABLE, and the pre-dispatch input gate
 * is why that matters: four of its seven findings name a per-type field, and three of those name
 * a built-in one. The gate re-evaluates the task as it stands NOW, so with a write path a parked
 * run is cleared by supplying the value and rechecking; without one the only exits were a human
 * waiving the finding or deleting a task whose id every stored reference points at.
 *
 * Deliberately NOT frozen once a run is working, matching `title` and `description` (the other
 * free-text inputs a run reads): the case this exists for is a task parked precisely because the
 * value is missing.
 */
export async function applyTaskTypeFieldsPatch(
  deps: TaskTypeFieldsPatchDeps,
  patch: UpdateBlockInput,
  block: Block,
  homeWorkspaceId: string,
): Promise<BlockPatch> {
  const { customTaskTypeFields, builtinTaskTypeFields, ...rest } = patch
  const names = customTaskTypeFields !== undefined || builtinTaskTypeFields !== undefined
  if (!names || block.level !== 'task') return rest

  const taskType = block.taskType ?? 'feature'
  let next: TaskTypeFields | undefined = block.taskTypeFields ?? undefined
  if (customTaskTypeFields !== undefined) next = replaceCustomHalf(next, customTaskTypeFields)
  if (builtinTaskTypeFields !== undefined) next = replaceBuiltinHalf(next, builtinTaskTypeFields)

  const validated = deps.validatedFields(taskType, next)
  // A bag that sanitizes away is stored as `null` rather than `{}`, keeping `custom`'s presence
  // meaning "parameters were collected".
  if (builtinTaskTypeFields === undefined) return { ...rest, taskTypeFields: validated ?? null }

  // The built-in half can name a REVIEW task's target, which creation validates against the
  // provider before writing anything and then folds into the description. Both halves repeat
  // here, in creation's order: canonicalise first, so what lands in the description is the
  // provider's own link rather than whatever was typed.
  const resolved = await deps.resolveReviewTarget(homeWorkspaceId, block.id, taskType, validated)
  return { ...rest, taskTypeFields: resolved ?? null, ...refold(rest, block, taskType, resolved) }
}

/**
 * The description to store alongside a settled built-in patch, or nothing when it is unchanged.
 *
 * A description arriving in the SAME patch is text the caller has just authored, so there is no
 * earlier fold inside it to reconcile and the preamble simply goes on the front, exactly as
 * creation does. Only an UNTOUCHED description has a fold with a history, which is the case
 * {@link refoldReviewDescription} judges.
 */
function refold(
  patched: { description?: string },
  block: Block,
  taskType: Block['taskType'],
  resolved: Block['taskTypeFields'],
): { description?: string } {
  if (typeof patched.description === 'string') {
    return { description: buildReviewDescription(taskType, resolved, patched.description) }
  }
  const outcome = refoldReviewDescription(
    taskType,
    block.taskTypeFields,
    resolved,
    block.description ?? '',
  )
  // One refusal shape for everything wrong with a `fields` write, whichever half raised it: the
  // reason a caller branches on stays `task_type_fields_invalid` and `problems` names this one.
  if (!outcome.ok) {
    throw new ValidationError(outcome.problem, {
      reason: 'task_type_fields_invalid',
      problems: [outcome.problem],
    })
  }
  return outcome.description === block.description ? {} : { description: outcome.description }
}
