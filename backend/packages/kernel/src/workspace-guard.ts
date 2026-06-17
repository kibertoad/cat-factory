import { assertFound } from './domain/errors'
import type { WorkspaceRepository } from './ports/repositories'
import type { Workspace } from './domain/types'

export async function requireWorkspace(
  repository: WorkspaceRepository,
  id: string,
): Promise<Workspace> {
  return assertFound(await repository.get(id), 'Workspace', id)
}
