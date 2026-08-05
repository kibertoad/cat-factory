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
  'task-review-target',
  'task-context-docs',
  'task-context-issues',
  'recurring-schedule',
  'task-execution',
  'task-estimate',
  'task-dependencies',
  'task-run-settings',
  'task-agent-config',
  'task-type-fields',
  'task-structure',
  // service / module body
  'container-summary',
  'frontend-config',
  'service-connections',
  'service-test-config',
  'service-test-secrets',
  'service-fragments',
  'service-release-health',
  'service-validation-checks',
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
/**
 * A block whose inspector carries a pipeline RUN. An initiative's planning pipeline is an
 * ordinary run of ordinary agent steps (analyst → interviewer → planner → committer), so it
 * gets the same execution panel a task does — step list, live phases, step-detail drill-down,
 * and the Stop / Discard-run controls that are the only way to unwedge a stalled planning run.
 * Before this it had no run surface at all, which is why a stuck plan was a dead end.
 */
const hasRuns = (b: Block) => isTask(b) || b.level === 'initiative'
/**
 * A block that carries attached CONTEXT (imported documents + tracker issues). The
 * create-initiative modal stages the same attachments the add-task modal does and links them
 * to the initiative block, and the whole planning pipeline reads them — so an initiative
 * whose inspector never showed them left the user with no evidence the attachment landed and
 * no way to reach the source. Same panels, same store reads (both are keyed by block id only).
 */
const takesContext = (b: Block) => isTask(b) || b.level === 'initiative'
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
  // FIRST in the task body: for a review task the reviewed PR is what the task IS, so it reads
  // above the context it was given and the run that acts on it. Gated on the task TYPE alone —
  // the panel itself hides when the task carries no PR reference.
  { id: 'task-review-target', order: 5, when: (b) => isTask(b) && b.taskType === 'review' },
  // Shared with the initiative body — an initiative takes the same attachments a task does.
  { id: 'task-context-docs', order: 10, when: takesContext },
  { id: 'task-context-issues', order: 20, when: takesContext },
  { id: 'recurring-schedule', order: 30, when: isTask },
  // Shared with the initiative body — the panel renders a RUN, and an initiative has one.
  { id: 'task-execution', order: 40, when: hasRuns },
  { id: 'task-estimate', order: 50, when: isTask },
  { id: 'task-dependencies', order: 60, when: isTask },
  { id: 'task-run-settings', order: 70, when: isTask },
  { id: 'task-agent-config', order: 80, when: isTask },
  // The answers to a CUSTOM task type's declared fields. Gated on being a task alone; the panel
  // itself hides unless the task's type is one this deployment registered WITH descriptor fields,
  // which is the only case there is anything to edit. It sits beside the other task inputs rather
  // than under Run settings: these are what the task IS, not how it runs.
  { id: 'task-type-fields', order: 85, when: isTask },
  { id: 'task-structure', order: 90, when: isTask },
  { id: 'container-summary', order: 110, when: isContainer },
  { id: 'frontend-config', order: 120, when: (b) => isFrame(b) && b.type === 'frontend' },
  { id: 'service-connections', order: 130, when: (b) => isFrame(b) && b.type === 'service' },
  { id: 'service-test-config', order: 140, when: isDeployableFrame },
  { id: 'service-test-secrets', order: 150, when: isDeployableFrame },
  { id: 'service-fragments', order: 160, when: isFrame },
  { id: 'service-release-health', order: 170, when: isDeployableFrame },
  // Pre-PR validation checks: the commands the harness runs before opening this service's PRs.
  // Deployable frames only — a doc repo ships no build to install/lint/test, exactly like the
  // test-infra and release-health panels above it.
  { id: 'service-validation-checks', order: 180, when: isDeployableFrame },
  { id: 'epic-children', order: 200, when: (b) => b.level === 'epic' },
  // Ordered FIRST so an initiative reads the way a task does: its own identity + controls, then
  // the context it was given (10/20), then the run detail (40). Levels never overlap, so this
  // number only ever competes with the task ids the initiative body doesn't render.
  { id: 'initiative-inspector', order: 5, when: (b) => b.level === 'initiative' },
]
