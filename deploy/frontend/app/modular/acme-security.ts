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
//   - `nav`             — a sidebar + command-palette destination with its own `run`.
//   - `inspectorPanels` — an extra inspector body panel for task blocks.
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

/** The namespaced result-view id shared by the window (the `resultViews` entry) and the
 *  agent kind that selects it (the `agentKinds` entry) — the pairing key. */
export const ACME_SECURITY_REPORT_VIEW = 'acme:security-report'

/** The backend agent kind this deployment provides a bespoke window for. Matches
 *  `SECURITY_AUDITOR_KIND` in `@cat-factory/example-custom-agent`. */
const SECURITY_AUDITOR_KIND = 'security-auditor'

/** The CUSTOM task type this deployment contributes (a namespaced `<ns>:<name>` id). */
export const ACME_INCIDENT_TASK_TYPE = 'acme:incident'

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
 */
interface CustomTaskTypeContribution {
  taskType: string
  presentation: { label: string; icon: string; color: string; description: string }
  fields?: {
    key: string
    label: string
    type: 'text' | 'textarea' | 'number' | 'select'
    help?: string
    placeholder?: string
    options?: { value: string; label: string }[]
    required?: boolean
    maxLength?: number
  }[]
  defaultPipelineId?: string
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
          // A real consumer would open its own overlay / route; overlays are a later slice,
          // so this demonstrates a nav item invoking real behaviour via a shared toast.
          useToast().add({
            title: 'Acme security dashboard',
            description: 'Demo consumer nav action — wire this to your own panel.',
            icon: 'i-lucide-shield-check',
          })
        },
      },
    ],
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
