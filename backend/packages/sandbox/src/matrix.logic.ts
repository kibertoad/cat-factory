import type { SandboxExperiment, SandboxMatrix, SandboxRun } from '@cat-factory/kernel'

// Pure expansion of an experiment's matrix into individual run cells. One cell per
// (prompt version × model × fixture × repeat). The durable fan-out driver consumes
// these queued skeletons; everything time/identity-dependent is injected so the
// expansion is deterministic and unit-testable.

/** The number of cells a matrix expands to (for the pre-launch cost estimate). */
export function cellCount(matrix: SandboxMatrix, repeats: number): number {
  return matrix.promptVersionIds.length * matrix.models.length * matrix.fixtureIds.length * repeats
}

export interface ExpandDeps {
  /** Mint a unique run id; called once per cell (pass index so callers can vary it). */
  makeId: (index: number) => string
  /** The frozen `name@vN` label for a prompt version id (resolved by the service). */
  labelFor: (promptVersionId: string) => string
  now: number
}

/**
 * Expand an experiment into queued {@link SandboxRun} cells. The product (prompt ×
 * model × fixture × repeat) is emitted in a stable order (prompt-major) so a results
 * grid renders consistently. Each cell starts `queued` with all outcome fields null.
 */
export function expandMatrix(
  experiment: Pick<SandboxExperiment, 'id' | 'matrix' | 'repeats'>,
  deps: ExpandDeps,
): SandboxRun[] {
  const { promptVersionIds, models, fixtureIds } = experiment.matrix
  const runs: SandboxRun[] = []
  let index = 0
  for (const promptVersionId of promptVersionIds) {
    for (const model of models) {
      for (const fixtureId of fixtureIds) {
        for (let repeatIndex = 0; repeatIndex < experiment.repeats; repeatIndex++) {
          runs.push({
            id: deps.makeId(index),
            experimentId: experiment.id,
            promptVersionId,
            model,
            fixtureId,
            repeatIndex,
            status: 'queued',
            outputText: null,
            usage: null,
            latencyMs: null,
            branch: null,
            prUrl: null,
            diff: null,
            error: null,
            seedSha: null,
            promptLabel: deps.labelFor(promptVersionId),
            startedAt: null,
            finishedAt: null,
          })
          index++
        }
      }
    }
  }
  return runs
}

/** A non-empty matrix references at least one of each axis. */
export function isRunnableMatrix(matrix: SandboxMatrix): boolean {
  return (
    matrix.promptVersionIds.length > 0 && matrix.models.length > 0 && matrix.fixtureIds.length > 0
  )
}
