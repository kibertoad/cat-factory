import { assertFound } from './domain/errors.js'
import type { WorkspaceRepository } from './ports/repositories.js'
import type { Workspace } from './domain/types.js'

export async function requireWorkspace(
  repository: WorkspaceRepository,
  id: string,
): Promise<Workspace> {
  return assertFound(await repository.get(id), 'Workspace', id)
}
