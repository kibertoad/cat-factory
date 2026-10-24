// ---------------------------------------------------------------------------
// The fix for each setup gap a refusal can name: who closes the gap, and which screen closes it.
// The conflict table (`utils/conflictCopy.ts`) and the failure block read these, and the toasts
// gate them on who is asking (`composables/pipelineErrorToast/setupConflictGate.ts`). Plain data,
// so a util and a unit test can import it without the stores the remedies read.
// ---------------------------------------------------------------------------

import type { useSetupRemedies } from '~/composables/useSetupRemedies'
import type { InfraSetupOwners } from '~/types/domain'
import {
  MODEL_SETUP_OWNER,
  SOURCE_CONTROL_SETUP_OWNER,
  type SetupActor,
  type SetupOwner,
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
