import { agentKindCapabilityViews } from '@cat-factory/agents'
import { Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'

/**
 * The mothership-mode AGENT-KIND CAPABILITY API: `GET /internal/agent-kinds`.
 *
 * The fourth application of the rule its three siblings established (`/internal/foundational-
 * services`, `/internal/binary-generators`, `/internal/prompt-fragments`): state a deployment
 * registers in CODE and a RUN resolves is org state, so in mothership mode the node reads it from
 * the mothership rather than from its own copy.
 *
 * What is DIFFERENT here, and the reason this endpoint serves a slice rather than a registry: an
 * agent kind is half data and half code. Its prompts may be functions, its `preOps`/`postOps` are
 * backend TypeScript and its structured output is a parser — none of which crosses a wire — so the
 * KIND CATALOG stays node-local, exactly like task types (ADR 0042) and the pipeline registry. That
 * split is safe because its failure is LOUD: a step naming a kind this build does not have is
 * refused at admission.
 *
 * The CAPABILITY layer is the half whose failure is silent, which is why it crosses. A deployment
 * attaches its house playbook or its issue-tracker MCP server to a BUILT-IN kind through
 * `assignSkills` / `assignToolServers`, and both are pure data (a `SKILL.md` payload; a transport
 * plus a credential's NAME). A node one build behind then dispatches `coder` without the org's
 * playbook and nothing anywhere says so: the agent does the work its own way, which reads exactly
 * like an agent that considered the standard and moved on.
 *
 * A DEDICATED `/internal/*` endpoint rather than an entry in the persistence allow-list (ADR 0009),
 * for the reason its siblings state: a registry is not a repository, holds no rows, and has nothing
 * account-shaped for a scope rule to bind. The set is one deployment-wide layer every workspace of
 * every account already resolves in full.
 *
 * Security mirrors `PersistenceController`: the `/internal` prefix bypasses the user-session gate,
 * so the audience-pinned machine token is checked here and a user session / ws ticket / container
 * token can never be replayed against it. The reply carries a credential's KEY NAME (never a
 * value), which is the one thing here that is not already on the wire to a workspace viewer; the
 * machine gate is what keeps it to the nodes the mothership provisioned, and the node's side of
 * that boundary (what it resolves such a key against) is the reserved-key floor its executor
 * already enforces.
 *
 * Reads `container.agentKindRegistry` — this process's OWN registry, never the resolved source, so
 * a satellite can never answer for a satellite and a mothership-of-a-mothership cannot loop.
 *
 * Mounted on BOTH facades via the shared controller registration. It never 503s: a deployment that
 * assigns no capabilities has an empty layer, which is a real and correct answer (the stock
 * product's). What must not read as empty is a failure to REACH it, and that is the client's half.
 */
export function agentKindsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/internal/agent-kinds', async (c) => {
    if (!(await verifyMachineRequest(c))) {
      return c.json({ error: { code: 'forbidden', message: 'invalid machine token' } }, 403)
    }
    return c.json({ kinds: agentKindCapabilityViews(c.get('container').agentKindRegistry) }, 200)
  })

  return app
}
