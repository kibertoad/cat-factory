import {
  getPreviewContract,
  startPreviewContract,
  stopPreviewContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { PreviewModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/**
 * Resolve the preview module, gating on the runtime's `frontendPreview.supported` capability
 * FIRST (defense-in-depth: slice 5a only gated the SPA toggle, so a direct API call on an
 * unsupported runtime — e.g. the Worker — must still be refused here). Refuses with a 503
 * when the runtime can't host a preview OR the module isn't wired.
 */
function requirePreview<E extends AppEnv>(c: Context<E>): PreviewModule {
  const container = c.get('container')
  const supported = container.config.infrastructure?.frontendPreview?.supported !== false
  return requireCapability(
    supported ? container.preview : null,
    'Browsable frontend previews are not supported on this runtime',
  )
}

/**
 * Browsable frontend preview (slice 5c): start / poll / stop a long-lived build+serve container
 * for a `frontend` frame, reachable on a host URL. A local/node differentiator — 503 on the
 * Worker (which reports `frontendPreview.supported: false`). Mounted under `/workspaces/:workspaceId`.
 */
export function previewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', ['/frames/:frameId/preview'])

  buildHonoRoute(app, getPreviewContract, async (c) => {
    const preview = requirePreview(c)
    const frameId = c.req.valid('param').frameId
    return c.json(await preview.service.get(param(c, 'workspaceId'), frameId), 200)
  })

  buildHonoRoute(app, startPreviewContract, async (c) => {
    const preview = requirePreview(c)
    const frameId = c.req.valid('param').frameId
    return c.json(await preview.service.start(param(c, 'workspaceId'), frameId), 201)
  })

  buildHonoRoute(app, stopPreviewContract, async (c) => {
    const preview = requirePreview(c)
    const frameId = c.req.valid('param').frameId
    return c.json(await preview.service.stop(param(c, 'workspaceId'), frameId), 200)
  })

  return app
}
