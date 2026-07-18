import type { RemoteModuleManifest } from '@modular-vue/core'
import type { AgentArchetype, CustomAgentKind } from '~/types/domain'
import type { AppSlots } from './slots'

/**
 * Custom agent kinds as remote capability manifests (slice 2 of the modular-vue
 * adoption — docs/initiatives/modular-vue-adoption.md).
 *
 * A deployment's BACKEND-registered agent kinds arrive in the workspace snapshot
 * as `customAgentKinds` (wire data). Rather than mutating a module-global
 * catalog, they're modeled as a single {@link RemoteModuleManifest} whose
 * `agentKinds` slot carries the data. cat-factory holds ONE active manifest per
 * workspace (swapped on snapshot), so the agents store reads its `.slots`
 * directly — the sanctioned single-active-manifest shape (the merge-many
 * `mergeRemoteManifests` helper is for holding several manifests at once, which
 * we don't). CODE-shipped consumer kinds instead enter via the static
 * `agentKinds` slot (a `registerAppModule` module); the store merges both.
 */

/** The stable id for the per-workspace capability manifest built from the snapshot. */
export const WORKSPACE_CAPABILITIES_MANIFEST_ID = 'cat-factory:workspace-capabilities'

/**
 * Model the snapshot's `customAgentKinds` as a single remote capability
 * manifest. `version` is a constant — this manifest is swapped wholesale per
 * workspace, not diffed, so it needs no real versioning.
 */
export function buildAgentCapabilitiesManifest(
  kinds: readonly CustomAgentKind[],
): RemoteModuleManifest<AppSlots> {
  return {
    id: WORKSPACE_CAPABILITIES_MANIFEST_ID,
    version: '1',
    slots: { agentKinds: [...kinds] },
  }
}

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
