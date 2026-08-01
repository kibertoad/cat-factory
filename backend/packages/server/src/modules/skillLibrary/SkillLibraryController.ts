import {
  linkSkillSourceContract,
  listAccountSkillsContract,
  listSkillSourcesContract,
  skillSourceStatusContract,
  syncSkillSourceContract,
  unlinkSkillSourceContract,
} from '@cat-factory/contracts'
import type { SkillLibraryModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability, requireUser } from '../../http/guards.js'

/** Resolve the skill-library module or send a 503 when unconfigured. */
function requireLibrary<E extends AppEnv>(c: Context<E>): SkillLibraryModule {
  return requireCapability(
    c.get('container').skillLibrary,
    'The Claude Skills library is not configured',
  )
}

/**
 * The repo-source service, wired only when the GitHub integration is too — a SECOND capability
 * behind the same module, so it gets its own accessor rather than a guard restated at each of
 * the five source routes.
 */
function requireSources<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    requireLibrary(c).sourceService,
    'Repo-sourced skills require the GitHub integration to be configured',
  )
}

/**
 * The repo-sourced Claude Skills library API (ADR 0024).
 * Skills live in ONE tier (the account, shared across its workspaces), so — unlike
 * the fragment library — this is mounted only under `/accounts/:accountId`. Routes
 * are guarded by account membership (404 hides existence, mirroring boards). The
 * skill catalog itself is a plain account read; linking/syncing repo sources needs
 * the GitHub integration.
 */
export function skillLibraryController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const accountId = <E extends AppEnv>(c: Context<E>) => param(c, 'accountId')

  app.use('/skills', accountGuard)
  app.use('/skill-sources', accountGuard)
  app.use('/skill-sources/*', accountGuard)

  // ---- the account skill catalog ------------------------------------------

  buildHonoRoute(app, listAccountSkillsContract, async (c) => {
    const lib = requireLibrary(c)
    return c.json(await lib.catalogService.list(accountId(c)), 200)
  })

  // ---- repo sources -------------------------------------------------------

  buildHonoRoute(app, listSkillSourcesContract, async (c) => {
    const sources = requireSources(c)
    return c.json(await sources.list(accountId(c)), 200)
  })

  buildHonoRoute(app, linkSkillSourceContract, async (c) => {
    const sources = requireSources(c)
    const source = await sources.link(accountId(c), c.req.valid('json'))
    return c.json(source, 201)
  })

  buildHonoRoute(app, unlinkSkillSourceContract, async (c) => {
    const sources = requireSources(c)
    await sources.unlink(accountId(c), c.req.valid('param').id)
    return c.body(null, 204)
  })

  buildHonoRoute(app, skillSourceStatusContract, async (c) => {
    const sources = requireSources(c)
    return c.json(await sources.status(accountId(c), c.req.valid('param').id), 200)
  })

  buildHonoRoute(app, syncSkillSourceContract, async (c) => {
    const sources = requireSources(c)
    return c.json(await sources.sync(accountId(c), c.req.valid('param').id), 200)
  })

  return app
}

/** Guard an account-scoped request: require sign-in + membership (404 otherwise). */
async function accountGuard(c: Context<AppEnv>, next: () => Promise<void>) {
  const user = requireUser(c, 'Sign in to manage the skill library')
  // requireMember throws NotFoundError (→ 404) when the user isn't a member.
  await c.get('container').accountService.requireMember(param(c, 'accountId'), user.id)
  await next()
}
