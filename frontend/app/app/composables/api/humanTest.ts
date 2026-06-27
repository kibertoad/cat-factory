import {
  confirmHumanTestContract,
  destroyHumanTestEnvContract,
  pullMainHumanTestContract,
  recreateHumanTestEnvContract,
  requestHumanTestFixContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The human-testing gate's run-driving actions. Each acts on the block's parked `human-test`
 * step and returns the updated execution instance (the gate state rides on its current step,
 * and also arrives live via the execution stream).
 */
export function humanTestApi({ send, ws }: ApiContext) {
  return {
    // Confirm the change works: tear the env down and advance the pipeline.
    confirmHumanTest: (workspaceId: string, blockId: string) =>
      send(confirmHumanTestContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Submit findings and request a fix (dispatches the Tester's fixer, then rebuilds the env).
    requestHumanTestFix: (workspaceId: string, blockId: string, findings: string) =>
      send(requestHumanTestFixContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { findings },
      }),

    // Pull latest main into the PR branch + redeploy (conflict → conflict-resolver).
    pullMainHumanTest: (workspaceId: string, blockId: string) =>
      send(pullMainHumanTestContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Rebuild the ephemeral environment on demand.
    recreateHumanTestEnv: (workspaceId: string, blockId: string) =>
      send(recreateHumanTestEnvContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Destroy the ephemeral environment on demand (the run stays parked).
    destroyHumanTestEnv: (workspaceId: string, blockId: string) =>
      send(destroyHumanTestEnvContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),
  }
}
