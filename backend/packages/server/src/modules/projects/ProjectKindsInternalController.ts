import { type Context, Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'

/**
 * `GET /internal/project-kinds`: the project kinds this deployment registers, read by a
 * mothership-mode node through `HttpProjectKindSource`. Kinds are registered in code and resolved
 * when a project is created or a task is admitted under one, so the mothership owns them.
 */
export function projectKindsInternalController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const requireMachine = (c: Context<AppEnv>) => verifyMachineRequest(c)
  const forbidden = { error: { code: 'forbidden', message: 'invalid machine token' } } as const

  app.get('/internal/project-kinds', async (c) => {
    if (!(await requireMachine(c))) return c.json(forbidden, 403)
    return c.json({ kinds: c.get('container').projectKindRegistry.all() }, 200)
  })

  return app
}
