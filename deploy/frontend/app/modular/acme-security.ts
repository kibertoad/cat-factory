// A WORKED EXAMPLE of a CONSUMER frontend extension module — the frontend analogue of the
// backend `@cat-factory/example-custom-agent` package. It teaches the `@cat-factory/app`
// layer new frontend behaviour purely through the public `registerAppModule` seam (see
// `../plugins/acme-security.client.ts`), with ZERO host edits and ZERO fork: everything is
// a slot contribution keyed by a namespaced id.
//
// This single module exercises EVERY landed consumer seam at once:
//   - `resultViews`     — a bespoke run-detail window (`AcmeSecurityReport`) paired to the
//                         `acme:security-report` id, opened when a `security-auditor` step
//                         is inspected. It reuses the layer's shared `ResultWindowShell` +
//                         `StepRunMeta` run-metadata block (see the component).
//   - `agentKinds`      — the palette/catalog entry for the `security-auditor` kind, which
//                         POINTS its `resultView` at `acme:security-report`. A deployment
//                         that also ships `@cat-factory/example-custom-agent` on the backend
//                         gets a first-class palette block whose runs open THIS window
//                         (backend data × code-shipped component, joined by the id).
//   - `nav`             — a sidebar + command-palette destination with its own `run`, which
//                         now opens the `appOverlays` overlay below (extension slice D).
//   - `appOverlays`     — a CODE-shipped top-level OVERLAY (`AcmeSecurityDashboard`, extension
//                         slice D) the nav `run` opens via `useAppOverlays()`. The one host
//                         surface a consumer could not extend before; it reuses the layer's
//                         shared `ResultWindowShell` chrome with ZERO host edits.
//   - `inspectorPanels` — an extra inspector body panel for task blocks.
//   - `externalTools`   — the deployment's OWN web applications, listed under the "External
//                         tools" sidebar section. Each resolves its URL from the invocation
//                         CONTEXT (user, workspace, and the custom workspace metadata below),
//                         so a click lands on the right state instead of the tool's front door.
//                         This is the case the seam exists for: a map editor opened already
//                         switched to the game this board is about.
//   - `workspaceMetadataFields` — the CUSTOM workspace fields whose values an operator types
//                         into Workspace settings -> Metadata (a tab that exists only where a
//                         deployment declares fields), and which the resolver above reads. The
//                         platform has no opinion about `gameId`; this pair is what lets a
//                         deployment give it one.
//   - `taskTypes`       — a CODE-shipped CUSTOM task type (`acme:incident`, extension slice B)
//                         with descriptor-driven create-form fields. It becomes a first-class
//                         create-task choice + card badge with ZERO host edits — the frontend
//                         twin of a backend-registered agent kind. (A deployment can also deliver
//                         a task type from the backend via its app-owned `TaskTypeRegistry`; the
//                         SPA merges both into one catalog. This shows the code-shipped channel.)
//
// See `frontend/app/app/docs/consumer-extensions.md` for the authoring walkthrough.
import { defineModule } from '@modular-vue/core'
import type { PanelEntry } from '@modular-vue/core'
import AcmeSecurityReport from '../components/acme/AcmeSecurityReport.vue'
import AcmeIncidentPanel from '../components/acme/AcmeIncidentPanel.vue'
import AcmeSecurityDashboard from '../components/acme/AcmeSecurityDashboard.vue'

/** The namespaced result-view id shared by the window (the `resultViews` entry) and the
 *  agent kind that selects it (the `agentKinds` entry) — the pairing key. */
export const ACME_SECURITY_REPORT_VIEW = 'acme:security-report'

/** The namespaced overlay id shared by the `appOverlays` entry and the nav item that opens
 *  it (extension slice D) — the pairing key for a consumer top-level overlay. */
export const ACME_SECURITY_DASHBOARD_OVERLAY = 'acme:security-dashboard-overlay'

/** The backend agent kind this deployment provides a bespoke window for. Matches
 *  `SECURITY_AUDITOR_KIND` in `@cat-factory/example-custom-agent`. */
const SECURITY_AUDITOR_KIND = 'security-auditor'

/** The CUSTOM task type this deployment contributes (a namespaced `<ns>:<name>` id). */
export const ACME_INCIDENT_TASK_TYPE = 'acme:incident'

/**
 * The registration shapes for the two slots this module adds, copied structurally so the example
 * needs no deep import of the layer's `modular/*` types (the reachable public type is slice G's
 * work) — the same treatment `CustomTaskTypeContribution` below gets.
 */
interface ExternalToolContribution {
  id: string
  title: string
  description?: string
  icon: string
  url: string | ((context: ExternalToolInvocation) => string | null)
  requiredMetadata?: readonly string[]
  order?: number
}

/** What a resolver may read about the click: who, which board, and the board's custom fields. */
interface ExternalToolInvocation {
  userId: string | null
  userEmail: string | null
  workspaceId: string
  workspaceName: string
  metadata: Readonly<Record<string, string>>
}

interface WorkspaceMetadataFieldDefinition {
  key: string
  label: string
  description?: string
  placeholder?: string
  type?: 'text' | 'number' | 'select'
  options?: readonly { value: string; label: string }[]
  order?: number
}

/** The subject the inspector panel filters on — typed structurally so the example needs no
 *  deep import of the layer's `Block` type (the reachable public type is slice G's work). */
interface InspectedBlock {
  level?: 'frame' | 'module' | 'task'
}

/**
 * The wire shape of a custom task type (a structural copy of `@cat-factory/contracts`'s
 * `CustomTaskType`, so the example needs no deep import — the reachable public type is slice G).
 * `taskType` is a namespaced id; `fields` are the descriptor-driven create-form inputs whose
 * values land in the task's sparse `taskTypeFields.custom` bag.
 *
 * Kept in step with the contract deliberately: a deployment reads THIS to learn what it may
 * declare, so a copy missing an axis reads as an axis that does not exist. `presentation.category`
 * groups the create-task picker, `defaultFragmentIds` seeds standing context, and `fields` spans
 * the whole shared descriptor vocabulary except `password` (a task field value reaches prompts and
 * telemetry, so it is the wrong home for a secret).
 */
interface CustomTaskTypeContribution {
  taskType: string
  presentation: {
    label: string
    icon: string
    color: string
    description: string
    category?: string
  }
  fields?: {
    key: string
    label: string
    type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'checkbox-group' | 'path'
    help?: string
    placeholder?: string
    options?: { value: string; label: string }[]
    required?: boolean
    default?: string
    defaultValues?: string[]
    showWhen?: { key: string; equals?: string | boolean | number; includes?: string }
    maxLength?: number
  }[]
  defaultPipelineId?: string
  defaultFragmentIds?: string[]
  formPanel?: string
}

/**
 * The consumer module. Slot contributions are plain data + component references; the layer
 * merges them into its own slots at boot (duplicate namespaced ids fail fast, unpaired ids
 * degrade to the generic rendering). `registerAppModule` accepts any module descriptor.
 */
export const acmeSecurityModule = defineModule({
  id: 'acme:security',
  version: '1.0.0',
  slots: {
    // The bespoke run-detail window, paired against `acme:security-report`.
    resultViews: [{ id: ACME_SECURITY_REPORT_VIEW, component: AcmeSecurityReport }],
    // The palette entry for the `security-auditor` kind, routing its result view to the
    // window above. `container` marks whether the kind runs in a container (presentation
    // only — the backend owns execution). This overrides the generic result view a
    // backend-only registration would deliver, giving the kind a first-class window.
    agentKinds: [
      {
        kind: SECURITY_AUDITOR_KIND,
        container: true,
        presentation: {
          label: 'Security Auditor',
          icon: 'i-lucide-shield-check',
          color: '#ef4444',
          description: 'Read-only security audit of the change, with a compliance report.',
          category: 'review',
          // A specialist kind: offered only at the palette's widest agent tier. Omitting
          // `tier` would default it to `intermediate`.
          tier: 'advanced',
          resultView: ACME_SECURITY_REPORT_VIEW,
        },
      },
    ],
    // A sidebar + command-palette destination. A consumer item carries its own `run`
    // closure (first-party items use a typed `action` id instead). Gating is optional —
    // add `gate: (g) => g.canManageIntegrations` to hide it without the permission.
    nav: [
      {
        id: 'acme:security-dashboard',
        labelKey: 'acme.nav.securityDashboard',
        icon: 'i-lucide-shield-check',
        surfaces: ['sidebar', 'command'],
        testId: 'nav-acme-security',
        sidebar: { group: 'integrations', order: 90 },
        command: { group: 'integrations', order: 90 },
        run: () => {
          // Open THIS deployment's own top-level overlay (the `appOverlays` entry below) via
          // the auto-imported `useAppOverlays()` seam — extension slice D. No layer store
          // import, no host edit; the layer's single `<AppOverlayHost>` mounts the paired
          // component. (Before slice D this could only fire a toast — a consumer nav item had
          // no host surface to open.)
          useAppOverlays().open(ACME_SECURITY_DASHBOARD_OVERLAY)
        },
      },
    ],
    // A CODE-shipped top-level OVERLAY (extension slice D), paired to the nav `run` above by
    // its namespaced id. `<AppOverlayHost>` (mounted once in the layer's `pages/index.vue`)
    // resolves this slot and mounts the component when `ui.openOverlay(id)` fires — the one
    // host surface a consumer could not extend before. The overlay composes the layer's shared
    // `ResultWindowShell` chrome (see the component), so it inherits focus-trap / scroll-lock /
    // shared-stack Escape with zero host edits.
    appOverlays: [{ id: ACME_SECURITY_DASHBOARD_OVERLAY, component: AcmeSecurityDashboard }],
    // An extra inspector body panel for task-level blocks. `when(block)` gates it per block
    // (the same predicate shape the built-in panels use); `order` places it among them.
    inspectorPanels: [
      {
        id: 'acme:incident-panel',
        component: AcmeIncidentPanel,
        when: (block: InspectedBlock) => block?.level === 'task',
        order: 55,
      },
    ] satisfies PanelEntry<InspectedBlock>[],
    // The deployment's own applications. A tool declares a RESOLVER rather than a link, so the
    // invocation context rides along: this one opens the map editor already switched to the game
    // this board is about (`gameId`, declared below) and scoped to the acting user, which is the
    // difference between a bookmark and an integration.
    //
    // `requiredMetadata` is what turns an unconfigured workspace from "the tool is broken" into
    // "somebody has to fill in gameId": the item stays listed and, on click, says exactly that.
    externalTools: [
      {
        id: 'acme:map-editor',
        title: 'Map editor',
        description: 'Edit the level geometry for this project.',
        icon: 'i-lucide-map',
        requiredMetadata: ['gameId'],
        url: (ctx) => {
          const url = new URL('https://maps.acme.dev/edit')
          url.searchParams.set('game', ctx.metadata.gameId ?? '')
          url.searchParams.set('workspace', ctx.workspaceId)
          if (ctx.userId) url.searchParams.set('user', ctx.userId)
          return url.toString()
        },
      },
      {
        // A tool needing no context at all is just a static URL — the resolver is optional.
        id: 'acme:asset-pipeline',
        title: 'Asset pipeline',
        description: 'Build status for the shared art assets.',
        icon: 'i-lucide-boxes',
        url: 'https://assets.acme.dev',
        order: 10,
      },
    ] satisfies ExternalToolContribution[],
    // The custom workspace fields the tool above reads. Declared in CODE (a deployment adds,
    // renames and retires them without a migration); the VALUES are per workspace and typed in
    // under Workspace settings -> Metadata, which is the tab this slot brings into existence.
    workspaceMetadataFields: [
      {
        key: 'gameId',
        label: 'Game id',
        description:
          'Which game this board builds. Used to open the map editor on the right project.',
        placeholder: 'zork',
        order: 0,
      },
      {
        key: 'region',
        label: 'Deployment region',
        type: 'select',
        options: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'North America' },
        ],
        order: 10,
      },
    ] satisfies WorkspaceMetadataFieldDefinition[],
    // A CODE-shipped CUSTOM task type (extension slice B). The SPA merges it into the create-task
    // picker + the card-badge catalog, and renders its descriptor `fields` in the create form —
    // their values land in the task's `taskTypeFields.custom` bag. `defaultPipelineId`/`formPanel`
    // are omitted here (the type uses the workspace default pipeline and the descriptor fields);
    // a real deployment could also register this type on the BACKEND `TaskTypeRegistry` to deliver
    // it in the snapshot instead.
    taskTypes: [
      {
        taskType: ACME_INCIDENT_TASK_TYPE,
        presentation: {
          label: 'Incident',
          icon: 'i-lucide-siren',
          color: '#ef4444',
          description: 'A production incident to triage and resolve.',
          // The picker's grouping axis: the type gets its own captioned row instead of trailing the
          // built-in `feature` / `bug` choices, which is what keeps a growing catalog of the
          // deployment's own types findable. One category is enough to demonstrate the axis; an org
          // shipping a dozen types declares several.
          category: 'Incident response',
        },
        fields: [
          {
            key: 'severity',
            label: 'Severity',
            type: 'select',
            required: true,
            options: [
              { value: 'sev1', label: 'SEV1 — critical' },
              { value: 'sev2', label: 'SEV2 — major' },
              { value: 'sev3', label: 'SEV3 — minor' },
            ],
          },
          {
            key: 'incidentUrl',
            label: 'Incident URL',
            type: 'text',
            help: 'Link to the incident in your on-call tool.',
            placeholder: 'https://acme.pagerduty.com/incidents/…',
          },
        ],
      },
    ] satisfies CustomTaskTypeContribution[],
  },
})
