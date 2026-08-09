// The entrypoint a Cloudflare OS deployment discovers this Worker through.
//
// The workspace scans its own environment for `GATEKEEPER_*` SERVICE BINDINGS and treats each as a
// vendor, reaching the bound Worker's `GatekeeperVendor` entrypoint over native Workers RPC. That
// is a different door from `/rpc`, and the difference that matters is the authorization:
//
//   - On this path, HOLDING THE BINDING IS THE AUTHORIZATION. A service binding is configuration
//     only the OS deployment's operator can write, and the call never traverses the internet.
//     There is no shared token in the published model and none is asked for here; adding one would
//     be a second secret to rotate that protects nothing the binding does not already.
//   - `/rpc` stays bearer-gated by `OS_SHARED_TOKEN`, because a Worker with a route attached is
//     reachable by anyone who finds it. Nothing about that door changes: it is what a non-OS
//     consumer speaks, and the promise that this Worker is not Cloudflare-OS-only rests on it.
//
// Everything the vendor answers is a PROJECTION of the operation table or of the policy compiled
// against it. Nothing here is transcribed, so a surface change cannot leave the description of it
// behind.

import { WorkerEntrypoint } from 'cloudflare:workers'
import type { GatekeeperEnv } from '../env.js'
import { Gatekeeper } from '../gatekeeper.js'
import type { GatekeeperPolicy } from '../policy/compile.js'
import type { AccountProps } from './account.js'
import { loopbackExport } from './exports.js'
import type { SupportedResource, VendorDescription, VendorEntrypoint } from './protocol.js'
import { supportedResourceFor } from './resources.js'
import { renderTierSessionTypes } from './session-types.js'

/**
 * A fresh account id.
 *
 * Random rather than derived: the vendor is handed nothing to derive one FROM (`createAccount()`
 * takes no arguments by design, so that a public method cannot be used to look an existing account
 * up), and a guessable id would be one an agent could name in place of its own.
 */
function mintAccountId(): string {
  return `acct_${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * Build the vendor entrypoint class over a deployment's policy.
 *
 * The deployment exports the result under the name the OS pins:
 *
 *     export const GatekeeperVendor = createGatekeeperVendor({ policy: POLICY })
 */
export function createGatekeeperVendor(options: {
  policy: GatekeeperPolicy
}): new (ctx: ExecutionContext, env: GatekeeperEnv) => VendorEntrypoint {
  const { policy } = options

  return class GatekeeperVendor extends WorkerEntrypoint<GatekeeperEnv> {
    #gatekeeper(): Gatekeeper {
      return Gatekeeper.create(this.env, policy)
    }

    async describe(): Promise<VendorDescription> {
      const deployment = this.#gatekeeper().deployment
      return {
        displayName: 'cat-factory',
        url: deployment,
        tagline: 'Ship software with managed agents.',
        description:
          'File work onto a cat-factory board, start a pipeline run, watch it, and answer what it ' +
          'parks on. Calls are made with a per-account API key this Gatekeeper mints and holds; ' +
          'no agent ever sees a credential.',
        // This vendor cannot authenticate anyone for sign-in: there is no per-user OAuth on the
        // cat-factory side, so no provider-verified email exists to be one.
        providesAuth: false,
        // It CAN mint an account with no flow, which is the contract's own escape hatch for
        // exactly this case. See `account.ts` for what that does and does not buy.
        autoProvisionsAccount: true,
      }
    }

    async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
      return [supportedResourceFor(this.#gatekeeper().deployment)]
    }

    /**
     * The session types, rendered for the DEFAULT tier.
     *
     * The vendor is asked this before any account exists, so the tier is the one an account will
     * get: that is what `defaultTier` means. The authoritative copy for a bound session is the
     * resource's own `getTypeScriptTypes()`, which knows the tier the account actually resolved to
     * and is the one `ResourceDescription.tsType` points at.
     */
    async getTypeScriptTypes(): Promise<string> {
      const gatekeeper = this.#gatekeeper()
      // Asked with a throwaway id on purpose: an id no policy grants resolves the
      // auto-provisioned default, which is exactly the tier a real account will get. It refuses
      // when there is none, which is better than describing a session that will not open.
      return renderTierSessionTypes(gatekeeper.tierForAccount(mintAccountId()))
    }

    /**
     * Mint a new connected account.
     *
     * Deliberately creating-only and identity-free, which is what makes it safe on a public
     * interface: it cannot look an existing account up, so holding the binding buys the ability to
     * make an account and never the ability to reach somebody else's.
     */
    async createAccount(): Promise<unknown> {
      const props: AccountProps = { accountId: mintAccountId() }
      // Resolved before the account is handed back, so a deployment missing the export is refused
      // at the call that would have created the account rather than at the first use of it.
      return loopbackExport<unknown>(this.ctx.exports, 'account', props)
    }
  }
}
