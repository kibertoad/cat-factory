import type { Context } from 'hono'
import type { AppEnv } from '../http/env.js'
import { type MachinePayload, TOKEN_AUDIENCE, signerFor } from './signing.js'

/**
 * The ONE machine-token gate for every `/internal/*` machine endpoint: verify the
 * `machine`-audience token, then consult the machine-node roster so a REVOKED node is
 * refused everywhere at once (SEC-5). Before this helper each controller inlined the same
 * six verify lines, which is exactly how a revocation check would have landed on some
 * endpoints and not others.
 *
 * Returns the verified payload, or null when the request must be refused; each controller
 * keeps its own refusal envelope (the relay controllers' `{ ok: false }` shape and the
 * plain `{ error }` shape both stay where they are). A revoked node gets the same 403 as
 * an invalid token: the caller holds the token either way, so there is no oracle to
 * protect, and the reconnect flow is the remedy for both.
 *
 * A roster read that THROWS propagates (a 500, retried by the machine clients), because
 * an unreadable roster is not consent to serve a possibly-revoked node.
 */
export async function verifyMachineRequest(c: Context<AppEnv>): Promise<MachinePayload | null> {
  const container = c.get('container')
  const secret = container.config.auth.sessionSecret
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const payload = secret
    ? await signerFor(secret).verify<MachinePayload>(token, { aud: TOKEN_AUDIENCE.machine })
    : null
  if (!payload) return null
  const nodes = container.machineNodeRepository
  if (nodes && (await nodes.isRevoked(payload.nodeId))) return null
  return payload
}
