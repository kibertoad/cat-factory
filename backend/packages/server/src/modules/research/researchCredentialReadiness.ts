import {
  type ResearchCredentialReadiness,
  type ResearchDefinition,
  isReservedPlatformEnvKey,
} from '@cat-factory/contracts'
import type { ToolSecretResolver } from '@cat-factory/kernel'

/**
 * Whether each credential a research definition declares resolves for `workspaceId`, through the
 * same resolver and subject a research dispatch reads, so "configured" here means what the run
 * will find. A key in the reserved platform set is never sent, so it is named as such.
 */
export async function researchCredentialReadiness(
  definition: ResearchDefinition,
  workspaceId: string,
  resolver: ToolSecretResolver | undefined,
): Promise<ResearchCredentialReadiness[]> {
  const sendable = definition.credentials.filter((c) => !isReservedPlatformEnvKey(c.key))
  const values =
    resolver && sendable.length > 0
      ? await resolver.resolve({
          workspaceId,
          subject: { kind: 'research-definition', id: definition.key },
          keys: sendable.map((c) => ({ key: c.key })),
        })
      : {}
  return definition.credentials.map((credential) => ({
    key: credential.key,
    kind: credential.kind,
    label: credential.label,
    ...(credential.onboarding ? { onboarding: credential.onboarding } : {}),
    requiredAtStart: credential.requiredAtStart,
    status: isReservedPlatformEnvKey(credential.key)
      ? 'reserved'
      : values[credential.key]
        ? 'stored'
        : 'missing',
  }))
}
