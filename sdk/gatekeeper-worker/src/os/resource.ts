// The per-resource object the workspace binds: a Durable Object serving one paired cat-factory
// workspace to one account.
//
// WHAT A RESOURCE IS, decided here and recorded in the initiative tracker: the PAIRED cat-factory
// WORKSPACE, named by a URLPattern over the deployment origin. It follows from the credential
// rather than being a modelling preference. This Worker holds one provisioning key, a cat-factory
// key is scoped to exactly one workspace, and `STATE` is already keyed on the deployment origin for
// the same reason. So one Gatekeeper Worker serves one resource, and an OS deployment that wants
// two workspaces runs two Gatekeepers with two bindings, which is also the only arrangement in
// which the two workspaces' credentials sit in different secret stores.
//
// Everything below is a FACADE. The policy compilation, the key broker, the durable state and the
// approval answerers are the same single implementation the `/rpc` door reaches; what differs is
// the door, and the governance that door brings with it. This file is the SHELL: it supplies
// `ctx.props` and holds one `ResourceCore`, which is where the behaviour lives.

import { DurableObject } from 'cloudflare:workers'
import type { GatekeeperEnv } from '../env.js'
import type { GatekeeperPolicy } from '../policy/compile.js'
import type { ActionKind, ApprovalQueue, ResourceDescription, ResourceObject } from './protocol.js'
import { ResourceCore, type ResourceProps } from './resource-core.js'

export type { ResourceProps } from './resource-core.js'

/**
 * Build the resource Durable Object class over a deployment's policy.
 *
 * A factory rather than a class, for the reason `createGatekeeperWorker` is one: the policy is the
 * deployment's and arrives as an argument, so a class that imported one would own the file the
 * operator is supposed to write.
 */
export function createGatekeeperResource(options: {
  policy: GatekeeperPolicy
}): new (ctx: DurableObjectState<ResourceProps>, env: GatekeeperEnv) => ResourceObject {
  const { policy } = options

  return class CatFactoryResource extends DurableObject<GatekeeperEnv, ResourceProps> {
    // ONE core for the object's lifetime, because the action ledger inside it is what a later
    // `applyAction` settles: a core rebuilt per call would have forgotten the action the decision
    // is about. Field initializers run after the base constructor, so `ctx` and `env` are set.
    readonly #core = new ResourceCore(this.env, policy, this.ctx.props)

    async describe(): Promise<ResourceDescription> {
      return this.#core.describe()
    }

    async getTypeScriptTypes(): Promise<string> {
      return this.#core.getTypeScriptTypes()
    }

    async startSession(approvalQueue: ApprovalQueue): Promise<unknown> {
      return this.#core.startSession(approvalQueue)
    }

    async getAutoApprovableActions(): Promise<ActionKind[]> {
      return this.#core.getAutoApprovableActions()
    }

    async applyAction(action: number): Promise<void> {
      return this.#core.applyAction(action)
    }

    async rejectAction(action: number): Promise<void> {
      return this.#core.rejectAction(action)
    }

    async revertAction(action: number): Promise<{ message: string; canRetry: false }> {
      return this.#core.revertAction(action)
    }

    async addObserver(id: string, user: unknown): Promise<void> {
      return this.#core.addObserver(id, user)
    }

    async removeObserver(id: string): Promise<void> {
      return this.#core.removeObserver(id)
    }
  }
}
