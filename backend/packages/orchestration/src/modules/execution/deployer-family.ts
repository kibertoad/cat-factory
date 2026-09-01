import type { RunDispatcherDeps } from './RunDispatcherDependencies.js'
import { DeployFixController } from './DeployFixController.js'
import {
  DeployerStepController,
  type DeployerStepControllerDeps,
} from './DeployerStepController.js'
import { DisposerStepController } from './DisposerStepController.js'
import { EnvironmentInvestigationController } from './EnvironmentInvestigationController.js'

// ---------------------------------------------------------------------------
// Construction of the ENVIRONMENT-LIFECYCLE step controllers: the `deployer` fan-out, its two
// remediation loops (repair in the checkout, investigate the provider), and the `disposer` that
// reclaims at the other end.
//
// One factory rather than four `new`s in `RunDispatcher`'s constructor, extracted along the seam
// the dispatcher's other controller extractions follow (the file-size rule: split, never raise the
// ratchet). The four belong together because they are the only controllers sharing a subject,
// the environments a run stands up, and because the wiring between them is not flat: the deployer
// takes both loops, and both loops are narrowed by which optional collaborators the facade wired.
// ---------------------------------------------------------------------------

/**
 * The dispatcher-owned callbacks the deployer family calls back into, taken off the deployer's own
 * dependency type rather than restated. Restating them compiled and then failed structurally: the
 * step type is re-exported through two packages, so a hand-written signature naming it is not the
 * same type the controller declares.
 */
export type DeployerFamilyHooks = Pick<
  DeployerStepControllerDeps,
  'recordStepResult' | 'applyContainerRunning' | 'applySubtaskProgress' | 'recoverContainerEviction'
>

/** The controllers the dispatcher holds, built together. */
export interface DeployerFamily {
  deployer: DeployerStepController
  deployFix: DeployFixController
  environmentInvestigation: EnvironmentInvestigationController
  disposer: DisposerStepController
}

export function buildDeployerFamily(
  deps: RunDispatcherDeps,
  hooks: DeployerFamilyHooks,
): DeployerFamily {
  const deployFix = new DeployFixController({
    agentExecutor: deps.agentExecutor,
    contextBuilder: deps.contextBuilder,
    runStateMachine: deps.runStateMachine,
    clock: deps.clock,
    notificationService: deps.notificationService,
    logger: deps.logger,
  })
  // Every collaborator here is optional on purpose: a facade with no model provider, no
  // provisioning service or no teardown seam NARROWS what the loop can offer rather than failing
  // to build, and with none of them the loop is a pass-through.
  const environmentInvestigation = new EnvironmentInvestigationController({
    investigator: deps.environmentInvestigator,
    environmentProvisioning: deps.environmentProvisioning,
    environmentTeardown: deps.environmentTeardown,
    runStateMachine: deps.runStateMachine,
    clock: deps.clock,
    logger: deps.logger,
  })
  const deployer = new DeployerStepController({
    blockRepository: deps.blockRepository,
    contextBuilder: deps.contextBuilder,
    runStateMachine: deps.runStateMachine,
    clock: deps.clock,
    environmentProvisioning: deps.environmentProvisioning,
    deployFix,
    environmentInvestigation,
    recordStepResult: hooks.recordStepResult,
    applyContainerRunning: hooks.applyContainerRunning,
    applySubtaskProgress: hooks.applySubtaskProgress,
    recoverContainerEviction: hooks.recoverContainerEviction,
    logger: deps.logger,
  })
  const disposer = new DisposerStepController({
    runStateMachine: deps.runStateMachine,
    environmentTeardown: deps.environmentTeardown,
    recordStepResult: hooks.recordStepResult,
    logger: deps.logger,
  })
  return { deployer, deployFix, environmentInvestigation, disposer }
}
