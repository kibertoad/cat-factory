import {
  createPromptFragmentSchema,
  linkFragmentSourceSchema,
  updatePromptFragmentSchema,
} from '@cat-factory/contracts'
import type { FragmentOwnerKind } from '@cat-factory/kernel'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { FragmentLibraryModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

type Scope = 'account' | 'workspace'

/** Resolve the fragment-library module or send a 503 when unconfigured. */
function requireLibrary(c: Context<AppEnv>): FragmentLibraryModule | null {
  return c.get('container').fragmentLibrary ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Prompt-fragment library is not configured' } },
    503,
  )

const sourcesUnavailable = (c: Context<AppEnv>) =>
  c.json(
    {
      error: {
        code: 'unavailable',
        message: 'Repo-sourced fragments require the GitHub integration to be configured',
      },
    },
    503,
  )

/**
 * The prompt-fragment library API (ADR 0006 §8), mounted twice — once under
 * `/accounts/:accountId` and once under `/workspaces/:workspaceId` — so a tier's
 * fragments and repo sources are managed at the scope that owns them. Workspace
 * routes are authorized by the global per-workspace gate in app.ts; account
 * routes guard on account membership here. The merged/resolved read (what an
 * agent actually sees) is workspace-only.
 */
export function fragmentLibraryController(scope: Scope): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const ownerId = (c: Context<AppEnv>) =>
    scope === 'account' ? param(c, 'accountId') : param(c, 'workspaceId')
  const ownerKind: FragmentOwnerKind = scope

  // Account-scoped routes are an authenticated concept: require sign-in and
  // membership in the addressed account (404 hides existence, mirroring boards).
  if (scope === 'account') {
    app.use('/prompt-fragments', accountGuard)
    app.use('/prompt-fragments/*', accountGuard)
    app.use('/fragment-sources', accountGuard)
    app.use('/fragment-sources/*', accountGuard)
  }

  // ---- fragments (this tier, raw — not merged) ----------------------------

  app.get('/prompt-fragments', async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    return c.json(await lib.libraryService.listTier(ownerKind, ownerId(c)))
  })

  app.post('/prompt-fragments', jsonBody(createPromptFragmentSchema), async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    const fragment = await lib.libraryService.create(ownerKind, ownerId(c), c.req.valid('json'))
    return c.json(fragment, 201)
  })

  app.patch(
    '/prompt-fragments/:fragmentId{.+}',
    jsonBody(updatePromptFragmentSchema),
    async (c) => {
      const lib = requireLibrary(c)
      if (!lib) return unavailable(c)
      const fragment = await lib.libraryService.update(
        ownerKind,
        ownerId(c),
        param(c, 'fragmentId'),
        c.req.valid('json'),
      )
      return c.json(fragment)
    },
  )

  app.delete('/prompt-fragments/:fragmentId{.+}', async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    await lib.libraryService.remove(ownerKind, ownerId(c), param(c, 'fragmentId'))
    return c.body(null, 204)
  })

  // ---- repo sources -------------------------------------------------------

  app.get('/fragment-sources', async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    return c.json(await lib.sourceService.list(ownerKind, ownerId(c)))
  })

  app.post('/fragment-sources', jsonBody(linkFragmentSourceSchema), async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    const source = await lib.sourceService.link(ownerKind, ownerId(c), c.req.valid('json'))
    return c.json(source, 201)
  })

  app.delete('/fragment-sources/:id', async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    await lib.sourceService.unlink(param(c, 'id'))
    return c.body(null, 204)
  })

  app.get('/fragment-sources/:id/status', async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    return c.json(await lib.sourceService.status(param(c, 'id')))
  })

  app.post('/fragment-sources/:id/sync', async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    return c.json(await lib.sourceService.sync(param(c, 'id')))
  })

  // ---- resolved (workspace only) — the merged catalog an agent sees -------

  if (scope === 'workspace') {
    app.get('/prompt-fragments/resolved', async (c) => {
      const lib = requireLibrary(c)
      if (!lib) return unavailable(c)
      return c.json(await lib.libraryService.resolvedCatalog(param(c, 'workspaceId')))
    })
  }

  return app
}

/** Guard an account-scoped request: require sign-in + membership (404 otherwise). */
async function accountGuard(c: Context<AppEnv>, next: () => Promise<void>) {
  const user = c.get('user')
  if (!user) {
    return c.json(
      { error: { code: 'unauthorized', message: 'Sign in to manage the library' } },
      401,
    )
  }
  // requireMember throws NotFoundError (→ 404) when the user isn't a member.
  await c.get('container').accountService.requireMember(param(c, 'accountId'), user.id)
  await next()
}
