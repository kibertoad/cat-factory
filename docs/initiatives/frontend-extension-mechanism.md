# Initiative: frontend extension mechanism (consumer modules over modular-vue)

**Status:** slice A landed (dogfood consumer module + authoring guide) · **Owner:** frontend · **Started:** 2026-07-21

> Durable source of truth for a multi-PR initiative. Read this first before picking up a
> slice; update the checklist at the end of each PR. This initiative builds ON TOP of the
> landed [modular-vue adoption](./modular-vue-adoption.md) (slices 0–5): that initiative
> put the registry/slot/journey/panel machinery in place and converted the first-party
> features onto it; THIS one turns those seams into a complete, documented, dogfooded
> **consumer extension surface** and adds the seams that are still missing.

## Goal & rationale

A deployment extending `@cat-factory/app` (`extends: ['@cat-factory/app']`) can already
contribute real components through `registerAppModule(...)` — nav/command entries, result
windows, inspector panels, agent-kind palette data, journeys. But the extension story is
incomplete in exactly the places a company shipping proprietary agents hits first:

- **Custom task types** don't exist. `taskTypeSchema` is a closed picklist
  (`feature|bug|document|spike|review|ralph|recurring`); the create-task form, the card
  badge, the per-type fields, and the default-pipeline mapping are all keyed to the
  built-ins. A deployment with an "incident", "pentest", or "compliance-audit" work item
  has no way to model it.
- **Interactive phases** (a run parking for human input mid-pipeline) are bespoke per
  feature: requirements-review, fork-decision, human-test, visual-confirm each own a
  contract state, controller routes, a store, a window, a notification type, and a
  reveal handler. A consumer agent kind cannot park for a decision at all — its only
  human touchpoint is the generic decision gate with the generic modal.
- **Several host surfaces are closed:** top-level modals are hand-mounted `v-if`s in
  `pages/index.vue` (~45 of them, no registry); the workspace-stream `onMessage` switch
  silently drops unknown event types; the notification type set is a closed picklist with
  three exhaustive `Record`s in `NotificationsInbox.vue`.
- **The seams that DO exist are under-documented and not dogfooded end to end** — there
  is no shipped example of a consumer module (the backend has
  `@cat-factory/example-custom-agent`; the frontend has nothing equivalent), and the
  "public surface" a consumer may rely on (which composables, which types, which slots)
  has never been declared.

The governing principle is the same as the backend's custom-agent framework
([`backend/docs/custom-agents.md`](../../backend/docs/custom-agents.md)): **zero host
edits for a consumer extension**. A deployment registers modules by reference from its
own Nuxt plugin; the layer stays unforked; ids are namespaced; unknown contributions
degrade gracefully instead of breaking the host.

## The consumer model (the contract this initiative completes)

One seam, one call shape, everything else is slots:

```ts
// deploy plugin: e.g. app/plugins/acme.ts (default bucket — runs BEFORE the layer's
// enforce:'post' install plugin, which is what makes the registration visible)
import AcmeSecurityReport from '../components/AcmeSecurityReport.vue'
import AcmeIncidentPanel from '../components/AcmeIncidentPanel.vue'

export default defineNuxtPlugin(() => {
  registerAppModule(
    defineModule({
      id: 'acme:security',
      version: '1.0.0',
      slots: {
        // run detail window for the backend-registered `security-auditor` kind
        resultViews: [{ id: 'acme:security-report', component: AcmeSecurityReport }],
        // CODE-shipped agent kind (alternative to backend snapshot delivery)
        agentKinds: [
          {
            kind: 'acme-triager',
            container: false,
            presentation: {
              label: 'Incident Triager',
              icon: 'i-lucide-siren',
              color: 'rose',
              description: 'Correlates an incident with recent releases.',
              category: 'review',
              resultView: 'acme:security-report',
            },
          },
        ],
        // extra inspector body panel for blocks the extension cares about
        inspectorPanels: [
          {
            id: 'acme:incident-panel',
            component: AcmeIncidentPanel,
            when: (block) => block.taskType === 'acme:incident',
            order: 55,
          },
        ],
        nav: [
          /* command-palette / sidebar entries with `run` closures */
        ],
        // NEW slots this initiative adds — see the extension-point sections below:
        taskTypes: [
          /* … */
        ],
        appOverlays: [
          /* … */
        ],
        notificationKinds: [
          /* … */
        ],
        streamHandlers: [
          /* … */
        ],
      },
    }),
  )
})
```

Rules that hold across every extension point:

- **Namespacing.** Every consumer-authored id is `<ns>:<name>` (the
  `NAMESPACED_RESULT_VIEW_ID_PATTERN` rule from `@cat-factory/contracts`, generalized).
  A bare unknown id is a validation error (the typo guardrail); a namespaced id is
  trusted to the deployment. Built-ins are never shadowable — the merge logic in every
  catalog (the agents store is the template) drops a consumer entry whose id collides
  with a built-in.
- **Data × component pairing.** Wherever backend data selects frontend behaviour, the
  wire carries only a namespaced id and the component ships in the consumer module,
  paired via `resolveComponentRegistry` / `pairById` (the slice-2 primitive). An
  unpaired id degrades to the generic rendering (prose panel, default notification row),
  never a crash.
- **Fail fast at boot, degrade at runtime.** Duplicate ids across first-party + consumer
  modules throw when the install plugin resolves the merged slots (the existing
  `resolveComponentRegistry`/`resolvePanels` boot resolves — every new slot gets the same
  treatment). Missing pairings and unknown wire ids degrade with a dev-console warn.
- **Two delivery channels per capability, one catalog.** CODE-shipped contributions
  enter via the static slot; BACKEND-registered ones arrive in the workspace snapshot and
  are folded into the per-workspace `RemoteModuleManifest`
  (`cat-factory:workspace-capabilities`). A store merges built-ins + consumer slot +
  manifest into one reactive catalog and projects it into a pure read-model (the
  `agents` store / `setCustomAgentKindMeta` pattern) so renderers never import the store.
- **i18n.** Consumer modules ship their strings via the layer deep-merge
  (`i18n/locales/*.json` in the deployment, keys under the consumer's own root, e.g.
  `acme.*`). First-party strings stay in the layer catalog; the parity/typecheck gates
  only govern the layer's own keys.
- **Ordering.** Consumer plugins register in the default (or `pre`) bucket; the layer's
  install plugin is `enforce: 'post'` and resolves once. Registration after boot is not
  supported (module descriptors are static; per-workspace variability comes from the
  remote manifest, which IS swappable at runtime).

## Extension points

Each section states the current state, the design, and what lands in which slice.

### 1. Custom agent kinds + run-detail windows (landed — the reference pattern)

Already complete from the modular-vue adoption (slice 2) + the backend custom-agent
framework: an agent kind registered on the backend `AgentKindRegistry` (or contributed as
code via the `agentKinds` slot) becomes a first-class palette block; its
`presentation.resultView` — a built-in id or `<ns>:<name>` — opens through the single
`dispatchStepView` funnel and `StepResultViewHost`, paired against a `resultViews`-slot
component; a structured kind without its own window gets `generic-structured` for free.

What remains here is not mechanism but **proof and documentation**: no shipped consumer
example exercises the pairing end to end, and the authoring guide lives scattered across
code comments. Slice A closes that (see the checklist) with a worked example module in
`deploy/frontend` mirroring `@cat-factory/example-custom-agent` on the backend, plus a
consumer-authoring doc. Every later extension point copies this section's shape — it is
the gold standard, the way the execution flow is the gold standard on the backend.

### 2. Custom task types (slice B — the biggest missing axis)

**Design: a namespaced task type, registered backend-side, presented frontend-side —
symmetric with agent kinds.**

- **Contracts.** `taskTypeSchema` (and `createTaskTypeSchema`) widen from a closed
  picklist to `union(picklist, namespacedTaskTypeId)` — the exact shape
  `agentPresentationSchema.resultView` already uses. A new
  `customTaskTypeSchema` carries the registration's wire projection:

  ```ts
  {
    taskType: '<ns>:<name>',
    presentation: { label, icon, color, description },   // card badge + create-form entry
    fields?: TaskTypeFieldDescriptor[],                   // data-driven create-form fields
    defaultPipelineId?: string,                           // pairs with a registered pipeline
    formPanel?: '<ns>:<name>',                            // optional bespoke form section id
  }
  ```

  `fields` reuses the descriptor-driven form vocabulary (the `credentialFieldSchema` /
  [descriptor-driven-infra-forms](./descriptor-driven-infra-forms.md) pattern): label,
  input kind (text/textarea/number/select), options, required, maxLength. Values land in
  a new sparse `taskTypeFields.custom: Record<string, string | number>` bag — additive,
  no migration, mirroring how the built-in per-type fields already work.

- **Backend.** An app-owned `TaskTypeRegistry` (kernel, `defaultTaskTypeRegistry()`), a
  facade registers deployment types by reference — the same shape as
  `AgentKindRegistry`/`PipelineRegistry`, threaded through `CoreDependencies`. Boot-time
  `validateRegistrations` checks: namespaced id, `defaultPipelineId` resolves against the
  pipeline registry, `formPanel` id well-formed. `defaultPipelineIdForTaskType` consults
  the registry after the built-in map. The per-service running-task limit's optional
  per-type bucketing treats a custom type as its own bucket (it keys off the string).
  Both runtimes see the same registry (it is engine-level, not persistence — no parity
  work beyond the conformance assertion that a custom-typed task round-trips).

- **Snapshot.** `workspaceSnapshotSchema` gains
  `customTaskTypes: v.optional(v.array(customTaskTypeSchema))`, assembled next to
  `customAgentKinds` in `WorkspaceController`. The frontend folds BOTH lists into the
  single workspace-capabilities `RemoteModuleManifest`
  (`buildAgentCapabilitiesManifest` generalizes to `buildWorkspaceCapabilitiesManifest`,
  version hash covering both lists).

- **Frontend.** A `taskTypes` slot (code-shipped) + the manifest list merge in a
  `taskTypes` store (clone of the agents-store merge/projection). Consumers:
  - `AddTaskModal` renders its type choices from the merged catalog (built-ins + custom)
    and, for a custom type, the descriptor-driven fields — plus, when `formPanel` is set,
    the paired component from a `taskTypeFormPanels` component slot (pairing rules as in
    §1; unpaired ⇒ descriptor fields only).
  - `TaskCard`/board badges read icon/color/label through a pure
    `taskTypeMeta(taskType)` read-model (the `agentKindMeta` twin) so an unknown/custom
    type renders its registered presentation, and an UNREGISTERED namespaced type (stale
    data after an extension was removed) falls back to the `feature` presentation
    rather than breaking the card.
  - Inspector: no new seam needed — the existing `inspectorPanels` slot's `when(block)`
    predicates already key off `block.taskType`.

### 3. Interactive phases for consumer agents (slice C — the design centerpiece)

**Problem.** Each built-in interactive phase (requirements-review loop, fork-decision
propose→park→choose, human-test, visual-confirm) hand-rolls the same five parts:
step-state contract, controller routes, frontend store, window, notification + reveal.
A consumer agent kind cannot park for human input at all.

**Design: one generic step-interaction protocol; the consumer supplies only the payload
schema, the resolver, and the window.** This is the frontend half of a cross-layer
feature; the backend half rides the existing decision-wait machinery (the same durable
park the decision gates and fork-decision already use), so no new engine archetype is
invented:

- **Backend registration.** A custom agent kind's registration gains an optional
  `interaction` block: `{ onResult(step, ctx) => 'complete' | { park: payload } }` to
  decide whether the step's structured result parks, and
  `{ onSubmit(step, action, body, ctx) => 'resume' | { repark: payload } }` to handle the
  human's submission (validate, mutate, optionally re-park for iterative loops). The
  engine stores `step.interaction = { status: 'awaiting_input', payload, approvalId }`
  (a wire-validated, size-budgeted JSON payload — the `step.custom` twin), parks via
  `parkStepOnDecision`, and resumes/re-parks off the resolver's verdict. Iterative
  chat-style flows reuse the fork-decision transient re-entry template; that
  generalization can land later without changing the frontend contract.
- **Generic routes.** `GET /workspaces/:ws/executions/:id/steps/:stepIndex/interaction`
  and `POST …/interaction/:action` (CAS on the approval id, like fork-decision's
  choose/chat). One controller serves every consumer interaction.
- **Frontend window.** Nothing new: the parked step's window IS the kind's
  `resultView` window (§1). The window reads `step.interaction.payload` off the
  execution store (live-pushed like any step field) and submits through a small public
  composable the layer exports: `useStepInteraction(viewId)` → `{ payload, status,
submit(action, body), pending, error }` — wrapping the generic routes + the
  authed api client + the optimistic `reflect` pattern from `stores/forkDecision.ts`,
  so a consumer never touches `useApi` internals.
- **Opening.** Parked steps already surface through the board's approval badge →
  `openApprovalDetail` → `dispatchStepView` → the kind's `resultView`. No new dispatch
  path.
- **Notification.** ONE new built-in type `interaction_pending` (raised by the generic
  park, exactly as `fork_decision_pending` is today) covers every consumer interaction:
  its inbox row renders the agent kind's presentation (icon/color/label from
  `agentKindMeta`), and its reveal handler resolves the parked step and dispatches its
  view. The closed notification picklist grows by one line, not per extension.

Pass-through everywhere it can't run (kind has no `interaction`, resolver throws ⇒
step fails cleanly, no window registered ⇒ generic decision modal on the park) so
existing pipelines and the engine tests are untouched — the same pass-through discipline
as every gate/reviewer seam.

### 4. Overlays / top-level modals (slice D)

`pages/index.vue` hand-mounts ~45 modals as `v-if`s on ad-hoc `ui` store booleans — the
one surface a consumer flatly cannot extend today (a nav item's `run` closure has nothing
to open). Design:

- An `appOverlays` slot: `{ id: '<ns>:<name>', component }` (a `ComponentEntry`, pairing
  - boot fail-fast as in §1).
- A generic `ui.openOverlay(id, subject?)` / `ui.closeOverlay()` pair holding a single
  `activeOverlay: { id, subject } | null`, and one `<AppOverlayHost>` mounted in
  `index.vue` that resolves the slot and mounts the active entry. This is finally the
  natural home for the upstream `OverlayOutlet`/`useOverlay` primitives that slice 5
  released but did not adopt (the result windows preferred the slotted shell) — adopt
  them here; the window components themselves keep composing `ResultWindowShell` /
  `useModalBehavior` for chrome.
- **Scope discipline:** the slice ships the seam + host + one consumer example. The ~34
  existing lazy modals are NOT migrated wholesale; they convert opportunistically (each
  conversion deletes a `ui` boolean + an `index.vue` line) — strangler, like everything
  else here. First-party fast-path modals (DecisionModal, AddTaskModal, …) stay put.

### 5. Consumer notification kinds (slice E)

For extensions whose backend raises its OWN notification types (beyond §3's
`interaction_pending`): widen `notificationTypeSchema` to
`union(picklist, namespacedId)`, and add a `notificationKinds` slot:
`{ type: '<ns>:<name>', icon, color, actionKey?, reveal?(notification, ctx) }`.
`NotificationsInbox.vue` keeps its three exhaustive `Record`s for the built-ins and
consults the merged slot for namespaced types; an UNREGISTERED namespaced type renders a
safe default row (bell icon, "Open" action, reveal ⇒ `ui.select(blockId)`), so a stale
notification never breaks the inbox. `ctx` hands the reveal handler the same typed
surface the built-in reveals use (`ui`, the execution store lookups) rather than raw
store imports.

### 6. Consumer stream events (slice F — last, and deliberately narrow)

The workspace stream's `onMessage` switch drops unknown event types silently, and the
adoption tracker marks the event fan-out a choke point to leave alone. The narrow,
non-invasive design: the `WorkspaceEvent` union gains ONE member
`{ type: 'custom', kind: '<ns>:<name>', workspaceId, payload }` (backend: a
publisher-side helper to emit it), and `onMessage` gains ONE terminal branch looking up
`kind` in the merged `streamHandlers` slot (`{ kind, handle(payload, ctx) }`). No
existing branch changes; the fan-out refactor stays a separate future initiative.
Consumer handlers typically patch the consumer's own Pinia store, which its windows and
panels read — the layer's stores are not writable from consumer code.

### 7. Already-landed seams (documented, not re-built)

For completeness — these are DONE (modular-vue slices 1–5) and slice A's authoring guide
documents them as part of the one consumer surface:

| Seam                                        | Slot / primitive                                      | Host                                        |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Sidebar / command-palette / toolbar entries | `nav` (`NavContribution`, reactive RBAC `slotFilter`) | the three shells via `useNavContributions`  |
| Run-detail windows                          | `resultViews` (`ComponentEntry`)                      | `StepResultViewHost` via `dispatchStepView` |
| Agent kinds (palette data)                  | `agentKinds` slot + snapshot manifest                 | agents store merge                          |
| Inspector body panels                       | `inspectorPanels` (`PanelEntry<Block>`)               | `<PanelsOutlet>` in `InspectorPanel`        |
| Multi-step wizards                          | `registerJourney` + step modules                      | `<JourneyHost>`/`<JourneyOutlet>`           |
| Window chrome                               | `ResultWindowShell` / `useModalBehavior`              | composed by each window                     |
| Locale strings                              | layer deep-merge of `i18n/locales/*.json`             | `@nuxtjs/i18n`                              |

**Explicit non-goals of this initiative:** replaceable board NODE components (Vue Flow
node internals stay first-party; custom task types get presentation-driven badges, and if
richer per-card affordances are ever needed the slice-4 panels primitive supports a
`taskCardAdornments` group as a follow-up — not committed here); routing/pages (the SPA
is single-route); consumer mutation of first-party stores; the `applySnapshot` /
`onMessage` fan-out refactor (unchanged choke-point policy, §6's single branch excepted).

## The public surface (slice G — hardening)

Consumer extensions are only durable if the layer declares what they may import. Slice G
ships an explicit, exported, semver-guarded public surface from `@cat-factory/app`:

- **Registration:** `registerAppModule`, `defineModule`, the `AppSlots` contribution
  types (`NavContribution`, `ResultViewContribution`, `PanelEntry<Block>`,
  `CustomAgentKind`, + the new `TaskTypeContribution`, `OverlayContribution`,
  `NotificationKindContribution`, `StreamHandlerContribution`).
- **Composables:** `useResultView`, `usePanelSubject`, `useStepInteraction` (§3),
  `usePanelsOutlet` re-exports, the read-models (`agentKindMeta`, `taskTypeMeta`),
  `ui.openOverlay` (via a thin `useAppOverlays`), and a scoped authed API client for
  consumer routes (`useConsumerApi(namespace)` — baseURL + auth + error mapping, so
  consumer backends mounted on the same host are reachable without touching `useApi`).
- **Types:** the wire types consumers render (`Block`, `PipelineStep`, `Notification`,
  the step-interaction payload envelope) re-exported from one entry point.
- Everything else in the layer is internal; the guide says so, and a `knip`-style export
  audit keeps the public entry honest. Consumer-visible changes to this surface are
  minor changesets per the existing convention.

## Per-slice checklist

| #   | Slice                     | Target                                                                                                                                                                                                                                                    | Status | PRs     |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- |
| A   | Dogfood + authoring guide | Worked consumer example module in `deploy/frontend` pairing with `@cat-factory/example-custom-agent` (result window for `security-auditor`, a nav entry, an inspector panel); `frontend/app` consumer-authoring doc; e2e spec driving the consumer window | done   | this PR |
| B   | Custom task types         | Contracts widen + `customTaskTypeSchema`; kernel `TaskTypeRegistry` + validation + conformance; snapshot `customTaskTypes`; frontend `taskTypes` slot/store/read-model, `AddTaskModal` descriptor fields + `taskTypeFormPanels`, card badge fallback      | todo   | —       |
| C   | Generic step interaction  | Backend `interaction` registration + generic park/submit routes + `interaction_pending` notification; frontend `useStepInteraction`; example interactive consumer agent; conformance both runtimes                                                        | todo   | —       |
| D   | Overlays                  | `appOverlays` slot + `<AppOverlayHost>` (adopting upstream `OverlayOutlet`/`useOverlay`) + `ui.openOverlay`; one consumer example; opportunistic first conversions                                                                                        | todo   | —       |
| E   | Notification kinds        | `notificationTypeSchema` widen + `notificationKinds` slot + safe default row                                                                                                                                                                              | todo   | —       |
| F   | Custom stream events      | `custom` `WorkspaceEvent` member + `streamHandlers` slot + single `onMessage` branch                                                                                                                                                                      | todo   | —       |
| G   | Public surface            | Exported registration/composable/type surface, export audit, semver policy documented                                                                                                                                                                     | todo   | —       |

Sequencing: A first (it exercises only landed seams and produces the guide the later
slices extend); B and C are independent after A; D–F are independent of each other;
G closes. Each slice follows the repo rules: e2e (`data-testid` + live-push) before
refactor, changesets, doc sweep, and — where a slice touches modular-vue itself — the
co-evolution loop from the [adoption tracker](./modular-vue-adoption.md) (upstream fix,
release, re-adopt in-slice; no shims outliving a slice).

## Slice A outcomes (landed)

- **A worked consumer module ships in `deploy/frontend`** — the `acme:security` module
  (`deploy/frontend/app/modular/acme-security.ts`, registered from
  `app/plugins/acme-security.client.ts`), the frontend analogue of the backend
  `@cat-factory/example-custom-agent`. One `registerAppModule` call contributes to EVERY landed
  seam at once: a bespoke `resultViews` window (`AcmeSecurityReport.vue`) paired to
  `acme:security-report`, the `agentKinds` palette entry that routes the `security-auditor` kind
  to it, a `nav` sidebar/command destination, and an `inspectorPanels` panel for task blocks —
  all with zero host edits and no deep imports into the layer's `app/components/*` internals
  (shared components are named through the `#components` virtual registry; composables + the
  `registerAppModule` seam are auto-imported). Its strings ship in
  `deploy/frontend/i18n/locales/en.json` (layer deep-merge).
- **Shared building blocks are reused, not reinvented.** The example window composes the layer's
  `ResultWindowShell` (chrome + `useModalBehavior` Escape/focus-trap/scroll-lock), the shared
  `StepRunMeta` run-details metadata block, and `MarkdownProse` — all referenced via
  `#components` — together with the auto-imported `useResultView`; the inspector panel reuses
  `InspectorSection` (via `#components`) + `usePanelSubject`. This proves a consumer gets the
  same run-detail surface the first-party windows use for free — the explicit ask that shaped
  this slice. **Gotcha carried to slice G:** a bare layer-component tag in a _consumer_ SFC
  silently renders as an unknown element (Nuxt registers layer components under a path-derived
  name and only rewrites bare tags in the layer's own SFCs), so a consumer must reference them
  through `#components`; slice G hardens this into an explicit, location-independent public
  export surface. The authoring guide documents the reusable palette + this rule.
- **The authoring guide** (`frontend/app/app/docs/consumer-extensions.md`, linked from the layer
  README + `deploy/frontend/README.md`) documents the one seam (`registerAppModule` +
  `enforce:'post'` ordering), the landed seam table, the shared-building-block table, the i18n
  deep-merge, and the namespacing/degradation rules.
- **e2e drives the dogfood end to end** (`backend/internal/e2e/tests/consumer-extension.spec.ts`):
  the consumer nav entry + inspector panel render, and a run whose pipeline includes
  `security-auditor` opens the paired consumer window from the completed step. No backend change
  was needed — the pipeline-shape validation doesn't gate kind existence and the deterministic
  fake runs an unregistered kind inline (prose), so the window renders without registering the
  example package on the e2e backend (a deployment that ships the backend package additionally
  gets the structured assessment on `step.custom`).
- **Only landed seams were exercised.** No modular-vue upstream work and no `@cat-factory/app`
  code change — the layer change is docs-only; `deploy/frontend` + `@cat-factory/e2e` are
  changeset-ignored. Slices B–G add the still-missing seams on top of this proven base.

## Conventions & gotchas (carried between slices)

- **Copy the agents-store merge shape for every new catalog** (consumer slot + remote
  manifest + built-ins → reactive merged catalog → sync-flushed pure read-model). It
  already solved no-shadowing, content-hashed no-op re-hydration, and store-free
  renderer lookups.
- **Every new slot gets a boot-time fail-fast resolve** in `modular.client.ts`
  (duplicate ids throw at startup, not first use) and a dev-warn `missing` bucket for
  unpaired wire ids.
- **Never let stale backend data break rendering.** Any id that arrives on the wire
  (task type, notification type, resultView, event kind) must have a defined degraded
  rendering when no registration matches — extensions get removed; persisted rows
  outlive them (backwards compat is a non-goal for shapes, but the frontend still must
  not crash on a leftover string).
- **The remote manifest is capability DATA only** — components never travel the wire;
  per-workspace variability is expressed by which capabilities the snapshot lists, not
  by which modules are registered (registration is boot-static).
- **Keep the runtimes symmetric** for every backend half (registry threading,
  interaction routes, notification raise) with conformance assertions in the same PR.
- **Interaction payloads are step-state, not a side table** — runtime-symmetric by
  construction (the `forkDecision`/`followUps` precedent); size-budget and
  wire-validate them.
- **`enforce: 'post'` stays load-bearing**: consumer registration must happen in
  plugin-setup of a default/`pre` plugin; document this in every consumer-facing
  example, because a consumer `enforce: 'post'` plugin silently registers too late.
