import { type Component, defineComponent, h } from 'vue'
import { defineModule, usePanelSubject } from '@modular-vue/core'
import type { PanelEntry } from '@modular-vue/core'
import type { Block } from '~/types/domain'

/** The engine's opaque component type on a `PanelEntry` (the neutral `UiComponent`,
 *  which isn't exported by name). A Vue component is a valid one; the outlet renders
 *  it as a Vue component. We reference it structurally so no cast reaches for `any`. */
type PanelComponent = PanelEntry<Block>['component']
import {
  INSPECTOR_PANELS_SLOT,
  INSPECTOR_PANEL_SPECS,
  type InspectorPanelId,
} from '~/modular/panels/inspector.logic'
import TaskContextDocs from '~/components/documents/TaskContextDocs.vue'
import TaskContextIssues from '~/components/tasks/TaskContextIssues.vue'
import RecurringScheduleSettings from '~/components/panels/inspector/RecurringScheduleSettings.vue'
import TaskExecution from '~/components/panels/inspector/TaskExecution.vue'
import TaskEstimateBadge from '~/components/panels/inspector/TaskEstimateBadge.vue'
import TaskDependencies from '~/components/panels/inspector/TaskDependencies.vue'
import TaskRunSettings from '~/components/panels/inspector/TaskRunSettings.vue'
import TaskAgentConfig from '~/components/panels/inspector/TaskAgentConfig.vue'
import TaskStructure from '~/components/panels/inspector/TaskStructure.vue'
import ContainerSummary from '~/components/panels/inspector/ContainerSummary.vue'
import FrontendConfig from '~/components/panels/inspector/FrontendConfig.vue'
import ServiceConnections from '~/components/panels/inspector/ServiceConnections.vue'
import ServiceTestConfig from '~/components/panels/inspector/ServiceTestConfig.vue'
import ServiceTestSecrets from '~/components/panels/inspector/ServiceTestSecrets.vue'
import ServiceFragments from '~/components/panels/inspector/ServiceFragments.vue'
import ServiceReleaseHealthConfig from '~/components/panels/inspector/ServiceReleaseHealthConfig.vue'
import EpicChildren from '~/components/panels/inspector/EpicChildren.vue'
import InitiativeInspector from '~/components/panels/inspector/InitiativeInspector.vue'

/**
 * Component wiring for the block-inspector panel group (slice 4). The gating +
 * ordering live in `inspector.logic.ts` (pure, unit-tested); this file attaches
 * the sub-panel SFCs and registers the module. It imports `.vue`, so — like
 * `result-views.ts` and the journey step module — it is registered from the
 * client plugin via `extraModules`, keeping the unit-tested `registry.ts` import
 * graph SFC-free.
 */

/**
 * Bridge a `block`-prop sub-panel onto the subject-keyed panels primitive.
 * `<PanelsOutlet>` injects the selected block as the panel *subject* (a `subject`
 * prop + a `provide`), but the existing inspector sub-panels take a `block` prop
 * (and several — `TaskExecution`, `ServiceTestConfig` — are reused OUTSIDE the
 * inspector, so their prop can't be renamed). So each entry's component is this
 * thin wrapper: it reads the injected subject via `usePanelSubject` and forwards
 * it as `:block`. The host sets `<PanelsOutlet :subject-key="b => b.id">`, so the
 * wrapper remounts on block switch — matching the pre-slice-4 per-panel
 * `:key="…-${block.id}"`.
 */
function blockPanel(component: Component, id: InspectorPanelId): PanelComponent {
  return defineComponent({
    name: `InspectorPanel__${id}`,
    setup() {
      const block = usePanelSubject<Block>()
      return () => h(component, { block: block.value })
    },
  }) as unknown as PanelComponent
}

/** Exhaustive id → sub-panel map. Typed `Record<InspectorPanelId, …>` so adding a
 *  spec without a component (or vice-versa) fails the typecheck. */
const COMPONENTS: Record<InspectorPanelId, Component> = {
  'task-context-docs': TaskContextDocs,
  'task-context-issues': TaskContextIssues,
  'recurring-schedule': RecurringScheduleSettings,
  'task-execution': TaskExecution,
  'task-estimate': TaskEstimateBadge,
  'task-dependencies': TaskDependencies,
  'task-run-settings': TaskRunSettings,
  'task-agent-config': TaskAgentConfig,
  'task-structure': TaskStructure,
  'container-summary': ContainerSummary,
  'frontend-config': FrontendConfig,
  'service-connections': ServiceConnections,
  'service-test-config': ServiceTestConfig,
  'service-test-secrets': ServiceTestSecrets,
  'service-fragments': ServiceFragments,
  'service-release-health': ServiceReleaseHealthConfig,
  'epic-children': EpicChildren,
  'initiative-inspector': InitiativeInspector,
}

/** The built-in `PanelEntry`s: each spec's gating/order + its wrapped component. */
export const INSPECTOR_PANEL_ENTRIES: PanelEntry<Block>[] = INSPECTOR_PANEL_SPECS.map((spec) => ({
  id: spec.id,
  order: spec.order,
  when: spec.when,
  component: blockPanel(COMPONENTS[spec.id], spec.id),
}))

/** The first-party module: contributes the built-in panels to the `inspectorPanels`
 *  slot. Registered by the client plugin (`extraModules`). */
export const inspectorPanelsModule = defineModule({
  id: 'cat-factory:inspector-panels',
  version: '1.0.0',
  slots: { [INSPECTOR_PANELS_SLOT]: INSPECTOR_PANEL_ENTRIES },
})
