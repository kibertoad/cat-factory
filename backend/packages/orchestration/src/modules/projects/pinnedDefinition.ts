import type { Project, ProjectDefinition, ProjectPin } from '@cat-factory/contracts'
import { type ProjectDefinitionSource, ValidationError } from '@cat-factory/kernel'

/**
 * The definition a project's pin names, for work that runs it. Refused when the definition is gone
 * or a registered one no longer hashes to the pin, so nothing starts from a definition the project
 * never agreed to.
 */
export async function resolvePinnedDefinition(
  definitions: ProjectDefinitionSource,
  project: Pick<Project, 'accountId' | 'kind'>,
  pin: Pick<ProjectPin, 'definitionKey' | 'definitionVersion' | 'definitionHash'>,
): Promise<ProjectDefinition> {
  const resolved = await definitions.get(
    project.accountId ?? '',
    project.kind,
    pin.definitionKey,
    pin.definitionVersion,
  )
  if (!resolved) {
    throw new ValidationError('The pinned definition no longer exists', {
      reason: 'project_definition_not_found',
      kind: project.kind,
      definitionKey: pin.definitionKey,
      definitionVersion: pin.definitionVersion,
    })
  }
  if (resolved.contentHash !== pin.definitionHash) {
    throw new ValidationError('The registered definition changed since the project pinned it', {
      reason: 'project_definition_changed',
      definitionKey: pin.definitionKey,
    })
  }
  return resolved.definition
}
