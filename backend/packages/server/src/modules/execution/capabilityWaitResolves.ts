import type { CapabilityCredentialWait } from '@cat-factory/contracts'
import { toolSecretSubjectOf } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'

/**
 * The capability re-check a credential-wait resume runs: whether the key now resolves for the
 * run's workspace, asked of the subject that declared it, through the same resolver a dispatch
 * reads. Shared by the app's resume route and the public one.
 */
export function capabilityWaitResolves(
  container: ServerContainer,
  workspaceId: string,
): (wait: CapabilityCredentialWait) => Promise<boolean> {
  return async (wait) => {
    const subject = toolSecretSubjectOf(wait.declaredBy)
    const resolver = container.toolSecretResolver
    if (!subject || !resolver) return false
    const resolved = await resolver.resolve({ workspaceId, subject, keys: [{ key: wait.key }] })
    return Boolean(resolved[wait.key])
  }
}
