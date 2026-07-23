/**
 * Environment-module sub-factories, extracted verbatim from `modules.ts` (pure code motion, no
 * behaviour change) to keep that file under its size budget. Each builds one collaborator of the
 * environments module — the per-user override store, the provisioning service, and the ephemeral
 * self-test service — and is called from `createEnvironmentsModule` in `modules.ts`.
 */

import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import {
  EnvironmentProvisioningService,
  EnvironmentUserHandlerService,
  defaultEnvironmentBackendRegistry,
} from '@cat-factory/integrations'
import type {
  EnvironmentConnectionService,
  EnvironmentTeardownService,
  PreflightService,
  ProvisioningLogRecorder,
  SharedStackService,
} from '@cat-factory/integrations'
import { EnvironmentTestService } from '../modules/environments/EnvironmentTestService.js'
import type { CoreDependencies } from '../container.js'

/**
 * Build the per-USER environment override store, wired ONLY when its repository is present (by
 * design, only the local facade wires it). Its `resolveOverrides` is the
 * `resolveUserHandlerOverrides` seam the provisioning service layers over the workspace handlers
 * for the run initiator. Returns undefined when unwired. Split out of
 * {@link createEnvironmentsModule} to keep it under the complexity ceiling.
 */
export function buildEnvironmentUserHandlerService(
  deps: CoreDependencies,
  secretCipher: NonNullable<CoreDependencies['secretCipher']>,
): EnvironmentUserHandlerService | undefined {
  if (!deps.environmentUserHandlerRepository) return undefined
  return new EnvironmentUserHandlerService({
    userHandlerRepository: deps.environmentUserHandlerRepository,
    environmentBackendRegistry:
      deps.environmentBackendRegistry ?? defaultEnvironmentBackendRegistry(),
    secretCipher,
    clock: deps.clock,
    ...(deps.environmentCustomTlsSupported !== undefined
      ? { customTlsSupported: deps.environmentCustomTlsSupported }
      : {}),
    ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  })
}

/**
 * Build the environment provisioning service — the deployer's async, container-backed deploy
 * lifecycle plus the synchronous raw-manifest REST path. Each optional collaborator (user-handler
 * overrides, the deploy job client + clone-target resolver, shared-stack bring-up, compose
 * preflights, the provisioning log) is wired only when supplied. Split out of
 * {@link createEnvironmentsModule} to keep it under the complexity ceiling.
 */
export function buildEnvironmentProvisioningService(args: {
  deps: CoreDependencies
  connectionService: EnvironmentConnectionService
  environmentRegistryRepository: NonNullable<CoreDependencies['environmentRegistryRepository']>
  secretCipher: NonNullable<CoreDependencies['secretCipher']>
  teardownService: EnvironmentTeardownService
  userHandlerService: EnvironmentUserHandlerService | undefined
  sharedStackService: SharedStackService | undefined
  preflightService: PreflightService | undefined
  provisioningLog: ProvisioningLogRecorder | undefined
}): EnvironmentProvisioningService {
  const {
    deps,
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    teardownService,
    userHandlerService,
    sharedStackService,
    preflightService,
    provisioningLog,
  } = args
  return new EnvironmentProvisioningService({
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    environmentTeardown: teardownService,
    ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
    ...(deps.resolveRunRepoContext ? { resolveRunRepoContext: deps.resolveRunRepoContext } : {}),
    ...(deps.resolveRepoFilesForCoords
      ? { resolveRepoFilesForWorkspace: deps.resolveRepoFilesForCoords }
      : {}),
    ...(userHandlerService
      ? {
          resolveUserHandlerOverrides: (userId, ws) =>
            userHandlerService.resolveOverrides(userId, ws),
        }
      : {}),
    // The async, container-backed deploy lifecycle (kustomize/helm) is wired when the facade
    // supplies the runner transport + the clone-target resolver; absent ⇒ only the synchronous
    // raw-manifest REST path runs (a render-needing config fails loudly).
    ...(deps.deployJobClient ? { deployJobClient: deps.deployJobClient } : {}),
    ...(deps.resolveDeployCloneTarget
      ? { resolveDeployCloneTarget: deps.resolveDeployCloneTarget }
      : {}),
    // A compose stack recipe's `sharedStackRefs` are brought up (provider-before-consumer) through
    // the shared-stack service, whose managed networks the compose provider attaches the per-PR
    // project to. Wired only when the shared-stacks module exists (its repository is present on
    // every facade); the lifecycle itself refuses without a host daemon.
    ...(sharedStackService
      ? { ensureSharedStacks: (ws, refs) => sharedStackService.ensureRefsUp(ws, refs) }
      : {}),
    // A compose stack recipe's `prerequisites` are re-run at provision start through the preflight
    // service, whose host probes exist only on the local facade; absent ⇒ a recipe that declares
    // them fails loudly instead of silently skipping a machine-prerequisite gate.
    ...(preflightService ? { runPreflights: (_ws, refs) => preflightService.run(refs) } : {}),
    ...(provisioningLog ? { provisioningLog } : {}),
  })
}

/**
 * Build the ephemeral-environment self-test service, wired only when its own run store AND a git
 * provider (to create/delete the throwaway branch) are present; absent either ⇒ no self-test (the
 * controller 503s). Split out of {@link createEnvironmentsModule} to keep it under the complexity
 * ceiling.
 */
export function buildEnvironmentTestService(args: {
  deps: CoreDependencies
  provisioningService: EnvironmentProvisioningService
  teardownService: EnvironmentTeardownService
  environmentRegistryRepository: NonNullable<CoreDependencies['environmentRegistryRepository']>
  eventPublisher: ExecutionEventPublisher | undefined
}): EnvironmentTestService | undefined {
  const {
    deps,
    provisioningService,
    teardownService,
    environmentRegistryRepository,
    eventPublisher,
  } = args
  if (!deps.environmentTestRunRepository || !deps.resolveRunRepoContext) return undefined
  return new EnvironmentTestService({
    environmentTestRunRepository: deps.environmentTestRunRepository,
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    provisioning: provisioningService,
    teardown: teardownService,
    environmentRegistry: environmentRegistryRepository,
    resolveRunRepoContext: deps.resolveRunRepoContext,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    ...(deps.environmentTestRunner ? { runner: deps.environmentTestRunner } : {}),
    ...(eventPublisher ? { eventPublisher } : {}),
  })
}
