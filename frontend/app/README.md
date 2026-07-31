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
- [Agent tiers (basic / intermediate / advanced)](#agent-tiers-basic--intermediate--advanced)
- [In-app tutorial tours](#in-app-tutorial-tours)
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

### A store must be instantiable outside a component `setup`

A Pinia setup store runs its body on the FIRST `useStore()` anywhere in the app, and that
caller is not always a component: `plugins/modular.client.ts` builds the nav gates
(`createNavGates`) during plugin setup, which instantiates a handful of stores before any
component exists. So nothing a store reaches for at setup time may require an active
component instance.

The one that bites is **`useI18n()`, which throws `MUST_BE_CALL_SETUP_TOP` outside a
component** — and because it happens inside a plugin, Nuxt's error boundary replaces the
whole app with its 500 page rather than surfacing a broken feature. Resolve translations
through the Nuxt app's global i18n instance instead (`useNuxtApp().$i18n`, typed as
`ReturnType<typeof useI18n>`), as `stores/board.ts`, `stores/recurringPipelines.ts` and
`composables/usePipelineErrorToast.ts` do. This costs no typed-message-key coverage: tier 1
only sees literal keys written in a `<script setup>`, never in a `.ts` store or composable.

The blast radius is why this is a rule rather than a preference — a store reached one call
earlier than before takes the entire SPA down at boot, and the unit suite cannot see it
(nothing there installs the plugin). Every e2e spec does, because every one of them boots
the app.

### Always import a layer component explicitly

**Import a component under `components/` by path before using it in a template.** Do not lean on Nuxt's auto-registration. This layer sets no `components` config, so the default `pathPrefix: true` applies and a component is registered under its path-prefixed name: `components/panels/StepEffortReport.vue` becomes `PanelsStepEffortReport`, and a bare `<StepEffortReport>` matches nothing.

Some bare tags do work, which is exactly what makes this worth writing down. Nuxt drops a directory segment the filename already repeats, so `pipeline/PipelinePicker.vue` registers as `PipelinePicker` and resolves bare, while `pipeline/AgentKindIcon.vue` in the same folder registers as `PipelineAgentKindIcon` and does not. Whether a tag resolves therefore depends on a coincidence between a folder name and a filename, and renaming either end breaks the tag with no error. An explicit import does not care.

The failure is silent, which is why this is a rule rather than a preference. An unresolved tag warns in dev and then renders nothing, so a built SPA has a hole where the component should be. Nothing catches it: not typecheck, not the unit tests, not the e2e suite, and not the user, who reads it as a backend returning no data. Seven components had shipped this way.

`scripts/check-component-imports.mjs` enforces it (CI's `repo-guards` job). If a panel section is missing and the data looks right, check the import first.

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
   switcher at the top of the sidebar, under the board switcher — or from the **command
   palette** entry, which is deliberately _not_ an advanced item: basic is the default, so the
   route back to the advanced half has to exist inside basic mode.
3. **`basic`.**

That switcher is a **segmented control showing both tiers**, above the fold rather than in the
footer, because basic is the shipped default and it is most users' only sight of the tier: a
dropdown states the current mode but not that another one exists, so the half of the product it
gates stays invisible to anyone who does not open menus to see what is in them. In the collapsed
rail it degrades to one button that flips the tier (with only two modes a toggle is
unambiguous), keeping the current tier's name under the glyph.

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

## Agent tiers (basic / intermediate / advanced)

A separate, narrower axis: how deep into the **agent catalog** a surface reaches. Every agent
kind carries a `tier` — `basic` (the everyday delivery loop), `intermediate` (reached for
regularly) or `advanced` (specialist) — and the two surfaces that enumerate the catalog, the
**pipeline builder's palette** and the **model preset's per-agent override list**, show the
selected tier and everything below it. They open on `basic`; the `AgentTierSelect` control on
each widens them, with `advanced` showing the whole catalog. The choice is one shared,
persisted preference (the `agentTier` store), because picking the agents a pipeline runs and
picking what each of them runs on are halves of the same job.

- The vocabulary, the default and the cumulative predicate live in `@cat-factory/contracts`
  (`AGENT_TIERS` / `DEFAULT_AGENT_TIER` / `agentTierVisibleAt`), beside
  `purposeAllowsAgentCategory` — so a **deployment-registered kind's** declared tier
  (`presentation.tier`, carried in the workspace snapshot) and the SPA's own built-ins are
  read by one rule. A kind that declares no tier is treated as `intermediate`.
- **This is not the interface mode.** That tier decides which surfaces the whole SPA offers;
  this one decides how much of one surface's catalog is listed. They are independent — an
  advanced-mode user still starts on the basic agent tier — and the tier control is present in
  **both** interface modes, since it is the only route to the kinds it hides.
- A narrowed catalog states what it is holding back (the "n hidden at this tier" hint), and
  the model preset list **always keeps a kind the edited preset already pins a model for**,
  whatever the tier — the same rule `showOverrideField` states for a single field: a row the
  user can neither read nor clear is worse than a longer list.

## In-app tutorial tours

On first launch (once the board is up and no other startup advisory is open) the app asks
whether the user wants a guided tour. The answer is SAVED per browser (`stores/tutorial.ts`,
persisted like the interface tier): "no thanks" stops the prompt for good, closing without
answering defers it to the next launch, and the command palette's "Take a tour" entry is the
way back either way.

A tour is **data, not components**: an ordered list of steps, each pointing at an on-screen
control by its `data-testid` (the e2e anchor vocabulary — cover a control that has none by
adding the test id first) and carrying i18n keys for its copy. One shared runtime
(`components/tutorial/TutorialOverlay.vue`) renders every tour: it highlights the current
step's control, places the tooltip (`utils/tutorial.ts` owns the pure geometry + types),
advances on Next or — for `advanceOn: 'target-click'` steps — on the user really clicking
the control, so the app's real response (the actual modal, the actual task) is what the next
step anchors to. `target-click` is for BUTTONS, where the click is the completed action; a
text field keeps Next, or the tooltip would leave the instruction the moment the user clicked
in to type. A step whose anchor never appears within its wait is SKIPPED, because controls
come and go with RBAC, tier, and deployment wiring: a tour is a set of opportunities, not a
fixed script. Reaching the end having skipped steps is reported on the final card rather than
congratulating the user on a walkthrough they did not see — and a tour that could only ever
be abridged should not be offered at all, which is what each tour's `when(gates)` is for (the
task-creation tour requires board write AND a service frame to add a task to).

**A step carries its own `when(gates)` when its BRANCH, not its control, is the thing that
may not apply.** The two are different facts and only one of them is a defect: a skip means
the control should be here and isn't, while a `when` means this board is not on that branch
of the flow (a run parked on a decision has no approval gate, and the reverse). Reporting the
second as an abridged tour would tell a user who saw exactly the right walkthrough that they
missed half of it, every time. `resolveTours` (in `utils/tutorial.ts`, applied by
`navSlotFilter`) drops the rejected steps and then drops a tour left with none, so a tour
whose every step is branch-specific can never open on an empty cursor. With no gates service
wired at all (a bare install withholds nothing) every branch survives instead, and only one
of them can anchor — so the abridged notice ignores any skipped step that carries a `when`,
which has already declared that not applying is legitimate.

**Gates decide what is OFFERED; the running tour's script is resolved once and HELD.** The
overlay snapshots its tour when it starts rather than re-reading the gated slot on every
flip. This is not an optimisation: gates over live run state flip as a direct result of
following the tour — `answer-park` is offered while something waits for a human, so the
moment the user answers, its `when` goes false. A re-reading overlay tore itself down there,
one step short of its own finish card and with nothing recorded as completed, at exactly the
moment the user succeeded. Holding the script also freezes the branch `resolveTours` chose,
so a step can't be swapped underneath a stationary cursor.

**Gates must mean what the board RENDERS, not what the store holds.** `boardHasOpenDecision`
/ `boardHasPendingApproval` are not the store's raw pending counts: a park on a frame block
has no task card, and a reviewer gate mid-cycle is deliberately suppressed by the card
(`useReviewStage().isBackground`), so either would offer a tour onto a control that isn't
there. `hasActionablePark` (`modular/nav-gates.logic.ts`) is the shared rule; the run gates
are task-scoped for the same reason.

**Fixed proper nouns ride `bodyParams`, not the catalogs.** A step naming the sample
repository slug (`SAMPLE_REPO` in `modular/tutorial-tours.ts`) passes it as a `{repo}`
interpolation, so it is written once in code rather than translated into ten catalogs that
each drift on their own — the same split components make for inline placeholders.

The built-ins walk the delivery loop end to end, each gated on the state the previous one
leaves behind, so the launch prompt only ever offers what this board can demonstrate: board
basics, add a repository (`add-service`), create a task (`first-task`), run it (`run-task`),
answer it when it parks (`answer-park`), review and merge the result (`review-merge`). One
deliberate asymmetry: `run-task` points at Start without click-to-advance, because starting a
run spends real model budget and nobody should discover they agreed to that by following a
tutorial.

Two runtime constraints worth knowing before changing the overlay: it must keep
`pointer-events-auto` and swallow `pointerdown`, because Nuxt UI modals are reka-ui
dismissable layers that set `body { pointer-events: none }` and dismiss on an outside
pointerdown — without both, the tooltip's own buttons go inert and pressing one closes the
user's half-filled form. And everything that DECIDES (skip direction, wait budget,
target-click matching, which skips count as abridged) lives in
`components/tutorial/TutorialOverlay.logic.ts` so it is unit-tested; the SFC keeps only the
DOM work. Note that target-click matching is by SELECTOR, not by the highlighted element:
several anchors (`task-card`, `task-resolve`, `run-step`) render once per board item and the
ring can only sit on one of them, so requiring the click to land on that one left a user who
clicked the card the copy asked for with no way forward — such a step renders no Next.

The catalog is the `tutorialTours` slot: first-party tours live in
`modular/tutorial-tours.ts`, and a consumer deployment contributes its own through
`registerAppModule` — they appear in the launch prompt beside the built-ins, gated per tour
by its `when(gates)` predicate (the same reactive gates service the nav uses, filtered in
`navSlotFilter`). Completion is persisted per tour id, so renaming an id resets its state.

## Extending the layer (consumer modules)

A deployment can contribute its own components — result windows, nav entries, inspector
panels, agent-kind palette data — plus two DATA-only seams that need no components at all:
its own applications in an **External tools** sidebar section (`externalTools`, each
resolving its URL from the acting user / open workspace / this board's custom fields) and the
**custom workspace metadata fields** those resolvers read (`workspaceMetadataFields`, edited
on the Metadata tab of Workspace settings). All of it **without forking**, through the
auto-imported
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
  docs/issues/scenarios. Decisions resolve via `DecisionModal`. A `review` task
  additionally leads with `TaskReviewTarget`, linking the pull request it reviews —
  distinct from the execution panel's link to the PR a run PRODUCED, which a review
  task never has.
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
  model layer — the engines, the per-agent model choice, and the surfaces that
  evaluate a prompt+agent+model combination (Sandbox, Kaizen); `integrations` the
  optional EXTERNAL systems; `infrastructure` where agent containers and test
  environments run; `configuration` workspace/account settings. A surface that
  connects to nothing does not belong in `integrations` however configuration-shaped
  it feels. `nav-contributions.spec.ts` pins the section order and each section's
  membership.
- **A flow that edits ONE entity's config is a section of the window that owns that
  config, not a sibling nav entry.** The guided Docker Compose environment setup
  (`ComposeEnvironmentSetupSection.vue` → `EnvironmentSetupWizard.vue`) lives inside
  Infrastructure → Test environments for exactly this reason: it writes a service's
  Compose recipe plus the workspace's Compose handler, both configured in that tab.
  It also carries a full "how it works / when you need this / when you can skip it"
  explanation there rather than a one-line hint, since the decision to run it has to
  be made before opening a five-minute wizard.
- **"It talks to an external service" is not what puts a surface in `integrations`.**
  Private package registries connect to npmjs.com and GitHub Packages and still belong
  in Infrastructure, because the question they answer is _what may a container install
  from_ — a property of where agents RUN, which is what the Infrastructure window is
  for. `integrations` is for a system the WORKSPACE links in and would still be a
  coherent product without. Ask which question the destination answers, not whether a
  credential leaves the building. A surface moved between sections must also move its
  entry point: leaving a hub row behind as a shortcut splits the answer across two
  places, so the row goes and the window's tab becomes the single route in.

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
