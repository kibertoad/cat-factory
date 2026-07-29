# `@cat-factory/app` — Frontend (Nuxt layer)

The user-facing app, packaged as a **reusable Nuxt 4 layer**: a single-page app
that runs entirely in the browser and renders the architecture board, drives agent
pipelines, and reflects live execution. A deployment consumes it via
`extends: ['@cat-factory/app']` (see [`deploy/frontend`](../../deploy/frontend)).
It talks to the [backend Worker](../../backend/README.md) over REST and a single
WebSocket, sharing wire types from
[`@cat-factory/contracts`](../../backend/packages/contracts).

The SPA source lives under `app/` (the Nuxt srcDir).

## Table of contents

- [What it is](#what-it-is)
- [Tech stack](#tech-stack)
- [Layout](#layout)
- [Interface modes (basic / advanced)](#interface-modes-basic--advanced)
- [Key UI surfaces](#key-ui-surfaces)
- [Develop & test](#develop--test)

## What it is

A spatial planning surface. You lay out a system as a **board** of frames
(services), modules and tasks on a [Vue Flow](https://vueflow.dev) canvas, wire up
dependencies, attach requirements, and apply **agent pipelines** to blocks.
Execution streams back in real time — step/subtask progress bars, decision
prompts, failures with retry — so the canvas doubles as a live dashboard.

It is a thin client: there is **no business logic here**. Every mutation calls the
Worker API and the stores hydrate from server snapshots and live updates pushed
over the WebSocket. How that sync works is written up in
[`app/docs/architecture.md`](./app/docs/architecture.md).

## Tech stack

- **Nuxt 4 / Vue 3** SPA — single route (`pages/index.vue`).
- **Pinia** (+ `pinia-plugin-persistedstate`) — feature stores.
- **Vue Flow** (`core`, `background`, `controls`, `node-resizer`) — the canvas.
- **Nuxt UI** + Tailwind — components and styling.
- **VueUse** — composable utilities.
- Lint/format via **oxlint** + **oxfmt**; tests via **vitest** + **happy-dom**.

## Layout

| Path              | Contents                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.vue`         | Root; wraps the page in `AuthGate`.                                                                                                                   |
| `pages/index.vue` | The only route — mounts the sidebar, canvas, toolbar, inspector, focus view, and all modals.                                                          |
| `components/`     | UI grouped by area (see [Key UI surfaces](#key-ui-surfaces)).                                                                                         |
| `composables/`    | `useApi` (typed client), `useWorkspaceStream` (WebSocket sync), `useBlockDrag`, `useBlockQueries`, `useBoardFlow`, `useSemanticZoom`, `useDepLabels`. |
| `stores/`         | Pinia stores, one per feature domain.                                                                                                                 |
| `types/`          | TypeScript domain unions (`domain.ts`) and wire types mirroring the contracts.                                                                        |
| `utils/`          | Small pure helpers.                                                                                                                                   |

## Interface modes (basic / advanced)

The SPA renders at one of two **interface tiers**. `basic` (the default) is the everyday
**delivery** surface — plan work on a board, run it, review and merge it: the run/pipeline
options that only exist to override a workspace-level default are left at that default, and
the nav is trimmed to what that loop needs. `advanced` shows everything. The tier resolves in
a fixed order, first match wins:

1. **`NUXT_PUBLIC_UI_MODE`** (`basic` | `advanced`) — the deployment pin. Like
   `NUXT_PUBLIC_API_BASE` it is baked in at **build** time (`ssr: false`), and while it is
   set the in-app switcher is a read-only indicator, since a preference the resolver ignores
   would be a lie. An unrecognised value is ignored rather than failing the boot.
2. **The user's own choice**, persisted client-side (the `uiMode` store) and changed from the
   switcher at the bottom of the sidebar — or from the **command palette** entry, which is
   deliberately _not_ an advanced item: basic is the default, so the route back to the
   advanced half has to exist inside basic mode.
3. **`basic`.**

The sidebar can independently be **collapsed to an icon rail** (the toggle at its top, lg+
only — below `lg` the navbar is already an off-canvas drawer). The rail preference is
**per-tier**: basic _defaults_ to railed and advanced to expanded, and each tier remembers its
own choice, so an expand in either survives a reload and a round trip through the other.

Two seams carry the tier, and a new feature should use them rather than reading the store ad
hoc where it can be avoided:

- **A nav destination** declares `advanced: true` in `app/modular/nav-contributions.ts`. The
  shared `navSlotFilter` drops it in basic mode across all three shells (sidebar, command
  palette, toolbar), independently of its RBAC `gate` — both must pass. A consumer module's
  own contributions take the same flag. The bar is **whether the everyday delivery loop needs
  it**, and marking an item does one of two distinguishable things:
  - **Reached another way** — a shortcut whose surface a basic destination also opens, so
    nothing is lost (the Merge / Service-best-practices palette entries into Workspace
    settings, the local-models knob the Model providers hub already offers).
  - **Out of the tier** — the sole route, hidden on purpose, so the capability is _absent_
    from basic mode and the tier switch is the way to it (Sandbox, Kaizen, repo bootstrap,
    and the deployment-wide operator + reports rollups).

  Sole-route items stay in basic when the delivery loop runs on them: the pipeline builder,
  add-from-repo, the fragment library, the infrastructure/PREnv windows, and the workspace /
  model configuration a run actually reads. `nav-contributions.spec.ts` pins the advanced set
  against a table naming each item's kind and reason, so promoting one forces that claim to be
  written down rather than assumed.

- **A less-used option inside a surface** reads `useUiModeStore().isAdvanced`. Hide, never
  disable, and only ever hide an OVERRIDE: what remains must be exactly the default the hidden
  field would have shown, so a basic-mode user never gets different behaviour from an advanced
  one — only fewer choices. An input nothing else supplies (the pipeline, the apriori branches)
  stays in both tiers however advanced it feels.
- **A whole AUTHORING affordance** may be tier-scoped the same way — the frame header's
  recurring-schedule and initiative buttons are advanced-only — but only while the tier hides
  the ability to CREATE, never the ability to SEE. Existing state has to stay legible in basic
  mode through its normal surfaces (a live schedule still badges its task card and opens its
  inspector panel; an initiative is still a block on the board with its own inspector), or the
  tier turns into a way for a user to be acted on by configuration they cannot find.
- **An override control on an EXISTING entity gates on `showOverrideField(isAdvanced, …values)`**
  (`app/utils/uiMode.ts`) rather than on `isAdvanced` alone. Hiding an override is only safe
  while it is unset — always true for a creation form, never guaranteed for a block that a
  teammate on the advanced tier (or the API) already wrote one onto. The helper reveals the
  control, editable, as soon as any value it edits is set (`false` included — a tri-state
  `false` is a choice, not absence), so basic mode can never conceal a setting a run will
  actually use.

## Extending the layer (consumer modules)

A deployment can contribute its own components — result windows, nav entries, inspector
panels, agent-kind palette data — **without forking**, through the auto-imported
`registerAppModule` seam (the frontend analogue of the backend's `registerAgentKind` /
`registerGate` registries). The authoring walkthrough, the reusable shared building blocks
(`ResultWindowShell`, the `StepRunMeta` run-metadata block, `useResultView`, …), and the
namespacing / degradation rules are in
[`app/docs/consumer-extensions.md`](./app/docs/consumer-extensions.md); a full worked
example ships in [`deploy/frontend`](../../deploy/frontend) (the `acme:security` module).

## Key UI surfaces

- **Board canvas** (`components/board`) — `BoardCanvas` + `nodes/` (`BlockNode`,
  `ModuleFrame`, `TaskCard`), dependency edges, the per-block `AgentFailureCard` /
  `AgentStopButton`, and a deep-zoom `focus/BlockFocusView`. A running task card expands
  its build pipeline (`TaskPipelineMini`) on hover at any zoom level, and across every
  on-screen card past the `steps` zoom band — the two grants are combined in the
  `taskExpansion` store and driven by `useTaskExpansion`.
- **Sidebar & chrome** (`components/layout`) — board/account switchers, palettes
  entry points, the language + [interface-mode](#interface-modes-basic--advanced)
  switchers, the `SpendWarningBanner`, and the toolbar (zoom, LOD, decision queue).
- **Palettes** (`components/palettes`) — drag blocks, pipelines and agents onto
  the board.
- **Inspector** (`components/panels` + `panels/inspector`) — per-block tabs:
  structure, dependencies, model + fragment picker, live execution, and linked
  docs/issues/scenarios. Decisions resolve via `DecisionModal`.
- **Pipeline builder** (`components/pipeline`) — assemble/edit agent chains and
  watch `PipelineProgress`. `PipelinePicker` (+ its `PipelinePreview` pane) is the
  single way a pipeline is chosen anywhere — add-task, run settings, the recurring
  schedule, the focus view's Run menu — so every surface explains a pipeline by the
  ordered steps it will run rather than by its name alone.
- **Context attachments** (`components/context`) — `ContextAttachmentFields`, the
  shared staged-attachment form used by both the add-task and create-initiative
  modals. Picks are held locally and import-and-linked once the block exists (see
  `composables/useContextLinking`), because linking needs a block id. Both hosts
  attach to the SAME per-block linkage, so the inspector's `TaskContextDocs` /
  `TaskContextIssues` sections render for a task AND an initiative — an initiative's
  attachments would otherwise be invisible the moment the create modal closed.
- **Integrations** — modals/panels for `github` (the source-control panel, shared
  by every VCS provider), `vcs` (the GitLab personal-access-token connect),
  `bootstrap`, `documents`, `tasks`, `requirements` (review), `scenarios`
  (acceptance), and `fragments` (the prompt-fragment library).
- **Model providers** — `ModelProvidersHub.vue`, the sibling hub for the ENGINES
  (OpenRouter, vendor keys, personal subscriptions, own-machine runners). Kept out
  of the Integrations hub on purpose: an integration is optional context in or
  output out, while a provider is what executes the work, so a deployment with none
  connected runs nothing at all. **A new provider-shaped connection belongs here,
  never in `IntegrationsHub.vue`.** Both hubs, plus the user-scoped `PersonalSetupModal`,
  share the `IntegrationBackTitle` Back control, which returns to whichever hub set
  its came-from marker (`ui.cameFrom{Integrations,ModelProviders,Personal}`) — a panel
  reachable from more than one hub must not hard-code its return.
- **Auth** (`components/auth`) — `AuthGate` / `LoginScreen` / `UserMenu`; the app
  is gated when the backend requires sign-in.

## Where a surface lives

Two placements are load-bearing enough to state, because putting a new one in the
wrong place is invisible until a user cannot find it:

- **The sidebar section is a claim about what the destination IS.** `models` is the
  engines, `integrations` the optional systems, `infrastructure` where agent
  containers and test environments run, `configuration` workspace/account settings.
  `nav-contributions.spec.ts` pins the section order and each section's membership.
- **A flow that edits ONE entity's config is a section of the window that owns that
  config, not a sibling nav entry.** The guided Docker Compose environment setup
  (`ComposeEnvironmentSetupSection.vue` → `EnvironmentSetupWizard.vue`) lives inside
  Infrastructure → Test environments for exactly this reason: it writes a service's
  Compose recipe plus the workspace's Compose handler, both configured in that tab.
  It also carries a full "how it works / when you need this / when you can skip it"
  explanation there rather than a one-line hint, since the decision to run it has to
  be made before opening a five-minute wizard.

## Develop & test

```bash
pnpm install
pnpm dev          # Nuxt dev server (expects the Worker running; set NUXT_PUBLIC_API_BASE)
pnpm test         # vitest
pnpm typecheck    # nuxt typecheck
pnpm lint         # oxlint + oxfmt --check
```

> Building/deploying the static site is covered in the deployment docs — see the
> [top-level README → Deployment](../../README.md#deployment) and
> [`deploy/frontend/README.md`](../../deploy/frontend/README.md).
