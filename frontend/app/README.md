# `@cat-factory/app`: Frontend (Nuxt layer)

The user-facing app, packaged as a **reusable Nuxt 4 layer**: a single-page app
that runs entirely in the browser and renders the architecture board, drives agent
pipelines, and reflects live execution. A deployment consumes it via
`extends: ['@cat-factory/app']` (see [`deploy/frontend`](https://github.com/kibertoad/cat-factory/tree/main/deploy/frontend)).
It talks to the [backend Worker](https://github.com/kibertoad/cat-factory/blob/main/backend/README.md) over REST and a single
WebSocket, sharing wire types from
[`@cat-factory/contracts`](https://github.com/kibertoad/cat-factory/tree/main/backend/packages/contracts).

The SPA source lives under `app/` (the Nuxt srcDir).

## Table of contents

- [What it is](#what-it-is)
- [Tech stack](#tech-stack)
- [Layout](#layout)
- [Task swimlanes](#task-swimlanes)
- [Roles (engineer / product manager / designer)](#roles-engineer--product-manager--designer)
- [Interface modes (basic / advanced)](#interface-modes-basic--advanced)
- [Agent tiers (basic / intermediate / advanced)](#agent-tiers-basic--intermediate--advanced)
- [In-app tutorial tours](#in-app-tutorial-tours)
- [Real-time store coherence](#real-time-store-coherence-avoid-the-full-refresh-clobber)
- [Internationalization (i18n) authoring](#internationalization-i18n-authoring)
- [Extending the layer (consumer modules)](#extending-the-layer-consumer-modules)
- [Key UI surfaces](#key-ui-surfaces)
- [Develop & test](#develop--test)

## What it is

A spatial planning surface. You lay out a system as a **board** of frames
(services), modules and tasks on a [Vue Flow](https://vueflow.dev) canvas, wire up
dependencies, attach requirements, and apply **agent pipelines** to blocks.
Execution streams back in real time (step/subtask progress bars, decision
prompts, failures with retry) so the canvas doubles as a live dashboard.

It is a thin client: there is **no business logic here**. Every mutation calls the
Worker API and the stores hydrate from server snapshots and live updates pushed
over the WebSocket. How that sync works is written up in
[`app/docs/architecture.md`](./app/docs/architecture.md).

## Tech stack

- **Nuxt 4 / Vue 3** SPA: single route (`pages/index.vue`).
- **Pinia** (+ `pinia-plugin-persistedstate`): feature stores.
- **Vue Flow** (`core`, `background`, `controls`, `node-resizer`): the canvas.
- **Nuxt UI** + Tailwind: components and styling.
- **VueUse**: composable utilities.
- Lint/format via **oxlint** + **oxfmt**; tests via **vitest** + **happy-dom**.

## Layout

| Path              | Contents                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.vue`         | Root; wraps the page in `AuthGate`.                                                                                                                   |
| `pages/index.vue` | The only route: mounts the sidebar, canvas, toolbar, inspector, focus view, and all modals.                                                           |
| `components/`     | UI grouped by area (see [Key UI surfaces](#key-ui-surfaces)).                                                                                         |
| `composables/`    | `useApi` (typed client), `useWorkspaceStream` (WebSocket sync), `useBlockDrag`, `useBlockQueries`, `useBoardFlow`, `useSemanticZoom`, `useDepLabels`. |
| `stores/`         | Pinia stores, one per feature domain.                                                                                                                 |
| `types/`          | TypeScript domain unions (`domain.ts`) and wire types mirroring the contracts.                                                                        |
| `utils/`          | Small pure helpers.                                                                                                                                   |

### The board's top overlay region has ONE owner

**A surface that appears at the top of the board renders as a member of `BoardTopOverlays`, and places nothing itself.** No `absolute`/`fixed`, no `top-*`, no z-index of its own: the band is a flex column, and it owns placement and stacking for everything in it. A member contributes only its card plus `pointer-events-auto` (the column is click-through, so its empty strip never intercepts clicks on the board underneath).

The reason this is a rule is that the alternative failed exactly once per surface. Each of the toolbar, the spend/connection/PAT banners and the four advisory banners used to anchor itself at `top-0` with its own z-index, so which one you could see came down to who picked the higher number: a standing advisory covered the zoom and fit controls outright, and the board-basics tour then ringed a control nobody could see. Tuning an offset onto one of them (`top-16`, sized against the toolbar pill) fixes the pair that was noticed and leaves the rest, and it goes stale the first time the pill wraps or grows a scrollbar. In one column the overlap is not tuned, it is unrepresentable, and a toolbar that grows pushes the banners down by exactly what it grew.

Order within the column is by what the user loses by not reading it now; the toolbar stays first so a tour anchor and the everyday zoom controls do not move as advisories come and go. Full-width page chrome (the translation-warning strip) is a different surface: it sits in NORMAL FLOW at the top of the shell, so it takes its own height rather than covering the row beneath it.

`app/components/layout/BoardTopOverlays.spec.ts` enforces the no-self-placement half, reading the member list from the component's own imports.

### A board driver that MEASURES the DOM runs off the activity pulse, never a bare RAF

Two board features cannot be derived from the stores alone: the dependency-edge overlay needs
each card's on-screen rectangle, and the task-expansion driver needs the topmost card under the
pointer. Both used `useRafFn`, so an open board paid O(edges) `querySelector` plus forced layout
reads sixty times a second with nothing moving, and the edge overlay reassigned an
equal-but-new segment array every frame on top of that.

**A new driver of that kind pairs `useSettlingRaf(compute)` with the canvas pulse
(`useBoardActivity`), and `compute` reports honestly whether it changed anything.** The pulse
answers "something may have started moving" (DOM mutations under the canvas, its resize, the
Vue Flow camera, pointer/wheel/scroll gestures) and the settling loop carries that wake through
the animation that follows, parking once the output has held still for a few frames. Neither
half works alone: a signal fires one frame BEFORE the transition it starts has any geometry, and
a bare frame loop never stops.

**The pulse does not treat its signals alike, and a driver must not assume it does.** What the
user is moving (pointer, wheel, scroll, resize, the camera's own `pulse()`) wakes the loops
immediately, because a lagging arrow under a drag is the bug this whole design exists to fix.
RENDERS do not: a live board re-renders its cards on every execution event, and admitting each
one kept the loops awake forever on exactly the board where measuring costs most, so mutations
go through a rate limit (`utils/boardWakeGate.ts`, one wake led in immediately and then at most
one per 250ms while the stream lasts). The cost is stated rather than hidden: a geometry change
caused purely by a re-render, a badge appearing and growing a card, can take up to that interval
to be followed. A driver that needs a signal the DOM cannot show, a link set changing with no
card moving, watches its own reactive source and pokes, the way `TaskDependencyEdges` watches
its four link lists.

The gesture listeners are on the WINDOW, not on the canvas element. A drag does not stop at the
canvas's edge (`useBlockDrag` tracks the pointer on the window for exactly that reason) and the
top overlay region and the inspector are siblings painted OVER the canvas, so a canvas-bound
listener went quiet for as long as the cursor crossed one of them.

**Measure through `utils/blockRects.ts`, never a `querySelector` per card.** `measureBlocks()`
hands a pass one snapshot: the cards resolved in one query, first-in-document-order per id, and
each rect read at most once. It is what makes a wake cheap enough for the rate limit above to be
a saving rather than a way of hiding an expensive pass, and it is lazy, so a pass that resolves
nothing (a board with no links at all) touches no DOM.

Two things this cost, both worth knowing before adding a third driver. `compute` returning
`true` unconditionally silently restores the old behaviour, which is why the loop's contract is
stated in terms of what the user can see rather than what the function did. And the pulse
watches `style`/`class` attributes but not the geometry attributes the overlay itself writes,
because a driver whose own output pulsed it awake would never settle.

A `compute` that THROWS parks the loop and lets the error reach the frame callback, so the next
pulse of any kind is what restarts it. Retrying the frame instead would turn one bad measurement
into a 60Hz error storm, and staying awake with no frame scheduled would make every later poke a
no-op and freeze the board for the session.

What the pulse cannot see is a reflow with no mutation and no gesture, a late-loading image or
font resizing a card. That leaves an arrow stale until the next pulse of any kind, which is the
deliberate trade: firing too often costs a handful of frames, and the alternative is the loop
that never sleeps.

`app/utils/settlingLoop.spec.ts` pins the loop against a hand-driven frame clock;
`boardWakeGate.spec.ts` pins that the rate limit delivers every suppressed wake rather than
dropping it, and `blockRects.spec.ts` that a snapshot resolves and measures each card once.

### A store must be instantiable outside a component `setup`

A Pinia setup store runs its body on the FIRST `useStore()` anywhere in the app, and that
caller is not always a component: `plugins/modular.client.ts` builds the nav gates
(`createNavGates`) during plugin setup, which instantiates a handful of stores before any
component exists. So nothing a store reaches for at setup time may require an active
component instance.

The one that bites is **`useI18n()`, which throws `MUST_BE_CALL_SETUP_TOP` outside a
component**, and because it happens inside a plugin, Nuxt's error boundary replaces the
whole app with its 500 page rather than surfacing a broken feature. Resolve translations
through the Nuxt app's global i18n instance instead (`useNuxtApp().$i18n`, typed as
`ReturnType<typeof useI18n>`), as `stores/board.ts`, `stores/recurringPipelines.ts` and
`composables/usePipelineErrorToast.ts` do. This costs no typed-message-key coverage: tier 1
only sees literal keys written in a `<script setup>`, never in a `.ts` store or composable.

The blast radius is why this is a rule rather than a preference: a store reached one call
earlier than before takes the entire SPA down at boot, and the unit suite cannot see it
(nothing there installs the plugin). Every e2e spec does, because every one of them boots
the app.

### The persisted board pin is UNVALIDATED until `init()` resolves it

`workspace.workspaceId` is restored from persisted state SYNCHRONOUSLY, before any request fires,
so every `immediate: true` watcher on it (`pages/index.vue`) runs against an id nothing has
checked. The pin can name a board that was deleted, or one whose access was revoked while the
browser held it, and the RBAC gate answers both with a 404 (it hides a denial as a not-found, so
existence never leaks). `init()` then validates the pin against `GET /workspaces` and re-points it
at a board the user can actually reach.

Firing the per-board reads on the pin anyway is deliberate: it overlaps them with the workspace
list instead of queueing them behind it, which is why `init()` fetches the pinned SNAPSHOT
speculatively too. **What travels with that is the miss.** Each of those boot reads states its own
tolerance at its own seam (`init`'s `.catch(() => null)`, `github.ensureProbed`'s internal catch,
`models.prefetchForBoard`), because a 404 there is an expected outcome and not a fault: the
watcher fires again for the board init resolved, which is the read that counts. A bare
`void store.load(workspace.workspaceId)` in that chain is an uncaught rejection in a real user's
browser, and the e2e suite's `pageErrors` fixture fails the spec that boots a session whose access
was just revoked.

Tolerating the miss is not the same as pretending it succeeded: a dropped load leaves its store
UNLOADED (`models.loaded` stays false, so `useAiReadiness().ready` is false), which reads as
unresolved rather than as a board with nothing configured, and leaves the next caller free to
retry. Pin new boot reads with a store-level unit test (`stores/models.spec.ts`).

### A backend-DECLARED form renders through `DescriptorFields.vue`

When the backend declares the fields and the SPA only collects them, render them with the shared
`components/common/DescriptorFields.vue` over the contracts vocabulary
(`contracts/src/form-fields.ts`), and never hand-roll a second renderer for the same shapes. Two
surfaces use it: an initiative preset's create form and a reusable operation's per-case form on a
custom task type (`AddTaskModal`). Adding a third is a `:fields` binding, not a component.

**Grouping is the descriptor's own, through `descriptorFieldSections`**, not a wrapper each surface
builds: consecutive fields sharing a `section` render under one caption, and the reduction applies
`showWhen` first, so a section whose every field is hidden renders no caption. Never re-group or
re-order the fields at a call site, or a form renders in an order its author never wrote.

**A captioned run is rendered FLAT, never as a per-run wrapper element** (`descriptorFormRows`
carries each run's caption on the field that opens it). Run membership is derived state that shifts
as `showWhen` reveals fields, while a field's identity does not: nesting the fields inside a wrapper
re-parents them when a boundary moves, and Vue can only do that by unmounting and remounting. The
remounted input is typically the one being TYPED INTO, because typing into the trigger is what moved
the boundary, so it loses focus, caret and IME composition mid-keystroke. Keep every field a sibling
keyed by `field.key` and the diff MOVES it instead. The same trap as keying any list by index, with a
worse symptom: `descriptorFields.spec.ts` pins that a reveal preserves every field key.

Four rules travel with it. **Validate with the shared `validateDescriptorFields`** so the submit
button reflects exactly what the server will refuse, and **submit the shared
`sanitizeDescriptorFields` result** so a stale answer on a since-hidden `showWhen` field never
reaches the wire. **Every string a descriptor carries is deployment-authored English rendered
verbatim**, labels, help, option captions and the `section` grouping captions alike: only the
platform's own chrome around them (the path-invalid message) is i18n, so no descriptor string enters
a locale catalog. And **the value-bag rules live in `utils/descriptorFields.ts`, not in the SFC**
(`defaultDescriptorValues` for the initial values, `setDescriptorValue` / `setDescriptorCheckbox` /
`toggleDescriptorGroupValue` for one edit): what an edit freezes on an entity is what a unit test
must be able to reach, and a rule inside a component is only reachable by mounting one.

Mirroring the server's check leaves one refusal still reachable, deliberately: the deployment can
re-register the descriptor while the dialog sits open, so a create can come back `422` with
`details.reason: 'task_type_fields_invalid'`. Map it to translated copy like any other reason
(`AddTaskModal`'s `createRefusalMessage`) rather than showing the server's field-key prose.

### Always import a layer component explicitly

**Import a component under `components/` by path before using it in a template.** Do not lean on Nuxt's auto-registration. This layer sets no `components` config, so the default `pathPrefix: true` applies and a component is registered under its path-prefixed name: `components/panels/StepEffortReport.vue` becomes `PanelsStepEffortReport`, and a bare `<StepEffortReport>` matches nothing.

Some bare tags do work, which is exactly what makes this worth writing down. Nuxt drops a directory segment the filename already repeats, so `pipeline/PipelinePicker.vue` registers as `PipelinePicker` and resolves bare, while `pipeline/AgentKindIcon.vue` in the same folder registers as `PipelineAgentKindIcon` and does not. Whether a tag resolves therefore depends on a coincidence between a folder name and a filename, and renaming either end breaks the tag with no error. An explicit import does not care.

The failure is silent, which is why this is a rule rather than a preference. An unresolved tag warns in dev and then renders nothing, so a built SPA has a hole where the component should be. Nothing catches it: not typecheck, not the unit tests, not the e2e suite, and not the user, who reads it as a backend returning no data. Seven components had shipped this way.

`scripts/check-component-imports.mjs` enforces it (CI's `repo-guards` job). If a panel section is missing and the data looks right, check the import first.

### Every failure toast goes through ONE funnel

**A failed call is reported with `usePipelineErrorToast().present(error, titleKey)`.** Never build
`toast.add({ title, description: e instanceof Error ? e.message : String(e) })`, and never wrap that
shape in a per-component `notifyError(title, e)` helper (29 components had a copy of the same six
lines, plus four more spellings of it).

The funnel is not a formatting convenience. Four properties are what it exists for, and a hand-built
toast has none of them:

- **Translated copy.** The description is resolved from the envelope's status class or its
  `details.reason`; the backend's untranslated prose is DETAIL, never the headline (see the i18n
  section). A hand-built toast shows English to every locale.
- **It does not auto-dismiss.** An error is the one toast a reader has to finish, quote, or act on,
  and a ~5s dismissal took it away mid-sentence. It keeps its close button, so leaving is a choice.
- **One-click copy of the whole thing**, through `useCopyToClipboard` (so the copy's own
  success/failure is reported rather than silently no-op'ing in an insecure context). Selecting text
  in a toast is fiddly and impossible once it is gone.
- **The `requestId` travels with it.** `mountRequestLogging` puts that id on every error envelope,
  and it is the ONLY join between what the user saw and the one server log line that explains it. A
  report that arrives without it costs whoever reads it the entire diagnosis.

`present` takes a KEY, not a resolved title (plus optional interpolation params), so it can resolve
its own copy. A store passes it through its context alongside `api`/`toast` (see
`stores/board/context.ts`) rather than calling the composable per write. A site with BESPOKE copy for
a recognised refusal keeps that branch and drains only its fallback into the funnel
(`stores/board/placement.ts`, `components/board/AddTaskModal.vue`).

**A FAILED CALL, though, not every refusal.** The funnel's whole job is to classify what the backend
answered, so a local check that never left the browser must not be dressed up as one: a synthesized
`new Error(t('...'))` has no envelope and no status, which is precisely the input `describeGenericFailure`
reads as a network fault. A blank required field then renders as "The server could not be reached",
with the real sentence hidden behind a disclosure. Client-side validation stays a plain
`toast.add` with translated title and description (`components/settings/ModelConfigurationPanel.vue`).

The still-open remainder is the INLINE family: `error.value = e.message` rendered in a panel, and
`testResult = { ok: false, message }` rendered by `ConnectionTestVerdict`. Those need a render
surface rather than a toast, and are tracked as G4 in
[`error-message-coverage.md`](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/error-message-coverage.md).

### Type a chip map with `BadgeColor`, never `string`

A status → chip map feeding a `<UBadge :color="…">` types its values as `BadgeColor` (`utils/badge.ts`), which is derived from `UBadge`'s own prop type rather than restated as a literal union. Typed `string`, the binding does not compile and the reflex is `as any` at each call site: seven of them had accumulated. That cast also accepts a colour Nuxt UI does not define, which renders as an unstyled badge with nothing failing.

## Task swimlanes

A service frame lays its tasks out in **status lanes**, not at coordinates. Three lanes a reader
works in (`not_started`, `in_progress`, `needs_you`) plus a collapsed **Done** strip beneath them.
The vocabulary, the classification and the Done caps are `app/utils/swimlanes.ts`; the ordering and
grouping are `app/utils/laneSort.ts`; `composables/useFrameLanes.ts` is the only store-facing half.

`useFrameLanes` runs ONE INSTANCE PER MOUNTED FRAME and any execution event invalidates all of them,
so what it derives is a performance decision as much as a modelling one. Two rules hold that line: a
derivation over WORKSPACE-wide state belongs on the store that owns its input, never here (the
review-debt map is `notifications.reviewDebtByBlock` for exactly this reason), and the assembled
output passes through `utils/laneIdentity.ts`, which hands back the previous lane / group / entry
objects wherever the fresh ones match, so the common event that moves no card leaves `TaskLane` and
`LaneGroup` diffing on `===`. That reuse is sound only while every DERIVED field is compared (those
exist nowhere but the entry, so a stale one is a lie nothing corrects), which is why a new
`LaneTaskEntry` field must be added to `sameEntry` in the same change. The `task` itself is compared
by reference and deliberately not field by field: a replaced block is a new reference, and an
in-place patch (`board/placement.ts`, the optimistic drag and field edits) is one object both entries
share, which the renderer reads through and deep reactivity invalidates on its own.

**A lane is a CLAIM, which is a higher bar than a badge.** A mislabelled badge sits beside the
truth; a card filed in the wrong lane states something false _and_ hides the card from the column
its reader was scanning. Three rules follow, and they are what the tests pin:

- **The classification is TOTAL.** `BASE_REASON_BY_STATUS` is a `Record<BlockStatus, …>`, so a new
  status fails the build; and a status the TYPE says is impossible while the DATABASE still holds it
  (a retired picklist member on an old row) resolves to `unclassified` → `needs_you`, never to
  `undefined`, which would drop the card out of every lane with nothing left to say it existed.
- **An imprecise reason beats a wrong lane.** The SPA models only decisions and approvals as global
  per-block selectors; a judge / human-test / visual-confirmation / fork / follow-up / input-gate
  park is reachable only by drilling into a step. But every one of them parks the RUN at
  `status: 'blocked'`, and that coarse marker places the card correctly even when this layer cannot
  name the surface. Such a park reports `parked` — named but imprecise, never demoted to "in flight".
- **The reason is a separate answer from the lane.** The lane says "look at this"; the reason says
  "what would I do". `failed`, `budget_paused` and `approval` all stop work dead and need three
  unrelated actions, which is why `blocking_reason` is a grouping and why a lane header can name it.

**Ordering defaults per lane** (`smart`), because the actionable order genuinely differs by column:
what can be started now / what has gone quiet / what has waited longest. Two rules bind any new
comparator: an **unknown timestamp sorts last in BOTH directions** (a run that reported no activity
is not stale and not fresh, and ranking it as either invents a fact), and **every comparator ends on
board order**, since these re-run on every live push and an unresolved tie makes the lane shuffle
itself. `nullsLast` is the single place the first rule lives.

**Sizing is decoupled from content** (`utils/laneGeometry.ts`). A lane scrolls; it does not grow. A
service with 300 open tasks gets the same frame as one with three, which is what the old free layout
could not do — a busy service grew until it dwarfed its neighbours.

Three consumers have to agree about that size, which is why the module exports two FUNCTIONS rather
than leaving each to do the arithmetic: `frameContentSize` is the frame's floor (read by
`contentSize`, and by `framePlacement.EMPTY_FRAME_SIZE`, which has to reserve a spot for a frame
that does not exist yet and so cannot measure it), and `laneBodyHeightIn` is its inverse, handing a
lane whatever the frame's ACTUAL size leaves it. A dragged border therefore grows the lanes rather
than leaving dead canvas below them, and a constant restating either answer is exactly what went
stale before. A frame with no children at all is the one that skips the lanes: it renders one "add
the first task" panel and is sized for that.

**Two preferences, deliberately different scopes.** The sort/group choice is per user, per browser
(`stores/laneView.ts`, persisted like the interface tier): it is personal and changes several times
an hour, and making it shared would let one person's triage sweep re-arrange everyone's board. The
Done lane's two **caps** are per-workspace settings (`doneLaneMaxItems`, `doneLaneRetentionDays`),
because what the board may show of a service's history is a shared decision. Both caps hide cards
only, and the lane reports the two drop counts separately: an age drop means "there is older
history", a cap drop means "there is more from this period".

**A task with no `completedAt` is exempt from the age cap**, not treated as ancient. Every block
merged before that column existed reads that way, and hiding history on the strength of a timestamp
nobody recorded would be the platform inferring a fact it does not have. The count cap still bounds
them, so the exemption cannot make the lane unbounded, and `undatedShown` says how many there are.

**A FRAME still has coordinates, and they live on its `WorkspaceMount`, not on the block** (one
shared service sits at a different spot on every board that mounts it), so every frame-returning read
projects through kernel's `applyMountLayout`. The resize path is where people hit a missed projection,
because a `size`-only edit is the one frame patch with no other visible effect: the SPA upserts the
authoritative block the mutation returned and the frame jumps to coordinates no board shows it at.

**No two top-level board nodes may overlap**, and that is a standing invariant rather than a rule
each write remembers. `useFrameOverlapGuard` (mounted by `BoardCanvas`) watches the rendered
geometry of every frame and epic and, whenever two come to overlap, bounces them apart through
`framePlacement.resolveFrameOverlaps`. Placement alone was not enough: `findFreeFramePosition`
refuses to CREATE an overlap, but three later events make one anyway, and only one of them is a
drag. A border drag grows a frame into its neighbour, and a frame GROWS ON ITS OWN when its first
task arrives, because an empty service renders the "add the first task" panel and reserves a much
smaller footprint than one rendering lanes. Watching the geometry covers all three, and covers the
next write nobody has thought of yet.

Three things about it are load-bearing:

- **It runs in the SPA because only the SPA can measure a frame.** The footprint is derived from
  the lane geometry the browser renders at (`containerSize`); the backend stores a position and at
  most a size override, so it cannot tell whether two frames overlap.
- **Correcting the VIEW and WRITING the correction are separate, and only a local gesture
  authorises the write.** Every client always draws the board clear, which needs no coordination
  because `resolveFrameOverlaps` is pure: two browsers holding one board draw it identically
  whatever order their events arrived in, and a read-only viewer gets the corrected view for free.
  Persisting is the narrower act, and a drag or border resize is the only cause with an
  unambiguous single author, so that client settles the board when the gesture ends and writes what
  it displaced. A frame that grew ON ITS OWN has no author, so its correction is drawn everywhere
  and written by nobody: better than every open session racing to persist the same value, and
  better behaved besides, since a projected neighbour comes back off the server's own geometry when
  the frame shrinks again while a persisted one would stay pushed.
- **The settlement ORDER is the whole policy** (`bySettlementOrder`), and it takes at most ONE
  anchor: the node the local user is placing, held still while its neighbours move aside. A LIST of
  anchors would carry an order of its own, and every order available to build one from is
  per-client (the sequence a client's live events arrived in, or a history only the client that
  watched the change has), so two clients would resolve one overlap to different positions and
  write over each other. Everything else settles in READING ORDER, which is POSITIONAL: the node
  nearest the top-left keeps its place. Note that this is not "the newcomer yields to the frames
  already there": a block carries no shared creation stamp, so arrival is knowable only from a
  client's own session, which is the per-client input this rules out.

The guard stands down for the whole of a gesture. A drag previews a position on every pointer move,
and bouncing neighbours off those in-flight positions displaces frames the user is merely passing
OVER: each pass reads the neighbour where the previous pass pushed it, so the displacement
accumulates instead of springing back. A frame drawn over its neighbours while the pointer holds it
is what direct manipulation looks like; the board settles on release.

**Dragging a card now only reparents** (`positioned: false` in `useBlockDrag`): between services,
and into or out of a module via a module group header's drop zone. Which LANE a card is in is not
something a drop can decide — the lane is derived from state, so dropping a not-started card on
"In progress" could only lie or silently do nothing. Because that drop target exists only while the
reader has grouping set to `module`, the inspector carries a **module picker** that does not depend
on the current grouping; module sub-frames no longer render as boxes, so without it the only route
into a module would be to change a view preference first.

**A move re-stamps the module the task DECLARES**, which is the one thing about that drag that is
not obvious. A task names its module twice: the block it is parented to, and `moduleName`, which
exists because the engine only materialises the module block on merge, so a task can name its module
before anything is its parent. Grouping reads the parent and falls back to the declared name — so a
card dragged OUT of a module and left still declaring it lands right back in the group it came from.
`BoardService.reparent` therefore rewrites the name from the destination container, exactly as it
already rewrote the `type` a task inherits from its frame, and the SPA's optimistic write predicts
the same answer through the shared `moduleNameInContainer` (`@cat-factory/contracts`) so the card
does not visibly jump when the response lands. "No module" is the EMPTY STRING on the wire, the way
every other clearable field spells a clear; `undefined` is dropped by `JSON.stringify` and reaches
the server as an empty patch.

## Roles (engineer / product manager / designer)

The outermost of the three narrowing axes, and the only one the app **asks about**: on a first-ever
launch it puts up one question, "what do you work on?", offering `engineer`, `product-manager` and
`designer` with a line each on what picking it gives you. Vocabulary, resolution and the
presentation table are in `app/utils/uiRole.ts`; the choice and its once-per-session prompt live in
the `uiRole` store.

Two roles, three names. `engineer` and `product-manager` both map to the **`full`** surface, and
that is the product decision rather than an oversight: the two do the same job in this app (plan
work on a board, run it, review and merge it), and what makes the question answerable is the copy a
person recognises themselves in. `designer` maps to **`intake`**: the services already on the board,
the work in flight on them, and the routes that bring new work IN (a new task, a task from a tracker
ticket, a task from a design). None of the platform configuration behind that. They are separate
`UiRole` members precisely so one of them can gain a surface the other does not without a migration.

- **The default is the FULL surface, and an unanswered question changes nothing.** Closing the prompt
  writes no choice, so the next launch asks again and the person keeps the whole product in the
  meantime. There is deliberately no "don't ask me again": an unanswered question costs nothing,
  where a wrongly-recorded one costs somebody destinations they need. It is also why the prompt
  yields to every startup advisory (and why the tour offer, in turn, yields to it: the role decides
  which surfaces exist, so a tour picked ahead of it could be about half a product).
- **It is not authorization.** Workspace RBAC (ADR 0025) decides what a request may do and is
  enforced server-side; this decides what the SPA OFFERS, and every role's surface is still gated by
  the caller's permissions on top. Nothing here can widen what a person may do, and everything it
  hides is something they may well be allowed to open, which is why the **way back is reachable from
  inside the narrowed role**: the switcher at the top of the sidebar (rendered in every role) plus a
  command-palette entry, both `intake`.
- **There is NO deployment env pin**, unlike the interface tier. Which tier a fleet of kiosk-ish
  deployments shows is a decision an operator can reasonably make; which JOB the person at the
  keyboard does is not something a build can know.
- **A narrowed role CAPS the interface tier at basic** (`resolveUiMode` takes the surface and answers
  `basic` for `intake`, ahead of the env pin). Resolved rather than merely hidden, so every
  `isAdvanced` reader inside a surface agrees with the narrowed nav without restating the role, and
  the tier switcher is dropped for that role: a control that flipped a tier the resolver fixes would
  be the same lie it refuses to be under an env pin.

The seams, and what a new feature should use rather than reading the store ad hoc:

- **A nav destination** declares `intake: true` in `app/modular/nav-contributions.ts` to survive a
  narrowed role. It is **opt-in**, so a destination added later defaults to the full-surface roles:
  getting that wrong costs one flag, where the other default is a persona that stopped being simple
  without anyone deciding to un-simplify it. Today's set is three (`tutorial`,
  `keyboard-shortcuts`, `ui-role`), and `nav-contributions.spec.ts` pins it against a table naming
  each one's reason, so adding a fourth forces the claim to be written down. The `fullSurface` gate
  rides the same reactive `NavGates` service as `advancedMode`, so a role switch re-gates all three
  shells with no reload; all three axes (role, tier, `gate`) must pass.
- **A deployment's own external tool** declares the same flag, and defaults the same way. The three
  axes live on one `NavGatedContribution` that both `NavContribution` and `ExternalToolContribution`
  extend, and `navSlotFilter` runs the one `navItemVisible` over both slots, because a tool is
  projected onto a nav contribution downstream. A tool filtered by any other expression is a
  registered application that outlives the narrowing every destination beside it obeys, which is how
  the role axis first shipped; `nav-contributions.spec.ts` pins the two slots' verdicts in lockstep
  across the axes rather than trusting the two spellings to stay equal.
- **A surface that narrows inline** reads `useUiRoleStore().fullSurface` (the frame header's bug-hunt
  button, the palette's per-connection integration commands). Same rule as the tier: what remains
  must be exactly what the full surface would have shown, only less of it.
- **A tutorial tour whose step clicks a non-`intake` nav entry declares
  `TUTORIAL_REQUIREMENTS.fullSurface`.** Which tours those are is not a judgement call:
  `tutorial-tours.spec.ts` derives the pairing from `navItemVisible`, so a tour that gains such a
  step fails until the requirement is declared. A single STEP that the role removes (the orientation
  tour's interface-tier step) declares `when` instead, so it is dropped rather than reported as an
  abridged tour.

## Interface modes (basic / advanced)

The SPA renders at one of two **interface tiers**. `basic` (the default) is the everyday
**delivery** surface: plan work on a board, run it, review and merge it: the run/pipeline
options that only exist to override a workspace-level default are left at that default, and
the nav is trimmed to what that loop needs. `advanced` shows everything. The tier resolves in
a fixed order, first match wins:

0. **The [role](#roles-engineer--product-manager--designer)'s surface**, as a ceiling: an `intake`
   role renders `basic` whatever the two below say.
1. **`NUXT_PUBLIC_UI_MODE`** (`basic` | `advanced`): the deployment pin. Like
   `NUXT_PUBLIC_API_BASE` it is baked in at **build** time (`ssr: false`), and while it is
   set the in-app switcher is a read-only indicator, since a preference the resolver ignores
   would be a lie. An unrecognised value is ignored rather than failing the boot.
2. **The user's own choice**, persisted client-side (the `uiMode` store) and changed from the
   switcher at the top of the sidebar, under the board switcher, or from the **command
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
only: below `lg` the navbar is already an off-canvas drawer). The rail preference is
**per-tier**: basic _defaults_ to railed and advanced to expanded, and each tier remembers its
own choice, so an expand in either survives a reload and a round trip through the other.

Two seams carry the tier, and a new feature should use them rather than reading the store ad
hoc where it can be avoided:

- **A nav destination** declares `advanced: true` in `app/modular/nav-contributions.ts`. The
  shared `navSlotFilter` drops it in basic mode across all three shells (sidebar, command
  palette, toolbar), independently of its RBAC `gate` and of the role's `intake` flag: all
  three must pass. A consumer module's own contributions take the same flag. The bar is **whether the everyday delivery loop needs
  it**, and marking an item does one of two distinguishable things:
  - **Reached another way**; a shortcut whose surface a basic destination also opens, so
    nothing is lost (the Merge / Service-best-practices palette entries into Workspace
    settings, the local-models knob the Model providers hub already offers).
  - **Out of the tier**: the sole route, hidden on purpose, so the capability is _absent_
    from basic mode and the tier switch is the way to it (Sandbox, Kaizen, repo bootstrap,
    and the deployment-wide operator + reports rollups).

  Sole-route items stay in basic when the delivery loop runs on them: the pipeline builder,
  add-from-repo, the fragment library, the infrastructure/ephemeral-env windows, and the workspace /
  model configuration a run actually reads. `nav-contributions.spec.ts` pins the advanced set
  against a table naming each item's kind and reason, so promoting one forces that claim to be
  written down rather than assumed.

- **A less-used option inside a surface** reads `useUiModeStore().isAdvanced`. Hide, never
  disable, and only ever hide an OVERRIDE: what remains must be exactly the default the hidden
  field would have shown, so a basic-mode user never gets different behaviour from an advanced
  one; only fewer choices. An input nothing else supplies (the pipeline, the apriori branches)
  stays in both tiers however advanced it feels.
- **A whole AUTHORING affordance** may be tier-scoped the same way (the frame header's
  recurring-schedule and initiative buttons are advanced-only) but only while the tier hides
  the ability to CREATE, never the ability to SEE. Existing state has to stay legible in basic
  mode through its normal surfaces (a live schedule still badges its task card and opens its
  inspector panel; an initiative is still a block on the board with its own inspector), or the
  tier turns into a way for a user to be acted on by configuration they cannot find.
- **An override control on an EXISTING entity gates on `showOverrideField(isAdvanced, …values)`**
  (`app/utils/uiMode.ts`) rather than on `isAdvanced` alone. Hiding an override is only safe
  while it is unset: always true for a creation form, never guaranteed for a block that a
  teammate on the advanced tier (or the API) already wrote one onto. The helper reveals the
  control, editable, as soon as any value it edits is set (`false` included: a tri-state
  `false` is a choice, not absence), so basic mode can never conceal a setting a run will
  actually use.
- **The tier may also change which of two routes to the same thing LEADS**, and that is not a
  hidden capability: a `pr_ready` task card offers the outcome summary in both tiers and drops
  the raw pull-request chip in basic, because the card the button opens carries that same link
  at the top. What basic mode may never do is remove the only route (the rule above); ordering
  two routes by which one a tier's reader wants first is what the tier is for. **Write the
  condition as that INVARIANT, not as `isAdvanced` alone** (`TaskCard`'s `showPrChip`: keep the
  chip wherever the outcome card is not offered), because the surface that carries the hidden
  half is itself conditional, and two predicates that must agree by coincidence eventually do
  not: the day the leading route hides, `isAdvanced` alone takes the last route with it.

## Agent tiers (basic / intermediate / advanced)

A separate, narrower axis: how deep into the **agent catalog** a surface reaches. Every agent
kind carries a `tier`: `basic` (the everyday delivery loop), `intermediate` (reached for
regularly) or `advanced` (specialist), and the two surfaces that enumerate the catalog, the
**pipeline builder's palette** and the **model preset's per-agent override list**, show the
selected tier and everything below it. They open on `basic`; the `AgentTierSelect` control on
each widens them, with `advanced` showing the whole catalog. The choice is one shared,
persisted preference (the `agentTier` store), because picking the agents a pipeline runs and
picking what each of them runs on are halves of the same job.

- The vocabulary, the default and the cumulative predicate live in `@cat-factory/contracts`
  (`AGENT_TIERS` / `DEFAULT_AGENT_TIER` / `agentTierVisibleAt`), beside
  `purposeAllowsAgentCategory`, so a **deployment-registered kind's** declared tier
  (`presentation.tier`, carried in the workspace snapshot) and the SPA's own built-ins are
  read by one rule. A kind that declares no tier is treated as `intermediate`.
- **This is not the interface mode.** That tier decides which surfaces the whole SPA offers;
  this one decides how much of one surface's catalog is listed. They are independent (an
  advanced-mode user still starts on the basic agent tier) and the tier control is present in
  **both** interface modes, since it is the only route to the kinds it hides.
- A narrowed catalog states what it is holding back (the "n hidden at this tier" hint), and
  the model preset list **always keeps a kind the edited preset already pins a model for**,
  whatever the tier: the same rule `showOverrideField` states for a single field: a row the
  user can neither read nor clear is worse than a longer list.

### The palette's second dial: the pipeline's purpose

The builder's palette narrows on two axes, and both controls sit on one row above the catalog
(`PipelinePurposeSelect` above `AgentTierSelect`), each with its own "n hidden" hint so neither
narrowing reads as an empty catalog. The tier says how deep to look; the **purpose** says what
the pipeline is for (`build` / `bugfix` / `document` / `review` / `research` / `planning`), and the
palette drops the categories that purpose has no use for. `bugfix` is the one pair that shares a
row with another member: it ships code exactly as `build` does, and differs only in being offered
to a `bug` task and withheld from a `feature` one, because a preset that investigates a defect
report and writes a failing reproduction test has neither input on a feature. It reaches past the
palette: the saved-pipeline
library in the builder's third column lists the pipelines built for the purpose being edited, so
one dial narrows both ends of the slideover. The purpose is not a view preference either: it is
saved on the pipeline and also decides which task pickers offer it, which is why the control
writes through to the draft while the tier writes to its own store.

`Pipeline.purpose` is MANDATORY, so there is no unclassified state for any of these surfaces to
invent a policy for: a new draft starts at `build` (what an unclassified pipeline always behaved
as) and the dial only moves it. What each surface still has to read carefully is a purpose the
BUNDLE cannot name, which the persisted, closed vocabulary makes reachable in both directions (a
browser older than a new member, a row older than a retired one).

Purpose is filtered by three predicates in `@cat-factory/contracts`, and the difference between
the first two is the point:

- `purposeSuggestsAgentKind` is **relevance**: what the palette OFFERS. Opinionated (a
  review pipeline designs nothing; a planning pipeline has no pull request to gate), because a
  wrong guess costs one purpose switch. It reads the kind's `category` through
  `purposeSuggestsAgentCategory` and then the kind's OWN `presentation.purposes`, and the two
  INTERSECT: a declaration may only hide more, never buy a kind back into a purpose its section
  is not offered to, which is what keeps relevance inside compatibility whatever a deployment
  declares.
- `purposeAllowsAgentCategory` is **compatibility**: what the builder will SAVE. It states only
  what is contradictory (a pipeline that writes no code carrying an implementation step) and
  drives the draft's conflict warning.
- `pipelineMatchesPurpose` is **membership**: which SAVED pipelines the builder's library lists,
  reduced with the label and archive dials in `utils/pipelineLibrary.ts`. The one dial in that
  column whose control is elsewhere, so it is the one that owes a "n hidden" hint. It may be
  exact where the pickers' `pipelineAllowedForTaskType` is permissive, because it narrows a list
  somebody is BROWSING rather than one they are about to run from: two known purposes never mix,
  while a pipeline whose classifier this build cannot NAME is listed at every purpose rather than
  vanishing from the editor that has to fix it.

The library's purpose is a BROWSING dial of its own, defaulting to the draft's and relaxed by the
hint itself ("show every purpose"). Reading the draft directly is the trap: it is an authoring
field with no "off" setting, so a hint that only NAMES the absence would send the reader to a
control whose every setting narrows and whose every change is saved. A dial that hides rows owes
both a count and a way back, and the way back may not be an edit.

Relevance is a subset of compatibility, asserted over the whole grid in `pipeline.spec.ts`. Keep
it that way: the palette may hide what the save gate tolerates, so tightening the relevance table
never turns a stored pipeline into one its own editor refuses, but offering a kind the save gate
then rejects would be a dead end with the refusal arriving after the work.

**A category is a shelf label, not a statement of what a kind does**, which is why relevance is
asked of the KIND. Keeping `docs` for a `review` pipeline so the Domain Rules Reviewer survives
also handed it the two kinds that WRITE documentation into the repo, and `document` and `research`
had identical rows, so moving the dial between them narrowed nothing at all. A kind that belongs
to one use-case says so in `presentation.purposes` and leaves a section its siblings stay in; the
section keeps deciding for every kind that declares nothing, which is the normal case and the one
a deployment-registered kind falls into for free. Declare it only to opt OUT: it can never widen,
and a list naming only purposes this build cannot name is read as no declaration at all rather
than as excluding everything, the same default-open reading the unknown `purpose` gets. An EMPTY
list is refused at registration instead (`agentPresentationSchema`, and `catalog.spec.ts` for the
static half valibot never parses): the reader cannot tell one from declaring nothing, so it would
offer the kind everywhere its section is offered, which is the inverse of what writing it means.

**Each hint counts what relaxing THAT dial alone would reveal**, which is why each reduction is one
function (`utils/agentPalette.ts` for the catalog, `utils/pipelineLibrary.ts` for the library)
rather than chained filters at the call site. Chaining them
and subtracting the lengths gives the second dial an honest count and hands the first one the whole
rest of the catalog: at the default `basic` tier a `planning` pipeline claimed thirteen kinds hidden
for its purpose when switching back to Build revealed three, the other ten being tier-hidden either
way. So a kind BOTH dials hide is counted by neither, correctly, and a new dial measures itself
against what the others already admit rather than against the raw catalog.

**A purpose or category this build does not recognise narrows nothing.** Both are closed
vocabularies and both are persisted, so a reader is total against the type and partial against the
data: a `Pipeline.purpose` outlives the build that wrote it, and a `presentation.category` arrives
in the snapshot from a kind a deployment registered. Narrow with the schema-derived
`isPipelinePurpose` / `isAgentCategory` before indexing anything by one, never with an optional
call, so adding a member still fails the build. The two predicates read the unknown value through
one helper because they have to agree about it: one narrowing by a purpose the other no longer
recognises is exactly the subset violation above. On the control itself an unrecognised purpose is
NAMED and quoted back rather than left to render blank, which would read as a pipeline nobody
classified while the saved row says otherwise.

Offering such a kind is only half of keeping it: `groupAgentPalette` puts whatever no section
CLAIMED into the trailing custom bucket, derived from the sections rather than from an absent
`category`. A kind whose category has no section matches neither test, so filtering on the absent
one alone deleted it from a palette its own save gate accepts.

## In-app tutorial tours

On first launch (once the board is up and no other startup advisory is open) the app asks
whether the user wants a guided tour. The answer is SAVED per browser (`stores/tutorial.ts`,
persisted like the interface tier): "no thanks" stops the prompt for good, and closing without
answering defers it to the next launch.

**The prompt is the OFFER; the catalogue is the library.** `TutorialCatalogue.vue` (the
sidebar's Help section, the palette, and a button in the prompt's own footer) lists every tour
the deployment ships and lets any of them be started, resumed or repeated at any time. The two
surfaces exist separately because they answer different questions, and the split is what keeps
the prompt a short answerable one rather than a browsing surface. Start / Resume / Repeat /
Back-to-the-tour is decided ONCE for both (`useTutorialLaunch` over the pure `tourState` +
`launchActionFor`), or the same button would mean different things on two screens.

**Which is why a tour can be catalogue-only** (`offeredAtLaunch: false`, read through the pure
`isLaunchOffer`; `useTutorialTours` exposes `offered` for the prompt beside `tours` for the
overlay). The catalog covers the PLATFORM as well as the delivery loop (the engine, the pipeline
builder, the standards library, the integrations), and those tours gate on a PERMISSION rather
than on board state, so every one of them is startable on a brand-new board. Offered unfiltered
they would put six walkthroughs in front of someone whose board has neither a repository nor a
task, burying the two they can act on. The default is OFFERED, so a consumer deployment's tour
appears beside the built-ins with nothing to declare, and a tour cannot fall out of the offer by
omission. It thins an offer, never the library: an un-offered tour is listed, startable, counted
in the progress line and one footer button away, and `requires` remains the only thing that can
hold a tour back, which is always reported.

**The finish card HANDS OFF to the next walkthrough** (`nextTourAfter`, offered beside Done). The
delivery loop is a chain — each tour produces the state the next one requires — and finishing one is
the last moment the product can bring the tutorial up at all: `startTour` writes
`decision: 'accepted'`, which is exactly what stops the launch prompt auto-opening, so without this
the walkthrough a user's own action just unlocked is reachable only by going and finding the
catalogue. It offers ONE tour, launch-offer tours first whatever their `order` (a deployment's
reference tour must not cut into the arc), never one already completed or the one just finished, and
nothing at all when nothing is ready — where the plain Done is the honest ending. It reads the gates
LIVE, which is the one deliberate exception to the held-script rule below: completing `first-task` is
precisely what makes `run-task` ready, so a candidate resolved at tour start would be empty exactly
when it matters. Taking the offer completes this tour first (or its badge stays "not started") and
goes through the same `useTutorialLaunch().launch`, so a suggested tour the user had broken off
earlier RESUMES. **Per-run overlay state resets with the script**, not by the component unmounting:
the handoff completes one tour and starts the next in ONE tick, so `touring` never goes false for a
render and the finished tour's skips would otherwise be counted against the new one.

**A CONTEXTUAL offer catches a tour becoming takeable** (`resolveNudge` over `newlyAvailableTour` +
`useTutorialNudge` + `TutorialNudge.vue`): a corner card, not a modal, since the whole point is the
moment. The trigger is deliberately not a per-surface hook — every tour already declares, as its
`requires`, the predicate that means "you can take this now", so ONE rule over the resolved
catalogue covers the catalog and inherits `navRequirementDrift` unchanged. Four rules bind it. It
fires on a TRANSITION into `ready`, never on the standing state, which would greet every board load
with an offer about a walkthrough available for weeks. Only the launch-offer arc, for the same reason
`offeredAtLaunch` exists. Never twice per tour (`nudgedTourIds`, persisted) and never after an
explicit decline — "no thanks" answered the question about guided tours, not about when it was
asked. And the offer is HELD rather than dropped while a tour or a tutorial window is up, because
the two most valuable moments (a run parked, a run failed) routinely arrive then; it is marked spent
when RAISED, so holding it cannot become nagging.

**What that transition is measured against is the subtle half, and it takes TWO guards** (both in
the pure `resolveNudge`, so they are unit-tested rather than inferred from a watcher; the composable
holds only the ref, because a pure function cannot). Every gate reads a store something fills
asynchronously, so a baseline taken when the composable mounts records "nothing is takeable" and the
app's own startup then reads as a transition, which is the every-board-load greeting the rule exists
to prevent arriving through the mechanism meant to be its cure.

- **`workspace.ready`** gates taking a baseline at all on the snapshot having been fanned out, and
  is re-set per board, which is what makes switching boards RE-SEED rather than offer everything the
  incoming board happens to satisfy.
- **A board-state FINGERPRINT** (`boardStateFingerprint`, over the `boardHas*` gates) is what an
  offer requires to have MOVED. Readiness widening is not the world changing: a permission
  resolving or a capability probe answering makes tours takeable that were "blocked" only because
  the app had not found out yet, and the app finding out about itself is not a moment to interrupt
  anyone about. Those resolutions advance the baseline silently. This is the guard that generalises
  — it needs no list of which stores load late, because none of them describe the world — and it is
  the reason readiness alone was not enough: `workspace.ready` flips before the RBAC access and the
  integration probes have landed.

**The catalogue lists the tours it CANNOT start, and says what would unlock each.** That is the
reason a tour's preconditions are declared (`TutorialRequirement`: an id, a copy key, and the
gate predicate) rather than being an anonymous `when(gates)`. A predicate can only answer "no",
and a list that quietly omits four of six walkthroughs is indistinguishable from a deployment
that ships two: to exactly the user who came looking for the rest. It also forces the two
unavailable cases apart, because they need different reactions: `blocked` names something the
reader can go and do ("A service on the board"), while `not-applicable` (requirements met, but
every step is about a branch this board isn't on) names nothing at all, and telling them to fix
it would send them hunting for a control that was never missing.

**Tour gating therefore does NOT live in `navSlotFilter`**, unlike every other gated slot. A
`SlotFilter` maps slots to slots, so it can only drop; `resolveTourCatalogue` (pure,
gates-nullable, in `utils/tutorial.ts`) returns every tour with its availability and its unmet
requirements, and `useTutorialTours` runs it once: exposing `tours` (what can start now, which
is what the prompt and the overlay have always seen) and `catalogue` (everything, annotated). It
reads the SAME registered `gates` service the nav filter does, through the shared-dependency
`useOptional('gates')`, so the two can never disagree about what this board offers.

**Progress follows the USER, not the browser** (`useTutorialSync` / `useTutorialServer` over
`GET|PUT|DELETE /tutorial/progress`). The browser-persisted store stays what the SPA reads and stays
fully functional with no accounts, no store wired on the facade, or offline; the server row is a
MIRROR, adopted in the snapshot fan-out (`stores/workspace/hydrate.ts`) so the launch prompt decides
whether to appear against the merged state rather than this browser's copy alone. Both id lists are
grow-only sets and are UNIONED on BOTH sides, because two browsers signed in as one person each hold
a full copy and each write it back: a last-writer-wins replace on either side silently drops what the
other learned, and the symptom is a finished walkthrough going back to "not started" days later.
Only `decision` is replaced (a preference, not an accumulating fact), and then only where this browser
is not holding an answer the mirror has not carried yet: without that exception a failed push lets the
next snapshot re-adopt the older server answer, so "No thanks" silently comes back as accepted and
every contextual offer re-arms. "Reset progress" is a DELETE, which is also why the catalogue calls
`useTutorialServer` and not just the store — a local clear alone would be undone by the next snapshot
re-merging the row.

Three rules make fire-and-forget honest rather than merely convenient. Every push carries the WHOLE
local state, so a retry, a racing tab and a stale copy are all the same well-formed write. The
RESPONSE (the merged row) is reconciled back through the store, which is what closes the hole the
server's un-rev-guarded merge leaves: two concurrent merges can lose a writer's ids, because a union
is idempotent under retry but not commutative under concurrency, and the loser's answer comes back
missing something local and re-pushes automatically. And the mirror watches the store's LOCAL
revision counter rather than its state, because adopting the server's own ids is a state change too:
watching the state posts the server's row straight back at it on every fresh-browser board load, and
a reset (whose server side is the DELETE) would race a push of the freshly-emptied state.

**The funnel is counted** (`POST /tutorial/events` → the kernel `OperationalMetrics` counters
`tutorial.tour_started` / `_completed` / `_abandoned`, dimensioned by tour). The events are DERIVED
from the cursor in one watcher rather than emitted from each store action, because those are five
sites and a missing `started` fails nothing — it just biases the number the next decision is made
against. Vue's batching is what makes that work across the handoff: it completes one tour and starts
the next in a single tick, so the cursor goes `A → null → B` and the watcher sees `A → B` with the
completion list one longer, reporting "A completed, B started". A resume counts as a start, which is
deliberate: an attempt is an attempt, and not counting re-entries would make completions exceed
starts. Nothing per-user or per-workspace is recorded, and nothing is stored.

Progress is per tour id. The catalogue's counter is over the WHOLE catalog, not
the runnable part: counting only today's runnable tours would move the denominator every time a
repo was linked, and "2 of 2 completed" on a board with four walkthroughs still waiting reads as
a finished tutorial. `Reset progress` clears the completions, the resume point AND the saved
launch answer, because everyone who asks for it (demoing, handing the app to a colleague) wants
the first-launch experience back; it leaves a RUNNING tour alone, since a click about history
must not end the walkthrough in progress. **It is therefore offered whenever ANY of those three
is set, not only when a tour was taken**: someone who answered "No thanks" and stopped there has
nothing completed and nothing paused, and that saved answer is the whole of what stands between
them and the offer they came to restore.

**The coach marks stand down while a tutorial-owned window is open** (`ownWindowOpen`). The
overlay renders at `z-[70]`, above the app's own modals, because a step legitimately points INTO
one, but no step points into the prompt or the catalogue, so there the same rule would float a
highlight ring and a tooltip over the window the user just opened. The catalogue reaches that
state by design: it is openable mid-tour, which is what the `continue` action is for. The overlay
is SUPPRESSED rather than unmounted, because it holds the running tour's resolved script and a
remount would re-resolve it against gates that may have flipped since the tour started.

The decisions behind this surface, and why each alternative was rejected, are recorded in
[ADR 0036](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0036-in-app-tutorials.md). This section is the authority on how
the thing WORKS.

A tour is **data, not components**: an ordered list of steps, each pointing at an on-screen
control by its `data-testid` (the e2e anchor vocabulary; cover a control that has none by
adding the test id first) and carrying i18n keys for its copy. One shared runtime
(`components/tutorial/TutorialOverlay.vue`) renders every tour: it highlights the current
step's control, places the tooltip (`utils/tutorial.ts` owns the pure geometry + types),
advances on Next or (for `advanceOn: 'target-click'` steps) on the user really clicking
the control, so the app's real response (the actual modal, the actual task) is what the next
step anchors to. `target-click` is for BUTTONS, where the click is the completed action; a
text field keeps Next, or the tooltip would leave the instruction the moment the user clicked
in to type. A step whose anchor never appears within its wait is SKIPPED, because controls
come and go with RBAC, tier, and deployment wiring: a tour is a set of opportunities, not a
fixed script. Reaching the end having skipped steps is reported on the final card rather than
congratulating the user on a walkthrough they did not see, and a tour that could only ever
be abridged should not be offered at all, which is what each tour's `requires` is for (the
task-creation tour needs board write AND a service frame to add a task to).

**A step carries its own `when(gates)` when its BRANCH, not its control, is the thing that
may not apply.** The two are different facts and only one of them is a defect: a skip means
the control should be here and isn't, while a `when` means this board is not on that branch
of the flow (a run parked on a decision has no approval gate, and the reverse). Reporting the
second as an abridged tour would tell a user who saw exactly the right walkthrough that they
missed half of it, every time. `resolveTourCatalogue` (in `utils/tutorial.ts`) drops the
rejected steps and marks a tour left with none `not-applicable` rather than ready, so a tour
whose every step is branch-specific can never open on an empty cursor. With no gates service
wired at all (a bare install withholds nothing) every branch survives instead, and only one
of them can anchor, so the abridged notice ignores any skipped step that carries a `when`,
which has already declared that not applying is legitimate.

**Gates decide what is OFFERED; the running tour's script is resolved once and HELD.** The
overlay snapshots its tour when it starts rather than re-reading the gated slot on every
flip. This is not an optimisation: gates over live run state flip as a direct result of
following the tour; `answer-park` is offered while something waits for a human, so the
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
each drift on their own: the same split components make for inline placeholders.

The built-ins come in two halves. The DELIVERY LOOP, end to end, each tour gated on the state the
previous one leaves behind, so the launch prompt only ever offers what this board can demonstrate:
board basics, add a repository (`add-service`), create a task (`first-task`), run it (`run-task`),
answer it when it parks (`answer-park`), read a failure when one comes (`diagnose-failure`), review
and merge the result (`review-merge`). The loop covers work going WRONG on purpose: a first run fails
often, `boardHasFinishedRun` deliberately excludes failures (a result view and a merge control are
not what a failed run renders), and that left the state a new user is most likely to be in as the
only one on the arc with no walkthrough. Then the PLATFORM behind it, catalogue-only: connect an
engine (`wire-models`), assemble a flow (`design-pipeline`), curate the standards agents read
(`agent-standards`), link the systems a run talks to (`connect-systems`), where runs execute
(`prepare-infrastructure`), review by panel (`panel-reviews`), the shared services designs build on
(`share-services`). Each of those covers ONE surface and ends there, because the surface opens as a
modal over the sidebar it was reached from, so a later step could not click another sidebar entry
anyway, and each declares exactly the permission that renders the entry it clicks, since a weaker
requirement offers a tour to someone with no such control and it then reports itself abridged.

**That pairing is DERIVED from the nav catalog, not restated.** A step whose anchor IS a nav
entry's `testId` is checked by `navRequirementDrift` (`tutorial-tours.spec.ts`, beside the anchor
guard) against that `NavContribution`'s OWN `gate`: over every combination of the `NavGates`
booleans, a gate set satisfying the tour's `requires` must also be one the entry RENDERS in.
Restating the permission in a spec's gate literal is what this replaced, and it could not catch
either edit that really breaks the pairing, because neither one touches the tour. Tightening an
entry's `gate` is the obvious one. The subtler one is marking it `advanced: true`, which hides it
from BASIC mode; basic is the shipped default, so that tour would be offered to nearly everyone
and find nothing. "Renders" therefore means the gate AND the tier, and a tour that wants an
advanced entry has to declare the tier as a requirement of its own.

**A SECTION can hide itself the same way, one level below anything that guard can see.**
`panel-reviews` clicks `nav-model-config`, a BASIC-mode entry, but the consensus section inside that
panel renders on `uiMode.isAdvanced || groups.hasGroups` — so on the shipped default tier a workspace
that has never made a group renders nothing for the anchored step to find. `navRequirementDrift` pairs
a tour only against a NAV entry's visibility, so this one is declared by hand (`advancedTier`) and
pinned by its own named case in `tutorial-tours.spec.ts`. Any tour anchoring INSIDE a surface owes the
same check of what that surface's own `v-if`s read.

Two deliberate asymmetries about click-to-advance: `run-task` points at Start without it,
because starting a run spends real model budget and nobody should discover they agreed to that by
following a tutorial; `design-pipeline` points at Save without it, because Save is DISABLED until
the draft holds a step, and a click-to-advance step whose control cannot be clicked has no Next
button either, so it strands the tour.

Two runtime constraints worth knowing before changing the overlay: it must keep
`pointer-events-auto` and swallow `pointerdown`, because Nuxt UI modals are reka-ui
dismissable layers that set `body { pointer-events: none }` and dismiss on an outside
pointerdown; without both, the tooltip's own buttons go inert and pressing one closes the
user's half-filled form. And everything that DECIDES (skip direction, wait budget,
target-click matching, which skips count as abridged) lives in
`components/tutorial/TutorialOverlay.logic.ts` so it is unit-tested; the SFC keeps only the
DOM work. Target-click matching is by SELECTOR, not by the highlighted element:
several anchors (`task-card`, `task-resolve`, `run-step`) render once per board item and the
ring can only sit on one of them, so requiring the click to land on that one left a user who
clicked the card the copy asked for with no way forward; such a step renders no Next.

**An anchor that is on the page but off SCREEN is revealed before it is pointed at.** An
element scrolled out of a panel or panned off the board still HAS layout boxes, so it passes
the visibility check, and the ring was drawn at off-screen coordinates while the tooltip
clamped to a viewport edge, leaving the user reading "click this" beside nothing. The two
`task-card` steps hit this hardest, since they anchor whichever card is first in the DOM.
`needsReveal` (in `utils/tutorial.ts`, unit-tested) decides, measuring against
`min(anchorArea, viewportArea)` so a control bigger than the viewport (`board-canvas`,
`sidebar`) is judged on how much of the SCREEN it fills rather than on a fraction of its own
area it could never clear. The mechanism then depends on the container: the board is a
transform-panned Vue Flow canvas, where `scrollIntoView` does nothing and the camera has to
move instead (clamped to the current zoom, or fitting one button would throw away the user's
view of their board), and everything else is an ordinary scroll. `boardNodeIdFor` asks the
DOM which it is, rather than keying off the target id: the same id is a canvas node on the
board and a plain row in a panel. A reveal is attempted at most once per step, because both
mechanisms are animations longer than a tracking tick.

**Tracking is event-driven once an anchor is held**: only the hunt for a not-yet-mounted
anchor polls fast, and it is bounded by the step's wait budget. Movement arrives from scroll
(capture phase, so every scroll container counts), window resize, a `ResizeObserver` on the
anchor, and the board camera: with a slow backstop tick that also RE-RESOLVES the selector,
which is what lets a step re-anchor when its control is replaced underneath it. Every one of
those re-measures is coalesced into one per animation frame, because `measure()` reads layout
and then writes it, and capture-phase scroll fires for every container many times a frame.

**Accessibility.** The card is a non-modal `dialog` and deliberately not a focus trap: half
the catalog asks the user to operate the real control behind it. Focus moves onto the card
when the tour starts and on every Next/Back (without that a keyboard user has to tab the
whole page, since the overlay is teleported to the end of `body`) but never on a
`target-click` advance, where the app is opening a modal that rightly autofocuses its own
first field and the NEXT step is usually the one telling the user to type in it. That is a
decision, so it is `shouldFocusCard` in the logic module with a test on it, not an `if` at
the call site: it was an inline one, and a call site that forgot it is exactly how the card
came to steal focus from the modal it had just opened.

Step changes are announced through a separate `role="status"` region rather than `aria-live`
on the card, because the card's entire contents are replaced per step and a wholesale subtree
swap inside a dialog is not reliably announced. Two things about that region are load-bearing
and easy to undo by accident: it lives OUTSIDE the overlay's `v-if` and its text lands a tick
after the node does, because assistive tech announces a CHANGE to a live region and routinely
says nothing about one that was inserted already populated, which would silently cost the
first step of every tour. And it is the SOLE announcement: the card carries no
`aria-describedby`, or the body would be read a second time on every focus move.

Motion is honoured on both sides: `motion-safe:` on the ring transition and the searching
spinner, and an instant scroll and camera move under `prefers-reduced-motion`.

**Breaking off a tour leaves a resume point.** Esc and Skip are both easy to reach (one by
accident, one to get the overlay out of the way for a moment) and what they discarded was
the whole walkthrough. `stopTour()` records where it stopped and the prompt offers Resume
instead of only Start. Session-only, like the cursor itself: within a session the board is
still in the state the tour left it in, which is exactly what a DOM-anchored position needs.
The store validates no index (it knows nothing about which tours exist), so the overlay
clamps a resume that lands past the end of a script the gates have thinned since, and the
runtime's own bail-out on an unresolvable tour passes `resumable: false`, or resuming would
put the user straight back into the same dead overlay. There is ONE slot, and starting a tour
clears only that tour's own entry: another tour's position is not this action's to discard,
and it loses the slot soon enough, when this one is broken off past step 0.

The catalog is the `tutorialTours` slot: first-party tours live in
`modular/tutorial-tours.ts`, and a consumer deployment contributes its own through
`registerAppModule`; they appear in the prompt and the catalogue beside the built-ins, held
back per tour by its own `requires` (resolved against the same reactive gates service the nav
uses). A consumer writes its own requirement objects with its own copy keys; the first-party
ones are shared constants (`TUTORIAL_REQUIREMENTS`), because a second copy of "a service on the
board" is a second sentence to keep in step with the gate it describes. Completion is persisted
per tour id, so renaming an id resets its state.

**A built-in tour's anchors are drift-guarded** (`tutorial-tours.spec.ts`), because they are
the one thing about a tour that nothing else in the build checks: a renamed `data-testid`
passes typecheck, lint and the whole e2e suite, and several anchors have no other consumer at
all. The failure it prevents is worse than a dead step: those steps carry no `when`, so the
miss counts as an unexpected skip and every user lands on a permanent "you missed N steps"
notice, a false claim the tour goes on making in production with nothing red anywhere. The
guard scans the layer for both ways an id is named: written onto an element, or declared as a
`testId` field on a data contribution (the whole `nav-*` family reaches the DOM that way). It
is scoped to the built-in catalog, since a consumer's tours anchor on its own layer.

## Real-time store coherence: avoid the full-refresh CLOBBER

The recurring product bug behind most e2e flakes: a stale full-snapshot refresh clobbering newer
live state. The SPA has two delivery shapes and mixing them wrong drops live-added state with NO
event left to restore it.

- **Know how your entity is delivered.** Targeted events (`execution`/`bootstrap`/`initiative`)
  carry the entity and `upsert` it, so they don't clobber. A `board` event is delivered EITHER
  way and the backend decides per change: it carries `block` when the change is fully described
  by one (a spawned task, a field edit, a dependency toggle, a move), and carries none when it is
  not (a removal, a reparent, a resize, a blueprint reconcile). A payload-less `board` event still
  means a debounced full `workspace.refresh()`, where `hydrate` REPLACES whole lists. Routing
  lives in `composables/workspaceStream/applyWorkspaceEvent.ts`, whose `switch` carries a `never`
  guard: a new `WorkspaceEvent` member fails the BUILD rather than falling through to nothing. The
  emit-site decision lives in `BoardService.emitBoardChanged`'s doc comment. Prefer a targeted
  upsert for anything that must appear reliably.
- **Two blocks are refused a payload at the wire, on EVERY event that carries one.** Kernel's
  `deliverableBoardBlock` is the single gate (both facades' `boardChanged` AND `bootstrapChanged`
  assemble through it, via `boardWireEvent`/`bootstrapWireEvent`), so a new emitter cannot
  reintroduce either by forgetting: a service FRAME, whose position and size are a per-board
  `WorkspaceMount` override that one shared payload cannot state correctly on the several boards a
  fan-out reaches; and a headless `internal` anchor block, which `composeBoard` filters out of
  every snapshot and which would therefore render as a card no later read can remove. Both degrade
  to the coarse signal, so nothing is lost but the refresh. A bootstrap's frame is always the first
  case, which is why the `bootstrap` event's job rides live while the frame's own transitions
  arrive as coarse `board` events beside it.
- **Full refreshes go through the ONE funnel, which is what makes them monotonic.**
  `workspace.refresh()` IS the funnel (`stores/workspace/refreshFunnel.ts`), so the ~35 direct
  post-mutation call sites need no opt-in and a new one inherits it. It SERIALIZES: at most one
  snapshot fetch is outstanding, so two cannot resolve out of order and no sequence stamp is
  needed. It is deliberately not plain single-flight: a caller arriving mid-fetch joins a single
  QUEUED follow-up rather than the in-flight request, because a caller that mutated and then
  refreshed is entitled to a snapshot read AFTER its call. Do not reintroduce an unguarded
  `hydrate(await fetch())`, and never add a second refresh path beside the funnel.
- **Serializing makes one stalled request everyone's problem, so the slot is BOUNDED.** The API
  client sets no timeout, and a hung fetch behind a shared slot stops every later refresh, the
  coarse-event resync and the retry chain at once. The funnel puts a deadline on its own read and
  ABORTS it, so a dead connection surfaces as an ordinary failure rather than a wedge; a snapshot
  arriving after the deadline is never applied. Anything else that serializes work behind one slot
  owes the same bound. The same argument is why a dedupe must QUEUE the later ask rather than drop it
  (`environmentTest.reconcileRun`): the outstanding read may predate the state the later ask exists
  to observe.
- **Never gate readiness on a snapshot a later resync can undo.** The on-connect resync flips
  `connected` only after it settles (which is why e2e gates on `data-connected`). A resync that
  stands down because a NEWER one started must hand its caller that newer one, not resolve: a
  stand-down is not a reconcile, and `socket.onopen` cannot tell the difference.
- **A REPLACE-style `hydrate` must never silently drop live-only state.** Either fold that state
  into the snapshot or reconcile rather than replace. The funnel above orders refreshes against
  each OTHER and does nothing when ONE slow fetch straddles a live event, so every such store also
  takes a WATERMARK: `refresh()` captures each one's `hydrateBaseline()`
  before the fetch (`LiveWriteBaselines`) and its `hydrate` keeps whatever was written after it.
  `board` and `notifications` are the two today; `execution` gets the same protection from the
  server `rev` it carries. Whether the store can re-derive the dropped state is what decides how
  bad the bug is: a block's status arrives again on the run's next transition, while a
  notification is pushed ONCE, so dropping the card leaves a parked run nothing can surface (the
  `pr-review` spec's flaky 30s wait on `notifications-bell`). A watermark that tracks only
  INSERTS is half a guard: a card resolved live must also stay gone, or a snapshot read while it
  was open resurrects an action the server has already taken.
- **An action's OPTIMISTIC ECHO is a clobber too, and it bypasses both guards above.** A store
  that awaits a mutation and then assigns the returned sub-state onto the cached run
  (`step.forkDecision`, `step.prReview`, `step.judge`, `step.followUps`) is writing straight past
  `upsert`'s `rev` check. Where the mutation WAKES THE DRIVER, the driver's next emit routinely
  beats the HTTP response, so the echo puts the run back; if the run then parks, nothing emits
  again and the newer state is gone for good (the fork-chat reply that vanished, leaving a
  "thinking…" bubble spinning). Every echo therefore goes through
  `execution.echoAfter(executionId, send, apply)`, which captures the run's `rev` before the
  request and drops the echo if anything advanced it. Never hand-roll the await-then-assign.
- **The coarse-event debounce is capped, and it checks coverage before firing.**
  (`composables/workspaceStream/coarseRefresh.ts`, which owns both ways a full resync is asked for:
  the on-connect reconcile and the `board`-event fan-out.) Trailing-only
  re-armed forever under a sustained sub-300ms event stream, so the board stopped resyncing exactly
  when the workspace was busiest; there is now a max-wait. Before fetching it asks the funnel
  whether a snapshot issued after the latest coarse event has already hydrated
  (`refreshMark()` / `hydratedSince()`) and stands down if so, which is what stops a mutation that
  refreshes directly AND raises a coarse event from paying for two snapshots. That skip rests on
  the server emitting a coarse `board` event only after committing what it announces.
- **The board snapshot's runs are a LEAN PROJECTION, so a hydrate can WITHHOLD what it does not
  clobber.** `projectExecutionForBoard` (contracts) strips each step's captured prose from the
  snapshot's executions and stamps the instance `projected`; a live `execution` event still carries
  the whole run. Two rules follow, and both are the clobber rule in a new shape. A step-detail
  surface fetches the run before rendering (`execution.ensureFull`, asked by the two overlay HOSTS
  so no window can forget) and reads `stepHasOutput`, never `step.output`, for the "there is prose
  here" affordance. And the store's reconcile carries the withheld fields forward ONLY at an equal
  `rev`: at the same revision the withheld prose IS what the cache holds, one revision later it may
  not be, so a newer projection replaces and the open overlay re-fetches.
- **`execution.instances` is a `shallowRef`, so a write must both TRIGGER and change IDENTITY.**
  Nothing under the ref is a reactive proxy any more, so the only dependency a reader can hold is
  the ref itself, and nearly every reader holds it through an identity-stable chain
  (`computed(() => getInstance(id))` to `steps[i]` to one field). `triggerRef` re-runs the FIRST
  computed in that chain, and Vue stops propagating when its recomputed value is `===` the previous
  one, so a run patched in place reaches that computed and nothing below it. `upsert` replaces the
  run object; `echoAfter` applies the action store's patch to a COPY of the run and its steps and
  swaps that in. A missing trigger and an in-place patch are both SILENT, so
  `stores/execution.spec.ts` pins each write shape twice: once on the array, once through the
  `getInstance` chain a window actually reads.
- **Pin it with a store-level unit test** (`stores/workspace.spec.ts` for refreshes,
  `stores/workspace/refreshFunnel.spec.ts` for the funnel's own rules, `stores/execution.spec.ts`
  for echoes): drive the two orderings and assert the fresher one wins.

## Internationalization (i18n) authoring

All user-facing SPA copy goes through `@nuxtjs/i18n`; never hard-code a display string. This
layer ships the base `en` locale, and a downstream deployment overrides by dropping its own files
(the per-layer deep-merge is the override seam, consumer wins key by key). Migration status:
[`docs/internal/localization.md`](https://github.com/kibertoad/cat-factory/blob/main/docs/internal/localization.md).

- `i18n/locales/<locale>.json`: the catalogs (the v9+ `i18n/` convention, NOT `app/locales/`).
- `i18n/i18n.config.ts`: runtime vue-i18n behaviour only (fallback locale, the plural
  selectors, the named `numberFormats`/`datetimeFormats`). Messages are deliberately NOT here
  so the module can deep-merge across the `extends` chain. Referenced as the BARE filename
  `vueI18n: 'i18n.config.ts'`, never `layerDir`-anchored.
- `i18n/plural-rules.ts`: the per-locale plural selectors, kept beside the config as pure
  logic so they unit-test standalone. See **Plural forms** below.
- `package.json` `files` MUST include `"i18n"`. Release-blocking.

**Adding a string**: add the key to `en.json` under the feature namespace, resolve with
`t('feature.area.key')`, and format numbers/dates through `$n`/`$d` (the named formats), never
raw `Intl`.

**Key conventions**: one namespace per feature; **leaf keys mirror the enum/code value verbatim**
so a dynamic lookup is total; **no cross-key concatenation** (a full sentence is ONE key with
`{named}` placeholders, plurals use the pipe form).

**Component mechanics that bite:**

- `useI18n` is auto-imported; destructure in `<script setup>` and use those fns in the template
  so the typed-key check sees literal keys. Never `import` it.
- Plural + interpolation: `t(key, { vendor, count }, count)`, where the THIRD arg is the choice.
- **Code/format-example placeholders stay INLINE**, not in the catalog; required when they
  contain `{`/`}` (vue-i18n metacharacters). Only prose placeholders get a key. Same for brand
  names.
- **No HTML in message bodies**: drop mid-sentence `<strong>`, or use `<i18n-t>` with slots.
- For a vendor/enum-keyed set, build an array of STATIC literal `t()` keys, one per member.
  Reserve the runtime-assembled key + exhaustive `Record` guard for lookups genuinely unknown
  until runtime.
- Straight quotes, no em-dashes in new entries.

**Plural forms: how MANY forms an entry carries is part of its contract.** Most locales run on
vue-i18n's built-in selector, where a 2-form entry is `one | other` and a 3-form entry is
`zero | one | other` (the leading zero form is a copy nicety, not a CLDR category: "no
participants" beats "0 participants"). `pl`, `uk` and `he` override that selector in
`i18n/plural-rules.ts` because the built-in one cannot express their agreement, so their entries
carry the locale's CLDR categories instead, optionally behind the same zero form:

| Locale      | CLDR forms            | With a zero form              |
| ----------- | --------------------- | ----------------------------- |
| `pl` / `uk` | `one \| few \| many`  | `zero \| one \| few \| many`  |
| `he`        | `one \| two \| other` | `zero \| one \| two \| other` |

Dropping a form does not drop a case, it RE-POINTS every remaining slot onto a different count,
so `i18n/plural-forms.spec.ts` fails the build on an entry whose form count is neither shape (and
on a key `en` pluralizes that one of those three renders flat). Neither other i18n gate can see
this: the key exists and it moved with `en`, which is all they check. `plural-rules.spec.ts`
separately pins each selector against `Intl.PluralRules`, so a hand-written rule that disagrees
with the platform's own CLDR data fails a test rather than shipping.

**Translator descriptions (`@<key>` siblings): default to NONE.** They live only in `en.json` and
are notes to a translator, never runtime data. Add one ONLY when a competent translator seeing
the English and the key path could plausibly get it wrong: homograph / part-of-speech ambiguity
(`@close`), proper nouns that must NOT be translated (`@kaizen`), umbrella strings hiding cases
the text doesn't show, placeholder/format constraints, or plural-form requirements beyond
English's two.

**Presenting a backend failure**: raw backend prose is DETAIL, never the description. Even with
no `reason` to key off, a failure is described from its STATUS CLASS through an exhaustive
`Record<ApiErrorCode, …>` of translated copy, and the untranslated `message` (plus a validation
400's `issues` and the envelope's `requestId`) is reached through a "Show details" disclosure
that reveals it in place. So a non-English user is never handed English as the primary
explanation, and the elaborate operator remedies the backend does write stay one click away
rather than being dropped. A new failure-presenting surface copies that split (the
`usePipelineErrorToast.ts` pattern; the wire vocabulary comes from `@cat-factory/contracts`).

**Drift guards** (oxlint has no `no-raw-text` rule, so these replace it):

1. **Typed message keys** make a statically written unknown `t('literal.key')` a typecheck
   failure. This does NOT cover a runtime-assembled key.
2. For enum→key lookups, guard with an **exhaustive `Record<TheEnum, string>`** keyed off the
   contracts union, plus a runtime `te()` fallback. Never rely on tier 1 alone for a
   reason/status-keyed lookup.
3. `pnpm --filter @cat-factory/app run i18n:check` hard-fails on MISSING keys and reports unused
   ones as non-blocking warnings (the catalog legitimately seeds keys ahead of use).
4. **Locale parity**: `i18n-locale-parity.mjs --since origin/<base>` requires a PR that adds,
   changes, or removes an `en.json` key to make the SAME change in every other locale. It is
   change-coupling against the merge-base, NOT full key parity.
5. **Plural shape**: `i18n/plural-forms.spec.ts` fails on a `pl`/`uk`/`he` entry carrying the
   wrong number of forms (see **Plural forms** above), which the other three gates all pass.

**Translate for real: NEVER ship an English string as a non-`en` value.** The parity gate checks
only that the key exists, so it will pass a verbatim English copy, and that copy is a bug. The
only values that may legitimately match `en` are proper nouns identical across languages
(`DeepSeek`, `AWS Bedrock`). If you genuinely cannot produce a translation, say so in the PR
rather than committing a placeholder that reads as done.

Migration is incremental: when you touch a component, lift its visible copy into the catalog.

## Extending the layer (consumer modules)

A deployment can contribute its own components (result windows, nav entries, inspector
panels, agent-kind palette data) plus two DATA-only seams that need no components at all:
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
example ships in [`deploy/frontend`](https://github.com/kibertoad/cat-factory/tree/main/deploy/frontend) (the `acme:security` module).

## Key UI surfaces

- **Board canvas** (`components/board`): `BoardCanvas` + `nodes/` (`BlockNode`,
  `FrameSwimlanes` / `TaskLane` / `LaneGroup` / `LaneTask`, `TaskCard`), dependency edges,
  the per-block `AgentFailureCard` /
  `AgentStopButton`, and a deep-zoom `focus/BlockFocusView`. Tasks are laid out in status
  lanes rather than at coordinates (see [Task swimlanes](#task-swimlanes)); the board-level
  order/grouping override is `LaneViewControl` in the toolbar. A running task card expands
  its build pipeline (`TaskPipelineMini`) on hover at any zoom level, and across every
  on-screen card past the `steps` zoom band: the two grants are combined in the
  `taskExpansion` store and driven by `useTaskExpansion`.
- **Sidebar & chrome** (`components/layout`): board/account switchers, palettes
  entry points, the language + [interface-mode](#interface-modes-basic--advanced)
  switchers, the `SpendWarningBanner`, and the toolbar (zoom, LOD, decision queue).
- **Palettes** (`components/palettes`): drag blocks, pipelines and agents onto
  the board.
- **Inspector** (`components/panels` + `panels/inspector`): per-block tabs:
  structure, dependencies, model + fragment picker, live execution, and linked
  docs/issues/scenarios. Decisions resolve via `DecisionModal`. A `review` task
  additionally leads with `TaskReviewTarget`, linking the pull request it reviews:
  distinct from the execution panel's link to the PR a run PRODUCED, which a review
  task never has.
- **Outcome summary** (`components/outcome`): the run-keyed result window, and what
  the board card and the inspector open to "read the result". It renders the reduction
  in `utils/runOutcome.ts` (requirement coverage joined to the service spec, the
  tester's verdict, the captured views, the recorded checks) and keeps the pull request
  at the top, so the diff stays one click away rather than being the starting point.
  The only result window keyed by a RUN rather than a step: it opens with
  `stepIndex: null` and composes from the whole instance, which is also why it passes
  no `stepRef` to the shell (there is no step to restart from). Available in both
  interface tiers; what `basic` changes is which affordance leads (see
  [interface modes](#interface-modes-basic--advanced)).
  Two rules bind anything added to it. Every entry point gates on `hasOutcomeToShow`
  from the same reduction, so the card is never offered onto sections that all read
  "nothing here". And the window is BLOCK-keyed with the run riding along: a block
  naming a run the store never hydrated is a distinct fact from a task that never ran
  (`RunUnavailableGap`), so a new section reports that case rather than composing from
  the empty step list, which would read as a pipeline that produced nothing.
- **Pipeline builder** (`components/pipeline`): assemble/edit agent chains and
  watch `PipelineProgress`. `PipelinePicker` (+ its `PipelinePreview` pane) is the
  single way a pipeline is chosen anywhere (add-task, run settings, the recurring
  schedule, the focus view's Run menu) so every surface explains a pipeline by the
  ordered steps it will run rather than by its name alone.
- **Context attachments** (`components/context`): `ContextAttachmentFields`, the
  shared staged-attachment form used by both the add-task and create-initiative
  modals. Picks are held locally and import-and-linked once the block exists (see
  `composables/useContextLinking`), because linking needs a block id. Both hosts
  attach to the SAME per-block linkage, so the inspector's `TaskContextDocs` /
  `TaskContextIssues` sections render for a task AND an initiative: an initiative's
  attachments would otherwise be invisible the moment the create modal closed.
- **Integrations**: modals/panels for `github` (the source-control panel, shared
  by every VCS provider), `vcs` (the GitLab personal-access-token connect),
  `bootstrap`, `documents`, `tasks`, `requirements` (review), `scenarios`
  (acceptance), and `fragments` (the prompt-fragment library).
- **Model providers**: `ModelProvidersHub.vue`, the sibling hub for the ENGINES
  (OpenRouter, vendor keys, personal subscriptions, own-machine runners). Kept out
  of the Integrations hub on purpose: an integration is optional context in or
  output out, while a provider is what executes the work, so a deployment with none
  connected runs nothing at all. **A new provider-shaped connection belongs here,
  never in `IntegrationsHub.vue`.** Both hubs, plus the user-scoped `PersonalSetupModal`,
  share the `IntegrationBackTitle` Back control, which returns to whichever hub set
  its came-from marker (`ui.cameFrom{Integrations,ModelProviders,Personal}`): a panel
  reachable from more than one hub must not hard-code its return.
- **Auth** (`components/auth`): `AuthGate` / `LoginScreen` / `UserMenu`; the app
  is gated when the backend requires sign-in.

## Where a surface lives

Two placements are load-bearing enough to state, because putting a new one in the
wrong place is invisible until a user cannot find it:

- **The sidebar section is a claim about what the destination IS.** `models` is the
  model layer: the engines, the per-agent model choice, and the surfaces that
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
  from_: a property of where agents RUN, which is what the Infrastructure window is
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

> Building/deploying the static site is covered in the deployment docs: see the
> [top-level README → Deployment](https://github.com/kibertoad/cat-factory/blob/main/README.md#deployment) and
> [`deploy/frontend/README.md`](https://github.com/kibertoad/cat-factory/blob/main/deploy/frontend/README.md).
