// ---------------------------------------------------------------------------
// The fix for each setup gap a refusal can name: who closes the gap, and which screen closes it.
// The conflict table (`utils/conflictCopy.ts`) and the failure block read these, and both the toasts
// and the failure block gate them on who is asking (`gateSetupFix`). Plain data, so a util and a
// unit test can import it without the stores the remedies read.
// ---------------------------------------------------------------------------

import type { useSetupRemedies } from '~/composables/useSetupRemedies'
import type { InfraSetupOwners } from '~/types/domain'
import {
  MODEL_SETUP_OWNER,
  SOURCE_CONTROL_SETUP_OWNER,
  setupRemedyFor,
  type SetupActor,
  type SetupOwner,
  type SetupRemedy,
} from '~/utils/setupAudience'

/** The remedies a setup fix can open. */
export type SetupRemedies = Pick<
  ReturnType<typeof useSetupRemedies>,
  | 'openInfraArea'
  | 'openModelSetup'
  | 'openModelConfig'
  | 'openSourceControl'
  | 'openServiceEnvironment'
>

/** The fix for one setup gap, before the audience decides who gets it. */
export interface SetupFix {
  /**
   * Who closes the gap, from the reported owners. `undefined` (an older backend) reads as the
   * workspace admin, as `effectiveOwner` says.
   */
  owner: (owners: InfraSetupOwners | null) => SetupOwner | undefined
  /** Open the screen that closes the gap. */
  open: (remedies: SetupRemedies, actor: SetupActor) => void
}

export const RUNNER_POOL_FIX: SetupFix = {
  owner: (owners) => owners?.agentExecutor,
  open: (remedies) => remedies.openInfraArea('agentExecutor'),
}
export const ENVIRONMENTS_FIX: SetupFix = {
  owner: (owners) => owners?.ephemeralEnvironments,
  open: (remedies) => remedies.openInfraArea('ephemeralEnvironments'),
}
export const BINARY_STORAGE_FIX: SetupFix = {
  owner: (owners) => owners?.binaryStorage,
  open: (remedies) => remedies.openInfraArea('binaryStorage'),
}
export const SOURCE_CONTROL_FIX: SetupFix = {
  owner: () => SOURCE_CONTROL_SETUP_OWNER,
  open: (remedies) => remedies.openSourceControl(),
}
/** No usable model: the AI onboarding dialog. */
export const MODEL_SETUP_FIX: SetupFix = {
  owner: () => MODEL_SETUP_OWNER,
  open: (remedies) => remedies.openModelSetup(),
}
/** A model that is blocked or cannot satisfy the preset: the model settings. */
export const MODEL_CONFIG_FIX: SetupFix = {
  owner: () => MODEL_SETUP_OWNER,
  open: (remedies) => remedies.openModelConfig(),
}

/** Who is asking and who owns each gap, read when a fix is offered (never at store setup). */
export interface ConflictAudience {
  actor: SetupActor
  owners: InfraSetupOwners | null
}

/** How a setup prompt reads its audience and opens a fix. */
export interface SetupConflictDeps {
  audience: () => ConflictAudience
  remedies: () => SetupRemedies
}

/** A {@link SetupFix} for one caller: the button, or the line that names who can fix it. */
export type GatedSetupFix = { remedy: null; run: () => void } | { remedy: SetupRemedy }

/**
 * Apply the setup cards' audience rule (`utils/setupAudience.ts`) to a fix: only a caller who can
 * act gets the button. Everyone else gets the remedy to name, because a button that opens a screen
 * their save is refused on is worse than no button. The conflict toasts and the failure block all
 * ask this, so they cannot disagree with each other or with the cards.
 */
export function gateSetupFix(
  fix: SetupFix,
  audience: ConflictAudience,
  deps: Pick<SetupConflictDeps, 'remedies'>,
): GatedSetupFix {
  const remedy = setupRemedyFor(fix.owner(audience.owners), audience.actor)
  return remedy
    ? { remedy }
    : { remedy: null, run: () => fix.open(deps.remedies(), audience.actor) }
}
