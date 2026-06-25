import {
  cloneSandboxPromptSchema,
  createSandboxExperimentSchema,
  createSandboxFixtureSchema,
  saveSandboxVersionSchema,
  setSandboxLabelsSchema,
} from '@cat-factory/contracts'
import type { SandboxModule } from '@cat-factory/orchestration'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the Sandbox module or send a 503, returning null when unconfigured. */
function requireSandbox(c: Context<AppEnv>): SandboxModule | null {
  return c.get('container').sandbox ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'The Sandbox is not configured' } }, 503)

/**
 * The Sandbox API (the parallel prompt/model testing surface): manage versioned prompt
 * candidates + the fixture library, define experiments (prompt × model × fixture), and
 * launch one to run + grade every cell. Opt-in: 503 when no Sandbox repositories are
 * wired. Mounted under `/workspaces/:workspaceId`.
 */
export function sandboxController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- overview -------------------------------------------------------------
  app.get('/sandbox/overview', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(await sandbox.service.overview(param(c, 'workspaceId')))
  })

  // ---- prompt versions ------------------------------------------------------
  app.get('/sandbox/prompts', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const agentKind = c.req.query('agentKind')
    return c.json(await sandbox.service.listPrompts(param(c, 'workspaceId'), agentKind))
  })

  app.post('/sandbox/prompts/clone', jsonBody(cloneSandboxPromptSchema), async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const version = await sandbox.service.clonePrompt(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(version, 201)
  })

  app.post('/sandbox/prompts', jsonBody(saveSandboxVersionSchema), async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const version = await sandbox.service.saveVersion(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(version, 201)
  })

  app.patch('/sandbox/prompts/:promptId/labels', jsonBody(setSandboxLabelsSchema), async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const version = await sandbox.service.setLabels(
      param(c, 'workspaceId'),
      param(c, 'promptId'),
      c.req.valid('json'),
    )
    return c.json(version)
  })

  app.delete('/sandbox/prompts/:promptId', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    await sandbox.service.archivePrompt(param(c, 'workspaceId'), param(c, 'promptId'))
    return c.body(null, 204)
  })

  // ---- fixtures -------------------------------------------------------------
  app.get('/sandbox/fixtures', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(await sandbox.service.listFixtures(param(c, 'workspaceId')))
  })

  app.post('/sandbox/fixtures', jsonBody(createSandboxFixtureSchema), async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const fixture = await sandbox.service.createFixture(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(fixture, 201)
  })

  app.delete('/sandbox/fixtures/:fixtureId', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    await sandbox.service.removeFixture(param(c, 'workspaceId'), param(c, 'fixtureId'))
    return c.body(null, 204)
  })

  // ---- experiments ----------------------------------------------------------
  app.get('/sandbox/experiments', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(await sandbox.service.listExperiments(param(c, 'workspaceId')))
  })

  app.post('/sandbox/experiments', jsonBody(createSandboxExperimentSchema), async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const experiment = await sandbox.service.createExperiment(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(experiment, 201)
  })

  app.get('/sandbox/experiments/:experimentId', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(
      await sandbox.service.getExperiment(param(c, 'workspaceId'), param(c, 'experimentId')),
    )
  })

  // Run + grade every cell of the experiment, then return the full result grid.
  app.post('/sandbox/experiments/:experimentId/launch', async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(
      await sandbox.runService.launch(param(c, 'workspaceId'), param(c, 'experimentId')),
    )
  })

  return app
}
