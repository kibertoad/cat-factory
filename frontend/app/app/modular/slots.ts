import type { Component } from 'vue'
import type { ComponentEntry, PanelEntry } from '@modular-vue/core'
import type { Block, CustomAgentKind, CustomTaskType } from '~/types/domain'
import type { TutorialTour } from '~/utils/tutorial'
import type { NavContribution } from './nav-contributions'
import type { ExternalToolContribution } from './external-tools'
import type { WorkspaceMetadataFieldDefinition } from './workspace-metadata'

/**
 * The layer's aggregated slot map — the single home for every slot key the
 * first-party modules (and consumer deployments) contribute to. Grows one key
 * per converted seam as the modular-vue adoption proceeds
 * (backend/docs/adr/0049-modular-vue-adoption.md):
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
 *  - `taskTypes` (extension slice B) — CODE-shipped custom task types a consumer
 *    module contributes (the create-task-picker + card-badge data half). BACKEND-
 *    registered types arrive separately in the shared capability manifest read by
 *    the task-types store — see `stores/taskTypes.ts`. Symmetric with `agentKinds`.
 *  - `taskTypeFormPanels` (extension slice B) — a bespoke create-task-form section
 *    per custom task type, addressed by the type's `formPanel` id and paired via
 *    `resolveComponentRegistry` (same shape as `resultViews`); shown INSTEAD of the
 *    descriptor-driven `fields`. An unpaired id degrades to the descriptor fields.
 *  - `tutorialTours` — the in-app tutorial catalog ({@link TutorialTour}: data-only
 *    guided tours anchored to `data-testid`s, no components). First-party tours come
 *    from `modular/tutorial-tours.ts`; a consumer contributes its own to the same slot
 *    and they appear in the launch prompt and the tutorial catalogue beside the built-ins.
 *    The one gated slot `navSlotFilter` does NOT filter: a tour's `requires` is resolved by
 *    `resolveTourCatalogue` in `useTutorialTours` instead, because the catalogue must list
 *    the tours this board can't run yet WITH what would unlock them — an annotation a
 *    slots-to-slots filter cannot carry.
 *  - `externalTools` — the deployment's OWN web applications, listed in their own
 *    "External tools" sidebar section ({@link ExternalToolContribution}). Each entry resolves
 *    its URL from the invocation context (user, workspace, the custom metadata below), so the
 *    tool opens already scoped to what the user is looking at; `useNavContributions` projects
 *    the gated slot onto the nav catalog, so the three shells render them like any other
 *    destination. Data-only, like `tutorialTours` — no components.
 *  - `workspaceMetadataFields` — the CUSTOM workspace metadata fields a deployment declares
 *    ({@link WorkspaceMetadataFieldDefinition}). The definitions are code-shipped here; the
 *    VALUES are per-workspace, typed into the settings panel and persisted on the workspace
 *    settings row. The pair exists so an external tool can be handed a workspace-specific id
 *    (`gameId`) the platform itself has no opinion about.
 *  - `appOverlays` (extension slice D) — top-level modals/overlays a consumer module
 *    contributes ({@link OverlayContribution}, an id → component `ComponentEntry`),
 *    opened by `ui.openOverlay(id, subject?)` / `useAppOverlays().open(...)` and
 *    mounted by the single `<AppOverlayHost>` in `pages/index.vue` (which selects the
 *    active entry through `resolveComponentRegistry`, the same pick-one primitive
 *    `resultViews` uses). This is the one host surface a consumer flatly could not
 *    extend before — a nav item's `run` closure now has something to open. First-party
 *    modals stay hand-mounted in `index.vue`; the seam is for consumer overlays.
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
  taskTypes: CustomTaskType[]
  taskTypeFormPanels: ResultViewContribution[]
  appOverlays: OverlayContribution[]
  tutorialTours: TutorialTour[]
  externalTools: ExternalToolContribution[]
  workspaceMetadataFields: WorkspaceMetadataFieldDefinition[]
  [key: string]: unknown[]
}

/**
 * One dedicated result-view window, addressed by its `resultView` id (the same
 * ids as `@cat-factory/contracts` `RESULT_VIEW_IDS` for the built-ins). A plain
 * `ComponentEntry` so the modular `resolveComponentRegistry` / `pairById`
 * helpers index and pair it with the wire-delivered `presentation.resultView`
 * id — the sanctioned "backend data selects a code-shipped, locally-registered
 * component" pairing (see the modular-vue Remote Capability Manifests guide).
 * Reused for `taskTypeFormPanels` (a bespoke create-form section paired by a
 * custom task type's `formPanel` id).
 */
export type ResultViewContribution = ComponentEntry<Component>

/**
 * One consumer-contributed top-level overlay (a modal/panel with no first-party
 * home), addressed by its namespaced `<ns>:<name>` id. A plain `ComponentEntry`,
 * so `<AppOverlayHost>` indexes the merged `appOverlays` slot with the same
 * `resolveComponentRegistry` pick-one primitive as `resultViews` and mounts the
 * entry whose id matches the active `ui.openOverlay(...)` request. The overlay
 * component receives the (optional) subject as a `subject` prop and emits `close`;
 * it composes the layer's `ResultWindowShell` / `useModalBehavior` for its own
 * chrome (see the consumer-extensions guide).
 */
export type OverlayContribution = ComponentEntry<Component>
