import type { AgentArchetype, CustomAgentKind } from '~/types/domain'

/**
 * Custom agent-kind projection (slice 2 of the modular-vue adoption —
 * docs/initiatives/modular-vue-adoption.md).
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
    ...(p.resultView ? { resultView: p.resultView } : {}),
  }
}
