import {
  type Project,
  type ProjectCredentialReadiness,
  type ProjectDefinition,
  isReservedPlatformEnvKey,
  projectDefinitionSubjectId,
} from '@cat-factory/contracts'
import type { ToolSecretResolver } from '@cat-factory/kernel'

/**
 * Whether each credential a project's definition declares resolves for `workspaceId`, through the
 * same resolver and subject a project dispatch reads, so "configured" here means what the run
 * will find. A key in the reserved platform set is never sent, so it is named as such.
 */
export async function projectCredentialReadiness(
  project: Project,
  definition: ProjectDefinition,
  workspaceId: string,
  resolver: ToolSecretResolver | undefined,
): Promise<ProjectCredentialReadiness[]> {
  const sendable = definition.credentials.filter((c) => !isReservedPlatformEnvKey(c.key))
  const values =
    resolver && sendable.length > 0
      ? await resolver.resolve({
          workspaceId,
          subject: {
            kind: 'project-definition',
            id: projectDefinitionSubjectId(project.kind, definition.key),
          },
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
