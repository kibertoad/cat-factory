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
 * A deterministic, key-order-independent content signature covering BOTH capability lists, used as
 * the manifest `version`. The workspace snapshot re-delivers the SAME deployment capabilities on
 * every board-event refresh (a full `workspace.refresh()` re-hydrates each time), so a
 * content-derived version lets each store skip re-projecting an UNCHANGED catalog — otherwise every
 * refresh would replace its read-model and needlessly invalidate every `agentKindMeta` /
 * `taskTypeMeta` consumer. It still changes (and swaps wholesale) when a different workspace's
 * capabilities genuinely differ. Serialized as fixed-order tuples of only the fields that affect
 * display/pairing, so a re-serialization with reordered object keys can't spuriously differ.
 */
export function workspaceCapabilitiesVersion(
  kinds: readonly CustomAgentKind[],
  taskTypes: readonly CustomTaskType[],
): string {
  return JSON.stringify([
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
    taskTypes.map((t) => [
      t.taskType,
      t.presentation.label,
      t.presentation.icon,
      t.presentation.color,
      t.presentation.description,
      t.defaultPipelineId ?? null,
      t.formPanel ?? null,
      // The descriptor list affects the create-form, so fold its shape into the signature too.
      (t.fields ?? []).map((f) => [f.key, f.type, f.label, f.required ?? false]),
    ]),
  ])
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
