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
 * A deterministic, key-order-independent content signature of the custom kinds, used as the
 * manifest `version`. The workspace snapshot re-delivers the SAME deployment-registered kinds on
 * every board-event refresh (a full `workspace.refresh()` runs `hydrateCustomKinds` each time), so
 * a content-derived version lets the store skip re-projecting an UNCHANGED catalog — otherwise
 * every refresh would replace the `customAgentKindMeta` read-model and needlessly invalidate the
 * ~17 `agentKindMeta` / `isKnownAgentKind` consumers. It still changes (and swaps wholesale) when a
 * different workspace's kinds actually differ. Serialized as fixed-order tuples of only the fields
 * that affect display/pairing, so a re-serialization with reordered object keys can't spuriously
 * differ.
 */
export function capabilitiesManifestVersion(kinds: readonly CustomAgentKind[]): string {
  return JSON.stringify(
    kinds.map((k) => [
      k.kind,
      k.container,
      k.presentation.label,
      k.presentation.icon,
      k.presentation.color,
      k.presentation.description,
      k.presentation.category ?? null,
      k.presentation.resultView ?? null,
    ]),
  )
}

/**
 * Model the snapshot's `customAgentKinds` as a single remote capability manifest. The `version` is
 * a {@link capabilitiesManifestVersion content signature} so identical snapshots produce an
 * identical manifest — which `useAgentsStore().hydrateCustomKinds` uses to no-op an unchanged
 * re-hydrate. Swapped wholesale (not diffed) when the content genuinely changes.
 */
export function buildAgentCapabilitiesManifest(
  kinds: readonly CustomAgentKind[],
): RemoteModuleManifest<AppSlots> {
  return {
    id: WORKSPACE_CAPABILITIES_MANIFEST_ID,
    version: capabilitiesManifestVersion(kinds),
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
