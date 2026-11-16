import { type Context, Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'

/**
 * `GET /internal/project-definitions`: the project definitions this deployment registers in
 * code, read by a mothership-mode node through `HttpRegisteredProjectDefinitionSource`. A run
 * resolves them, so the mothership owns them. Stored definitions travel over the persistence RPC.
 */
export function projectDefinitionsInternalController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const requireMachine = (c: Context<AppEnv>) => verifyMachineRequest(c)
  const forbidden = { error: { code: 'forbidden', message: 'invalid machine token' } } as const

  app.get('/internal/project-definitions', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    return c.json({ definitions: c.get('container').projectDefinitionRegistry.all() }, 200)
  })

  return app
}
