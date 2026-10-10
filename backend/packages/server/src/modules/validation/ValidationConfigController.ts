import {
  deleteServiceValidationConfigContract,
  detectServiceValidationChecksContract,
  getServiceValidationConfigContract,
  listServiceValidationConfigsContract,
  setServiceValidationConfigContract,
} from '@cat-factory/contracts'
import type { DetectedValidationChecks } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { detectValidationChecksFromRepo } from '@cat-factory/integrations'
import type { ValidationConfigService } from '@cat-factory/integrations'
import { describeError } from '@cat-factory/kernel'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
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
  mountWorkspacePermission(app, 'settings.manage', [
    '/validation-checks',
    '/services/:blockId/validation-checks',
  ])

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

  // Suggest checks from the service repo's own manifests (the panel's "Detect" button).
  // A pure READ that writes nothing: it fills the operator's rows, and they save as usual.
  //
  // Deliberately independent of the config STORE (`requireValidationConfig`) — detection
  // reads the repo, not the table, so a facade that wired no store would still answer here.
  // The store's absence hides the whole panel client-side, so this never strands a control.
  buildHonoRoute(app, detectServiceValidationChecksContract, async (c) => {
    const container = c.get('container')
    const resolve = container.resolveRunRepoContext
    // The three outcomes are REPORTED, never collapsed into an empty list: "no repo linked"
    // and "GitHub read failed" send an operator to completely different places than "we read
    // your repo and recognised nothing".
    const empty = (status: DetectedValidationChecks['status']): DetectedValidationChecks => ({
      status,
      ecosystems: [],
      checks: [],
      truncated: false,
    })
    if (!resolve) return c.json(empty('repo_unavailable'), 200)

    const workspaceId = param(c, 'workspaceId')
    const blockId = c.req.valid('param').blockId
    try {
      const ctx = await resolve(workspaceId, blockId)
      if (!ctx) return c.json(empty('repo_unavailable'), 200)
      const detected = await detectValidationChecksFromRepo(ctx.repo, ctx.baseBranch)
      return c.json({ status: 'ok' as const, ...detected }, 200)
    } catch (error) {
      // A block with no linked service throws in the resolver, and a revoked token / rate
      // limit throws in the read. Both are a FAILED detection the panel states plainly —
      // never a 500 on an assistive button, and never a silent empty result.
      container.logger.warn('pre-PR validation autodetect failed', {
        workspaceId,
        blockId,
        ...describeError(error),
      })
      return c.json(empty('failed'), 200)
    }
  })

  buildHonoRoute(app, deleteServiceValidationConfigContract, async (c) => {
    const svc = requireValidationConfig(c)
    await svc.deleteFor(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.body(null, 204)
  })

  return app
}
