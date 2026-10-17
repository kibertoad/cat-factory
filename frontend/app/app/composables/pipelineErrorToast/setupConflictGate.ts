import type { InfraSetupOwners } from '~/types/domain'
import {
  MODEL_SETUP_OWNER,
  SOURCE_CONTROL_SETUP_OWNER,
  setupRemedyFor,
  type SetupActor,
  type SetupOwner,
  type SetupRemedy,
} from '~/utils/setupAudience'

/** The remedies a run-start conflict toast can open. */
export type SetupRemedies = Pick<
  ReturnType<typeof useSetupRemedies>,
  | 'openInfraArea'
  | 'openModelSetup'
  | 'openModelConfig'
  | 'openSourceControl'
  | 'openServiceEnvironment'
>

/** Who is asking and who owns each gap, read when a toast is raised (never at store setup). */
export interface ConflictAudience {
  actor: SetupActor
  owners: InfraSetupOwners | null
}

/** How a conflict toast reads its audience and opens a fix. */
export interface SetupConflictDeps {
  audience: () => ConflictAudience
  remedies: () => SetupRemedies
}

/** The fix for one setup gap on a conflict toast, before the audience decides who gets it. */
export interface SetupFix {
  /**
   * Who closes the gap, from the reported owners. `undefined` (an older backend) reads as the
   * workspace admin, as `effectiveOwner` says.
   */
  owner: (owners: InfraSetupOwners | null) => SetupOwner | undefined
  /** Open the screen that closes the gap. */
  open: (remedies: SetupRemedies, actor: SetupActor) => void
}

/** A {@link SetupFix} for one caller: the button, or the line that names who can fix it. */
export type GatedSetupFix = { remedy: null; run: () => void } | { remedy: SetupRemedy }

/**
 * Apply the setup cards' audience rule (`utils/setupAudience.ts`) to a conflict toast's fix: only a
 * caller who can act gets the button. Everyone else gets the remedy to name, because a button that
 * opens a screen their save is refused on is worse than no button. The bespoke and the mapped
 * conflict toasts both ask this, so they cannot disagree with each other or with the cards.
 */
export function gateSetupFix(fix: SetupFix, audience: ConflictAudience, deps: SetupConflictDeps) {
  const remedy = setupRemedyFor(fix.owner(audience.owners), audience.actor)
  const gated: GatedSetupFix = remedy
    ? { remedy }
    : { remedy: null, run: () => fix.open(deps.remedies(), audience.actor) }
  return gated
}

// The fixes more than one conflict toast offers, so the bespoke and the mapped toasts open the same
// screen for the same gap.

export const RUNNER_POOL_FIX: SetupFix = {
  owner: (owners) => owners?.agentExecutor,
  open: (remedies) => remedies.openInfraArea('agentExecutor'),
}
export const ENVIRONMENTS_FIX: SetupFix = {
  owner: (owners) => owners?.ephemeralEnvironments,
  open: (remedies) => remedies.openInfraArea('ephemeralEnvironments'),
}
export const SOURCE_CONTROL_FIX: SetupFix = {
  owner: () => SOURCE_CONTROL_SETUP_OWNER,
  open: (remedies) => remedies.openSourceControl(),
}
export const MODEL_CONFIG_FIX: SetupFix = {
  owner: () => MODEL_SETUP_OWNER,
  open: (remedies) => remedies.openModelConfig(),
}
