import type {
  AccountRiskPolicyRepository,
  ModelPresetRepository,
  RiskPolicyRepository,
  RiskPolicySuppressionRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { createWorkspaceRiskPolicyLibrary } from '../merge/WorkspaceRiskPolicyLibrary.js'
import type { PresetPinGuard } from './presetPinGuard.js'
import { createPresetPinGuard } from './presetPinGuard.js'
import type { RiskPolicySelectionGuard } from './riskPolicySelectionGuard.js'
import { createRiskPolicySelectionGuard } from './riskPolicySelectionGuard.js'

/** The two guards a board write passes through on its way to a library id. */
export interface BoardPolicyGuards {
  /** Whether the editor may move a task from one risk policy to another. */
  riskPolicySelection: RiskPolicySelectionGuard
  /** Whether a pinned model-preset / risk-policy id names anything at all. */
  presetPins: PresetPinGuard
}

/**
 * Compose both library guards from the repositories a board holds.
 *
 * They are built together because they take the SAME reading of what a board can see, and that
 * agreement is the point: since ADR 0055 a board's risk-policy library is its own rows merged with
 * the account policies it inherits, so each guard reads the merged library rather than the workspace
 * tier. Reading the workspace tier alone would refuse a pin the picker offers, and — worse for the
 * selection guard — let a move onto an inherited, wider posture past unjudged.
 *
 * The pin guard additionally takes the OWN tier, and only for the lazy-seeding question: what a pin
 * may NAME is the merged library, but the tier the built-in catalog is about to be written into is
 * only ever the board's own (see `presetPinGuard`).
 *
 * Its own module rather than four inline statements in `BoardService`'s constructor, which is where
 * this lived and what pushed that file past its size budget.
 */
export function createBoardPolicyGuards(deps: {
  riskPolicyRepository?: RiskPolicyRepository
  accountRiskPolicyRepository?: AccountRiskPolicyRepository
  riskPolicySuppressionRepository?: RiskPolicySuppressionRepository
  workspaceRepository: WorkspaceRepository
  modelPresetRepository?: ModelPresetRepository
}): BoardPolicyGuards {
  const riskPolicyReader = createWorkspaceRiskPolicyLibrary(deps)
  return {
    riskPolicySelection: createRiskPolicySelectionGuard({ riskPolicyReader }),
    presetPins: createPresetPinGuard({
      riskPolicyReader,
      riskPolicyRepository: deps.riskPolicyRepository,
      modelPresetRepository: deps.modelPresetRepository,
    }),
  }
}
