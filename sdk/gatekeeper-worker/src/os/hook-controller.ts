// The handle a workspace turns one bound hook on and off by.
//
// It is a fifth named export for the same reason the verifier is a fourth: what the workspace has
// to hold is not what the workspace has to be able to DO. A controller carries no capability, no
// key and no session; it names one registration, and its two methods are the only two things
// anybody may do to that registration from outside. Handing over a session or an account instead
// would hand over everything they carry along with the ability to disable a hook.
//
// Its props ARE the registration's identity, which is what keeps this class stateless: the
// workspace persists the controller, so the id, the topic, the account and the tier ride back in
// on `enable` without this Gatekeeper keeping a table of hooks nobody has approved yet. That is
// also the contract's own instruction ("avoid storing any state until the hook is enabled") read
// literally rather than approximately.

import { WorkerEntrypoint } from 'cloudflare:workers'
import { stateFor, type GatekeeperEnv } from '../env.js'
import type { HookControllerProps, HookRecord } from './hooks.js'
import type { HookController, HookInitiator, HookTargetMetadata } from './protocol.js'

export type { HookControllerProps } from './hooks.js'

/**
 * Build the hook controller class a deployment exports.
 *
 * No policy argument, like the verifier: nothing here resolves a tier or compiles a grant. The
 * tier a delivery is described at was resolved by the session that bound the hook and rides the
 * props, because re-resolving it here would silently re-tier a live hook the day an operator edits
 * the policy, with the workspace still believing it enabled the one it was shown.
 */
export function createGatekeeperHookController(): new (
  ctx: ExecutionContext<HookControllerProps>,
  env: GatekeeperEnv,
) => HookController {
  return class CatFactoryHookController extends WorkerEntrypoint<
    GatekeeperEnv,
    HookControllerProps
  > {
    /**
     * The workspace approved the hook: record it, and hold the initiator it handed over.
     *
     * Re-enabling an already-enabled hook REPLACES the initiator, which the contract asks for, and
     * the store keeps the counters this call zeroes (see `enableHook`): they are the
     * registration's history rather than that stub's, so resetting them would erase the record of
     * the deliveries a workspace missed at exactly the moment it is re-arming to stop missing them.
     */
    async enable(initiator: HookInitiator, target: HookTargetMetadata): Promise<void> {
      const record: HookRecord = {
        ...this.ctx.props,
        target,
        enabledAt: Date.now(),
        deliveries: 0,
        missed: 0,
        failures: 0,
        lastDeliveryAt: null,
        lastError: null,
      }
      await stateFor(this.env).enableHook(record, initiator)
    }

    /** The workspace withdrew the hook: the record and the live half both go, permanently. */
    async disable(): Promise<void> {
      await stateFor(this.env).disableHook(this.ctx.props.hookId)
    }
  }
}
