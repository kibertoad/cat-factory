import type { InfraSetupOwners } from '~/types/domain'
import { setupRemedyFor, type SetupActor, type SetupRemedy } from '~/utils/setupAudience'
import type { SetupFix, SetupRemedies } from '~/utils/setupFixes'

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
