import { seedPipelines } from '@cat-factory/kernel'
import type { Logger, Pipeline, PipelineRegistry, PipelineRepository } from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// ADOPTION: reconciling a workspace's stored pipeline rows with the CODE catalog.
//
// Built-ins (and a deployment's registered built-ins) are COPIED into each workspace at creation,
// so a board created before a pipeline shipped simply has no row for it, and the catalog's own
// copy is unreachable to every read: `PipelineService.list` is `listByWorkspace`, the builder edits
// rows, a run resolves its pipeline by row. The shipped way across that gap is the SPA's
// new-pipeline advisory plus a reseed.
//
// That is a fine story for a human browsing the pipeline library and a bad one for a REUSABLE
// OPERATION (`docs/initiatives/reusable-operations.md`), because an operation PINS its pipeline by
// id: a task of the operation is creatable on a board that never adopted it (the pin resolves off
// the task-type registry, which knows nothing about rows) and then refuses to start. So the run
// path adopts on first use, which is this module.
//
// Adoption WRITES the row rather than running off the catalog copy, deliberately. Resolving from
// code without persisting would leave a run executing a pipeline the board's own library does not
// list, cannot open in the builder, and cannot attach a schedule to: the same class of dishonesty
// as rendering an absent thing as an empty one. One insert keeps rows the single source every
// surface reads.
// ---------------------------------------------------------------------------

/**
 * The row a workspace's copy of a catalog pipeline is: the catalog definition, carrying over the
 * organizational metadata a workspace owns (`labels` / `archived`, written by `organize`) when it
 * already holds a copy. Shared by `PipelineService.reseed` and adoption so "adopting" and
 * "reseeding" cannot produce different rows for the same catalog entry.
 */
export function adoptedCatalogRow(seed: Pipeline, existing?: Pipeline | null): Pipeline {
  const labels = existing?.labels ?? seed.labels
  return {
    ...seed,
    ...(labels && labels.length ? { labels } : { labels: undefined }),
    ...(existing?.archived ? { archived: true } : { archived: undefined }),
  }
}

/**
 * The catalog definition a workspace SHOULD hold under this id but may never have been seeded
 * with, or undefined when the id is not an adoptable catalog entry.
 *
 * Restricted to `builtin` entries, and that restriction IS the safety argument. A built-in is
 * read-only in a workspace and becomes deletable only once RETIRED, and a retired id is absent
 * from `seedPipelines` by construction (kernel deletes the definition; `PipelineRegistry.retire`
 * splices the registration). So "no row, and a live built-in catalog entry" can only mean NEVER
 * ADOPTED. A VERSIONLESS registered pipeline is editable and deletable by the workspace, so
 * treating one the same way would silently resurrect a deliberate deletion, and re-materialise it
 * with the code definition rather than the workspace's own edits.
 */
function unadoptedCatalogEntry(
  pipelineId: string,
  registry: PipelineRegistry | undefined,
): Pipeline | undefined {
  const seed = seedPipelines(registry).find((p) => p.id === pipelineId)
  return seed?.builtin ? adoptedCatalogRow(seed) : undefined
}

/** Resolving a pipeline id against a workspace that may not have adopted the catalog entry yet. */
export interface PipelineAdoption {
  /**
   * The definition a run under this id WOULD use: the stored row, else the un-adopted catalog
   * entry. Reads only, so it is what a question about a prospective run asks (the personal-
   * credential gate's "which vendors would this need"). Answering `null` where `adoptForRun`
   * would succeed is what that gate did before, and it read as "this pipeline needs nothing".
   */
  resolveDefinition(workspaceId: string, pipelineId: string): Promise<Pipeline | null>
  /**
   * The definition a run under this id will use, ADOPTING an un-adopted catalog entry into the
   * workspace so every other surface can see what ran. Idempotent under a race: two tasks of the
   * same operation started at once both resolve "no row" and both insert the same catalog
   * definition, which `insertIfAbsent` settles first-write-wins.
   */
  adoptForRun(workspaceId: string, pipelineId: string): Promise<Pipeline | null>
}

export interface PipelineAdoptionDependencies {
  pipelineRepository: PipelineRepository
  /**
   * The app-owned registry a deployment registers its own pipelines on. Optional: absent, the
   * BUILT-IN catalog is still adoptable (it lives in code, not in the registry), so a caller that
   * registers nothing loses nothing. What it loses is adoption of a DEPLOYMENT's own registered
   * built-in, which is exactly the reusable-operation case, so a facade must thread it.
   */
  pipelineRegistry?: PipelineRegistry
  logger?: Logger
}

export function createPipelineAdoption(deps: PipelineAdoptionDependencies): PipelineAdoption {
  const log = deps.logger ?? noopLogger
  // The catalog build only ever happens on the MISS, so the hot path is the single point-read a
  // start already did.
  const resolve = async (workspaceId: string, pipelineId: string) =>
    (await deps.pipelineRepository.get(workspaceId, pipelineId)) ??
    unadoptedCatalogEntry(pipelineId, deps.pipelineRegistry) ??
    null

  return {
    resolveDefinition: resolve,
    async adoptForRun(workspaceId, pipelineId) {
      const stored = await deps.pipelineRepository.get(workspaceId, pipelineId)
      if (stored) return stored
      const seed = unadoptedCatalogEntry(pipelineId, deps.pipelineRegistry)
      if (!seed) return null
      await deps.pipelineRepository.insertIfAbsent(workspaceId, seed)
      log.info('Adopted a catalog pipeline into the workspace on first run', {
        workspaceId,
        pipelineId,
        version: seed.version,
      })
      return seed
    },
  }
}
