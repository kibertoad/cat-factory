import {
  connectTaskSourceContract,
  createTaskFromIssueContract,
  diagnoseTaskSourceContract,
  disconnectTaskSourceContract,
  getLinearInstallUrlContract,
  importTaskContract,
  linkTaskContract,
  listLinearTeamsContract,
  listTaskConnectionsContract,
  listTaskSourcesContract,
  listTasksContract,
  searchTasksContract,
  setTaskSourceEnabledContract,
  spawnEpicContract,
  taskSourceKindSchema,
  type TaskSourceKind,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { ValidationError, type TaskSearchRepoScope } from '@cat-factory/kernel'
import type { TasksModule } from '@cat-factory/orchestration'
import type { AppConfig } from '../../config/types.js'
import { LinearOAuth } from '../../auth/LinearOAuth.js'
import { StateSigner } from '../../github/state.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the tasks module or send a 503, returning null when unconfigured. */
function requireTasks<E extends AppEnv>(c: Context<E>): TasksModule | null {
  return c.get('container').tasks ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Task-source integration is not configured' } },
    503,
  )

/**
 * The Linear OAuth redirect_uri: the configured value, else derived from the request
 * origin (mirrors the Google login flow). MUST be identical at authorize + token
 * exchange + the registered Linear app, so both call sites resolve it through here.
 */
function linearCallbackUrl<E extends AppEnv>(c: Context<E>, cfg: AppConfig): string {
  const explicit = cfg.tasks.linearOAuth?.redirectUrl
  if (explicit) return explicit
  return `${new URL(c.req.url).origin}/tasks/oauth/callback`
}

/** Read + validate the `:source` path param as a known source kind. */
function sourceParam<E extends AppEnv>(c: Context<E>): TaskSourceKind {
  const source = param(c, 'source')
  if (!v.is(taskSourceKindSchema, source)) {
    throw new ValidationError(`Unknown task source '${source}'`)
  }
  return source
}

/**
 * Resolve the repo a GitHub-issue search runs against from its originating block
 * (a service frame or a task/module under one). A service is always created from
 * (or with) a repo, so a GitHub search scoped to a block REQUIRES the link — if it
 * can't be resolved we refuse the search rather than silently widening it to the
 * whole installation (the task couldn't run against an unlinked service anyway).
 * Repo-less sources (Jira) and the unscoped "import an issue" surface (no blockId)
 * skip this entirely.
 */
async function resolveSearchScope<E extends AppEnv>(
  c: Context<E>,
  source: TaskSourceKind,
  blockId: string | undefined,
): Promise<TaskSearchRepoScope | undefined> {
  if (!blockId || source !== 'github') return undefined
  const resolve = c.get('container').resolveRepoTarget
  let target: Awaited<ReturnType<NonNullable<typeof resolve>>> = null
  try {
    target = resolve ? await resolve(param(c, 'workspaceId'), blockId) : null
  } catch (err) {
    // `resolveRepoTarget` throws a ValidationError precisely when the block isn't under a
    // repo-linked service — the case this endpoint refuses below. Anything else (an
    // unexpected repo/DB failure) is NOT a "link a repo" problem, so let it propagate
    // rather than mislabel it; only the documented not-linked outcome falls through.
    if (!(err instanceof ValidationError)) throw err
    target = null
  }
  if (!target) {
    throw new ValidationError(
      'This service is not linked to a GitHub repository. Link it to a repo before creating tasks from issues.',
    )
  }
  return { owner: target.owner, repo: target.name }
}

/**
 * Workspace-scoped, source-parameterized task endpoints: source discovery,
 * connection management, issue import, issue listing, and linking an issue to a
 * block as agent context. Mounted under `/workspaces/:workspaceId`.
 */
export function taskSourceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- source discovery ---------------------------------------------------

  // The configured sources + their connect/import metadata AND the workspace's
  // per-source state (available + enabled), which drives the settings + import UI.
  // A 503 here is how the frontend learns the integration is off.
  buildHonoRoute(app, listTaskSourcesContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const sources = await tasks.connectionService.listSourceStates(param(c, 'workspaceId'))
    return c.json({ sources }, 200)
  })

  // Enable or disable a source for the workspace (the per-workspace toggle). A
  // credentialed source (Jira) must be connected first to be worth toggling; a
  // credentialless one (GitHub Issues) is offered with the GitHub App and toggled
  // off here when a workspace wants repos without issues.
  buildHonoRoute(app, setTaskSourceEnabledContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    await tasks.connectionService.setEnabled(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').enabled,
    )
    return c.body(null, 204)
  })

  // ---- connections --------------------------------------------------------

  buildHonoRoute(app, listTaskConnectionsContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const connections = await tasks.connectionService.listConnections(param(c, 'workspaceId'))
    return c.json({ connections }, 200)
  })

  buildHonoRoute(app, connectTaskSourceContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const connection = await tasks.connectionService.connect(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').credentials,
    )
    return c.json(connection, 201)
  })

  buildHonoRoute(app, disconnectTaskSourceContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    await tasks.connectionService.disconnect(param(c, 'workspaceId'), sourceParam(c))
    return c.body(null, 204)
  })

  // Live "check setup" probe: actually authenticate against the source and read a
  // slice of its issues API, returning a classified verdict (ready / not installed
  // / not connected / auth failed / missing permission / unreachable) so the UI can
  // tell a configured-but-broken source from a working one. POST (it performs a
  // live external call), no body — the source is the path param.
  buildHonoRoute(app, diagnoseTaskSourceContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const diagnostic = await tasks.connectionService.diagnose(
      param(c, 'workspaceId'),
      sourceParam(c),
    )
    return c.json(diagnostic, 200)
  })

  // ---- Linear-specific ----------------------------------------------------

  // List the connection's Linear teams, so the ticket-filing settings can offer a
  // team picker instead of a raw team-id paste. 409 when Linear isn't connected.
  buildHonoRoute(app, listLinearTeamsContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const teams = await tasks.connectionService.listLinearTeams(param(c, 'workspaceId'))
    return c.json({ teams }, 200)
  })

  // The "Connect with Linear" authorize URL, carrying an HMAC-signed `state` that binds
  // the install to this workspace + user with a short expiry. 503 when Linear OAuth
  // isn't configured (the manual API-key paste is then the way to connect).
  buildHonoRoute(app, getLinearInstallUrlContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const cfg = c.get('container').config
    const oauth = cfg.tasks.linearOAuth
    if (!oauth) {
      return c.json(
        { error: { code: 'unavailable', message: 'Linear OAuth is not configured' } },
        503,
      )
    }
    const workspaceId = param(c, 'workspaceId')
    const signer = new StateSigner(cfg.auth.sessionSecret)
    const state = await signer.sign({
      workspaceId,
      userId: c.get('user')?.id ?? null,
      exp: Date.now() + 10 * 60 * 1000,
    })
    const url = new LinearOAuth({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
    }).authorizeUrl({ redirectUri: linearCallbackUrl(c, cfg), state })
    return c.json({ url }, 200)
  })

  // ---- issues -------------------------------------------------------------

  buildHonoRoute(app, listTasksContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    return c.json(await tasks.importService.listTasks(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, importTaskContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const task = await tasks.importService.import(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').ref,
    )
    return c.json(task, 201)
  })

  // Search a tracker's issues by free text (title/content), returning lean hits
  // the picker can import + link on selection.
  buildHonoRoute(app, searchTasksContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const source = sourceParam(c)
    const { query, blockId } = c.req.valid('json')
    const scope = await resolveSearchScope(c, source, blockId)
    const results = await tasks.importService.search(param(c, 'workspaceId'), source, query, scope)
    return c.json({ results }, 200)
  })

  // ---- context links ------------------------------------------------------

  // Attach an imported issue to a block as extra agent context.
  buildHonoRoute(app, linkTaskContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const { source, externalId, blockId } = c.req.valid('json')
    const task = await tasks.linkService.linkToBlock(
      param(c, 'workspaceId'),
      blockId,
      source,
      externalId,
    )
    return c.json(task, 201)
  })

  // Materialise an imported issue as a new board task inside a container, linking
  // the issue to it for context. Returns the created block + the linked issue.
  buildHonoRoute(app, createTaskFromIssueContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const { source, externalId, containerId } = c.req.valid('json')
    const result = await tasks.linkService.createTaskFromIssue(
      param(c, 'workspaceId'),
      containerId,
      source,
      externalId,
      c.get('user')?.id ?? null,
    )
    return c.json(result, 201)
  })

  // Spawn an epic + its children: create an epic node, materialise each child issue as a
  // board task inside the container (joined to the epic), and seed dependsOn edges from
  // the issues' blocked-by/depends-on links. Returns the epic node + the created tasks.
  buildHonoRoute(app, spawnEpicContract, async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const { ref, containerId, position } = c.req.valid('json')
    const result = await tasks.linkService.spawnEpic(
      param(c, 'workspaceId'),
      sourceParam(c),
      ref,
      containerId,
      c.get('user')?.id ?? null,
      position,
    )
    return c.json(result, 201)
  })

  return app
}

/**
 * Public Linear OAuth callback (Linear redirects the browser here with `?code&state`,
 * so it can't be workspace-scoped or session-gated; the `state` is HMAC-verified).
 * Mounted at `/tasks`. Mirrors the Slack `/slack/oauth/callback` flow: the token
 * exchange happens here (the server holds the OAuth secret) and the resulting access
 * token is handed to the connection service to store as a `{ token }` connection.
 */
export function linearOAuthController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/oauth/callback', async (c) => {
    const container = c.get('container')
    const tasks = container.tasks
    if (!tasks) return unavailable(c)
    const oauth = container.config.tasks.linearOAuth
    if (!oauth) return unavailable(c)

    const code = c.req.query('code')
    if (!code) {
      return c.json({ error: { code: 'validation', message: 'Missing code' } }, 400)
    }
    const signer = new StateSigner(container.config.auth.sessionSecret)
    const state = await signer.verify(c.req.query('state') ?? null)
    if (!state) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired state' } }, 401)
    }

    const token = await new LinearOAuth({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
    }).exchangeCode(code, linearCallbackUrl(c, container.config))
    await tasks.connectionService.connectLinearViaOAuth(state.workspaceId, token)
    // Land back on the app (reuse the GitHub setup redirect target as the app URL).
    return c.redirect(container.config.github.setupRedirectUrl || '/')
  })

  return app
}
