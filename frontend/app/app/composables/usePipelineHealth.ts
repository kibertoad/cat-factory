import { computed } from 'vue'
import type { Pipeline } from '~/types/domain'
import type { StepGating } from '~/types/consensus'
import { COMPANION_FOR_PRODUCER, isKnownAgentKind, isProducerCompanion } from '~/utils/catalog'
import { usePipelinesStore } from '~/stores/pipelines'

/** Estimate-gating consults a `task-estimator` step (mirrors the backend constant). */
const TASK_ESTIMATOR_KIND = 'task-estimator'

export type PipelineProblemType = 'unknown-kind' | 'shape' | 'outdated'

export interface PipelineProblem {
  type: PipelineProblemType
  message: string
}

export interface PipelineHealth {
  pipeline: Pipeline
  problems: PipelineProblem[]
  /** Structural / unknown-kind problems — delete (custom) or reseed (built-in) to fix. */
  invalid: boolean
  /** A built-in whose catalog definition is newer than the stored copy — reseed to update. */
  outdated: boolean
}

/** A brand-new built-in pipeline that appeared in the catalog but isn't in the workspace yet. */
export interface NewPipeline {
  /** The catalog (built-in) id — what the reseed endpoint is keyed by (it creates the row). */
  id: string
  /** The built-in's display name, from the catalog versions' companion name map. */
  name: string
}

/**
 * A built-in's display name for the "new pipeline" advisory, humanised from its catalog id
 * (`pl_review` -> "review", rendered capitalised) — used only until the row is reseeded into
 * existence, at which point its real catalog name is stored. Mirrors `useRiskPolicyHealth`.
 */
function builtinPipelineName(id: string): string {
  return id.replace(/^pl_/, '').replace(/_/g, ' ')
}

/** Producers a companion kind is allowed to review (inverse of {@link COMPANION_FOR_PRODUCER}). */
function companionTargets(companion: string): string[] {
  return Object.entries(COMPANION_FOR_PRODUCER)
    .filter(([, c]) => c === companion)
    .map(([producer]) => producer)
}

const isEnabledAt = (p: Pipeline, i: number) => p.enabled?.[i] !== false

/**
 * Client-side mirror of the backend `validatePipelineShape` (companion adjacency + estimate
 * gating, over the ENABLED subset), collecting the first problem instead of throwing. Returns a
 * human message, or null when the shape is valid. Kept in step with
 * `backend/packages/orchestration/src/modules/pipelines/pipelineShape.ts`.
 */
function shapeProblem(p: Pipeline): string | null {
  const kinds = p.agentKinds
  // No enabled steps ⇒ nothing would run.
  if (kinds.length === 0 || !kinds.some((_, i) => isEnabledAt(p, i))) {
    return 'No enabled steps — the pipeline has nothing to run.'
  }
  // Companion adjacency: an enabled companion's nearest preceding enabled step must be a
  // producer it can review.
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]
    if (!kind || !isProducerCompanion(kind) || !isEnabledAt(p, i)) continue
    const targets = companionTargets(kind)
    let predecessor: string | undefined
    for (let j = i - 1; j >= 0; j--) {
      if (isEnabledAt(p, j)) {
        predecessor = kinds[j]
        break
      }
    }
    if (predecessor === undefined || !targets.includes(predecessor)) {
      return `Companion '${kind}' must run immediately after an enabled step it can review (${targets.join(', ')}).`
    }
  }
  // Estimate gating: an enabled gated step must be a companion, set ≥1 threshold, and have an
  // enabled task-estimator earlier in the chain.
  const gating = p.gating
  if (gating) {
    for (let i = 0; i < kinds.length; i++) {
      const g = gating[i] as StepGating | null | undefined
      if (!g?.enabled || !isEnabledAt(p, i)) continue
      const kind = kinds[i]
      if (!kind || !isProducerCompanion(kind)) {
        return `Step '${kind}' cannot be estimate-gated — only companion steps may be skipped on the estimate.`
      }
      if (g.minComplexity === undefined && g.minRisk === undefined && g.minImpact === undefined) {
        return `Step '${kind}' is estimate-gated but sets no threshold (complexity / risk / impact).`
      }
      const hasEstimator = kinds
        .slice(0, i)
        .some((k, j) => k === TASK_ESTIMATOR_KIND && isEnabledAt(p, j))
      if (!hasEstimator) {
        return `Step '${kind}' is gated on the estimate but no enabled '${TASK_ESTIMATOR_KIND}' runs before it.`
      }
    }
  }
  return null
}

/**
 * Detect pipelines in an unhealthy state for the startup advisory: those referencing an unknown
 * agent kind or with an invalid shape (offer to delete a custom one / reseed a built-in), built-ins
 * whose seeded definition has moved ahead of the stored copy (offer to reseed), AND brand-new
 * built-ins that appeared in the catalog but aren't in the workspace yet (offer to ADD them — a
 * board seeded before the built-in shipped, e.g. `pl_review`). Reads the pipeline library + the
 * snapshot's catalog versions from the pipelines store. Detection runs entirely client-side: the
 * canonical agent-kind catalog lives here (`AGENT_BY_KIND` + `SYSTEM_AGENT_META` + registered custom
 * kinds), and the catalog versions the snapshot ships ARE the set of built-in ids — a catalog id
 * with no stored pipeline is a new built-in. Mirrors `useRiskPolicyHealth` / `useModelPresetHealth`.
 */
export function usePipelineHealth() {
  const store = usePipelinesStore()

  const health = computed<PipelineHealth[]>(() => {
    const out: PipelineHealth[] = []
    for (const pipeline of store.pipelines) {
      const problems: PipelineProblem[] = []

      const unknown = [...new Set(pipeline.agentKinds.filter((k) => !isKnownAgentKind(k)))]
      if (unknown.length) {
        problems.push({
          type: 'unknown-kind',
          message: `References unknown agent ${unknown.length > 1 ? 'kinds' : 'kind'}: ${unknown.join(', ')}.`,
        })
      }

      const shape = shapeProblem(pipeline)
      if (shape) problems.push({ type: 'shape', message: shape })

      const catalogVersion = pipeline.builtin ? store.catalogVersions[pipeline.id] : undefined
      const outdated = catalogVersion !== undefined && catalogVersion > (pipeline.version ?? 0)
      if (outdated) {
        problems.push({
          type: 'outdated',
          message: `A newer version of this built-in pipeline is available (v${pipeline.version ?? 0} → v${catalogVersion}).`,
        })
      }

      if (problems.length) {
        out.push({ pipeline, problems, invalid: unknown.length > 0 || shape !== null, outdated })
      }
    }
    return out
  })

  // Brand-new built-ins: a catalog id (a `catalogVersions` key) with no stored pipeline. Adding one
  // is the same reseed call as adopting an update (it inserts the row when absent).
  const newPipelines = computed<NewPipeline[]>(() => {
    const storedIds = new Set(store.pipelines.map((p) => p.id))
    return Object.keys(store.catalogVersions)
      .filter((id) => !storedIds.has(id))
      .map((id) => ({ id, name: builtinPipelineName(id) }))
  })

  // An invalid built-in is reseeded (not deleted) and that also clears any "outdated" flag, so
  // exclude it from the outdated list to avoid offering the same fix twice.
  const invalid = computed(() => health.value.filter((h) => h.invalid))
  const outdated = computed(() => health.value.filter((h) => h.outdated && !h.invalid))
  const hasIssues = computed(() => health.value.length > 0 || newPipelines.value.length > 0)

  return { health, invalid, outdated, newPipelines, hasIssues }
}
