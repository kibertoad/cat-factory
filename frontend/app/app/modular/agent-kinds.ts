import type { AgentArchetype, CustomAgentKind } from '~/types/domain'

/**
 * Custom agent-kind projection (slice 2 of the modular-vue adoption —
 * backend/docs/adr/0049-modular-vue-adoption.md).
 *
 * A deployment's BACKEND-registered agent kinds arrive in the workspace snapshot as
 * `customAgentKinds` (wire data), folded into the shared per-workspace capability manifest
 * (see `./capabilities.ts`, generalized to carry custom TASK types too). CODE-shipped consumer
 * kinds instead enter via the static `agentKinds` slot (a `registerAppModule` module); the agents
 * store merges both. This module holds only the wire→display projection they share.
 */

/**
 * Project a wire `CustomAgentKind` onto the frontend's display `AgentArchetype`
 * (icon/label/color/description + optional category/resultView). The inverse of
 * the backend `agentPresentationSchema` — the SAME mapping the removed
 * `registerCustomKinds` did inline, now pure and shared by the consumer-slot and
 * backend-manifest paths.
 */
export function customKindToArchetype(kind: CustomAgentKind): AgentArchetype {
  const { presentation: p } = kind
  return {
    kind: kind.kind,
    label: p.label,
    icon: p.icon,
    color: p.color,
    description: p.description,
    ...(p.category ? { category: p.category } : {}),
    // A kind that declares no tier is left WITHOUT one rather than stamped with the default
    // here, so the single fallback stays in `agentTierVisibleAt` — filling it in at the
    // projection would fork the rule the moment the default changes.
    ...(p.tier ? { tier: p.tier } : {}),
    ...(p.resultView ? { resultView: p.resultView } : {}),
    // Not part of `presentation` on the wire — it is a fact about how the kind RUNS, projected
    // beside `container` — so it is lifted from the entry itself. Carried onto the archetype
    // because the pipeline builder resolves a step's meta through `agentKindMeta`, not through
    // the snapshot, and a required step option cannot be gated on something the read model
    // does not carry.
    ...(kind.binaryOutput ? { binaryOutput: true } : {}),
  }
}
