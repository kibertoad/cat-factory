import type { Component } from 'vue'
import type { ComponentEntry, PanelEntry } from '@modular-vue/core'
import type { Block, CustomAgentKind } from '~/types/domain'
import type { NavContribution } from './nav-contributions'

/**
 * The layer's aggregated slot map — the single home for every slot key the
 * first-party modules (and consumer deployments) contribute to. Grows one key
 * per converted seam as the modular-vue adoption proceeds
 * (docs/initiatives/modular-vue-adoption.md):
 *
 *  - `nav` (slice 1) — the nav/command catalog, rendered by the three shells.
 *  - `resultViews` (slice 2) — the id → dedicated result-window registry
 *    ({@link ResultViewContribution}), read by `StepResultViewHost` through
 *    `resolveComponentRegistry`. First-party AND consumer components enter here.
 *  - `agentKinds` (slice 2) — CODE-shipped custom agent kinds a consumer module
 *    contributes (the palette/catalog data half). BACKEND-registered kinds
 *    arrive separately as a {@link RemoteModuleManifest} read in the agents
 *    store — see `stores/agents.ts`.
 *  - `inspectorPanels` (slice 4) — the subject-keyed detail panels of the block
 *    inspector ({@link PanelEntry} over a `Block`), rendered all-matching + ordered
 *    by `<PanelsOutlet>` and gated per-block by each entry's `when(block)`
 *    predicate. Replaces `InspectorPanel.vue`'s level/type `v-if` fan; a consumer
 *    contributes its own panels to the SAME slot via `registerAppModule`. This is
 *    the slot key `definePanelGroup<Block>('inspectorPanels')` names.
 *
 * The index signature is mutable (`unknown[]`) to satisfy the runtime's
 * `SlotMap` constraint while `unknown[]` still meets `useReactiveSlots`'
 * `readonly unknown[]` bound (the slice-1 type-friction note).
 */
export interface AppSlots {
  nav: NavContribution[]
  resultViews: ResultViewContribution[]
  agentKinds: CustomAgentKind[]
  inspectorPanels: PanelEntry<Block>[]
  [key: string]: unknown[]
}

/**
 * One dedicated result-view window, addressed by its `resultView` id (the same
 * ids as `@cat-factory/contracts` `RESULT_VIEW_IDS` for the built-ins). A plain
 * `ComponentEntry` so the modular `resolveComponentRegistry` / `pairById`
 * helpers index and pair it with the wire-delivered `presentation.resultView`
 * id — the sanctioned "backend data selects a code-shipped, locally-registered
 * component" pairing (see the modular-vue Remote Capability Manifests guide).
 */
export type ResultViewContribution = ComponentEntry<Component>
