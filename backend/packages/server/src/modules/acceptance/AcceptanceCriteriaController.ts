import {
  createServiceAcceptanceCriterionContract,
  deleteAcceptanceCriterionContract,
  getServiceAcceptanceCriteriaContract,
  listServiceAcceptanceCriteriaContract,
  updateAcceptanceCriterionContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AcceptanceCriteriaService } from '@cat-factory/integrations'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the acceptance-criteria service, or null when the facade wired no store. */
function requireCriteria<E extends AppEnv>(c: Context<E>): AcceptanceCriteriaService | null {
  return c.get('container').acceptanceCriteria ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    {
      error: {
        code: 'unavailable',
        message: 'The acceptance-criteria store is not configured',
      },
    },
    503,
  )

/**
 * Per-service ACCEPTANCE CRITERIA: the durable given/when/then statements of required behaviour
 * a service accumulates (see `docs/initiatives/acceptance-criteria-store.md`). Mounted under
 * `/workspaces/:workspaceId`; the `:blockId` is the service-frame block (a run resolves its
 * criteria by walking UP to that frame), and an individual criterion is addressed by its own
 * stable id. Present only when a facade wired the repository.
 *
 * **Deliberately NOT admin-gated.** Every neighbouring frame-scoped controller
 * (validation-checks, release-health, test-secrets) mounts `requireWorkspacePermission(...)`
 * because it edits operator CONFIGURATION — commands that run, credentials that leak, monitors
 * that page. Acceptance criteria are product knowledge: the same class of thing as a task
 * description or a board block, which any member may write. So the authorization story here is
 * exactly the RBAC gate's viewer WRITE FLOOR (`mountAuthGate` requires ≥ member for any
 * non-GET), and adding a permission mount would lock members out of curating their own
 * service's behaviour. Confirming a criterion is what makes it steer agents, so the write that
 * matters is a member-tier one by design.
 */
export function acceptanceCriteriaController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listServiceAcceptanceCriteriaContract, async (c) => {
    const svc = requireCriteria(c)
    if (!svc) return unavailable(c)
    return c.json(await svc.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getServiceAcceptanceCriteriaContract, async (c) => {
    const svc = requireCriteria(c)
    if (!svc) return unavailable(c)
    const view = await svc.listForFrame(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(view, 200)
  })

  buildHonoRoute(app, createServiceAcceptanceCriterionContract, async (c) => {
    const svc = requireCriteria(c)
    if (!svc) return unavailable(c)
    const created = await svc.create(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
    )
    return c.json(created, 201)
  })

  buildHonoRoute(app, updateAcceptanceCriterionContract, async (c) => {
    const svc = requireCriteria(c)
    if (!svc) return unavailable(c)
    const updated = await svc.update(
      param(c, 'workspaceId'),
      c.req.valid('param').criterionId,
      c.req.valid('json'),
    )
    return c.json(updated, 200)
  })

  buildHonoRoute(app, deleteAcceptanceCriterionContract, async (c) => {
    const svc = requireCriteria(c)
    if (!svc) return unavailable(c)
    await svc.deleteCriterion(param(c, 'workspaceId'), c.req.valid('param').criterionId)
    return c.body(null, 204)
  })

  return app
}
