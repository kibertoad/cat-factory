import { createWorkspaceSchema, renameWorkspaceSchema } from '@cat-factory/contracts'
import {
  configContributionCatalog,
  registeredAgentKinds,
  registeredKindRequiresContainer,
} from '@cat-factory/agents'
import { Hono } from 'hono'
import type { CustomAgentKind, WorkspaceSnapshot } from '@cat-factory/contracts'
import type { AgentRouting } from '@cat-factory/agents'
import type { ModelRef } from '@cat-factory/kernel'

/**
 * The agent config-contribution catalog for a snapshot: the descriptors contributed
 * across every agent kind used by the workspace's pipelines (deduped by id). Static
 * metadata derived from the agent registry; the board renders the subset whose
 * owning kind appears in a task's selected pipeline.
 */
function snapshotAgentConfigCatalog(snapshot: WorkspaceSnapshot) {
  const kinds = new Set<string>()
  for (const pipeline of snapshot.pipelines) for (const kind of pipeline.agentKinds) kinds.add(kind)
  return configContributionCatalog(kinds)
}

/**
 * The deployment's env-routing defaults as `provider:model` ref strings, so the
 * model-defaults panel can name the model behind "Deployment default" per kind.
 * Derived from the shared agents config, so identical across facades.
 */
/**
 * The registered CUSTOM agent kinds carrying frontend presentation metadata, mapped to
 * the wire shape the SPA merges into its palette catalog. Only kinds that declared a
 * `presentation` become first-class palette blocks; the rest stay engine-internal. Static
 * (process-global registry), so identical for every workspace and every facade. Returns
 * undefined when none are registered, so the field is simply absent on the stock product.
 */
function snapshotCustomAgentKinds(): CustomAgentKind[] | undefined {
  const kinds = registeredAgentKinds()
    .filter((def) => def.presentation)
    .map((def) => ({
      kind: def.kind,
      presentation: def.presentation!,
      container: registeredKindRequiresContainer(def.kind),
    }))
  return kinds.length > 0 ? kinds : undefined
}

function deploymentModelDefaults(routing: AgentRouting) {
  const ref = (r: ModelRef) => `${r.provider}:${r.model}`
  return {
    default: ref(routing.default.ref),
    byKind: Object.fromEntries(
      Object.entries(routing.byKind)
        .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] != null)
        .map(([kind, cfg]) => [kind, ref(cfg.ref)]),
    ),
  }
}
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** The signed-in user, narrowed to what the tenancy layer needs. */
function accountUser(c: Context<AppEnv>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

/** Board (workspace) lifecycle and full-snapshot retrieval. */
export function workspaceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Boards visible to the signed-in user: those in any account they belong to,
  // plus any legacy board they personally own. When auth is disabled (`user`
  // unset) the scope is null → no scoping (every board, dev behaviour).
  app.get('/workspaces', async (c) => {
    const container = c.get('container')
    const user = accountUser(c)
    if (!user) return c.json(await container.workspaceService.list(null))
    await container.accountService.ensurePersonalAccount(user)
    const accountIds = await container.accountService.accessibleAccountIds(user.id)
    return c.json(await container.workspaceService.list({ accountIds, ownerUserId: user.id }))
  })

  app.post('/workspaces', jsonBody(createWorkspaceSchema), async (c) => {
    const container = c.get('container')
    const user = accountUser(c)
    const body = c.req.valid('json')

    // Resolve the owning account: an explicit one the caller belongs to, else the
    // caller's personal account; unscoped when there's no signed-in user (dev).
    let accountId: string | null = null
    if (user) {
      if (body.accountId) {
        // Membership is required — a non-member is told the account doesn't exist.
        await container.accountService.requireMember(body.accountId, user.id)
        accountId = body.accountId
      } else {
        accountId = (await container.accountService.ensurePersonalAccount(user)).id
      }
    } else if (body.accountId) {
      accountId = body.accountId
    }

    const snapshot = await container.workspaceService.create(body, user?.id ?? null, accountId)
    const spend = await container.spendService.status(snapshot.workspace.id)
    const customAgentKinds = snapshotCustomAgentKinds()
    return c.json(
      {
        ...snapshot,
        spend,
        agentConfigCatalog: snapshotAgentConfigCatalog(snapshot),
        deploymentModelDefaults: deploymentModelDefaults(container.config.agents.routing),
        ...(customAgentKinds ? { customAgentKinds } : {}),
      },
      201,
    )
  })

  app.get('/workspaces/:workspaceId', async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const snapshot = await container.workspaceService.snapshot(workspaceId)
    const spend = await container.spendService.status(workspaceId)
    // Carry bootstrap runs in the snapshot so the board renders a bootstrap's live
    // progress / failure + retry the moment it loads (no separate, independently
    // failing fetch). No-op when the bootstrap module isn't configured.
    const bootstrapJobs = container.bootstrap
      ? await container.bootstrap.service.listJobs(workspaceId)
      : undefined
    // Open notifications + merge-preset library, so the board renders the inbox,
    // per-block badges and the task preset picker on load. No-ops when unconfigured.
    const notifications = container.notifications
      ? await container.notifications.service.listOpen(workspaceId)
      : undefined
    const mergePresets = container.mergePresets
      ? await container.mergePresets.service.list(workspaceId)
      : undefined
    // The workspace's model presets (the model→agent mapping library a task picks
    // from), so the board renders the Model Configuration settings + the per-task
    // preset picker on load. No-op when the module isn't configured. `list` seeds the
    // built-in presets (Kimi K2.7 default + GLM-5.2) on first read.
    const modelPresets = container.modelPresets
      ? await container.modelPresets.service.list(workspaceId)
      : undefined
    // The workspace's default service-fragment selection, so the board renders the
    // defaults settings on load. No-op when the module isn't configured.
    const serviceFragmentDefaults = container.serviceFragmentDefaults
      ? await container.serviceFragmentDefaults.service.get(workspaceId)
      : undefined
    // The workspace's recurring pipelines + issue-tracker selection, so the board
    // renders the recurring-task badges and the tracker config on load. No-ops when
    // the modules aren't configured. Run history is fetched lazily, not here.
    const recurringPipelines = container.recurring
      ? await container.recurring.service.list(workspaceId)
      : undefined
    const trackerSettings = container.tracker
      ? await container.tracker.service.get(workspaceId)
      : undefined
    // The workspace's runtime settings (human-wait escalation threshold + per-service
    // task limit), so the board renders the settings panel on load. No-op when unconfigured.
    const settings = container.settings
      ? await container.settings.service.get(workspaceId)
      : undefined
    // In-org shared services: the workspace's mounts + the org catalog it can mount from
    // (each catalog service annotated with its mount count for the "Shared" badge).
    const mounts = container.services
      ? await container.services.service.listMounts(workspaceId)
      : undefined
    const accountId = container.services
      ? await container.workspaceService.accountOf(workspaceId)
      : undefined
    const serviceCatalog =
      container.services && accountId !== undefined
        ? await container.services.service.listForAccount(accountId)
        : undefined
    const customAgentKinds = snapshotCustomAgentKinds()
    return c.json({
      ...snapshot,
      spend,
      ...(bootstrapJobs ? { bootstrapJobs } : {}),
      ...(notifications ? { notifications } : {}),
      ...(mergePresets ? { mergePresets } : {}),
      ...(modelPresets ? { modelPresets } : {}),
      ...(serviceFragmentDefaults ? { serviceFragmentDefaults } : {}),
      ...(recurringPipelines ? { recurringPipelines } : {}),
      ...(trackerSettings ? { trackerSettings } : {}),
      ...(settings ? { settings } : {}),
      ...(mounts ? { mounts } : {}),
      ...(serviceCatalog ? { serviceCatalog } : {}),
      agentConfigCatalog: snapshotAgentConfigCatalog(snapshot),
      deploymentModelDefaults: deploymentModelDefaults(container.config.agents.routing),
      ...(customAgentKinds ? { customAgentKinds } : {}),
    })
  })

  app.patch('/workspaces/:workspaceId', jsonBody(renameWorkspaceSchema), async (c) => {
    const body = c.req.valid('json')
    const workspace = await c.get('container').workspaceService.update(param(c, 'workspaceId'), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...('description' in body ? { description: body.description } : {}),
    })
    return c.json(workspace)
  })

  app.delete('/workspaces/:workspaceId', async (c) => {
    await c.get('container').workspaceService.delete(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
