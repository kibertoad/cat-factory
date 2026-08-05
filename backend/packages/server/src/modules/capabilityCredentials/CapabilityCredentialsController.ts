import {
  deleteCapabilityCredentialContract,
  getCapabilityCredentialsContract,
  setCapabilityCredentialContract,
  setCapabilityCredentialsContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { CapabilityCredentialsService } from '@cat-factory/integrations'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermissionIncludingReads } from '../../http/workspaceAccess.js'
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
    // Read off the chain the facade actually COMPOSED, never re-asserted here. It decides whether
    // the UI may call a blank row "missing", and the two answers send an operator in opposite
    // directions, so the flag has to describe the real chain, including the case where a
    // deployment replaced it with its own resolver and the answer is "not known".
    ...(container.toolSecretEnvironmentFallback === undefined
      ? {}
      : { environmentFallback: container.toolSecretEnvironmentFallback }),
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
 *
 * Which is why the mount is `mountWorkspacePermissionIncludingReads` and not the usual
 * `mountWorkspacePermission`: that one passes GET/HEAD straight through, so for a release this
 * controller documented a gated read (here, in the SPA's tab gate, and in the store's 403 branch)
 * while every member's GET was answered in full.
 */
export function capabilityCredentialsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermissionIncludingReads(app, 'secrets.manage', ['/capability-credentials'])

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

  // The per-KEY write the credential CHECKLIST performs. It is not a convenience over the
  // whole-set PUT: a client that never received the values cannot re-send the set, so without
  // this, filling in a second credential would delete the first.
  buildHonoRoute(app, setCapabilityCredentialContract, async (c) => {
    const svc = requireCapabilityCredentials(c)
    const stored = await svc.put(
      param(c, 'workspaceId'),
      c.req.valid('param').key,
      c.req.valid('json').value,
    )
    return c.json(await viewFor(c.get('container'), stored), 200)
  })

  buildHonoRoute(app, deleteCapabilityCredentialContract, async (c) => {
    const svc = requireCapabilityCredentials(c)
    await svc.remove(param(c, 'workspaceId'), c.req.valid('param').key)
    return c.body(null, 204)
  })

  return app
}
