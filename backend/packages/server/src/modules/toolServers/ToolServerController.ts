import { listToolServersContract, probeToolServerContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermissionIncludingReads } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requestLogger } from '../../http/requestLogging.js'
import { collectDeclaredToolServers } from './declaredToolServers.js'
import { probeToolServer } from './probeToolServer.js'

/**
 * TOOL SERVER (MCP) OPERABILITY: what this deployment declared, and whether one of them answers.
 *
 * The read is the inventory nothing else provided. A tool server has four independent ways of not
 * reaching a run — no kind declares it, no harness can serve its transport, its credential does not
 * resolve, or the endpoint is dead — and before this surface each was visible somewhere else or
 * nowhere: the deployment's own source, a boot log line, a run's prompt. The probe settles the last
 * two for real, by resolving the credential through the same chain a dispatch uses and speaking the
 * protocol.
 *
 * `secrets.manage`-gated INCLUDING THE READ, via {@link requireWorkspacePermissionIncludingReads}
 * rather than the usual writes-only mount. The projection names the credential KEYS this
 * deployment's capabilities want, which is the same content the workspace snapshot deliberately
 * withholds from a viewer ("no business learning which environment variables the deployment sets"),
 * plus the endpoints those credentials are sent to. The probe needs the gate for a second reason: it
 * SPENDS an outbound request against a third party under the deployment's own credential, which is
 * not a read-tier capability whatever the response reveals.
 */
export function toolServerController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  // Mounted on this controller's OWN patterns rather than `'*'`, and both are needed (Hono's `*`
  // does not match the bare prefix). A `'*'` mount becomes `ALL /workspaces/:workspaceId/*` on the
  // shared app and would refuse every SIBLING controller's route registered after this one — which
  // is survivable for a writes-only gate and fatal for one that gates reads.
  const gate = requireWorkspacePermissionIncludingReads('secrets.manage')
  app.use('/tool-servers', gate)
  app.use('/tool-servers/*', gate)

  buildHonoRoute(app, listToolServersContract, (c) => {
    const container = c.get('container')
    return c.json(
      { servers: collectDeclaredToolServers({ agentKindRegistry: container.agentKindRegistry }) },
      200,
    )
  })

  buildHonoRoute(app, probeToolServerContract, async (c) => {
    const container = c.get('container')
    return c.json(
      await probeToolServer({
        agentKindRegistry: container.agentKindRegistry,
        workspaceId: param(c, 'workspaceId'),
        serverId: c.req.valid('param').id,
        // The composed chain, so the verdict is about THIS board's credentials. Absent when a facade
        // wired none, which the probe reports as `credentials_missing` — the same disposition the
        // dispatch path gives the same state.
        ...(container.toolSecretResolver
          ? { resolveToolSecrets: container.toolSecretResolver }
          : {}),
        logger: requestLogger(c),
      }),
      200,
    )
  })

  return app
}
