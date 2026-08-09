// One connected account, and the identity story behind it.
//
// The published contract's normal path is OAuth: a user connects their own vendor account through a
// nonce-protected flow, and identity thereafter travels as a props-imbued stub the workspace
// persists. cat-factory has no per-user OAuth, so this vendor takes the contract's own escape
// hatch: `autoProvisionsAccount`, where the workspace mints one account per user with no flow at
// all. That is a recognised low-trust variant rather than a violation, and it is worth being exact
// about what it does and does not buy.
//
// `createAccount()` "takes no arguments, so it carries no user identity" (the spec's own words). So
// the account's identity is one this Gatekeeper MINTS, and the workspace's persistence of the
// returned stub is what makes it stable and per-user. Two consequences follow, and both are better
// stated than discovered:
//
//   - The actor is stronger here than on `/rpc`, not weaker. `connect({ actorId })` trusts a string
//     the caller sent; an account id was never in anyone's hands to assert.
//   - A policy's `grants` map, keyed on an OS user identity an operator typed, cannot match an id
//     nobody had yet when the policy was written. So an auto-provisioned account resolves to the
//     policy's `autoProvisionedTier`, which is deliberately NOT `defaultTier` and does not inherit
//     from it: naming one is how a deployment opts into Cloudflare OS discovery, and a policy that
//     names none refuses, loudly, saying so. An operator who wants ONE account raised above it
//     reads that account's id off `describe()` (`uniqueName`) and grants THAT id directly.

import { WorkerEntrypoint } from 'cloudflare:workers'
import type { GatekeeperEnv } from '../env.js'
import { GatekeeperError } from '../errors.js'
import { Gatekeeper } from '../gatekeeper.js'
import type { GatekeeperPolicy } from '../policy/compile.js'
import { loopbackExport } from './exports.js'
import type {
  AccountDescription,
  AccountEntrypoint,
  SupportedResource,
  VerifierEntrypoint,
} from './protocol.js'
import { supportedResourceFor } from './resources.js'
import type { ResourceProps } from './resource.js'

/** What the vendor imbues an account with. The id IS the account; nothing else is stored. */
export interface AccountProps {
  accountId: string
}

/**
 * The account entrypoint over a deployment's policy.
 *
 * Stateless by construction: the workspace holds the stub, the stub holds the id, and everything
 * else is resolved from the policy and the paired deployment on each call. There is no account
 * table to fall out of step with the workspace's own.
 */
export function createGatekeeperAccount(options: {
  policy: GatekeeperPolicy
}): new (ctx: ExecutionContext<AccountProps>, env: GatekeeperEnv) => AccountEntrypoint {
  const { policy } = options

  return class CatFactoryAccount extends WorkerEntrypoint<GatekeeperEnv, AccountProps> {
    #gatekeeper(): Gatekeeper {
      return Gatekeeper.create(this.env, policy)
    }

    async describe(): Promise<AccountDescription> {
      const gatekeeper = this.#gatekeeper()
      const accountId = this.ctx.props.accountId
      const resource = supportedResourceFor(gatekeeper.deployment)
      return {
        // The id is surfaced as the canonical name because it is the value an operator needs in
        // hand to grant this account a tier above the default, and the only place it is visible.
        uniqueName: accountId,
        displayName: `cat-factory (${gatekeeper.tierForAccount(accountId).name})`,
        avatar: { url: new URL('/favicon.ico', gatekeeper.deployment).toString() },
        grantedResourceUrlPatterns: [resource.urlPattern],
      }
    }

    async getSupportedResources(): Promise<SupportedResource[]> {
      return [supportedResourceFor(this.#gatekeeper().deployment)]
    }

    /**
     * The resource object for a URL, imbued with this account's identity.
     *
     * The account id rides `ctx.props` onto the resource rather than being passed per call, which is
     * what makes it unforgeable from the session side: an agent holding a session has no argument
     * with which to name a different account.
     */
    async getGatekeeperClassFor(url: string) {
      const gatekeeper = this.#gatekeeper()
      const resource = supportedResourceFor(gatekeeper.deployment)
      if (!new URLPattern(resource.urlPattern).test(url)) {
        throw new GatekeeperError(
          'no_such_resource',
          `This Gatekeeper serves ${resource.urlPattern} and nothing else, so it cannot bind ` +
            `${url}. It is paired with one cat-factory workspace by the provisioning key it ` +
            'holds; a second workspace takes a second Gatekeeper deployment.',
        )
      }
      // The account, and nothing else: the URL is what was CHECKED, not what has to be carried.
      // Every URL this pattern matches binds the same paired workspace, so recording which one a
      // caller happened to name would be state no reader could act on (`ResourceProps`).
      const props: ResourceProps = { accountId: this.ctx.props.accountId }
      return { class: loopbackExport<unknown>(this.ctx.exports, 'resource', props), resource }
    }

    /** Nothing to grant: this vendor's single resource comes with the account. */
    async ensureResources(_resourceUrlPatterns: string[]): Promise<Record<string, never>> {
      return {}
    }

    /** Offboarding: revoke every cat-factory key this Gatekeeper minted for the account. */
    async revoke(): Promise<void> {
      await this.#gatekeeper().retire(this.ctx.props.accountId)
    }

    /**
     * Identity carried into another vendor's gatekeeper, and NOTHING else.
     *
     * A separate export rather than `this`, because the holder of a verifier is a third party's
     * gatekeeper: handing it this object would hand it `revoke()` and the resource classes too.
     */
    async getVerifier(): Promise<unknown> {
      return loopbackExport<unknown>(this.ctx.exports, 'verifier', {
        accountId: this.ctx.props.accountId,
      })
    }

    /** This vendor does not authenticate anybody: it auto-provisions, and says so in `describe()`. */
    async getAuthenticatedEmail(): Promise<string | null> {
      return null
    }

    /**
     * There is no connect flow to re-run.
     *
     * An account's credentials are the per-account cat-factory keys this Gatekeeper mints, and a
     * rejected one is already re-minted automatically on the next call. So the honest answer is a
     * refusal naming the real remedy rather than a URL that would open nothing.
     */
    async reconnect(): Promise<{ url: string }> {
      throw new GatekeeperError(
        'unsupported_action',
        'This vendor auto-provisions accounts and runs no connect flow, so there is nothing to ' +
          'reconnect. If calls are failing on credentials, the deployment-level provisioning key ' +
          'is the one to check; a per-account key is re-minted automatically when it is refused.',
      )
    }
  }
}

/**
 * The verifier: an identity token with no authority.
 *
 * The contract's own interface is empty, because what is being passed IS the identity: another
 * gatekeeper asks the workspace whether the holder of this stub may see something, and never calls
 * a method on it. `describe()` is here so a human looking at a share prompt sees which account is
 * being named rather than an opaque stub.
 */
export function createGatekeeperVerifier(): new (
  ctx: ExecutionContext<AccountProps>,
  env: GatekeeperEnv,
) => VerifierEntrypoint {
  return class CatFactoryVerifier extends WorkerEntrypoint<GatekeeperEnv, AccountProps> {
    async describe(): Promise<{ accountId: string }> {
      return { accountId: this.ctx.props.accountId }
    }
  }
}
