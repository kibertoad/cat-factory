// The Worker entry point: four routes and a cron, and no logic of its own beyond translating
// between HTTP and the Gatekeeper.
//
//   POST /webhook        the platform's outbound delivery receiver
//   ALL  /rpc            the Cap'n Web endpoint the paired Cloudflare OS talks to
//   POST /admin/enroll   re-assert this Worker's webhook registration on demand
//   GET  /health         liveness plus whether the policy compiles
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
import { ConfigError, type GatekeeperEnv } from './env'
import { GatekeeperError, PolicyError } from './errors'
import { Gatekeeper } from './gatekeeper'
import type { Actor } from './keys'

export { GatekeeperState } from './state'

/**
 * What the paired OS deployment sends to open a session.
 *
 * `actorId` is the OS's OWN authenticated identity for the person, which is the only claim in
 * this request the Gatekeeper trusts. Nothing here names a tier or a scope: those are resolved
 * from `policy.config.ts` against this id.
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
function refuseSetup(error: unknown): Response | null {
  if (error instanceof ConfigError) return problem(503, 'not_configured', error.message)
  if (error instanceof PolicyError) return problem(503, 'policy_invalid', error.message)
  return null
}

export default {
  async fetch(request: Request, env: GatekeeperEnv): Promise<Response> {
    const url = new URL(request.url)

    try {
      const gatekeeper = Gatekeeper.create(env)

      if (url.pathname === '/health') {
        return Response.json({ ok: true })
      }

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
          return problem(400, 'unparseable_delivery', 'The signed body is not a delivery envelope.')
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
    ctx.waitUntil(Gatekeeper.create(env).enroll())
  },
}
