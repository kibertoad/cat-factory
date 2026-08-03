import {
  deleteCapabilityCredentialContract,
  getCapabilityCredentialsContract,
  setCapabilityCredentialsContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { CapabilityCredentialsService } from '@cat-factory/integrations'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import {
  buildCapabilityCredentialsView,
  collectDeclaredCapabilityCredentials,
} from './declaredCredentials.js'
import { logger } from '../../observability/logger.js'
import type { CapabilityCredentialRef, CapabilityCredentialsView } from '@cat-factory/contracts'
import type { ServerContainer } from '../../http/env.js'

/** Resolve the capability-credential store, or refuse with a 503 naming what isn't wired. */
function requireCapabilityCredentials<E extends AppEnv>(
  c: Context<E>,
): CapabilityCredentialsService {
  return requireCapability(
    c.get('container').capabilityCredentials,
    'The capability-credential store is not configured (needs ENCRYPTION_KEY)',
  )
}

/**
 * Compose the view from the two halves: what the deployment's registries DECLARE (read through
 * `BinaryGeneratorSource`, so a mothership-mode node offers what its runs actually resolve
 * against) and what this workspace has STORED.
 */
async function viewFor(
  container: ServerContainer,
  stored: CapabilityCredentialRef[],
): Promise<CapabilityCredentialsView> {
  const declarations = await collectDeclaredCapabilityCredentials({
    agentKindRegistry: container.agentKindRegistry,
    binaryGenerators: container.binaryGenerators,
    logger,
  })
  return buildCapabilityCredentialsView({
    declarations,
    stored,
    // The facades all keep the deployment-environment resolver behind the store, so an unstored
    // key may still resolve. Stated rather than assumed, because it decides whether the UI may
    // call a blank row "missing".
    environmentFallback: true,
  })
}

/**
 * The PER-WORKSPACE capability-credential store: the tenant-scoped home for the secrets a
 * registered tool server or generative binary integration declares by name. Sealed at rest,
 * delivered to the agent out of band (never a prompt or the telemetry snapshot), and write-only —
 * the view returns which credentials the deployment DECLARES and which this workspace has stored,
 * never a value.
 *
 * Gated on `secrets.manage`, the same permission the sensitive test-credential store uses, and
 * that gate covers the READ as well as the writes — unusually, and on purpose. The view carries
 * the credential KEY NAMES this deployment's capabilities want, which the workspace snapshot's
 * own generative-integration projection deliberately omits ("a workspace viewer has no business
 * learning which environment variables the deployment sets"). Moving the value into a row does
 * not change that judgement.
 */
export function capabilityCredentialsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('secrets.manage'))

  buildHonoRoute(app, getCapabilityCredentialsContract, async (c) => {
    const svc = requireCapabilityCredentials(c)
    const stored = await svc.listStored(param(c, 'workspaceId'))
    return c.json(await viewFor(c.get('container'), stored), 200)
  })

  buildHonoRoute(app, setCapabilityCredentialsContract, async (c) => {
    const svc = requireCapabilityCredentials(c)
    const stored = await svc.set(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(await viewFor(c.get('container'), stored), 200)
  })

  buildHonoRoute(app, deleteCapabilityCredentialContract, async (c) => {
    const svc = requireCapabilityCredentials(c)
    await svc.remove(param(c, 'workspaceId'), c.req.valid('param').key)
    return c.body(null, 204)
  })

  return app
}
