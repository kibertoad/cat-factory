import { UnavailableError, ValidationError } from '@cat-factory/kernel'
import type { CreatePublicTaskInput } from '@cat-factory/contracts'
import type { ServerContainer } from '../../http/env.js'

// Checking the preset ids a public task creation PINS, before anything reaches the board.
//
// Its own module for the reason `taskTypeFields.ts` is: it belongs to the half of
// `createTaskWithAttachments` that refuses, and that half's whole rule is that it lands before the
// write. Two checks, one per preset knob, and the interesting part is what each REFUSES rather
// than what it reads.
//
// **An unknown id is a refusal, never a fallback to the default.** Both fields already mean "use
// the workspace default" when omitted, so accepting an id nobody has and then resolving the
// default gives the caller a `201` for a task running on something it did not ask for, and nothing
// it can read afterwards says so. That is the failure mode this whole surface is arranged against:
// a run that succeeds while being about the wrong thing. A typo'd preset id is exactly how it
// happens, because the id is a string a caller pasted.
//
// **Unwired and unknown are different answers.** A deployment with no preset repository wired holds
// no presets at all, so "there is no preset with that id" is true and useless: it sends someone
// hunting for a row when the fix is to wire a module. The 503 says the second thing, and only ever
// fires for a caller that pinned something, since a caller that pinned nothing has no dependency on
// the module being there.

/** The preset modules a pinned id is checked against; each absent when its repository is unwired. */
export interface PresetPinDeps {
  modelPresets: ServerContainer['modelPresets']
  riskPolicies: ServerContainer['riskPolicies']
}

export function presetPinDeps(container: ServerContainer): PresetPinDeps {
  return { modelPresets: container.modelPresets, riskPolicies: container.riskPolicies }
}

/**
 * Refuse the creation unless every preset it pins exists in this workspace.
 *
 * Both lists are read in FULL rather than probed by id, because both libraries are small (a
 * workspace holds its built-ins plus whatever an operator authored) and the list is the same read
 * the caller made to choose the id. A `get`-by-id per knob would be two more round trips to answer
 * a question one already-cached list answers.
 */
export async function assertPinnedPresetsExist(
  deps: PresetPinDeps,
  workspaceId: string,
  body: CreatePublicTaskInput,
): Promise<void> {
  if (body.modelPresetId) {
    const module = deps.modelPresets
    if (!module) throw unwired('Model presets are not configured', 'model_presets_unwired')
    const presets = await module.service.list(workspaceId)
    if (!presets.some((preset) => preset.id === body.modelPresetId)) {
      throw unknownPreset(
        'model',
        body.modelPresetId,
        presets.map(nameOf),
        'model_preset_not_found',
      )
    }
  }

  if (body.riskPolicyId) {
    const module = deps.riskPolicies
    if (!module) throw unwired('Merge presets are not configured', 'merge_presets_unwired')
    const presets = await module.service.list(workspaceId)
    if (!presets.some((preset) => preset.id === body.riskPolicyId)) {
      throw unknownPreset('merge', body.riskPolicyId, presets.map(nameOf), 'merge_preset_not_found')
    }
  }
}

function nameOf(preset: { id: string }): string {
  return preset.id
}

/**
 * The refusal, naming what this workspace DOES hold.
 *
 * The available ids ride along because the fix is always to pick a different one, and the caller
 * that got here has already shown it does not know which are real. Listing them turns two round
 * trips into none.
 */
function unknownPreset(
  kind: 'model' | 'merge',
  pinned: string,
  available: readonly string[],
  reason: string,
): ValidationError {
  return new ValidationError(
    `No ${kind} preset '${pinned}' in this workspace. Available: ${available.join(', ') || '(none)'}.`,
    { reason, available: [...available] },
  )
}

function unwired(message: string, reason: string): UnavailableError {
  return new UnavailableError(message, reason)
}
