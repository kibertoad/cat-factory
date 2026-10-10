import { type Context, Hono } from 'hono'
import type { DocumentSourceKind } from '@cat-factory/kernel'
import { describeError } from '@cat-factory/kernel'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import { requestLogger } from '../../http/requestLogging.js'
import type { AppEnv } from '../../http/env.js'

/**
 * The mothership-mode PROMPT-FRAGMENT pool API: `GET /internal/prompt-fragments`.
 *
 * The third `/internal/*` endpoint of the same family (see `FoundationalBuiltinsController` for the
 * full reasoning, which is identical). A mothership deployment is TWO processes: the hosted
 * mothership owns the org state, a local node with no main database runs the engine. The
 * deployment's best-practice standards are CODE, so they did not cross the machine API at all, and
 * a node one build behind the mothership is the normal state of running a pair. The run then folds
 * a standard the pipeline builder never offered, or folds nothing where the mothership has one,
 * which reads to a reviewer exactly like an org that never wrote the standard down.
 *
 * It answers BOTH projections in one payload rather than two routes: the pool and the
 * per-task-type default SETS are two independent registrations (a default set may name a
 * tenant-tier id that exists only as a row), but they are small, they are read on the same cadence,
 * and a node needing two round-trips to answer one question is how the two halves drift.
 *
 * Reads `container.promptFragmentRegistry`, this process's OWN registry, never the resolved
 * source, which on a node is remote. So a satellite can never answer for another satellite, and a
 * mothership-of-a-mothership cannot loop.
 *
 * Like its `/internal` siblings the security is the audience-pinned machine token (the `/internal`
 * prefix bypasses the user-session gate) with no account scope check, because there is nothing
 * account-shaped to check: the pool is one deployment-wide set with no owner, and every workspace
 * already resolves all of it through the ordinary catalog read. And like them it never 503s: a
 * deployment that registers nothing has an EMPTY pool, which is a real and correct answer. What
 * must never read as empty is a FAILURE to reach it, which is the client's half of the contract.
 */
export function promptFragmentsInternalController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const requireMachine = (c: Context<AppEnv>) => verifyMachineRequest(c)
  const forbidden = { error: { code: 'forbidden', message: 'invalid machine token' } } as const

  app.get('/internal/prompt-fragments', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    const registry = c.get('container').promptFragmentRegistry
    // The default sets are serialised as a plain map keyed by task type, built by asking the
    // registry for each type it actually carries one for. Enumerating `TASK_TYPES` and emitting
    // empty arrays would put the ABSENCE of a registration and a registration OF nothing on the
    // wire as the same value, and those are different facts to the reduction that reads them.
    const taskTypeDefaults: Record<string, string[]> = {}
    for (const taskType of registry.taskTypesWithDefaults()) {
      taskTypeDefaults[taskType] = registry.defaultFragmentIdsFor(taskType)
    }
    return c.json({ fragments: registry.all(), taskTypeDefaults }, 200)
  })

  // The DEPLOYMENT-scoped document read: the live body behind a code-registered fragment's
  // `documentRef`, resolved HERE because the credentials that authenticate it live in the
  // mothership's environment and never reach a node (the same sealed-secret rule that keeps a
  // decrypting repository off the remote route). The node reads the resolved BODY.
  //
  // Its own route rather than a field on the pool read above, which is the split
  // `/internal/foundational-services/contracts` already makes and for the identical reason: the
  // pool is read on every catalog miss and a document fetch is a call to an external vendor, so
  // folding bodies into it would make one unreachable page fail the read of every standard, most
  // of which no run names. A POST because the input is a LIST.
  //
  // Absent from the reply means "this deployment cannot resolve that ref", which the node
  // renders as the fragment's registered body. That is the same disposition a non-mothership
  // deployment reaches locally, so the two topologies degrade identically.
  app.post('/internal/prompt-fragments/document-bodies', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    const container = c.get('container')
    const body = (await c.req.json().catch(() => null)) as { refs?: unknown } | null
    const requested = Array.isArray(body?.refs) ? body.refs : []
    const resolver = container.deploymentDocumentResolver
    // What a fragment DECLARES is the whole admissible set, and intersecting against it is the
    // difference between this route and a general read proxy into the deployment's document estate.
    // The credentials it spends are central, and a machine token is held by every provisioned node,
    // so without this a node could name any page in the deployment's Notion/Confluence and be
    // served it. The node has no reason to ask for anything else either: it is reading the bodies
    // behind THIS pool, which it just read from the sibling route.
    //
    // It is also what BOUNDS the work. The caller's list is caller-controlled and each miss would
    // otherwise be a live vendor call; after the intersection the batch can be no larger than the
    // number of distinct documents this deployment registered, whatever was posted.
    const declared = declaredDocumentRefs(container.promptFragmentRegistry)
    const wanted = new Map<string, { source: DocumentSourceKind; externalId: string }>()
    for (const raw of requested) {
      const ref = raw as { source?: unknown; externalId?: unknown } | null
      if (!ref || typeof ref.source !== 'string' || typeof ref.externalId !== 'string') continue
      const key = documentBodyRefKey(ref.source, ref.externalId)
      const admissible = declared.get(key)
      if (!admissible) continue
      if (!resolver?.configured(admissible.source)) continue
      wanted.set(key, admissible)
    }
    const bodies: Record<string, { body: string; version: string }> = {}
    // SEQUENTIAL deliberately, now that the count is bounded by the deployment's own registrations
    // rather than by the caller: these are external vendor calls against ONE central credential, and
    // fanning a pool's worth of them out concurrently is how a deployment rate-limits itself out of
    // every node's read at once.
    for (const ref of wanted.values()) {
      try {
        const content = await resolver!.fetch(ref.source, ref.externalId)
        bodies[documentBodyRefKey(ref.source, ref.externalId)] = {
          body: content.body,
          version: content.version,
        }
      } catch (error) {
        // Omitted rather than 500: one unreachable page must not cost the caller every OTHER
        // body in the same batch, and the node's own disposition for an unresolvable document is
        // already "serve the registered body". Logged here because this is the only process that
        // can see WHY, the node having neither the credential nor the vendor's answer.
        requestLogger(c).warn(
          'A deployment-scoped document could not be resolved for a node; the node will fold the ' +
            'registered body instead, which may be stale',
          { source: ref.source, ...describeError(error) },
        )
      }
    }
    return c.json({ bodies }, 200)
  })

  return app
}

/**
 * Every document ref a fragment in this process's own registry declares, keyed for lookup.
 *
 * Read off `promptFragmentRegistry` (the mothership's CODE registrations) rather than off any
 * request input, which is what makes it an authority rather than an echo. Keyed by the same
 * function the reply is keyed by, so an admissible ref and a returned body cannot disagree about
 * what identifies a document.
 */
function declaredDocumentRefs(
  registry:
    | { all(): { documentRef?: { source: DocumentSourceKind; externalId: string } }[] }
    | undefined,
): Map<string, { source: DocumentSourceKind; externalId: string }> {
  const declared = new Map<string, { source: DocumentSourceKind; externalId: string }>()
  for (const fragment of registry?.all() ?? []) {
    const ref = fragment.documentRef
    if (!ref) continue
    declared.set(documentBodyRefKey(ref.source, ref.externalId), ref)
  }
  return declared
}

/**
 * The key one resolved body is returned under: `<source>:<externalId>`.
 *
 * Exported so the client indexes the reply with the same function the server built it with. The
 * pair is what identifies a document (an external id is only unique within its source), and a
 * batch reply keyed by anything the caller has to reconstruct is a reply the caller can silently
 * mis-index.
 */
export function documentBodyRefKey(source: string, externalId: string): string {
  return `${source}:${externalId}`
}
