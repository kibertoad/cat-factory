# Extending the SPA from a consumer deployment

A deployment that consumes this layer (`extends: ['@cat-factory/app']`) can contribute
its own **components** (result windows, navigation entries, inspector panels, agent-kind
palette data) **without forking the layer**. This is the frontend counterpart of the
backend's public registries (`registerAgentKind`, `registerGate`; see
[`backend/docs/custom-agents.md`](../../../backend/docs/custom-agents.md)). The governing
principle is the same: **zero host edits for a consumer extension**.

A worked, end-to-end example ships in the template deployment:
[`deploy/frontend/app/`](../../../deploy/frontend) (the `acme:security` module): the
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
      id: 'acme:security', // namespaced - see "Rules" below
      version: '1.0.0',
      slots: {
        resultViews: [{ id: 'acme:security-report', component: AcmeSecurityReport }],
        agentKinds: [/* palette entries - see "Agent kinds" */],
        nav: [/* sidebar / command-palette destinations - see "Navigation" */],
        inspectorPanels: [/* per-block detail panels - see "Inspector panels" */],
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
 , i.e. **do not** put `enforce: 'post'` on it, or it registers too late and is silently
  missed.
- **`defineModule` / the slot-entry types come from `@modular-vue/core`**: add it to your
  deployment's `dependencies`.

## The landed seams

| Seam                                | Slot key                  | Entry shape                                                                                      | Host                                                                      |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Run-detail windows                  | `resultViews`             | `{ id: '<ns>:<name>', component }`                                                               | `StepResultViewHost` via `dispatchStepView`                               |
| Agent kinds (palette data)          | `agentKinds`              | `{ kind, container, presentation: { label, icon, color, description, category?, resultView? } }` | agents store merge → `agentKindMeta`                                      |
| Custom task types                   | `taskTypes`               | `{ taskType: '<ns>:<name>', presentation, fields?, defaultPipelineId?, formPanel? }`             | `AddTaskModal` picker/fields + `TaskCard` badge (via `taskTypeMeta`)      |
| Sidebar / command-palette / toolbar | `nav`                     | `{ id, labelKey, icon, surfaces, gate?, advanced?, run, sidebar?, command?, toolbar? }`          | the three shells via `useNavContributions`                                |
| Inspector body panels               | `inspectorPanels`         | `{ id, component, when(block), order }` (`PanelEntry<Block>`)                                    | `<PanelsOutlet>` in `InspectorPanel`                                      |
| Top-level overlays                  | `appOverlays`             | `{ id: '<ns>:<name>', component }`                                                               | `<AppOverlayHost>` via `useAppOverlays().open(id)`                        |
| External tools                      | `externalTools`           | `{ id, title, icon, url, description?, requiredMetadata?, gate?, advanced?, order? }`            | the "External tools" sidebar section + palette, via `useNavContributions` |
| Custom workspace metadata fields    | `workspaceMetadataFields` | `{ key, label, description?, placeholder?, type?, options?, order? }`                            | the Metadata tab of Workspace settings                                    |
| Multi-step wizards                  | (journeys)                | `registerJourney` + step modules                                                                 | `<JourneyHost>` / `<JourneyOutlet>`                                       |
| Locale strings                      | (i18n)                    | `i18n/locales/*.json` in the deployment                                                          | `@nuxtjs/i18n` layer deep-merge                                           |

A `nav` entry may also declare `advanced: true`, which hides it in **basic** interface mode
(the shipped default) exactly as it does for the first-party destinations: see
[the layer README](../../README.md#interface-modes-basic--advanced). Use it for a power-user
destination; the flag is independent of `gate`, so both must pass for the item to render.

### Run-detail windows (`resultViews` + `agentKinds`)

Backend data selects a frontend component, joined by a namespaced id:

1. A backend agent kind (registered on `AgentKindRegistry`, e.g.
   `@cat-factory/example-custom-agent`'s `security-auditor`) arrives in the workspace
   snapshot with `presentation.resultView: '<ns>:<name>'`: **or** you code-ship the kind's
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

### External tools + workspace metadata (`externalTools`, `workspaceMetadataFields`)

Put your OWN web applications (a map editor, an asset pipeline, an admin console) in the
sidebar's **External tools** section, and open each one _already scoped to what the user is
looking at_. That second half is the point of the seam; a static link needs no registration.

```ts
externalTools: [
  {
    id: 'acme:map-editor',
    title: 'Map editor',                       // literal copy: a tool's name is DATA, not a key
    description: 'Edit the level geometry for this project.',
    icon: 'i-lucide-map',
    requiredMetadata: ['gameId'],
    url: (ctx) => {
      // Build, don't splice: every value here is operator-typed text (see below).
      const url = new URL('https://maps.acme.dev/edit')
      url.searchParams.set('game', ctx.metadata.gameId ?? '')
      url.searchParams.set('ws', ctx.workspaceId)
      return url.toString()
    },
  },
],
workspaceMetadataFields: [{ key: 'gameId', label: 'Game id', placeholder: 'zork' }],
```

- **`url` is a string or a RESOLVER** `(ctx) => string | null`. The context carries `userId`,
  `userEmail`, `workspaceId`, `workspaceName` and `metadata`: the custom workspace fields you
  declared. It is read at CLICK time, so a value a teammate fills in while the sidebar is open
  takes effect without a reload.
- **Clicking opens a separate page** (`target=_blank`, `noopener`). The resolved URL must be
  `http(s)`: anything else is refused rather than handed to the browser, because the string
  reaches `window.open` and a `javascript:` URL would run in the SPA's own origin.
- **Declare `requiredMetadata` for the fields your resolver needs.** An unconfigured workspace
  then gets "fill in `gameId` on the Metadata tab" instead of a generic failure, and the tool
  stays LISTED, because the person looking at the sidebar is usually the one who can fix it. A
  resolver that returns `null` reports separately ("this tool gave no address"), since that one
  is yours to fix, not the operator's.
- **Treat every `ctx.metadata` value as untrusted input.** A workspace admin types these in, so a
  value is operator-supplied text that happens to be length-bounded, not a constant you chose.
  Set it as a query parameter or an `encodeURIComponent`'d path segment, as above. Never build the
  ORIGIN from one: `` `https://${ctx.metadata.region}.acme.dev` `` with `region` set to
  `evil.com/x?a=` resolves to a URL on someone else's host, and the `http(s)` allow-list cannot
  tell that apart from the link you meant.
- **A resolver that THROWS costs only its own item.** It is caught and reported as a fourth
  reason (`resolver-failed`) with the cause logged to the console: the sidebar, the palette and
  the toolbar all render from one catalog, so an uncaught throw would otherwise blank all three.
  Do not rely on it: `requiredMetadata` is how you say a field must be there.
- **`gate` and `advanced`** work exactly as on a `nav` entry; both must pass.

**The metadata half** is a deployment-declared FIELD list (here) whose VALUES are per workspace,
typed in under _Workspace settings → Metadata_ and persisted on the workspace settings row. The
tab appears only where a deployment declares fields. Keys must be identifier-shaped
(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`: the backend refuses anything else); a malformed or duplicate
key is dropped with a dev-console warning rather than rendered. `type: 'select'` renders a picker
over your `options`; everything is stored as a string.

Two rules the editor keeps, and any other writer of the bag should too: a CLEARED field drops its
key (so "unset" never reads as "set to nothing" in a resolver), and a save carries through any
stored key the current build does not declare; the update replaces the whole bag, so a value
written under a field you have since retired must not be deleted by an unrelated save.

Values are readable anywhere in the SPA via `useWorkspaceSettingsStore().settings.metadata`.

### Custom task types (`taskTypes`)

Model a proprietary work item (an "incident", "pentest", "compliance-audit") as a first-class
task type, the create-task twin of an agent kind. Contribute `{ taskType: '<ns>:<name>',
presentation: { label, icon, color, description }, fields?, defaultPipelineId?, formPanel? }` to
the `taskTypes` slot (see `acme:incident` in the example module). The SPA merges it into the
create-task picker and the card-badge catalog:

- **`presentation`** drives the create-task picker entry and the `TaskCard` type badge (resolved
  through the pure `taskTypeMeta` read-model: the `agentKindMeta` twin). An UNREGISTERED
  namespaced type (a stale row after your extension is removed) degrades to the `feature`
  presentation, so a leftover string never breaks a card.
- **`fields`** are descriptor-driven create-form inputs (`text` / `textarea` / `number` /
  `select`); their values land in the task's sparse `taskTypeFields.custom` bag (no migration).
- **`formPanel`** optionally names a bespoke create-form section component you contribute to the
  `taskTypeFormPanels` slot (paired by that id, like `resultViews`); shown INSTEAD of `fields`. An
  unpaired id degrades to the descriptor fields.
- **`defaultPipelineId`** pre-selects the type's pipeline in the picker.

The **same type can be delivered from the backend** instead of code-shipped: register it on the
deployment's app-owned `TaskTypeRegistry` and it arrives in the workspace snapshot's
`customTaskTypes`, folded into the SAME merged catalog (data over the wire, never components). The
widened `taskType` contract (`<built-in> | <ns>:<name>`) accepts the namespaced id everywhere, so a
task created with it round-trips with zero host edits.

> **Validation.** A BACKEND-registered task type is checked at boot by `validateRegistrations`
> (namespaced id, well-formed `formPanel`, a `defaultPipelineId` that resolves to a real pipeline).
> A CODE-shipped `taskTypes` entry is trusted and **not** validated (like a code-shipped agent kind):
> a malformed `taskType`/`formPanel` id or a `defaultPipelineId` naming no real pipeline fails
> silently; the type just won't pre-select a pipeline and an unpaired `formPanel` degrades to the
> descriptor `fields`. Prefer backend registration when you want the fail-fast guardrail.

### Top-level overlays (`appOverlays`)

A nav item's `run` closure, or any consumer code, often needs to open a full-screen panel of
its own: a dashboard, a wizard, a settings surface. The layer's first-party modals are
hand-mounted in `pages/index.vue`, which a consumer can't edit, so the `appOverlays` slot + the
single `<AppOverlayHost>` are the seam:

1. Contribute `{ id: '<ns>:<name>', component }` to the `appOverlays` slot (see
   `acme:security-dashboard-overlay` in the example module).
2. Open it from anywhere with the auto-imported `useAppOverlays().open('<ns>:<name>', subject?)`:
  typically a nav item's `run` closure. The optional `subject` is any value your overlay
   renders against (e.g. a block id); it reaches the component as a `subject` prop.
3. `<AppOverlayHost>` resolves the slot with `resolveComponentRegistry` (the same pick-one
   primitive `resultViews` uses) and mounts the matching component, wiring its `close` emit to
   `useAppOverlays().close()`.

It is a **pick-one** host: opening a second overlay replaces the first, and `close()` clears it.
Compose the shared `ResultWindowShell` (via `#components`) for chrome so your overlay inherits
focus-trap / scroll-lock / shared-stack Escape: emit `close` from its `@close`. A dangling open
(`open('<ns>:x')` with no registered component, e.g. a stale closure after the extension was
removed) degrades to nothing (a dev-console warning names the id), never a crash. Duplicate ids
across modules throw at boot, like every other slot.

> **Scope.** This seam is for CONSUMER overlays. The layer's own ~34 first-party modals stay
> hand-mounted in `index.vue` and are migrated only opportunistically: don't reach for
> `appOverlays` to replace a first-party fast-path modal.

## Reuse the shared building blocks: don't reinvent them

The layer ships window/inspector primitives you compose instead of hand-rolling chrome or
re-deriving the "which run is this / how did the model do" facts. **Composables** (and the
`registerAppModule` helper) are auto-imported into your consumer code with zero imports;
**components** must be named through the `#components` virtual module (see the boxed note
below). Compose these:

| Building block                | Reference it as                           | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResultWindowShell`           | `#components` → `PanelsResultWindowShell` | The shared modal chrome for a result window: backdrop, header (icon/title/subtitle), a `#header-extras` slot, close button, and the modal _behaviour_ (focus-trap + return, body-scroll lock, shared-stack Escape via `useModalBehavior`). Pass `stepRef` to surface the shared "restart from here" control. It also renders the universal per-step trailing sections (agent effort, pre-PR validation, binary outputs) off the ACTIVE step, so your window inherits them and must not re-render them itself. |
| `StepRunMeta`                 | `#components` → `PanelsStepRunMeta`       | **The shared run-details metadata block** every agent window reuses: step position, live duration, model, run id, and the LLM model-activity rollup. Drop it into your window's sidebar, never reinvent run metadata.                                                                                                                                                                                                                                                                                         |
| `MarkdownProse`               | `#components` → `CommonMarkdownProse`     | Render an agent's prose output as markdown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CopyButton`                  | `#components` → `CommonCopyButton`        | The shared copy-to-clipboard affordance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `InspectorSection`            | `#components` → `PanelsInspectorSection`  | The collapsible inspector-section shell (chevron header, count, hint) so a consumer panel reads like a built-in one.                                                                                                                                                                                                                                                                                                                                                                                           |
| `useResultView(id)`           | auto-imported                             | The window seam contract: `{ open, blockId, instanceId, stepIndex, close }` (+ an `onOpen` loader for windows that fetch, and an `onClose` flush). Escape is owned by the shell, not here.                                                                                                                                                                                                                                                                                                                     |
| `useResultViewRunMeta(id, …)` | auto-imported                             | The `StepRunMeta` prop bundle (`{ step, instanceId, position, totalSteps, runFailed, failureAt }`), resolved for BOTH ways a window opens. A window reachable off-path (from a board card or the inspector) carries no `stepIndex`, so wiring `StepRunMeta` straight off `useResultView` leaves it blank on exactly that route; this resolves the block's live run and the step your view id declares instead.                                                                                               |
| `usePanelSubject<T>()`        | `@modular-vue/core`                       | Read the block injected into an inspector panel by `<PanelsOutlet>`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `useAppOverlays()`            | auto-imported                             | Open / close your own top-level overlays: `{ open(id, subject?), close(), active }`. The store-free seam a nav `run` closure uses to open an `appOverlays`-slot component (see "Top-level overlays").                                                                                                                                                                                                                                                                                                          |

> **Reference layer components through `#components`, not bare tags.** Nuxt auto-registers a
> layer's components under a **path-derived** name (`components/panels/ResultWindowShell.vue`
> → `PanelsResultWindowShell`), and only rewrites bare `<ResultWindowShell>` tags inside the
> layer's own SFCs. A bare tag in a **consumer** SFC resolves to nothing and silently renders
> as an unknown element: its `<slot>` children still appear, so a shallow test can pass while
> the shared chrome (and its `data-testid`) never mounts. Import the ones you use from
> `#components` (Nuxt's stable virtual registry: **not** a deep path into the layer's
> `app/components/*`), aliasing them back to the short names for readable templates:
>
> ```ts
> import {
>   PanelsResultWindowShell as ResultWindowShell,
>   PanelsStepRunMeta as StepRunMeta,
>   CommonMarkdownProse as MarkdownProse,
> } from '#components'
> ```
>
> Composables (`useResultView`, `useI18n`, the Pinia stores) and `registerAppModule` are
> auto-imported across layers by Nuxt's separate imports mechanism, so those need no import.
> Hardening these building blocks into an explicitly exported, location-independent public
> surface is slice G of the initiative.

### Don't render step state the shell already owns

Some state the engine records on a step is deliberately NOT a result view's job, because the
record's scope is wider than any one kind: the agent's effort self-assessment, the pre-PR
validation report, and (for a `binary-output` generator) the artifacts it declared it stored
(`step.binaryOutputs`). `ResultWindowShell` resolves the active step itself and renders each as a
collapsible trailing section, and the generic step-detail panel renders the same components for a
step whose kind declares no window at all.

So a generator kind should declare a result view for its OWN output (or none), and leave the
artifact list alone: you get it either way, on every entry point, with no id to register. A
window that renders it again just shows it twice.

The example `AcmeSecurityReport.vue` window is a full demonstration: it imports
`ResultWindowShell` + `StepRunMeta` + `MarkdownProse` from `#components`, composes them with
the auto-imported `useResultView`, adds only its own bespoke body (the security findings), and
reads the auditor's structured assessment straight off `step.custom`.

## i18n

Ship your strings under your own namespace in the deployment's `i18n/locales/*.json` (e.g.
`acme.*`). `@nuxtjs/i18n` is layer-aware and **deep-merges** them into the layer catalog, so
`t('acme.securityReport.title')` resolves in your components with no config change. The
layer's typed-key and locale-parity guards govern only the layer's own keys: your namespace
is yours.

## Rules that hold across every seam

- **Namespacing.** Every consumer-authored id is `<ns>:<name>`. Built-ins are never
  shadowable: the merge logic drops a consumer entry whose id collides with a built-in
  (see the agents store).
- **Fail fast at boot, degrade at runtime.** Duplicate ids across first-party + consumer
  modules throw when the layer resolves the merged slots at startup; missing pairings and
  unknown wire ids degrade with a dev-console warning, never a crash.
- **Never crash on stale data.** An id that arrives on the wire (a `resultView`, an agent
  kind) after its extension was removed must degrade to a defined rendering: extensions get
  uninstalled while persisted rows outlive them.
- **The remote manifest is DATA only.** Components never travel the wire; per-workspace
  variability comes from which capabilities the snapshot lists, not from which modules are
  registered (registration is boot-static).
