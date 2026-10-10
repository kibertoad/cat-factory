import { runPreflightsContract } from '@cat-factory/contracts'
import type { PreflightRef } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * Preflight checks (machine-prerequisite probes for a stack recipe): run a set of refs and get one
 * verdict each (pass / fail / warn + detail + remediation). Used by the environment setup wizard's
 * checklist + live re-check. The probes run only on the local (host) facade; the endpoint 503s
 * elsewhere. See PreflightController in @cat-factory/server.
 */
export function preflightsApi({ send, ws }: ApiContext) {
  return {
    runPreflights: (workspaceId: string, prerequisites: PreflightRef[]) =>
      send(runPreflightsContract, { pathPrefix: ws(workspaceId), body: { prerequisites } }),
  }
}
