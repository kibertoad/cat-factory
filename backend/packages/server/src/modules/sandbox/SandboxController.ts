import {
  archiveSandboxPromptContract,
  cloneSandboxPromptContract,
  createSandboxExperimentContract,
  createSandboxFixtureContract,
  getSandboxExperimentContract,
  launchSandboxExperimentContract,
  listSandboxExperimentsContract,
  listSandboxFixturesContract,
  listSandboxPromptsContract,
  removeSandboxFixtureContract,
  sandboxOverviewContract,
  saveSandboxPromptContract,
  setSandboxPromptLabelsContract,
} from '@cat-factory/contracts'
import type { SandboxModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'

/** Resolve the Sandbox module or send a 503, returning null when unconfigured. */
function requireSandbox<E extends AppEnv>(c: Context<E>): SandboxModule | null {
  return c.get('container').sandbox ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'The Sandbox is not configured' } }, 503)

/**
 * The Sandbox API (the parallel prompt/model testing surface): manage versioned prompt
 * candidates + the fixture library, define experiments (prompt × model × fixture), and
 * launch one to run + grade every cell. Opt-in: 503 when no Sandbox repositories are
 * wired. Mounted under `/workspaces/:workspaceId`.
 */
export function sandboxController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('integrations.manage'))

  // ---- overview -------------------------------------------------------------
  buildHonoRoute(app, sandboxOverviewContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const overview = await sandbox.service.overview(param(c, 'workspaceId'))
    // The catalog is exposed as `readonly` arrays; clone into the mutable shape the
    // contract response schema infers (the readonly-ness is a source-side detail only).
    return c.json(
      {
        ...overview,
        agentKinds: overview.agentKinds.map((kind) => ({
          ...kind,
          fixtureKinds: [...kind.fixtureKinds],
        })),
      },
      200,
    )
  })

  // ---- prompt versions ------------------------------------------------------
  buildHonoRoute(app, listSandboxPromptsContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const agentKind = c.req.valid('query').agentKind
    return c.json(await sandbox.service.listPrompts(param(c, 'workspaceId'), agentKind), 200)
  })

  buildHonoRoute(app, cloneSandboxPromptContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const version = await sandbox.service.clonePrompt(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(version, 201)
  })

  buildHonoRoute(app, saveSandboxPromptContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const version = await sandbox.service.saveVersion(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(version, 201)
  })

  buildHonoRoute(app, setSandboxPromptLabelsContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const version = await sandbox.service.setLabels(
      param(c, 'workspaceId'),
      c.req.valid('param').promptId,
      c.req.valid('json'),
    )
    return c.json(version, 200)
  })

  buildHonoRoute(app, archiveSandboxPromptContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    await sandbox.service.archivePrompt(param(c, 'workspaceId'), c.req.valid('param').promptId)
    return c.body(null, 204)
  })

  // ---- fixtures -------------------------------------------------------------
  buildHonoRoute(app, listSandboxFixturesContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(await sandbox.service.listFixtures(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createSandboxFixtureContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const fixture = await sandbox.service.createFixture(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(fixture, 201)
  })

  buildHonoRoute(app, removeSandboxFixtureContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    await sandbox.service.removeFixture(param(c, 'workspaceId'), c.req.valid('param').fixtureId)
    return c.body(null, 204)
  })

  // ---- experiments ----------------------------------------------------------
  buildHonoRoute(app, listSandboxExperimentsContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(await sandbox.service.listExperiments(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createSandboxExperimentContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    const experiment = await sandbox.service.createExperiment(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(experiment, 201)
  })

  buildHonoRoute(app, getSandboxExperimentContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(
      await sandbox.service.getExperiment(
        param(c, 'workspaceId'),
        c.req.valid('param').experimentId,
      ),
      200,
    )
  })

  // Run + grade every cell of the experiment, then return the full result grid.
  buildHonoRoute(app, launchSandboxExperimentContract, async (c) => {
    const sandbox = requireSandbox(c)
    if (!sandbox) return unavailable(c)
    return c.json(
      await sandbox.runService.launch(param(c, 'workspaceId'), c.req.valid('param').experimentId),
      200,
    )
  })

  return app
}
