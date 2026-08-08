import type { RemoteModuleManifest } from '@modular-vue/core'
import type { CustomAgentKind, CustomTaskType } from '~/types/domain'
import type { AppSlots } from './slots'

/**
 * The per-workspace capability manifest (modular-vue adoption slice 2 + the
 * frontend-extension-mechanism initiative, slice B).
 *
 * A deployment's BACKEND-registered capabilities arrive in the workspace snapshot as wire data
 * — `customAgentKinds` (slice 2) AND `customTaskTypes` (slice B). Rather than mutating
 * module-global catalogs, BOTH are folded into ONE {@link RemoteModuleManifest} whose slots carry
 * the data. cat-factory holds ONE active manifest per workspace (swapped on snapshot), so each
 * store reads its OWN slot off the shared manifest — the sanctioned single-active-manifest shape
 * (`mergeRemoteManifests` is for holding several at once, which we don't). CODE-shipped consumer
 * capabilities instead enter via the static `agentKinds` / `taskTypes` slots (a `registerAppModule`
 * module); each store merges its slot + its manifest half.
 */

/** The stable id for the per-workspace capability manifest built from the snapshot. */
export const WORKSPACE_CAPABILITIES_MANIFEST_ID = 'cat-factory:workspace-capabilities'

/**
 * Every key of `value`, recursively, in sorted order: the canonical form
 * {@link workspaceCapabilitiesVersion} signs. Arrays keep their order (a capability list's order is
 * content: it is the order the palette and the picker render in); objects lose theirs, so a
 * re-serialization with reordered keys can't spuriously differ.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

/**
 * A deterministic, key-order-independent content signature covering BOTH capability lists, used as
 * the manifest `version`. The workspace snapshot re-delivers the SAME deployment capabilities on
 * every board-event refresh (a full `workspace.refresh()` re-hydrates each time), so a
 * content-derived version lets each store skip re-projecting an UNCHANGED catalog: otherwise every
 * refresh would replace its read-model and needlessly invalidate every `agentKindMeta` /
 * `taskTypeMeta` consumer. It still changes (and swaps wholesale) when a different workspace's
 * capabilities genuinely differ.
 *
 * Signs the WHOLE entry, canonicalized, rather than a hand-listed tuple of the fields that seemed
 * to matter. The two mistakes are not symmetric: folding in a field nothing renders costs one
 * re-projection nobody sees, while OMITTING one costs correctness, because `hydrateCapabilities`
 * short-circuits on an unchanged version and the store then keeps serving the PREVIOUS declaration
 * until something else swaps the manifest. A field list drifts silently into that: it was missing
 * `tier` and `binaryOutput` before `purposes` was added to it, so a backend that re-declared any of
 * the three reached an open tab as the catalog it had replaced. There is nothing volatile in either
 * shape (no timestamps, no ids minted per request), so signing all of it costs nothing.
 */
export function workspaceCapabilitiesVersion(
  kinds: readonly CustomAgentKind[],
  taskTypes: readonly CustomTaskType[],
): string {
  return JSON.stringify([canonicalize(kinds), canonicalize(taskTypes)])
}

/**
 * Model the snapshot's `customAgentKinds` + `customTaskTypes` as a single remote capability
 * manifest. The `version` is a {@link workspaceCapabilitiesVersion content signature over both
 * lists} so identical snapshots produce an identical manifest — which each store's
 * `hydrateCapabilities` uses to no-op an unchanged re-hydrate. Swapped wholesale (not diffed) when
 * the content genuinely changes.
 */
export function buildWorkspaceCapabilitiesManifest(
  kinds: readonly CustomAgentKind[],
  taskTypes: readonly CustomTaskType[],
): RemoteModuleManifest<AppSlots> {
  return {
    id: WORKSPACE_CAPABILITIES_MANIFEST_ID,
    version: workspaceCapabilitiesVersion(kinds, taskTypes),
    slots: { agentKinds: [...kinds], taskTypes: [...taskTypes] },
  }
}
