import { type Context, Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
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

  return app
}
