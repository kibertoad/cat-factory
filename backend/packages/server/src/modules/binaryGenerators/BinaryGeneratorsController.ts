import { type Context, Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'

/**
 * The mothership-mode GENERATIVE BINARY INTEGRATIONS API:
 * `GET /internal/binary-generators` and `POST /internal/binary-generators/contracts`.
 *
 * The sibling of `FoundationalBuiltinsController`, for the same reason and with the same
 * properties. A mothership deployment is TWO processes — the hosted mothership serves the
 * pipeline builder that SELECTS an integration, a local node with no main database resolves that
 * selection for the runs it dispatches — and the registry is CODE, so it did not cross the
 * machine API at all. A deployment therefore had to register its integrations on both entry
 * points, and the two copies were equal only while both imported the same package at the same
 * commit.
 *
 * What that skew produced here is a refusal rather than an omission, and a MISATTRIBUTED one:
 * a step configured through the product's own picker (fed by the mothership's registry) is
 * refused at admission by the node with `unknown_generator`, naming a configuration that is
 * correct. This endpoint makes a deployment's integrations org state the mothership OWNS, like
 * every other org fact a node reads remotely.
 *
 * A DEDICATED `/internal/*` endpoint rather than an entry in the persistence allow-list (ADR
 * 0009), for the reason its sibling states: the registry is not a repository, holds no rows, and
 * has nothing account-shaped for a scope rule to bind.
 *
 * Security mirrors `PersistenceController`: the `/internal` prefix bypasses the user-session
 * gate, so the audience-pinned machine token is checked here and a user session / ws ticket /
 * container token can never be replayed against it. There is deliberately no account scope
 * check beyond that — the registry is one deployment-wide set with no owner, and every workspace
 * of every account already resolves all of it through the ordinary snapshot read.
 *
 * The reply carries a credential's KEY NAME (never a value), which is the one thing here that is
 * not already on the wire to a workspace viewer — the snapshot projection omits it deliberately.
 * The machine gate is what keeps it to the nodes the mothership provisioned; the node's side of
 * that boundary (what it will resolve such a key against) is documented on
 * `../../persistence/binaryGenerators.ts`.
 *
 * Both routes read `container.binaryGeneratorRegistry` — this process's OWN registry, never the
 * resolved source, which on a node is remote. So a satellite can never answer for another
 * satellite, and a mothership-of-a-mothership cannot loop.
 *
 * Mounted on BOTH facades via the shared controller registration, so either a Node or a
 * Cloudflare deployment can be a mothership. It never 503s: a deployment that registers no
 * integrations has an EMPTY registry, which is a real and correct answer — the stock product's
 * answer, in fact. (What must not read as empty is a failure to REACH it; that is the client's
 * half of the contract.)
 */
export function binaryGeneratorsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** The machine-token gate, shared by both routes. Returns the payload, or null after replying. */
  const requireMachine = (c: Context<AppEnv>) => verifyMachineRequest(c)
  const forbidden = { error: { code: 'forbidden', message: 'invalid machine token' } } as const

  // The engine projection: identity, content types, endpoint, credential DECLARATION and
  // contract manifests for every registered integration — never a document body, which the
  // brief renderer fetches below for exactly the ids a step selected.
  app.get('/internal/binary-generators', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    return c.json({ generators: c.get('container').binaryGeneratorRegistry.views() }, 200)
  })

  // The lazy half: the FULL documents for exactly the ids a step selected, in ONE read. A POST
  // because the input is a LIST — the same reason `/internal/persistence` is one — which also
  // keeps the route off the `:generatorId` namespace a per-id path would have created (a
  // generator id is a lower-kebab slug that could legitimately be `contracts`).
  //
  // An id the registry does not know is simply ABSENT from the reply rather than a 404: the
  // caller has already resolved which ids it wants, and a batch read cannot 404 for one member.
  app.post('/internal/binary-generators/contracts', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : []
    const registry = c.get('container').binaryGeneratorRegistry
    const documents: Record<string, unknown[]> = {}
    // A per-id loop is correct HERE and only here: on the mothership the projection is in
    // memory, so this is a `Map` lookup per id and not the I/O the batching exists to avoid.
    for (const id of ids) documents[id] = registry.documentsFor(id)
    return c.json({ documents }, 200)
  })

  return app
}
