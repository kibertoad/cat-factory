import type { Context } from 'hono'
import { bearerToken } from '../../auth/middleware.js'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { ContainerSession } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import type { BinaryArtifactStore } from '@cat-factory/kernel'
import { UnauthorizedError, UnavailableError } from '@cat-factory/kernel'

/**
 * Verify the container session token on a harness request and resolve the store its run may use.
 *
 * ONE helper for every direction of the seam (the tester's screenshot ingest, the reference
 * download beside it, and the asset ingest a media step stores through), so they can never end up
 * disagreeing about what authenticates a container: the SAME short-lived, workspace- and
 * execution-pinned token the agent already holds for the LLM proxy, and a store resolved from the
 * token's workspace rather than from anything the request says.
 *
 * It lives in its own module rather than on one of the controllers because the SECOND caller is
 * what makes the rule load-bearing: a per-controller copy is how one entry point ends up trusting
 * a workspace id off the request body while its sibling does not.
 */
export async function requireHarnessSession(
  c: Context<AppEnv>,
  scope: string,
): Promise<{ session: ContainerSession; store: BinaryArtifactStore }> {
  const container = c.get('container')
  const resolveStore = container.resolveBinaryArtifactStore
  if (!resolveStore) {
    throw new UnavailableError('Artifact storage not configured')
  }
  const secret = container.config.auth.sessionSecret
  if (!secret) {
    logger.error('harness artifacts: session secret not configured', { scope })
    throw new UnavailableError('Artifact ingest not configured')
  }
  const sessions = new ContainerSessionService({ secret })
  const session = await sessions.verify(bearerToken(c))
  if (!session) {
    logger.warn('harness artifacts: invalid or expired session token', { scope })
    throw new UnauthorizedError('Invalid or expired token')
  }
  // The store is the run's ACCOUNT's configured backend, resolved from the token's workspace
  // (never the request), so a container only ever reaches its own account's storage. Null means the
  // account configured no storage.
  const store = await resolveStore(session.workspaceId)
  if (!store) {
    throw new UnavailableError('Artifact storage not configured')
  }
  return { session, store }
}
