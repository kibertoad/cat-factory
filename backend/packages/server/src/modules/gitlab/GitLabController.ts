import {
  connectGitLabContract,
  disconnectGitLabContract,
  getGitLabConnectionContract,
} from '@cat-factory/contracts'
import type { VcsPatConnectionService } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the per-workspace VCS PAT connect service, or 503 when GitLab connect is unconfigured. */
function requireVcsConnect<E extends AppEnv>(c: Context<E>): VcsPatConnectionService {
  return requireCapability(
    c.get('container').vcsConnectionService,
    'GitLab integration is not configured',
  )
}

/**
 * Workspace-scoped GitLab connect endpoints: the per-workspace PAT connect flow, the analogue of
 * the GitHub App connect surface for a provider that authenticates with a pasted token. Connecting
 * validates + seals the PAT and writes the shared `github_installations`/`github_repos` projection
 * rows (stamped `provider: 'gitlab'`), so once connected the repo browse / link / sync surface is
 * the SAME GitHub-shaped store the SPA already drives. Mounted under `/workspaces/:workspaceId`;
 * 503 when the facade hasn't wired the connect service (GitLab connect disabled). Guarded by
 * `integrations.manage`, exactly like the GitHub controller.
 */
export function gitlabController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', ['/gitlab'])

  buildHonoRoute(app, getGitLabConnectionContract, async (c) => {
    const vcs = requireVcsConnect(c)
    const connection = await vcs.getConnection(param(c, 'workspaceId'))
    return c.json({ connection }, 200)
  })

  // Connect by pasting a PAT: validate it (a bad token surfaces as a typed ValidationError → 4xx),
  // seal it, and persist the workspace's GitLab connection. Idempotent per workspace.
  buildHonoRoute(app, connectGitLabContract, async (c) => {
    const vcs = requireVcsConnect(c)
    const { pat } = c.req.valid('json')
    const connection = await vcs.connect(param(c, 'workspaceId'), pat)
    return c.json(connection, 201)
  })

  buildHonoRoute(app, disconnectGitLabContract, async (c) => {
    const vcs = requireVcsConnect(c)
    await vcs.disconnect(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
