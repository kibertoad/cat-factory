// The Worker handler: five routes and a cron, and no logic of its own beyond translating between
// HTTP and the Gatekeeper.
//
// It is a FACTORY over the deployment's policy rather than a module-level `export default`, which
// is the whole shape of the base/template split. A deployment's entry point is then three lines
// (its policy, this factory, and the re-exported Durable Object class), so upgrading the machinery
// is a dependency bump instead of a re-merge against a file the operator has edited.
//
//   POST /webhook        the platform's outbound delivery receiver
//   ALL  /rpc            a Cap'n Web capability endpoint, for an agent runtime that speaks it
//   POST /admin/enroll   re-assert this Worker's webhook registration on demand
//   POST /admin/retire   revoke every key minted for one OS user, for offboarding
//   GET  /health         liveness plus whether this deployment could serve at all
//
// A Cloudflare OS deployment does NOT come in here. It reaches the `GatekeeperVendor` entrypoint
// over a service binding, using native Workers RPC (`src/os/`); Cap'n Web is the workspace's
// browser-to-backend and gadget-side protocol, which shares the semantics and not the wire. `/rpc`
// is the door for everything else: an agent runtime that speaks Cap'n Web, or a consumer that
// wants this Worker's capabilities without a Cloudflare OS at all.
//
// Two conventions are worth stating because they look like sloppiness and are not.
//
// A REFUSED DELIVERY STILL ANSWERS 2xx-ADJACENT ONLY WHERE IT SHOULD. A delivery that fails its
// signature check is a 401: it is not from the platform, and telling the sender otherwise would
// make an attacker's probe indistinguishable from a real endpoint. Everything the platform DID
// sign is a 202, duplicates and unrecognised families included, because the platform's delivery
// contract retries a 5xx and gives up on a 4xx: reporting "I already have this one" as an error
// would spend a receiver's retry budget arguing about a message it has already handled.
//
// THE RPC ROUTE IS BEARER-GATED even though the intended path is a Worker service binding, which
// never traverses the internet. A Worker with a route attached is reachable by anyone who finds
// it, and a capability surface whose only defence is obscurity is not one.

import { newWorkersRpcResponse, RpcTarget } from 'capnweb'
import { ConfigError, describeMissingBindings, missingBindings, type GatekeeperEnv } from './env.js'
import { GatekeeperError, PolicyError } from './errors.js'
import { Gatekeeper } from './gatekeeper.js'
import type { Actor } from './keys.js'
import { missingOsExports, OS_EXPORTS, type OsExportRole } from './os/exports.js'
import type { GatekeeperPolicy } from './policy/compile.js'

/** What a deployment supplies to get a Worker. */
export interface GatekeeperWorkerOptions {
  /**
   * The tiers, the grants and the default, as the deployment wrote them.
   *
   * Compiled against the LIVE operation table on every assembly, so a policy naming a retired or
   * above-scope operation refuses to serve rather than serving methods that 403.
   */
  policy: GatekeeperPolicy
}

/**
 * What the paired OS deployment sends to open a session.
 *
 * `actorId` is the OS's OWN authenticated identity for the person, which is the only claim in
 * this request the Gatekeeper trusts. Nothing here names a tier or a scope: those are resolved
 * from the deployment's policy against this id.
 */
interface ConnectRequest {
  actorId?: unknown
  label?: unknown
}

/** The root capability: the only thing reachable before an actor is named. */
class GatekeeperApi extends RpcTarget {
  readonly #gatekeeper: Gatekeeper

  constructor(gatekeeper: Gatekeeper) {
    super()
    this.#gatekeeper = gatekeeper
  }

  connect(request: ConnectRequest): RpcTarget {
    const actorId = typeof request?.actorId === 'string' ? request.actorId : ''
    if (actorId.length === 0) {
      throw new GatekeeperError(
        'unknown_actor',
        'connect() needs the OS user identity as `actorId`. It is the value every minted key is ' +
          'stamped with, so a run can be traced back to a person.',
      )
    }
    const actor: Actor = {
      id: actorId,
      ...(typeof request.label === 'string' ? { label: request.label } : {}),
    }
    return this.#gatekeeper.capabilityFor(actor)
  }
}

function problem(status: number, reason: string, message: string): Response {
  return Response.json({ error: { reason, message } }, { status })
}

/**
 * Turn a configuration or policy failure into the refusal an operator can act on.
 *
 * Both are 503 rather than 500 because neither is a fault in the request: the deployment is not
 * wired, which is exactly what the status class means, and the `reason` is what a monitor keys on.
 */
/** The refusal an operator can act on: every export the OS object model needs and cannot find. */
function describeMissingOsExports(missing: readonly OsExportRole[]): string {
  const names = missing.map((role) => OS_EXPORTS[role]).join(', ')
  return (
    'This Gatekeeper cannot be discovered or installed by a Cloudflare OS deployment: its entry ' +
    `module does not export ${names}. The Cloudflare OS object model resolves each by name ` +
    'against this Worker (deploy/gatekeeper/src/index.ts is the template). The HTTP routes here ' +
    'are unaffected.'
  )
}

function refuseSetup(error: unknown): Response | null {
  if (error instanceof ConfigError) return problem(503, 'not_configured', error.message)
  if (error instanceof PolicyError) return problem(503, 'policy_invalid', error.message)
  return null
}

/**
 * Build the Worker a deployment exports as its default.
 *
 * Everything it needs beyond the policy comes from the environment, so the returned handler is the
 * same one this package tests: an operator's Worker and the suite in `test/` differ only in which
 * policy they were given.
 */
export function createGatekeeperWorker(
  options: GatekeeperWorkerOptions,
): ExportedHandler<GatekeeperEnv> {
  const { policy } = options

  return {
    async fetch(request: Request, env: GatekeeperEnv, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)

      try {
        // Health runs BEFORE the assembly below, and asks the whole configuration rather than the
        // two bindings that assembly happens to read. A monitor keyed on this route is asking
        // "could a call served right now get past setup", and a Gatekeeper missing only its
        // WEBHOOK_SECRET or OS_SHARED_TOKEN answers every /rpc call with a 503 while its liveness
        // is perfect: green here and refusing everything there is the one answer this route must
        // never give.
        if (url.pathname === '/health') {
          const missing = missingBindings(env)
          if (missing.length > 0) {
            return problem(503, 'not_configured', describeMissingBindings(missing))
          }
          // The OS object model is resolved by NAME against this Worker's own exports, so a
          // deployment can be perfectly configured and still be undiscoverable because its entry
          // module is three lines short. That failure has no request path of its own: the workspace
          // simply never gets past `createAccount()`, which is not a call anyone monitors. Asked
          // here, in the same one pass as the bindings, for the same reason they are.
          const missingExports = missingOsExports(ctx.exports)
          if (missingExports.length > 0) {
            return problem(503, 'not_configured', describeMissingOsExports(missingExports))
          }
          // Assembling IS the rest of the check: it compiles the policy against the live operation
          // table, and a policy that does not compile is a Gatekeeper that serves nothing.
          Gatekeeper.create(env, policy)
          return Response.json({ ok: true })
        }

        const gatekeeper = Gatekeeper.create(env, policy)

        if (url.pathname === '/webhook') {
          if (request.method !== 'POST') return problem(405, 'method_not_allowed', 'POST only.')
          const outcome = await gatekeeper.takeDelivery(request, Date.now())
          if (outcome.handled === 'rejected') {
            return problem(
              401,
              outcome.reason,
              'This delivery did not verify against the endpoint secret.',
            )
          }
          if (outcome.handled === 'unparseable') {
            return problem(
              400,
              'unparseable_delivery',
              'The signed body is not a delivery envelope.',
            )
          }
          return Response.json(outcome, { status: 202 })
        }

        if (!gatekeeper.authorize(request.headers.get('authorization'))) {
          return problem(401, 'unauthorized', 'Present the paired deployment’s shared token.')
        }

        if (url.pathname === '/admin/enroll') {
          if (request.method !== 'POST') return problem(405, 'method_not_allowed', 'POST only.')
          return Response.json(await gatekeeper.enroll())
        }

        // Offboarding. It sits on the admin surface rather than on a capability because it is a
        // decision the OS deployment makes ABOUT a person, and an agent acting as one of them must
        // not be able to make it for the others.
        if (url.pathname === '/admin/retire') {
          if (request.method !== 'POST') return problem(405, 'method_not_allowed', 'POST only.')
          const actorId = url.searchParams.get('actorId') ?? ''
          if (actorId.length === 0) {
            return problem(
              400,
              'unknown_actor',
              'Name the OS user identity to retire as `?actorId=`. It is the same value connect() ' +
                'takes, and the value every key minted for them is stamped with.',
            )
          }
          return Response.json(await gatekeeper.retire(actorId))
        }

        if (url.pathname === '/rpc') {
          return await newWorkersRpcResponse(request, new GatekeeperApi(gatekeeper))
        }

        return problem(404, 'no_such_route', `Nothing is served at ${url.pathname}.`)
      } catch (error) {
        const refusal = refuseSetup(error)
        if (refusal !== null) return refusal
        throw error
      }
    },

    /**
     * Re-assert the webhook registration.
     *
     * A cron rather than a one-shot at first boot: the registration lives on the cat-factory side,
     * where it can be edited, disabled or dropped by someone tidying a workspace, and a Gatekeeper
     * that enrolled once would then go quiet with nothing failing. Re-asserting is idempotent by the
     * caller-chosen id, so it can never displace another integration's endpoint.
     */
    async scheduled(
      _controller: ScheduledController,
      env: GatekeeperEnv,
      ctx: ExecutionContext,
    ): Promise<void> {
      ctx.waitUntil(Gatekeeper.create(env, policy).enroll())
    },
  }
}
