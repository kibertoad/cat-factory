import type { ProjectKindDescriptor } from '@cat-factory/contracts'
import type { ProjectKindRegistry } from '../domain/project-kind-registry.js'

/**
 * Where project kinds are READ from. Kinds are registered in code and resolved when a task is
 * admitted under a project, so in mothership mode the mothership owns them and a node reads them
 * over the machine API. A read failure THROWS rather than answering with no kinds: "the
 * mothership is unreachable" and "this deployment registers no kinds" are the same value and
 * opposite facts.
 */
export interface ProjectKindSource {
  all(): Promise<ProjectKindDescriptor[]>
  get(id: string): Promise<ProjectKindDescriptor | undefined>
}

/** The in-process source: this deployment's own registry. */
export function registryProjectKindSource(registry: ProjectKindRegistry): ProjectKindSource {
  return {
    all: async () => registry.all(),
    get: async (id) => registry.get(id),
  }
}
