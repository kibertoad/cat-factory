import {
  deleteServiceValidationConfigContract,
  getServiceValidationConfigContract,
  listServiceValidationConfigsContract,
  setServiceValidationConfigContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ValidationConfigService } from '@cat-factory/integrations'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the validation-config service, or refuse with a 503 naming what isn't wired. */
function requireValidationConfig<E extends AppEnv>(c: Context<E>): ValidationConfigService {
  return requireCapability(
    c.get('container').validationConfig,
    'The validation-check store is not configured',
  )
}

/**
 * Per-service PRE-PR VALIDATION CHECKS: the shell commands the executor-harness runs against
 * the checkout after the coding agent settles and BEFORE the PR opens (see
 * `docs/initiatives/pre-pr-validation.md`). Mounted under `/workspaces/:workspaceId`; the
 * `:blockId` is the service-frame block (a run resolves its checks by walking UP to that frame).
 * Present only when a facade wired the repository.
 */
export function validationConfigController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('settings.manage'))

  buildHonoRoute(app, listServiceValidationConfigsContract, async (c) => {
    const svc = requireValidationConfig(c)
    return c.json(await svc.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getServiceValidationConfigContract, async (c) => {
    const svc = requireValidationConfig(c)
    return c.json(await svc.getView(param(c, 'workspaceId'), c.req.valid('param').blockId), 200)
  })

  buildHonoRoute(app, setServiceValidationConfigContract, async (c) => {
    const svc = requireValidationConfig(c)
    const view = await svc.set(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
    )
    return c.json(view, 200)
  })

  buildHonoRoute(app, deleteServiceValidationConfigContract, async (c) => {
    const svc = requireValidationConfig(c)
    await svc.deleteFor(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.body(null, 204)
  })

  return app
}
