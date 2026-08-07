import { computed } from 'vue'
import type { Pipeline } from '~/types/domain'
import type { StepGating } from '~/types/consensus'
import { isBuiltinGatableKind } from '@cat-factory/contracts'
import { COMPANION_FOR_PRODUCER, isKnownAgentKind, isProducerCompanion } from '~/utils/catalog'
import { usePipelinesStore } from '~/stores/pipelines'

/** Estimate-gating consults a `task-estimator` step (mirrors the backend constant). */
const TASK_ESTIMATOR_KIND = 'task-estimator'

export type PipelineProblemType = 'unknown-kind' | 'shape' | 'outdated' | 'retired'

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

/**
 * A stored built-in that has been WITHDRAWN from the catalog — no longer relevant, and removable
 * (the one case where deleting a built-in is allowed).
 *
 * It is a list of its own rather than a {@link PipelineProblem} on {@link PipelineHealth} because
 * every problem there is answered by a RESEED, and a retired pipeline has no catalog definition
 * left to reseed from. Keeping it separate is what guarantees the advisory can never offer both
 * fixes for one row — a retired pipeline is skipped by the health scan entirely.
 */
export interface RetiredPipelineHealth {
  pipeline: Pipeline
  /**
   * The live pipeline that supersedes it, when the catalog names one — resolved to a display name
   * so the advisory can write "Use {name} instead".
   *
   * Deliberately NOT a {@link Pipeline}: the replacement usually is NOT one this workspace stores.
   * The canonical retirement is "old flow superseded by a NEWLY SHIPPED built-in", and a new
   * built-in lives in `catalogVersions` with no row until someone reseeds it — it is literally a
   * {@link NewPipeline} at that moment. Typing this as a stored `Pipeline` made the replacement
   * unresolvable in exactly the case `replacedBy` exists for, silently dropping the sentence.
   */
  replacement?: { id: string; name: string }
}

/** A brand-new built-in pipeline that appeared in the catalog but isn't in the workspace yet. */
export interface NewPipeline {
  /** The catalog (built-in) id — what the reseed endpoint is keyed by (it creates the row). */
  id: string
  /** The built-in's display name, from the catalog versions' companion name map. */
  name: string
}

/**
 * A catalog entry's display name for the "new pipeline" advisory, used only while the entry has no
 * stored row to take a name off. The snapshot's companion name map answers it; the humanised id
 * (`pl_review` -> "review", rendered capitalised) is the FALLBACK for a facade that ships no map.
 *
 * The map is not a nicety. Humanising was fine for the shipped built-ins, whose ids read as their
 * names, and wrong the moment a deployment registers its own: a reusable operation's
 * `pl_org_introduce_api` was offered as "org introduce api", a name appearing nowhere else in the
 * product, on exactly the boards that predate the operation and therefore see this advisory.
 */
function builtinPipelineName(id: string, names: Record<string, string>): string {
  return names[id] ?? id.replace(/^pl_/, '').replace(/_/g, ' ')
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
 *
 * A rule here must be keyed off vocabulary SHARED with that module (`@cat-factory/contracts`)
 * wherever one exists, never re-stated locally — see the gating note below for what a drifted copy
 * costs. Adding a rule to `assertValidGating` without adding it here is the milder half of the same
 * drift: a pipeline the engine refuses at save that this advisory calls healthy.
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
  // Estimate gating: an enabled gated step must be a GATABLE kind, must not also carry a human
  // approval gate, must set ≥1 threshold, and must have an enabled task-estimator earlier in the
  // chain. Gatability reads the SHARED `BUILTIN_GATABLE_KINDS` rather than a local rule, because
  // this advisory auto-opens a modal over the board: a copy of the rule that drifts behind the
  // engine's does not merely warn wrongly, it calls a pipeline the product SHIPS invalid and leaves
  // the board unusable. A DEPLOYMENT-registered kind can override gatability for itself through the
  // agent-kind registry, which the SPA cannot see, so the two are not perfectly symmetric: such a
  // kind is reported here and accepted by the engine. That is the safe direction of the asymmetry —
  // a dismissible advisory rather than a refused save — and the only one available without shipping
  // the registry to the browser.
  const gating = p.gating
  if (gating) {
    for (let i = 0; i < kinds.length; i++) {
      const g = gating[i] as StepGating | null | undefined
      if (!g?.enabled || !isEnabledAt(p, i)) continue
      const kind = kinds[i]
      if (!kind || !isBuiltinGatableKind(kind)) {
        return `Step '${kind}' may not be estimate-gated — its output is required by the rest of the run. Only a step whose result later steps read as context (a design, a review, an extra verification pass) may be skipped on the estimate.`
      }
      // A human approval gate and an estimate gate on the same step contradict: the estimate may
      // ADD a human checkpoint but never CANCEL a pause the pipeline author asked for.
      if (p.gates?.[i] === true) {
        return `Step '${kind}' carries a human approval gate, so it cannot also be estimate-gated — the estimate may add a human checkpoint but never remove one.`
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

  /** Catalog ids the backend reports as withdrawn, indexed to their (optional) replacement id. */
  const retiredIds = computed(
    () => new Map(store.retiredPipelines.map((p) => [p.id, p.replacedBy])),
  )

  const health = computed<PipelineHealth[]>(() => {
    const out: PipelineHealth[] = []
    for (const pipeline of store.pipelines) {
      // A retired pipeline is reported by `retired` below, never here: every problem this scan
      // raises is answered by a reseed, and there is no catalog definition left to reseed from.
      // (An invalid retired pipeline would otherwise get a Reseed button that can only 422.)
      if (retiredIds.value.has(pipeline.id)) continue
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
      .map((id) => ({ id, name: builtinPipelineName(id, store.catalogNames) }))
  })

  // Retired built-ins this workspace still stores: the ones seeded before the withdrawal. A
  // retirement the board never had a row for is nothing to report — there is no cleanup to do.
  const retired = computed<RetiredPipelineHealth[]>(() =>
    store.pipelines
      .filter((p) => retiredIds.value.has(p.id))
      .map((pipeline) => {
        const replacementId = retiredIds.value.get(pipeline.id)
        const replacement = replacementId ? resolveReplacement(replacementId) : undefined
        return { pipeline, ...(replacement ? { replacement } : {}) }
      }),
  )

  /**
   * Name the pipeline a retirement points at. Two sources, in order, because a replacement is a
   * LIVE catalog id and a live catalog id may or may not have been seeded into this workspace yet:
   * the stored row's authored name when there is one, else the catalog-derived name — the same
   * `builtinPipelineName` fallback `newPipelines` uses for exactly this "in the catalog, no row
   * yet" state. Reading only the store would blank the replacement on the most common retirement
   * (superseded by a newly shipped built-in, which by definition has no row until it is added).
   *
   * An id in neither returns undefined and the advisory falls back to the un-named copy: the
   * backend guards `replacedBy` against naming a non-existent pipeline, but a SPA running against
   * a newer backend can still be handed one it doesn't know, and inventing a name for it would be
   * worse than saying nothing.
   */
  function resolveReplacement(id: string): { id: string; name: string } | undefined {
    const stored = store.getPipeline(id)
    if (stored) return { id, name: stored.name }
    if (id in store.catalogVersions)
      return { id, name: builtinPipelineName(id, store.catalogNames) }
    return undefined
  }

  // An invalid built-in is reseeded (not deleted) and that also clears any "outdated" flag, so
  // exclude it from the outdated list to avoid offering the same fix twice.
  const invalid = computed(() => health.value.filter((h) => h.invalid))
  const outdated = computed(() => health.value.filter((h) => h.outdated && !h.invalid))
  const hasIssues = computed(
    () => health.value.length > 0 || newPipelines.value.length > 0 || retired.value.length > 0,
  )

  return { health, invalid, outdated, newPipelines, retired, hasIssues }
}
