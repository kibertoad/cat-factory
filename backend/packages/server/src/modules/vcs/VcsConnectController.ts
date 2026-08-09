import { listVcsConnectOptionsContract, type VcsConnectOption } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermissionIncludingReads } from '../../http/workspaceAccess.js'

/**
 * Provider-neutral VCS connect capability: which connect surfaces this deployment can actually
 * serve. The `github` module builds for EITHER a GitHub App or a per-workspace GitLab PAT
 * connect, so the connection reads alone can't tell the SPA whether to render the App
 * installation picker, the PAT box, both, or neither — this route is that single signal
 * (see `listVcsConnectOptionsContract`).
 *
 * Capability only: it reports what CAN be connected, never what IS connected (that stays
 * `GET /github/connection`, whose `provider` discriminator the SPA switches presentation on).
 * Guarded by `integrations.manage`, exactly like the GitHub + GitLab connect controllers it
 * fronts, because a caller who may not connect has no use for the option list.
 *
 * That takes the INCLUDING-READS mount, and this controller is the one place where the writes-only
 * variant is provably inert rather than merely lenient: the single route it serves is a GET, which
 * that variant passes through, so `integrations.manage` here gated nothing whatsoever. It read as
 * enforcement for a release because the wholesale `'*'` mount it used to share DID refuse callers,
 * just on sibling controllers' routes instead of its own. Both halves of the SPA already expect the
 * refusal: `loadConnectOptions` degrades a 403 to an empty option list, under a store test that
 * names a member without `integrations.manage` as the caller it is modelling.
 */
export function vcsConnectController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermissionIncludingReads(app, 'integrations.manage', ['/vcs'])

  buildHonoRoute(app, listVcsConnectOptionsContract, (c) => {
    const container = c.get('container')
    const options: VcsConnectOption[] = []
    // The GitHub App connect needs BOTH the App configured and the module built: `enabled` is
    // the deployment gate, and a GitLab-only deployment still builds the module (with the GitLab
    // client), so neither check alone implies an installable App.
    // The host each option would bind to rides the option, because the surfaces that need it
    // render before anything is connected (the PAT box's "create a token" link, bootstrap's
    // "create a repository" button) and so have no connection to read it off. Same value the
    // connection carries once bound: both come from `CoreDependencies.vcsWebUrls`.
    const webUrls = container.vcsWebUrls ?? {}
    if (container.config.github.enabled && container.github) {
      options.push({ provider: 'github', method: 'app', webUrl: webUrls.github ?? null })
    }
    // The per-workspace PAT connect is wired iff the facade built a connect service; it names
    // the provider it serves, so this stays neutral as further PAT providers register.
    const vcs = container.vcsConnectionService
    if (vcs) {
      options.push({ provider: vcs.provider, method: 'pat', webUrl: webUrls[vcs.provider] ?? null })
    }
    return c.json({ options }, 200)
  })

  return app
}
