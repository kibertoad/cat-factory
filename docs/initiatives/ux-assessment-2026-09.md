# UX assessment 2026-09: the core delivery loop, by persona

Status: **assessment done, no fixes landed.** A heuristic evaluation and cognitive walkthrough of
the SPA's core loop (first launch, board, create a task, run it, answer a gate, review, merge, read
a failure) for the three roles the app asks about: engineer, product manager, designer. Every
finding below was seen in a running build, not inferred from code. Screens were captured on
2026-09-19 against `theme-switcher` at `585bcdaba` (light mode included), served by the e2e stack
(`backend/internal/e2e`: real SPA, real Node backend, fake agents and fake GitHub).

This document is the tracker for the fixes. It is deliberately narrow:

- **Visual consistency is out of scope here.** Typography, primitive choice, button variants,
  radius, overlay widths and the shell zoo are owned by
  [SPA consistency on Nuxt UI (#2246)](https://github.com/kibertoad/cat-factory/issues/2246).
  A finding that is really "two surfaces look different" is not repeated below.
- **Code-verified papercuts** already live in [`ux-papercuts.md`](./ux-papercuts.md) (111 items,
  UX-01..UX-111). Where a finding here overlaps one, the UX id is named and the item is not
  re-graded.
- Findings about the fake data itself (model `fake`, "Option A / Option B", the `acme.*` consumer
  extension that renders raw i18n keys, the "Map editor" tool) are test-stack scaffolding and are
  excluded.

## Goal and rationale

The product's flows are functionally solid and the last two UX passes fixed the destructive-action
and silent-failure classes. What has not been done is a walkthrough from a first-time user's chair,
per role, asking at every step "will they know what to do, will they see the control, will they get
feedback". That is where this pass found its highest-severity items: a lost first click on every
card action, a toast region that covers the inspector's primary buttons, and a designer role whose
promised entry points are absent with no explanation.

## Method

The method is adapted from Lokalise's
[`uiux-heuristics` skill](https://github.com/lokalise/ai-toolkit/blob/main/plugins/design/skills/uiux-heuristics/SKILL.md)
(read at the time of this pass). What was kept, what was dropped, and why:

| Part of the skill                                                                                                                | Verdict                                   | Reason                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief gate: persona, surface, jobs, concrete artifact, before any capture                                                        | Kept                                      | It is the one rule that stops a confident report about the wrong thing.                                                                                         |
| Main-loop rule: the evaluator reads every screenshot, subagents only summarise code                                              | Kept                                      | Visual judgement does not survive a text hand-off.                                                                                                              |
| State coverage decided up front (populated, empty, loading, error)                                                               | Kept                                      | Error and empty states are where this pass found most.                                                                                                          |
| Lens 1 (Nielsen's 10, Laws of UX) with the pro-tool calibration (weigh #7 as much as #8; do not flag density a daily user wants) | Kept                                      | This is a dense B2B tool; "too many options" is only a finding when the options are the wrong ones for the role.                                                |
| Lens 2 cognitive walkthrough (the five questions per step)                                                                       | Kept                                      | It is the part that found the lost click and the missing completion feedback.                                                                                   |
| Lens 4 UX writing rubric                                                                                                         | Kept, with the terminology source changed | Source of truth is this product's own glossary (`docs/glossary.md`) and `en.json`, not Lokalise's product terms.                                                |
| Severity scale (Catastrophic / Major / Minor / Cosmetic)                                                                         | Kept                                      | Matches how the papercuts tracker is already read.                                                                                                              |
| Lens 3 "delight" (surface vs deep)                                                                                               | Kept, reduced to one paragraph            | For an operator tool "deep delight" is the task being fast and legible; mascots and animation are not a target.                                                 |
| Lens 5 a11y with axe on every state, Lens 6 CLS/long-task instrumentation                                                        | Not run (fast read)                       | Named as unverified below. UX-62..66 already landed the icon-label, focus-ring and reduced-motion cluster, so a full axe pass is a separate, cheaper follow-up. |
| i18n stress-test (RTL, 30% expansion, pseudo-locale)                                                                             | Not run                                   | The locale parity gate exists; a pseudo-locale re-shoot is a follow-up, not part of a first walkthrough.                                                        |
| Playwright capture scripts, Vantage/Expert routing, app-switcher trap, `lokalise.local`                                          | Dropped                                   | Lokalise-internal mechanics. This pass drove the SPA with `agent-browser` against the e2e stack, which can force any run state over REST.                       |
| "Design-system adherence" check inside Lens 1                                                                                    | Dropped                                   | Owned by #2246.                                                                                                                                                 |
| Curly-quote ban in copy rewrites                                                                                                 | Dropped                                   | This repo's own writing rules apply instead (no em-dashes, sentence case, no filler). Curly quotes in `en.json` are a formatting decision, not a UX one.        |
| "Cross-reference memory for agreed terms"                                                                                        | Replaced                                  | The agreed terms are in `docs/glossary.md`; an assistant's private memory is not a shared source.                                                               |

Two things the skill does not say that mattered here and are added to the method:

- **Drive the gate states, do not wait for them.** The e2e backend's `fake-profile` control channel
  (`decisionOnSteps`, `confidence`, `dispatchThrowKinds`) and a gated pipeline let one seeded board
  show a decision, an approval gate, a merge review, a failure and an auto-merge inside ten minutes.
- **Watch for the click that did nothing.** The e2e README documents a "remount swallows the click"
  flake class as a test problem. Evaluated from the user's chair it is a product defect, and the
  most severe one found (UXA-01).

## Context recap

- **Personas.** Engineer and product manager share the `full` surface (the app's own product
  decision, `frontend/app/README.md` → Roles); they were walked as one flow with the PM's questions
  layered on ("did it ship?", "what am I approving?"). Designer maps to the `intake` surface and was
  walked separately.
- **Surface.** The SPA core loop in the basic tier, plus the advanced-tier sidebar for comparison.
  Settings, hubs, wizards, the pipeline builder and the initiative surfaces were not evaluated.
- **Jobs.** Engineer/PM: (1) first launch to a usable board, (2) create a task under a service,
  (3) start a run and answer what it asks, (4) review and merge, (5) understand a failure.
  Designer: (1) first launch, (2) see what is in flight, (3) file a task from a design or a ticket.
- **Artifact.** `http://localhost:3010` (production build of `deploy/frontend` pointed at the e2e
  backend on `:8790`), one seeded workspace ("Checkout platform", sample architecture, fake GitHub
  connected, `defaultProvisionType: infraless`).
- **Viewport.** Desktop 1440×900, light mode for every state, dark mode on the populated board.

## Coverage and limitations

Captured and read (28 screens): first launch (advisories, role question, tour offer), advisory
dismiss menu, board at fit-to-content and after focusing a frame, sidebar collapsed and expanded in
basic and advanced tiers, Add-task modal (engineer and designer), task inspector (planned, running,
blocked, done, failed), run started, decision needed on the card and in the inspector, decision
modal, run finishing, Done lane, Outcome window, approval gate on the card and the step-detail
rail, notification inbox with two items, merge confirmation, post-merge state, failed run on the
card and in the inspector, command palette (engineer and designer), Appearance menu and dark board,
inspector Run menu, designer board, Assistant modal.

Not evaluated, so silence below is not a clean bill: every settings window and hub, the pipeline
builder, initiatives, recurring runs, bug hunt, the tutorial tours themselves, the focus view,
the login screen (the e2e primary stack is dev-open), mobile widths (see
[`mobile-friendly-frontend.md`](./mobile-friendly-frontend.md)), RTL, non-English locales, axe,
keyboard-only operation, reduced motion, layout-shift or jank measurements. Real model output was
not seen: every agent reply is the fake's one line, so the content of the decision modal and the
approval rail is judged on structure only.

Known test-stack artefacts in the screenshots, excluded from findings: `acme.nav.securityDashboard`
and `ACME.INCIDENTPANEL.*` (the consumer-extension spec's module renders raw keys), "Map editor"
and "Asset pipeline" external tools, model label `fake`, step durations of 0s.

## Flow walkthroughs

Each step is asked the skill's five questions: know what to do, notice the control, connect it to
the outcome, get feedback, complete. "Issue" names the failing question.

### Engineer / PM, job 1: first launch to a usable board

| Step                 | User is trying to       | Issue                                                                                                                                                                                                             | Severity               |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Open the app         | See the board           | Three full-width amber advisories ("Agent executor not configured", "Test environment", "Content storage") paint under a modal asking "What do you work on?". Q1: the first thing to read is an operator problem. | Major (UXA-03)         |
| Pick a role          | Answer the question     | Copy is clear; the note "changes what you see, never what you are allowed to do" answers the fear. Hint for Designer promises "new tasks from a design or a ticket".                                              | OK                     |
| Tour offer           | Decide about a tour     | Four ways out (X, "No thanks", "Maybe later", "See all tutorials"); the difference between "No thanks" and "Maybe later" is not stated. Q3.                                                                       | Minor (UXA-15)         |
| Read the board       | Understand what is here | Fit-to-content lands at 42%: every card title is ~7px. Q2 fails until the user zooms or double-clicks a frame; nothing says double-click focuses a frame.                                                         | Minor (UXA-10)         |
| Clear the advisories | Get to work             | Each X opens a menu with a session dismissal and a permanent one; three times over. Copy is honest.                                                                                                               | Minor (part of UXA-03) |

### Engineer / PM, job 2: create a task

| Step              | User is trying to                      | Issue                                                                                                                                                                                                                                                            | Severity        |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Find where to add | Add a task to Auth Service             | "+" in the frame header and "Add the first task" in empty frames. Clear.                                                                                                                                                                                         | OK              |
| Fill the form     | Describe the work                      | Ten type chips plus an "Incident response" group; "Ralph loop", "Bug fishing", "Spike" have no explanation in place. Q3 for a PM.                                                                                                                                | Minor (UXA-04b) |
| Fill the form     | Not be asked things they cannot answer | "Agent configuration" shows two backend descriptors in the basic tier: "Implementation-fork decision" and "Reproduction proof" (the latter for a Feature), with helper text written for the engine ("`auto` gates on the task risk policy", "pre-fix tree"). Q1. | Major (UXA-04)  |
| Submit            | See the task                           | Card appears in Not started, inspector opens on it. Good. The dependency arrow from Login endpoint to Token refresh now runs through the new card.                                                                                                               | Minor (UXA-11)  |

### Engineer / PM, job 3: run and answer

| Step            | User is trying to        | Issue                                                                                                                                                                                               | Severity       |
| --------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Start           | Run the default pipeline | "Start · Standard build" on the card names the pipeline. "Run started" toast. Good.                                                                                                                 | OK             |
| Notice the park | See the run needs them   | Toolbar "1 decision" pill, bell, frame pill "Decision needed", card "Resolve", inspector "Needs attention", plus a tutorial nudge and the toast. Five signals at once; the eye has nowhere to land. | Minor (UXA-16) |
| Act             | Open the decision        | First click on "Resolve" expands the card's step list and is lost; the second opens the modal. Q4 fails: the click gave no feedback and did not act. Reproduced on Resolve, Outcome and Approve.    | Major (UXA-01) |
| Decide          | Choose                   | Modal shows agent, task, question, options. No route to what the architect produced. Structure only (fake content).                                                                                 | Minor (UXA-19) |
| Approval gate   | Review the step          | Card button reads "Approve" but opens a review rail; approval happens inside. Q3: the label promises the outcome of the next screen.                                                                | Minor (UXA-07) |
| In the rail     | Read the output, decide  | Metadata block (run id, model, timestamps, "Infrastructure attempts") leads; the output line sits below it. Four actions whose difference needs the footnote.                                       | Minor (UXA-20) |

### Engineer / PM, job 4: review and merge

| Step                         | User is trying to    | Issue                                                                                                                                                                                 | Severity               |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Run finishes with auto-merge | Know it shipped      | Card leaves the visible lanes into the collapsed "Done" lane; no toast; the bell is empty. What appears is a tutorial nudge "Review and merge" after the merge already happened. Q4.  | Major (UXA-06)         |
| Read the result              | Learn what was built | Outcome window: plain-language sections, absent data stated as absent ("no view was captured"). Best surface of the pass. Entry point on the card needs two clicks (UXA-01).          | OK                     |
| PR ready, human merge        | Decide to merge      | Inbox items explain why the run parked and offer the action in place. Strong. "Review effort" sits above "Confirm & merge" with no visible explanation and "No comments" preselected. | Minor (UXA-14)         |
| Merge                        | Confirm              | Dialog does not name the PR or task ("Merge this pull request?"). Two are PR-ready on this frame.                                                                                     | Minor (UXA-18)         |
| After merge                  | Know it worked       | Card moves to Done, inspector badge flips to "Merged". No toast observed.                                                                                                             | Minor (part of UXA-06) |

### Engineer / PM, job 5: understand a failure

| Step             | User is trying to   | Issue                                                                                                                                                                     | Severity       |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Notice           | See something broke | Card turns red with a titled failure block and a "Retry" button; inspector repeats it; nudge "Read a failure". Clear.                                                     | OK             |
| Read             | Know what to do     | ~90 words on the card, repeated twice in the inspector; "Retry to try again". The transient-vs-persistent explanation is good and belongs in the detail, not on the card. | Minor (UXA-13) |
| Retry or stop    | Act                 | Inspector footer "Run / Focus / Delete task" is under the fixed toast region while a nudge is showing; the click lands on the nudge.                                      | Major (UXA-02) |
| After it is done | Tidy                | "Stop" and "Reset" stay on a finished run; "This task has started. Its details are locked." on a Done task.                                                               | Minor (UXA-12) |

### Designer, all three jobs

| Step                      | User is trying to          | Issue                                                                                                                                                                                             | Severity                 |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Open the app              | Get a simpler board        | Same three operator advisories as the engineer, before the role question. The role hint says "a simpler board"; the first screen is not.                                                          | Major (UXA-03)           |
| Read the board            | See work in flight         | Frames, lanes and cards read well. Cards offer Start, Retry, Review, Merge as primary buttons: execution controls on the intake surface.                                                          | Question (UXA-24)        |
| File a task from a design | Use what the role promised | No "Start from a design" or "Create task from issue" anywhere: both render only when a source is connected, and the role hides the surface that connects one. Nothing says so. Q2 fails silently. | Major (UXA-05)           |
| Add a task                | Describe the work          | Identical modal to the engineer's: ten types, agent configuration, engine helper text.                                                                                                            | Major (UXA-04, same fix) |
| Find anything             | Search                     | Palette has three entries: assistant, shortcuts, role, tutorials. No task or service search (known: [`global-search-and-deep-links.md`](./global-search-and-deep-links.md)).                      | Known                    |

## Findings

Severity: Catastrophic blocks the task or loses data; Major causes errors or drop-off for many
users; Minor costs effort; Cosmetic is polish. Tags: [Copy], [A11y]. Anchors are the component
seen on screen; line numbers were not pinned because #2246 will move most of these files.

### Major

- **UXA-01. The first click on a card action is lost to the card's hover expansion.** Cards with a
  run expand their step list when the pointer enters; the action row moves and the click that was
  already on its way lands on nothing. Reproduced three times (Resolve, Outcome, Approve), each time
  the second click acted. Nielsen #1 and #4: the user acted, saw a layout change, and got no result.
  `backend/internal/e2e/README.md` already names this as a flake class (midpoint clicks landing on a
  remounted row) and works around it in the specs with `openAttention`.
  Mechanics (code-traced): the hover grant is recomputed on the next animation frame after any
  window `pointermove`/`pointerdown` with no delay (`useBoardActivity.ts`, `useTaskExpansion.ts`
  `hoveredTaskId`), and `TaskPipelineMini` renders as a sibling ABOVE the action row
  (`TaskCard.vue`, the mini at the top of the card body, the Resolve/Approve/Outcome/Merge row
  below it). Expanding pushes the row down by the step list's height; when that happens between
  `pointerdown` and `pointerup`, the two land on different elements and the browser fires `click`
  on their common ancestor, the card root, whose handler is `selectTask`. So the first click
  selects the task; the second, on a now-stable card, acts. Fix: render the mini BELOW the action
  row (or overlay it) so the row's position is invariant; the narrow alternative is to freeze
  `setHovered` while a pointer gesture is in flight. Pin with a component test that moves the
  pointer onto a compact card's button and clicks once, asserting the handler fired and the card
  was not merely selected.
- **UXA-02. The fixed toast and tutorial-nudge region covers the inspector footer.** At 1440×900
  with the inspector open, "New walkthrough available" sits over Run / Focus / Delete task. The
  browser refused the click because another element covered the point. Nielsen #7 (efficiency) and
  #3 (control): the primary action of the panel is unreachable exactly when the app is talking most.
  The nudge also appears on every new run state (Answer a waiting run, Review and merge, Read a
  failure), so this is the normal case for a first-week user, not an edge. Fix: give the toaster a
  region that excludes the inspector column (offset `end-4` by the inspector width when it is open),
  or dock nudges into the sidebar rail. Related: UX-77 kept remedy toasts sticky, which makes the
  overlap last longer. Surfaces: the toaster mount in `pages/index.vue`,
  `components/tutorial/TutorialNudge*.vue`.
- **UXA-03. First launch stacks three operator advisories under two modals.** A first-time user of
  any role sees "Agent executor not configured", "Test environment not configured", "Content storage
  not configured" (each with a "Configure" button that the intake role cannot use), then "What do
  you work on?", then "Take a quick tour?". Nielsen #8 and Tesler: the deployment's setup debt is
  handed to the person least able to fix it. `BoardTopOverlays` orders by "what the user loses by
  not reading now", but for a designer the loss is zero. Fix: gate the three advisories on
  `fullSurface` (and ideally on workspace admin), show them after the role and tour questions, and
  collapse three banners into one "This deployment is missing 3 capabilities" card with the detail
  behind it. Surfaces: `components/layout/BoardTopOverlays.vue` and the three advisory banners.
- **UXA-04. Add-task shows backend agent-configuration descriptors regardless of tier and type.**
  `configDescriptors` (`agentConfig.forPipeline`) render for every pipeline in the basic tier and
  for the designer, so "Implementation-fork decision" and "Reproduction proof" appear on a Feature
  task, with helper text addressed to the engine (backticked `auto` / `always` / `off`, "pre-fix
  tree", "the Coder"). Nielsen #2 and the tier rule in `frontend/app/README.md` (a basic surface
  shows the default, never the override). Fix: a descriptor is an override, so hide the block
  behind `showOverrideField(isAdvanced, ...)`; let a descriptor declare which task types it applies
  to; rewrite the two descriptions for a person ("Ask me to choose between approaches before code
  is written" / "Prove the fix with a failing-then-passing test"). [Copy] Surfaces:
  `components/board/AddTaskModal.vue` (agent configuration block), the descriptor definitions in
  the agent registry.
  - **UXA-04b.** Ten type chips without a description in place ("Ralph loop", "Bug fishing",
    "Spike", "Media"). A PM or designer has to recall what these are. Fix: one line under the
    selected chip, and hide the intake-irrelevant types ("Ralph loop", "Bug fishing", "Recurring")
    from the intake role. [Copy]
- **UXA-05. The designer's promised entry points are absent with no explanation.** The role hint
  reads "new tasks from a design or a ticket", but "Start from a design" and "Create task from
  issue" render only when a design or task source is connected
  (`BlockNode.vue`: `documents.connectedDesignSources.length > 0`, `tasks.anyOffered`), and the
  intake role hides Integrations, the surface that connects one. On a fresh workspace a designer
  sees neither button, no hint, and no way to ask for one. "Absent and zero render the same" is the
  repo's own rule (`CLAUDE.md` → Degrade loudly). Fix: when the role is intake and no source is
  connected, render the two buttons disabled-with-reason or an inline note "No design source is
  connected. Ask a workspace admin to connect Figma or Zeplin", and give the admin side a
  notification. Surfaces: `components/board/nodes/BlockNode.vue` frame header, the intake nav
  table.
- **UXA-06. A run that finishes and auto-merges gives no confirmation.** The card leaves the three
  visible lanes for the collapsed Done lane, the bell stays empty, no toast, and the only new thing
  on screen is a tutorial nudge offering to teach "Review and merge" for a PR that is already
  merged. Nielsen #1: for a PM the whole point of the run is "did it ship", and the answer is
  hidden behind a collapsed lane and an inspector scroll to "PR #1 Merged". Code-traced: the stream
  routes `pipeline_complete` only into the inbox (`useWorkspaceStream.ts` → `notifications.upsert`),
  and the manual merge path (`stores/execution/commands.ts` `mergePr`, `TaskCard.vue`) toasts only on
  failure; the only run-driven toasts in the app are errors (`usePipelineErrorToast.ts`). Start is
  the exception that confirms optimistically, which is why "Run started" exists and "Merged" does
  not. Fix: a success toast naming the task and the PR with an "Open PR" action, on both the
  manual merge and the `pipeline_complete` event; keep a just-finished card visible in Needs you or
  a "Recently done" strip for one session before it folds into Done; suppress the merge nudge when
  the run auto-merged. Surfaces: `composables/useWorkspaceStream.ts`,
  `stores/execution/commands.ts`, `components/board/nodes/FrameSwimlanes.vue` (Done lane).

### Minor

- **UXA-07. Card button "Approve" opens a review rail; it does not approve.** The label promises
  the outcome of the next screen (Nielsen #4). Fix: "Review" on the card (the rail then owns
  "Approve & proceed"), or "Review to approve". [Copy]
- **UXA-08. The task's default pipeline changes with the interface tier.** The same planned task
  reads "Start · Standard build" in basic and "Start · Adaptive build" in advanced
  (`defaultBuildPipelineId(uiMode.isAdvanced)`, `contracts/src/build-ladder.ts`). A view preference
  changes what a run does. Code-traced: the card's chain is task pin → workspace-declared
  interactive default → tier rung → first pipeline (`TaskCard.vue` `defaultPipeline`), computed
  live over `uiMode.isAdvanced` with nothing persisted. Tasks created through the modal are pinned,
  so this bites REST-created and seeded tasks and any task whose pin was cleared. Fix: resolve the
  default once from the workspace (a declared interactive default already outranks the rung), and
  let the tier decide only whether the picker is shown.
- **UXA-09. The inspector's Run menu is a flat list of 18 names.** No step preview, no grouping by
  purpose, custom pipelines last. `frontend/app/README.md` states `PipelinePicker` (with its
  preview pane) is "the single way a pipeline is chosen anywhere"; this menu is the exception. The
  catalog size itself is [`pipeline-catalog-collapse.md`](./pipeline-catalog-collapse.md)'s job.
  Fix: route the Run trigger through `PipelinePicker`.
- **UXA-10. Fit-to-content lands the board at 42% where nothing is legible.** Nothing tells the
  user that double-click focuses a frame (UX-16 added the gesture; it is undiscoverable). Fix: a
  zoom floor for the initial fit when the board is small (six frames fit at 83%), and a one-time
  hint on the zoom pill.
- **UXA-11. A dependency edge is drawn through an unrelated card.** Inserting a task between two
  dependent tasks in the Not started lane puts the new card on the arrow's path. Gestalt: the new
  task reads as part of the chain. Fix: route lane-internal edges along the lane edge, or order the
  lane so dependent pairs stay adjacent.
- **UXA-12. Finished runs keep "Stop" and "Reset", and a Done task says "This task has started.
  Its details are locked."** Stop on a finished run is a no-op offered in warning colour; the lock
  note is true but the tense is wrong once the task is done. Fix: hide Stop when the run is
  terminal; "This task has run. Its details are locked." or "Details are locked after the first
  run." [Copy]
- **UXA-13. The failure block puts ~90 words of red text on the card and repeats it twice in the
  inspector.** "The container failed to start." followed by "The agent's container could not be
  started" says the same thing; "Retry to try again" is circular. Fix: card shows the title and one
  sentence plus Retry; inspector shows the full explanation once; drop the last sentence. [Copy]
- **UXA-14. "Review effort" is asked without its explanation.** The `promptHint` ("Your answer is
  the ground truth the auto-merge thresholds are calibrated against. Tagging is optional") exists
  in `en.json` but is not visible in the inbox card; "No comments" is preselected, so "Confirm &
  merge" reads as if a review happened. Fix: render the hint, default to no selection.
- **UXA-15. The tour offer has four exits and four identical "Start" buttons.** Code-traced: "No
  thanks" persists a decision so the offer never auto-opens again; "Maybe later" and the X are the
  same call (`closePrompt`, nothing persisted, asks again next launch). Nothing on screen says which
  one is permanent. The Start buttons render only the action word (`TutorialPrompt.vue`), so a
  screen reader hears "Start" four times with no tour name. [A11y] Fix: two exits, labelled for
  their effect ("Not now" and "Don't offer tours again"); `:aria-label` composed from the tour
  title ("Start: Board basics").
- **UXA-16. A parked run raises five simultaneous signals.** Toolbar pill, bell, frame pill, card
  button, inspector badge, plus a nudge and a toast in the corner. Each is right alone; together the
  eye has no single place to land (Nielsen #8). Fix: the card and the toolbar pill are enough on the
  board; move the nudge to the sidebar; do not toast a state the toolbar already shows.
- **UXA-17. Command palette lists "Connect Linear" twice and cannot find a task.** The duplicate is
  a data bug in the integrations contributions; task search is the global-search initiative. Fix
  the duplicate now.
- **UXA-18. The merge confirmation does not name what it merges.** With two PR-ready cards on one
  frame, "Merge this pull request?" is ambiguous. Fix: "Merge PR #1 for 'Login endpoint'?" [Copy]
- **UXA-19. The decision modal gives no route to the step's output.** A person choosing between
  options cannot see what the agent produced without closing the modal and opening the step. Judged
  on structure (fake content). Fix: a "See the architect's output" link into the step detail.
- **UXA-20. The approval rail leads with metadata.** State, duration, step, two timestamps, model,
  raw run id and "Infrastructure attempts" fill the first fold; the agent's output starts under
  them. Fix: output first, metadata in a collapsed "Run details" block; give "Infrastructure
  attempts" a sentence.
- **UXA-21. Advanced-tier frame headers add two icon-only buttons.** Recurring and initiative
  actions have a `title` but no visible label and no distinct affordance from "+". [A11y] Fix: put
  them in the "+" menu with labels.

### Cosmetic

- **UXA-22. Rail labels truncate to "ENG…", "DESI…", "ADV…".** The collapsed rail shows the first
  four letters of the role and tier. Fix: icon only with a tooltip, or a two-letter code.
- **UXA-23. Em-dashes and ellipsis characters in placeholders.** "Describe the work — context…",
  "It won't run until you start a pipeline on it — you can keep editing". The repo's writing rule
  bans them in every human-readable string. [Copy]
- **UXA-24. (Question, not graded.)** The designer surface shows Start, Retry, Review and Merge as
  primary card actions. RBAC decides whether they work; the role decides what is offered. Should an
  intake persona be offered Merge? See unresolved questions.

## Hierarchy and delight read

Functional and reliable hold: every job completed, live updates arrived without a reload, and the
Outcome window and the notification inbox are the two surfaces where the product explains itself
best (plain sections, absent data stated as absent, the action in place). Usable is where the
severity sits: the lost first click (UXA-01) and the covered footer (UXA-02) are mechanical, not
conceptual, and they hit the two moments the user is most engaged. There is no surface delight to
speak of and that is fine for this tool; the deep delight that exists (a run parks, the inbox says
exactly why and offers the fix) is undercut when the completion of a run is silent (UXA-06).

## Copy and microcopy read

Voice is consistent and honest: advisories say what is missing and what it costs, the Outcome
window states absence rather than hiding it, the failure explanation distinguishes transient from
persistent. Terminology matches `docs/glossary.md` (block, task, frame, pipeline, run). The drift is
in register: strings written for the engine leak into forms a PM fills (UXA-04), and a few labels
promise the next screen's outcome rather than the click's (UXA-07). Highest-value rewrites: the two
agent-configuration descriptions, the card "Approve", the failure card, the lock note. Repo rule
violations (em-dashes, "…") are widespread in `en.json` placeholders and are one mechanical sweep.

## Priorities

1. UXA-01 lost first click on card actions.
2. UXA-02 toast region over the inspector footer.
3. UXA-06 silent completion and auto-merge.
4. UXA-03 first-launch advisories shown to every role.
5. UXA-04 and UXA-05 together: what the intake role is offered and what it is told is missing.

## Unresolved questions

1. **UXA-24.** Should the intake role be offered Merge and Retry on cards? The README says the role
   decides what the SPA offers and RBAC decides what works. Suggested answer: keep Review and
   Outcome, drop Start / Retry / Merge from the intake surface; a designer who needs them switches
   role, which is one click.
2. **UXA-08.** Is a tier-dependent default pipeline intended? `defaultBuildPipelineId(isAdvanced)`
   reads as deliberate. Suggested answer: it should be a workspace default; the tier should only
   decide whether the choice is shown.
3. **UXA-03.** Are the three startup advisories meant for every user, or for the person who can
   act on them? Suggested answer: gate on `fullSurface` plus `canManageIntegrations`, and show
   them after the role and tour questions.
4. **UXA-01.** Fix the expansion (do not move the action row) or the timing (hover delay)?
   Suggested answer: do not move the row; a delay trades one race for another.
5. Should the full-audit passes (axe on every captured state, keyboard-only, RTL and pseudo-locale
   re-shoots) run as a second slice of this tracker, or as their own? Suggested answer: own
   tracker after UXA-01..06 land, since they change the DOM the audit would measure.

## Checklist

Confidence: **high** means the screenshot shows it and the mechanism was traced in code; **medium** means seen once on the e2e stack and not traced, so reproduce it on a real `deploy/local` board at your own viewport before fixing; **low** means a structural judgement, partly on fake agent output, to confirm with the maintainer before filing. Three e2e-stack differences to keep in mind when validating: fake agents make every transition instant, the capability advisories reflect the e2e configuration, and the consumer-extension spec module adds nav and palette entries (a candidate cause of UXA-17).

| Id                                                       | Severity | Confidence                | Status   | PR  |
| -------------------------------------------------------- | -------- | ------------------------- | -------- | --- |
| UXA-01 lost first click on card actions                  | Major    | high: seen, code-traced   | todo     |     |
| UXA-02 toast region covers inspector footer              | Major    | high: seen, code-traced   | todo     |     |
| UXA-03 startup advisories for every role                 | Major    | medium: seen once         | todo     |     |
| UXA-04 agent-config descriptors in basic tier and intake | Major    | high: seen, code-traced   | todo     |     |
| UXA-04b task type chips without descriptions             | Minor    | high: seen, code-traced   | todo     |     |
| UXA-05 designer entry points absent without explanation  | Major    | high: seen, code-traced   | todo     |     |
| UXA-06 silent run completion and auto-merge              | Major    | high: seen, code-traced   | todo     |     |
| UXA-07 card "Approve" label                              | Minor    | low: structural judgement | todo     |     |
| UXA-08 tier-dependent default pipeline                   | Minor    | high: seen, code-traced   | question |     |
| UXA-09 inspector Run menu bypasses PipelinePicker        | Minor    | low: structural judgement | todo     |     |
| UXA-10 initial fit at 42%                                | Minor    | medium: seen once         | todo     |     |
| UXA-11 edge through an unrelated card                    | Minor    | medium: seen once         | todo     |     |
| UXA-12 Stop/Reset on finished runs, lock note tense      | Minor    | medium: seen once         | todo     |     |
| UXA-13 failure block length and repetition               | Minor    | medium: seen once         | todo     |     |
| UXA-14 review effort without hint, preselected           | Minor    | medium: seen once         | todo     |     |
| UXA-15 tour offer exits and Start names                  | Minor    | high: seen, code-traced   | todo     |     |
| UXA-16 five signals for one parked run                   | Minor    | low: structural judgement | todo     |     |
| UXA-17 duplicate "Connect Linear"                        | Minor    | medium: seen once         | todo     |     |
| UXA-18 merge confirm does not name the PR                | Minor    | low: structural judgement | todo     |     |
| UXA-19 decision modal has no route to output             | Minor    | low: structural judgement | todo     |     |
| UXA-20 approval rail leads with metadata                 | Minor    | low: structural judgement | todo     |     |
| UXA-21 icon-only frame header buttons (advanced)         | Minor    | low: structural judgement | todo     |     |
| UXA-22 rail label truncation                             | Cosmetic | medium: seen once         | todo     |     |
| UXA-23 em-dashes and ellipses in placeholders            | Cosmetic | medium: seen once         | todo     |     |
| UXA-24 intake role offered execution controls            | Question | low: structural judgement | open     |     |

## How to reproduce the captures

```sh
# Postgres from deploy/local is enough; create an empty database for the e2e backend first.
cd backend/internal/e2e
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/cat_factory_e2e_ux PORT=8790 CORS_ALLOWED_ORIGINS=http://localhost:3010 \
  E2E_AUTH_PORT=8792 E2E_AUTH_FRONTEND_URL=http://localhost:3011 node src/testServer.ts
# Build once, serve the emitted bundle with the API base read at start.
NUXT_PUBLIC_API_BASE=http://localhost:8790 pnpm --filter @cat-factory/deploy-frontend run build
NUXT_PUBLIC_API_BASE=http://localhost:8790 PORT=3010 node deploy/frontend/.output/server/index.mjs
```

Seed `POST /workspaces {seed:true}`, then the control channel on `:8791`: `/github-seed`, and
`/fake-profile` with `decisionOnSteps: []`, `confidence: 0.2` (merge review) or
`dispatchThrowKinds: ['coder']` (failure). A pipeline posted with `gates: [true, false]` parks on
the approval rail. The helpers in `backend/internal/e2e/tests/helpers.ts` are the reference for
each call.
