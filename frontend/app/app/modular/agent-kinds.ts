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
    // Carried verbatim, INCLUDING a list this build cannot fully name: `purposeSuggestsAgentKind`
    // owns the reading of an unrecognised member, so filtering here would fork that rule.
    ...(p.purposes?.length ? { purposes: p.purposes } : {}),
    // A kind that declares no tier is left WITHOUT one rather than stamped with the default
    // here, so the single fallback stays in `agentTierVisibleAt` — filling it in at the
    // projection would fork the rule the moment the default changes.
    ...(p.tier ? { tier: p.tier } : {}),
    ...(p.resultView ? { resultView: p.resultView } : {}),
    // The kind is the platform's to dispatch, not a block anyone places. Carried onto the
    // archetype rather than dropped at the projection because the catalog is also the READ MODEL
    // every run view resolves a step's label and icon through: filtering it out here would leave
    // the wizard's own analyst run rendering as an unknown kind.
    ...(p.internal ? { internal: true } : {}),
    // Not part of `presentation` on the wire — it is a fact about how the kind RUNS, projected
    // beside `container` — so it is lifted from the entry itself. Carried onto the archetype
    // because the pipeline builder resolves a step's meta through `agentKindMeta`, not through
    // the snapshot, and a required step option cannot be gated on something the read model
    // does not carry.
    ...(kind.binaryOutput ? { binaryOutput: true } : {}),
    // WHERE the kind's work runs, when it leaves the platform. Lifted from the entry rather than
    // from `presentation` for the reason `binaryOutput` is: it is a fact about how the kind RUNS.
    //
    // A `delegated` kind with no executor resolved still carries its ID, so the card can name what
    // this build cannot: an executor a deployment stopped registering is a step nobody can run,
    // and rendering it as an ordinary one is how that goes unnoticed until a run refuses.
    //
    // Carried only when the entry actually has one. A synthesised `{ id: '' }` was worse than no
    // entry at all: the empty string is not nullish, so it satisfied every `??` fallback downstream
    // and the card rendered a blank name in precisely the case this branch exists to handle.
    ...(kind.executor === 'delegated' && kind.delegatedExecutor
      ? {
          delegatedExecutor: {
            id: kind.delegatedExecutor.id,
            ...(kind.delegatedExecutor.label ? { label: kind.delegatedExecutor.label } : {}),
            ...(kind.delegatedExecutor.description
              ? { description: kind.delegatedExecutor.description }
              : {}),
            ...(kind.delegatedExecutor.telemetry
              ? { telemetry: kind.delegatedExecutor.telemetry }
              : {}),
          },
        }
      : {}),
  }
}
