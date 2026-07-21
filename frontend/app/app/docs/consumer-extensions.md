# Extending the SPA from a consumer deployment

A deployment that consumes this layer (`extends: ['@cat-factory/app']`) can contribute
its own **components** — result windows, navigation entries, inspector panels, agent-kind
palette data — **without forking the layer**. This is the frontend counterpart of the
backend's public registries (`registerAgentKind`, `registerGate`; see
[`backend/docs/custom-agents.md`](../../../backend/docs/custom-agents.md)). The governing
principle is the same: **zero host edits for a consumer extension**.

A worked, end-to-end example ships in the template deployment —
[`deploy/frontend/app/`](../../../deploy/frontend) (the `acme:security` module) — the
frontend analogue of the backend
[`@cat-factory/example-custom-agent`](../../../backend/internal/example-custom-agent)
package. Read this guide alongside it.

> This is the **landed** surface (modular-vue adoption slices 1–5). The larger consumer
> extension programme (custom task types, generic interactive phases, overlays, consumer
> notification kinds, stream events, and the hardened public export surface) is tracked in
> [`docs/initiatives/frontend-extension-mechanism.md`](../../../docs/initiatives/frontend-extension-mechanism.md).

## The one seam: `registerAppModule`

Everything is one call from your own Nuxt plugin. A module is a plain descriptor; each
capability is a slot contribution.

```ts
// deploy/frontend/app/plugins/acme.client.ts
import { defineModule } from '@modular-vue/core'
import AcmeSecurityReport from '../components/acme/AcmeSecurityReport.vue'

export default defineNuxtPlugin(() => {
  registerAppModule(
    defineModule({
      id: 'acme:security', // namespaced — see "Rules" below
      version: '1.0.0',
      slots: {
        resultViews: [{ id: 'acme:security-report', component: AcmeSecurityReport }],
        agentKinds: [
          /* palette entries — see "Agent kinds" */
        ],
        nav: [
          /* sidebar / command-palette destinations — see "Navigation" */
        ],
        inspectorPanels: [
          /* per-block detail panels — see "Inspector panels" */
        ],
      },
    }),
  )
})
```

- **`registerAppModule` is auto-imported** from the layer (`app/utils/modular.ts`), so you
  need no deep import into the layer's internals.
- **`enforce: 'post'` is load-bearing.** The layer's own install plugin is `enforce:
'post'`, and Nuxt runs layer plugins before the consuming app's plugins within one
  enforce bucket. So your registration plugin must run in the **default** (or `pre`) bucket
  — i.e. **do not** put `enforce: 'post'` on it, or it registers too late and is silently
  missed.
- **`defineModule` / the slot-entry types come from `@modular-vue/core`** — add it to your
  deployment's `dependencies`.

## The landed seams

| Seam                                | Slot key          | Entry shape                                                                                      | Host                                        |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Run-detail windows                  | `resultViews`     | `{ id: '<ns>:<name>', component }`                                                               | `StepResultViewHost` via `dispatchStepView` |
| Agent kinds (palette data)          | `agentKinds`      | `{ kind, container, presentation: { label, icon, color, description, category?, resultView? } }` | agents store merge → `agentKindMeta`        |
| Sidebar / command-palette / toolbar | `nav`             | `{ id, labelKey, icon, surfaces, gate?, run, sidebar?, command?, toolbar? }`                     | the three shells via `useNavContributions`  |
| Inspector body panels               | `inspectorPanels` | `{ id, component, when(block), order }` (`PanelEntry<Block>`)                                    | `<PanelsOutlet>` in `InspectorPanel`        |
| Multi-step wizards                  | (journeys)        | `registerJourney` + step modules                                                                 | `<JourneyHost>` / `<JourneyOutlet>`         |
| Locale strings                      | (i18n)            | `i18n/locales/*.json` in the deployment                                                          | `@nuxtjs/i18n` layer deep-merge             |

### Run-detail windows (`resultViews` + `agentKinds`)

Backend data selects a frontend component, joined by a namespaced id:

1. A backend agent kind (registered on `AgentKindRegistry`, e.g.
   `@cat-factory/example-custom-agent`'s `security-auditor`) arrives in the workspace
   snapshot with `presentation.resultView: '<ns>:<name>'` — **or** you code-ship the kind's
   palette entry via the `agentKinds` slot (as the example does, to give an existing kind a
   bespoke window).
2. You contribute the component to `resultViews` under the SAME id.
3. When a step of that kind is opened, `dispatchStepView` resolves the kind's `resultView`
   id, and `StepResultViewHost` mounts your paired component.

An unpaired id degrades to the generic prose panel (a dev-console warning names the dangling
id); a structured kind with no bespoke window gets the built-in `generic-structured` viewer
for free.

### Navigation

A consumer nav item carries its own `run` closure (first-party items use a typed `action`
id instead). Optional `gate: (g) => g.canManageIntegrations` hides it reactively without the
permission. `surfaces` picks which shells render it (`'sidebar' | 'command' | 'toolbar'`),
and `sidebar` / `command` / `toolbar` place it within each.

### Inspector panels

Contribute `PanelEntry<Block>` entries; each `when(block)` predicate decides which blocks
show the panel, and `order` places it among the built-ins. Your panel component reads the
selected block via `usePanelSubject<Block>()` (`@modular-vue/core`). `when` must tolerate a
nullish subject (the boot-time validation resolve passes `null`).

## Reuse the shared building blocks — don't reinvent them

The layer's window/inspector primitives are **auto-imported layer-wide**, so your consumer
components use them with **zero imports and zero deep paths**. Compose these instead of
hand-rolling chrome or re-deriving the "which run is this / how did the model do" facts:

| Building block         | What it gives you                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<ResultWindowShell>`  | The shared modal chrome for a result window — backdrop, header (icon/title/subtitle), a `#header-extras` slot, close button, and the modal _behaviour_ (focus-trap + return, body-scroll lock, shared-stack Escape via `useModalBehavior`). Pass `stepRef` to surface the shared "restart from here" control. |
| `<StepRunMeta>`        | **The shared run-details metadata block** every agent window reuses: step position, live duration, model, run id, and the LLM model-activity rollup. Drop it into your window's sidebar — never reinvent run metadata.                                                                                        |
| `useResultView(id)`    | The window seam contract: `{ open, blockId, instanceId, stepIndex, close }` (+ an `onOpen` loader for windows that fetch, and an `onClose` flush). Escape is owned by the shell, not here.                                                                                                                    |
| `<MarkdownProse>`      | Render an agent's prose output as markdown.                                                                                                                                                                                                                                                                   |
| `<CopyButton>`         | The shared copy-to-clipboard affordance.                                                                                                                                                                                                                                                                      |
| `<InspectorSection>`   | The collapsible inspector-section shell (chevron header, count, hint) so a consumer panel reads like a built-in one.                                                                                                                                                                                          |
| `usePanelSubject<T>()` | Read the block injected into an inspector panel by `<PanelsOutlet>` (`@modular-vue/core`).                                                                                                                                                                                                                    |

The example `AcmeSecurityReport.vue` window is a full demonstration: it composes
`<ResultWindowShell>` + `<StepRunMeta>` + `useResultView` + `<MarkdownProse>`, adds only its
own bespoke body (the security findings), and reads the auditor's structured assessment
straight off `step.custom`.

## i18n

Ship your strings under your own namespace in the deployment's `i18n/locales/*.json` (e.g.
`acme.*`). `@nuxtjs/i18n` is layer-aware and **deep-merges** them into the layer catalog, so
`t('acme.securityReport.title')` resolves in your components with no config change. The
layer's typed-key and locale-parity guards govern only the layer's own keys — your namespace
is yours.

## Rules that hold across every seam

- **Namespacing.** Every consumer-authored id is `<ns>:<name>`. Built-ins are never
  shadowable — the merge logic drops a consumer entry whose id collides with a built-in
  (see the agents store).
- **Fail fast at boot, degrade at runtime.** Duplicate ids across first-party + consumer
  modules throw when the layer resolves the merged slots at startup; missing pairings and
  unknown wire ids degrade with a dev-console warning, never a crash.
- **Never crash on stale data.** An id that arrives on the wire (a `resultView`, an agent
  kind) after its extension was removed must degrade to a defined rendering — extensions get
  uninstalled while persisted rows outlive them.
- **The remote manifest is DATA only.** Components never travel the wire; per-workspace
  variability comes from which capabilities the snapshot lists, not from which modules are
  registered (registration is boot-static).
