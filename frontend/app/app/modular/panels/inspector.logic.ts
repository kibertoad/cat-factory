import { definePanelGroup } from '@modular-vue/core'
import type { Block } from '~/types/domain'

/**
 * Pure definition of the block-inspector panel group (slice 4 of the modular-vue
 * adoption — docs/initiatives/modular-vue-adoption.md).
 *
 * The inspector used to be a 631-line `v-if` fan in `InspectorPanel.vue` that
 * switched its body on the selected block's `level` (frame/module/task/epic/
 * initiative) and, inside the frame branch, on `type` (frontend/service). Slice 4
 * turns that fan into the upstream **subject-keyed panels** primitive: each body
 * sub-panel is a `PanelEntry<Block>` contributed to the `inspectorPanels` slot,
 * and `<PanelsOutlet>` renders every entry whose `when(block)` passes, ordered by
 * `order`, with the selected block injected as the subject. A consumer deployment
 * contributes its OWN inspector panels (e.g. for a custom block type) to the SAME
 * slot via `registerAppModule`, with zero host edits.
 *
 * This file is deliberately free of `.vue`/`defineModule` imports so the gating +
 * ordering is unit-tested directly (`inspector.logic.spec.ts`) via the pure
 * `resolvePanels`; the component wiring (which imports the sub-panel SFCs) lives
 * in `inspector.ts`, registered from the client plugin — the same split as the
 * result-views and journey modules. (`definePanelGroup` is a pure `{ slotKey }`
 * token, so the group handle belongs here where every call site shares it.)
 */

/** The slot key the inspector panel entries are contributed under (and that the
 *  group handle names). Also the `AppSlots` key — keep the two in step. */
export const INSPECTOR_PANELS_SLOT = 'inspectorPanels' as const

/** The typed panel-group handle — `usePanels(inspectorPanels, block)` /
 *  `<PanelsOutlet :group="inspectorPanels" :subject="block">` resolve against it. */
export const inspectorPanels = definePanelGroup<Block>(INSPECTOR_PANELS_SLOT)

/** Every built-in inspector panel id. A const union so the component map in
 *  `inspector.ts` is exhaustive (a spec with no component is a compile error, not
 *  a silently-dropped panel). */
export const INSPECTOR_PANEL_IDS = [
  // task body (rendered in this order under the identity block)
  'task-context-docs',
  'task-context-issues',
  'recurring-schedule',
  'task-execution',
  'task-estimate',
  'task-dependencies',
  'task-run-settings',
  'task-agent-config',
  'task-structure',
  // service / module body
  'container-summary',
  'frontend-config',
  'service-connections',
  'service-test-config',
  'service-test-secrets',
  'service-fragments',
  'service-release-health',
  // epic / initiative body
  'epic-children',
  'initiative-inspector',
] as const

export type InspectorPanelId = (typeof INSPECTOR_PANEL_IDS)[number]

/** The gating + ordering for one built-in inspector panel — the `PanelEntry`
 *  minus its component (attached in `inspector.ts`). `when` is the predicate
 *  lifted verbatim from the panel's old `v-if`; `order` preserves the pre-slice-4
 *  render order within a level (levels never overlap, so cross-level order is
 *  irrelevant and the values are just grouped by level). */
export interface InspectorPanelSpec {
  id: InspectorPanelId
  order: number
  when: (block: Block) => boolean
}

const isTask = (b: Block) => b.level === 'task'
const isFrame = (b: Block) => b.level === 'frame'
/** frame OR module — the "container" panels. */
const isContainer = (b: Block) => b.level === 'frame' || b.level === 'module'
/**
 * A frame that gets built, tested and deployed as a running thing — i.e. every frame
 * EXCEPT a `document` repo. A document repo (`FrameRepoType` `document`) only runs
 * doc/spike tasks + doc pipelines: it stands up no test environment, holds no test
 * credentials and never ships a release to watch, so the test-infrastructure /
 * test-credentials / post-release-health panels don't apply to it and are hidden.
 */
const isDeployableFrame = (b: Block) => isFrame(b) && b.type !== 'document'

/**
 * The built-in panel specs. The `when` predicates and orders reproduce
 * `InspectorPanel.vue`'s pre-slice-4 behaviour exactly (pinned by
 * `inspector.logic.spec.ts`):
 *  - task body: context docs/issues, then schedule → execution → estimate →
 *    dependencies → run-settings → agent-config → structure.
 *  - service/module body: container summary (frame|module), then the frame-only
 *    panels, with frontend-config / service-connections further gated on `type`,
 *    and the test-infrastructure / test-credentials / post-release-health panels
 *    hidden for a `document` frame (a doc repo has no test env / release to config).
 *  - epic / initiative bodies: their single inspector.
 *
 * The frame-only "view requirements" button and the cross-cutting run banners
 * (`AgentFailureCard` / `AgentStopButton`) stay in the host shell — they are not
 * level-keyed body panels, so converting them would add ceremony without
 * extensibility value.
 */
export const INSPECTOR_PANEL_SPECS: readonly InspectorPanelSpec[] = [
  { id: 'task-context-docs', order: 10, when: isTask },
  { id: 'task-context-issues', order: 20, when: isTask },
  { id: 'recurring-schedule', order: 30, when: isTask },
  { id: 'task-execution', order: 40, when: isTask },
  { id: 'task-estimate', order: 50, when: isTask },
  { id: 'task-dependencies', order: 60, when: isTask },
  { id: 'task-run-settings', order: 70, when: isTask },
  { id: 'task-agent-config', order: 80, when: isTask },
  { id: 'task-structure', order: 90, when: isTask },
  { id: 'container-summary', order: 110, when: isContainer },
  { id: 'frontend-config', order: 120, when: (b) => isFrame(b) && b.type === 'frontend' },
  { id: 'service-connections', order: 130, when: (b) => isFrame(b) && b.type === 'service' },
  { id: 'service-test-config', order: 140, when: isDeployableFrame },
  { id: 'service-test-secrets', order: 150, when: isDeployableFrame },
  { id: 'service-fragments', order: 160, when: isFrame },
  { id: 'service-release-health', order: 170, when: isDeployableFrame },
  { id: 'epic-children', order: 200, when: (b) => b.level === 'epic' },
  { id: 'initiative-inspector', order: 210, when: (b) => b.level === 'initiative' },
]
