import { listVcsConnectOptionsContract, type VcsConnectOption } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'

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
 * fronts — a caller who may not connect has no use for the option list.
 */
export function vcsConnectController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', ['/vcs'])

  buildHonoRoute(app, listVcsConnectOptionsContract, (c) => {
    const container = c.get('container')
    const options: VcsConnectOption[] = []
    // The GitHub App connect needs BOTH the App configured and the module built: `enabled` is
    // the deployment gate, and a GitLab-only deployment still builds the module (with the GitLab
    // client), so neither check alone implies an installable App.
    if (container.config.github.enabled && container.github) {
      options.push({ provider: 'github', method: 'app' })
    }
    // The per-workspace PAT connect is wired iff the facade built a connect service; it names
    // the provider it serves, so this stays neutral as further PAT providers register.
    const vcs = container.vcsConnectionService
    if (vcs) options.push({ provider: vcs.provider, method: 'pat' })
    return c.json({ options }, 200)
  })

  return app
}
