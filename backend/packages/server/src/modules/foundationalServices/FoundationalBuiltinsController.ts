import { type Context, Hono } from 'hono'
import { signerFor, type MachinePayload, TOKEN_AUDIENCE } from '../../auth/signing.js'
import type { AppEnv } from '../../http/env.js'

/**
 * The mothership-mode foundational-services `builtin`-tier API:
 * `GET /internal/foundational-services` and
 * `GET /internal/foundational-services/:serviceId/contracts`.
 *
 * A mothership deployment is TWO processes — the hosted mothership answers the SPA, a local node
 * with no main database resolves the catalog for the runs it dispatches — and the catalog's
 * `builtin` tier is CODE, so it did not cross the machine API at all. The estate therefore had to
 * be registered on both entry points, and the two copies were equal only while both imported the
 * same package at the same commit. Nothing detected a skew, and a local node one build behind is
 * the normal state of a mothership deployment: the run's catalog was simply missing a service,
 * which reads exactly like an Architect judging it irrelevant. This endpoint makes the estate org
 * state the mothership OWNS, like every other org fact a node reads remotely.
 *
 * It is a DEDICATED `/internal/*` endpoint rather than an entry in the persistence allow-list
 * (ADR 0009): the registry is not a repository, it holds no rows, and every method in
 * `REMOTE_PERSISTENCE_METHODS` is bound to an account by a scope rule this has no argument to
 * offer one from.
 *
 * Security mirrors `PersistenceController`: the `/internal` prefix bypasses the user-session
 * gate, so the audience-pinned machine token is checked here and a user session / ws ticket /
 * container token can never be replayed against it. There is deliberately no ACCOUNT scope
 * check beyond that, because there is nothing account-shaped to check: the `builtin` tier is one
 * deployment-wide set with no owner, and every workspace of every account already resolves all
 * of it through the ordinary catalog read. The machine gate is what bounds this to the nodes the
 * mothership provisioned.
 *
 * Both routes read `container.foundationalServiceRegistry` — this process's OWN registry, never
 * the resolved `builtin` source, which on a node is remote. So a satellite can never answer for
 * another satellite, and a mothership-of-a-mothership cannot loop.
 *
 * Mounted on BOTH facades via the shared controller registration, so either a Node or a
 * Cloudflare deployment can be a mothership. Unlike its `/internal` siblings it never 503s: a
 * deployment that registers no estate has an EMPTY one, which is a real and correct answer.
 * (What must not read as empty is a failure to reach it — that is the client's half of the
 * contract; see `foundationalBuiltins.ts`.)
 */
export function foundationalBuiltinsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** The machine-token gate, shared by both routes. Returns the payload, or null after replying. */
  const requireMachine = async (c: Context<AppEnv>) => {
    const secret = c.get('container').config.auth.sessionSecret
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    return secret
      ? await signerFor(secret).verify<MachinePayload>(token, { aud: TOKEN_AUDIENCE.machine })
      : null
  }
  const forbidden = { error: { code: 'forbidden', message: 'invalid machine token' } } as const

  // The catalog projection: identity + contract manifests for every registered service, and
  // never a document body — the same split the stored tiers keep, so a node's design dispatch
  // does not drag the org's whole spec estate over the wire.
  app.get('/internal/foundational-services', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    return c.json({ entries: c.get('container').foundationalServiceRegistry.entries() }, 200)
  })

  // The lazy half: the FULL documents of one service, fetched only for the ids a design
  // declared. An id the registry does not know answers with an empty list rather than a 404,
  // exactly as the in-process source does — the caller has already decided this id's winning
  // tier is `builtin`, and inventing a distinction here would be a second contract to keep.
  app.get('/internal/foundational-services/:serviceId/contracts', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    const documents = c
      .get('container')
      .foundationalServiceRegistry.documentsFor(c.req.param('serviceId'))
    return c.json({ documents }, 200)
  })

  return app
}
