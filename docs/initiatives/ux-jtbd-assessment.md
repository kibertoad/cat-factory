# UX assessment: cat-factory against the jobs its users hire it for

Status: assessment only, no implementation. Written 2026-09-20 against `main` at `585bcdaba`,
the running local deployment on port 3010 (demo board "Checkout platform"), the website
(catfactory.ai), and the frontend README. Annotated screenshots and wireframes are under
`assets/ux-jtbd/` beside this file (section 8). The decision this report raises is filed as
[#2258](https://github.com/kibertoad/cat-factory/issues/2258).

Out of scope on purpose: visual consistency (typography, primitives, button variants, radius,
feedback states). Issue #2246 and its slices #2247 to #2252 own that. This report is about
whether the product serves the jobs its users come for, and where the weight of the interface
sits relative to those jobs.

## 1. Verdict

The product is not overwhelming because it has many features. It is overwhelming because the
interface is organised around the platform's mechanisms, and the user's jobs are spread thinly
across them. Every screen exposes how the engine works. Almost no screen is shaped like the
thing the user came to do.

Three facts carry most of the weight:

- The first minute asks the user four questions they did not come to answer (a role, a tour,
  three infrastructure banners that cover the board, then a fourth banner when those are
  dismissed). Every benchmark product opens on one text box or one list.
- The home screen is a spatial map at 34% zoom, where cards are unreadable and the work happens
  in a side panel and 66 overlays. The user's real job ("what needs me now") is answered in
  four separate places: a lane, a toolbar counter, a bell, and card badges. Devin, Copilot and
  Cursor all open on a status list of sessions.
- Creating one task asks 12 decisions and shows 10 task types. Every benchmark asks for a
  sentence and a repository.

The good news: the pieces for a job-shaped product already exist (the "Needs you" lane, the
outcome summary with the PR at the top, the assistant's text-first entry, the Basic tier, the
tutorial chain). They are secondary today. The recommendation is to make them primary.

## 2. Who the user is, and what they hire the product for

The website names three personas: the engineer who designs and reviews while agents implement,
the lead who watches many agents and the spend, and the operator who runs the deployment. The
in-app role prompt names engineer, product manager and designer. The frontend README is honest
that engineer and product manager map to the same surface.

The jobs, in the order a user meets them:

| Job                | The sentence the user would say                   | Frequency           |
| ------------------ | ------------------------------------------------- | ------------------- |
| J1 Intake          | "Get this done. Here is what I want."             | Daily, many times   |
| J2 Attention       | "What needs me right now? Let me deal with it."   | Continuous          |
| J3 Trust and merge | "Show me what changed and why I should merge it." | Daily               |
| J4 Get to green    | "Make the platform able to run a task at all."    | Once, then rarely   |
| J5 Tune            | "Change how agents work on my code."              | Weekly, power users |

J1 to J3 are the delivery loop the website sells. J4 is the price of self-hosting. J5 is where
the engine's richness belongs.

## 3. Where the interface weight sits today

Measured from the English catalog, the running app and the code.

| Measure                                             | Value                                     | Source                           |
| --------------------------------------------------- | ----------------------------------------- | -------------------------------- |
| User-facing strings                                 | 6,410                                     | `en.json` leaf count             |
| Strings under `settings.*`                          | 1,042 (16%)                               | `en.json`                        |
| Strings under `inspector.*` + `panels.*`            | 758                                       | `en.json`                        |
| Strings under `board.*`                             | 341                                       | `en.json`                        |
| Overlays mounted from the one page                  | 66                                        | `pages/index.vue`                |
| Sidebar sections / items (advanced)                 | 9 / 16                                    | running app                      |
| Command palette entries                             | 28, none is a search of tasks or runs     | running app                      |
| Fields and choices in "Add a task"                  | 12 decisions, 10 task-type buttons        | running app                      |
| Agent kinds in the builder palette                  | 33 (9 shown at Basic tier, 24 hidden)     | running app                      |
| Saved pipelines                                     | 23 (9 shown for purpose Build, 14 hidden) | running app                      |
| Steps in the default "Standard build"               | 11                                        | running app                      |
| Core concepts a new user is given                   | 27                                        | catfactory.ai core concepts page |
| Notification kinds                                  | 25                                        | `layout.notifications.action`    |
| Tutorial tours                                      | 15                                        | `tutorial.tours`                 |
| Workspace settings tabs / settings on the first tab | 8 / 12, each with a paragraph             | running app                      |
| Narrowing axes the user must understand             | 3 (role, interface tier, agent tier)      | frontend README                  |

Reading: one sixth of every word the product can say is a setting. The delivery loop (board
plus the "Needs you" lane, the decision modal, the outcome summary) is a small fraction. The
weight sits on J4 and J5. The website sells J1 to J3.

## 4. Benchmarks

Products that do a comparable job (hand work to coding agents, watch it, review and merge), plus
Linear as the reference for "opinionated and calm" in a tool developers use all day.

| Product                      | Home screen                                                    | Intake                                     | Attention                                  | Review                                 | Configuration                         |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | -------------------------------------- | ------------------------------------- |
| Devin (Agent Command Center) | Kanban of sessions: In flight, Blocked, Ready for review, Done | One prompt plus repo                       | The Blocked column                         | Click a card into the session's IDE    | Absent from the board                 |
| GitHub Copilot coding agent  | Agents panel: list of sessions with live status                | Prompt plus repo and branch, from any page | Status "waiting for review" on the session | Draft PR, review by `@copilot` mention | Custom agents defined once, elsewhere |
| OpenAI Codex (cloud)         | List of tasks with status                                      | Prompt, repo, environment                  | Task status                                | Diff plus terminal log, one click      | Environments configured once          |
| Google Jules                 | Task list                                                      | Prompt plus repo                           | Plan approval before work                  | Diff and PR                            | Almost none                           |
| Cursor (Agents Window)       | Sidebar of local and cloud agents, tabs side by side           | Prompt                                     | Agent status                               | Diff in the editor                     | Environments, once                    |
| Factory                      | Sessions list across web, desktop, mobile                      | Prompt                                     | Session status                             | Diff viewer tuned for small screens    | Droid settings, separate              |
| Linear                       | Issue list; Cmd+K taught first                                 | Title plus description                     | Inbox with the action inline               | Not applicable                         | Opinionated defaults, hierarchy given |

What every benchmark shares:

1. One primary object with a status. A session or task. The status list is the home.
2. Intake is a sentence and a repository. No type picker, no pipeline picker, no model picker.
3. Attention is a column or a list, and the item is the action. You do not "mark it read".
4. Review is a diff and a log one click from the status.
5. Configuration happens once, elsewhere, and does not appear on the working surface.
6. Plan approval (Jules, Devin planning) is the one interruption they add, because it is the
   moment human judgement pays most.

cat-factory has more capability than any of them (gates, judges, risk policies, spend caps,
trackers, ephemeral environments). None of that is the problem. The problem is that all of it is
on the working surface.

## 5. Findings, by job

Each finding states the job, what happens today, why it hurts, and what to challenge. Ordered by
impact on the everyday user.

### F1. J4 and J2: the first minute asks the wrong questions

What happens today. A first launch on the local deployment shows, in order: three stacked
infrastructure banners that cover the canvas (runner pool, test environment, content storage),
a modal "What do you work on?", then a modal "Take a quick tour?" with seven tours, then the
board. Dismissing the three banners for the session raised a fourth ("Runner pool needs
configuration"). Startup can also raise up to three health advisories (pipelines, risk policies,
model presets) and two AI-provider dialogs, each gated to one per session but all in the same
queue. The board's own controls were unclickable behind the banners at 1280 px wide.

Why it hurts. The user came to hand off work or to see what needs them. Instead the product
asks about the user, offers a curriculum, and lists what the operator has not done. The role
question maps two of its three answers to the same surface, so for most people it is a question
with no consequence. The banners are the operator's job leaking onto every engineer's screen.

Challenge.

- Replace the banners and the AI-provider dialogs with one persistent setup indicator: a chip or
  card that says "Setup 2 of 5" and opens one checklist (model, runner, GitHub, environment,
  storage), with status and one action per row. The checklist is J4's whole surface.
- Drop the role prompt from first launch. Default to the full surface. Keep the switcher in the
  sidebar for the designer case. A question whose two most common answers do nothing is noise.
- Offer tours contextually only (the nudge already exists). Do not modal them at launch.
- Show setup only to people who can act on it (the deployment operator or account admin). A
  member who cannot configure a runner pool gains nothing from being told about it.

### F2. J2: the board is the home, but the job is the queue

What happens today. The board opens at 34% zoom. Frames render as thumbnails; card text is not
legible. To act, the user clicks a card and works in the inspector or in one of 66 overlays.
Attention is counted in four places at once: the "Needs you" lane per frame, the "2 decisions"
toolbar button, the bell with "4", and status badges on cards. Each counts a different subset.

Why it hurts. The spatial layout is a planning tool (J1's structure). The daily job is J2, and a
map is a poor queue: you cannot scan, sort or filter a map. The frontend README already models a
lane as "a claim" and sorts each lane by what is actionable. That is a queue, drawn inside a
frame, inside a canvas, at a zoom where you cannot read it. Devin's Command Center, Copilot's
agents panel and Cursor's Agents Window all open on exactly this queue, without the canvas.

Challenge.

- Add a queue view as the default landing: three columns or lists across all services (Needs
  you, In flight, Ready to merge), each entry carrying the one action the lane already computes
  (Resolve, Retry, Review, Merge). Keep the board as a second view named for what it is (Map or
  Plan). This is the "board stays one canvas or becomes routed pages" decision that #2246 defers.
  The JTBD answer is: routed pages, with the canvas as one of them.
- Collapse the four attention counters into one. The bell and the toolbar "decisions" button
  answer the same question.
- The global search initiative (`global-search-and-deep-links.md`) becomes essential here: a
  queue without links to items cannot be shared in Slack or opened from a notification.

### F3. J1: creating a task asks twelve decisions

What happens today. "Add a task" shows 10 type buttons (Feature, Bug, Bug fishing, Document,
Spike, Review, Ralph loop, Media, Recurring, Incident), a title, a description, a "Technical
task" checkbox with a 40-word explanation, a Pipeline picker (23 pipelines), a Risk policy
picker, a Model preset picker, two tri-state agent options with 60-word explanations, best
practice fragments, context documents and context issues. This is the Advanced tier. The Basic
tier hides the overrides but still leads with the type row.

Why it hurts. The user's sentence is "get this done, here is what I want". Every benchmark asks
for that sentence and a repository. The task type is the platform's routing concern, not the
user's. "Ralph loop", "Bug fishing" and "Media" are mechanisms, not kinds of work a product
manager recognises. The pipeline, policy and preset each have a workspace default, and the form
offers to override all three before the user has typed a title.

Challenge.

- Intake is a title, a description and the service. Nothing else on the first screen.
- Infer or default the type: Feature unless the text reads like a bug; a "This is a bug" toggle
  is enough. Document, Spike, Review, Media, Recurring and Ralph loop move behind a "More kinds
  of work" control or into the palette.
- Overrides appear behind one "Change how this runs" disclosure, in both tiers. The
  `showOverrideField` rule already governs when a set override must show; apply the same idea to
  creation.
- Promote the assistant. It is the text-first intake the benchmarks use, and today it is one of
  two items under "Create". The prompt box should be the first thing on the intake screen.

### F4. J2: the notification does not carry the action

What happens today. The inbox ("Needs your attention") lists three overdue items. Two are
decisions a run is parked on. Their visible buttons are "Mark read" and "Dismiss". The text says
"Open the task to respond". Clicking the item's title does open the decision (the code routes
each notification kind to its surface), but the title carries no affordance: no button, no
link styling, no verb. In a test session I did not find it. One item (confirm a gated PR) does
carry its action inline as buttons, which shows the pattern works.

Why it hurts. The one moment the product asks for a human is the moment the only visible verb is
"Mark read". Linear's inbox, Devin's Blocked column and Copilot's "waiting for review" state all
make the item's primary button the action.

Challenge. Every notification kind carries its primary verb as a button (Answer, Retry, Review,
Merge, Acknowledge), wired to the routing the title click already has. "Mark read" is never
primary. This is the smallest change in the report: the routing exists, only the affordance is
missing. Slack and email need the same verb as a deep link (F2).

### F5. J2 and J3: failure copy is written for the platform engineer and repeated

What happens today. A failed task shows the same 90-word paragraph ("The agent's container
could not be started ... a misconfigured container binding/image or runner pool ...") three
times on one screen: on the card, at the top of the inspector, and again inside the Execution
section, each with its own Retry button. The step list labels the executor "fake".

Why it hurts. A person deciding whether to retry needs one line: what stopped, whether retrying
is likely to work, and one button. The paragraph explains the runtime's architecture. Repeating
it three times makes the panel scroll before the user reaches the PR link or the step list.

Challenge. One failure block per task view: a one-line cause, one recommended action, details
behind a disclosure. The card shows the status word and the action only. Write the copy for the
person who did not configure the runner.

### F6. All jobs: vocabulary load

What happens today. The core concepts page defines 27 terms. The app adds interface tiers, agent
tiers, roles, purposes, risk policies, model presets, fragments, foundational services, shared
stacks, capability credentials, Kaizen, Sandbox, initiatives, epics, Ralph loop, bug fishing,
bug hunt, spikes, recurring pipelines, dry runs, unattended defaults. Three narrowing axes (role,
interface tier, agent tier) are themselves concepts the user must hold, and the README spends
1,300 words explaining how they interact.

Why it hurts. Benchmarks ask the user to learn three or four nouns: task, session, environment,
PR. cat-factory names its mechanisms, and the names appear on the everyday surface: a sidebar
section called "Workspace context", a task type called "Ralph loop", a setting called
"Review-debt friction". A user cannot form a model of a product whose nouns outnumber their
jobs by ten to one.

Challenge.

- Split vocabulary by surface. The delivery surface uses outcome words: task, run, needs you,
  ready to merge, changed files, checks. The engine's names live in the builder, the settings
  and the docs.
- Merge the role axis into the tier axis. Designer equals Basic with fewer create routes; that
  is one flag, not a third concept with its own prompt.
- Rename by job where the section is a mechanism: "Workspace context" is "Standards";
  "Foundational services" is part of "Services"; Sandbox and Kaizen are "Evaluate".

### F7. J1 and J5: the pipeline is a required daily choice, but it is an admin object

What happens today. Every task carries a pipeline. The picker explains each of 23 pipelines by
its ordered steps (11 to 14 steps for the defaults). The sidebar's first section, "Create",
offers "Build a pipeline" ahead of any way to create a task. The builder exposes 33 agent kinds
across 5 categories, a purpose filter and a tier filter, and per-pipeline "in-app default",
"unattended default", archive and clone controls.

Why it hurts. No benchmark asks the user to pick how the agents will be sequenced. Jules asks
for approval of a plan, which is the judgement a human can make; the sequence of Architect,
Reviewer, Deployer, Tester, Conflicts, CI, Merger is not. The default pipeline ("Adaptive
build") already adapts to the task's estimate, which is the platform saying it can decide.

Challenge.

- One workspace default pipeline, invisible on intake. "Change how this runs" as the escape
  hatch (F3).
- The builder moves out of "Create" into the setup or settings area. It is J5.
- Consider a plan-approval step as the default human checkpoint instead of a pipeline choice:
  show the Architect's design and let the user approve or edit it. That is where the benchmarks
  put the human, and the engine already has the requirements reviewer and fork decision to do it.

### F8. J5: settings read as documentation

What happens today. Workspace settings has 8 tabs. The first tab holds 12 settings, each with a
heading, a 40 to 80 word paragraph and a control. Some are operator concerns (agent-context
storage and retention, screenshot retention, verification report publishing, Kaizen grading).
Some are team policy (running tasks per service, review-debt friction, run credential). One is
a personal display preference in disguise (Done lane caps). Account settings adds team, model
policy, risk policies, run credentials, fragments, skills, failure rules, platform alerts and
deployment integrations.

Why it hurts. The paragraphs are correct and careful, and they make a settings page a reading
task. The grouping is by where the value is stored (workspace, account), not by what the user is
deciding.

Challenge.

- Group by decision: Merging and risk, Spend, Who can do what, Trackers and sources, Standards,
  Retention and observability. Tabs follow those names.
- Label plus one line. The paragraph becomes a "Learn more" link to the website page, which is
  where the docs split (ADR 0051) says operator explanation belongs.
- Operator-only settings (retention, telemetry bodies, report publishing, grading) move to an
  operator area with the setup checklist from F1.

### F9. Navigation is organised by mechanism

What happens today. The sidebar's nine sections are Create, Repositories, Models, Integrations,
Infrastructure, Workspace context, External tools, Configuration, Help. "Create" contains the
assistant and the pipeline builder; creating a task is not there (it lives on frames only).
"Models" holds two hubs plus Sandbox and Kaizen. Connections split across two hubs (Integrations
and Model providers) for a reason documented in the README but invisible to a user who wants to
"connect X". The command palette lists the same 28 destinations and cannot find a task, a run
or a service.

Why it hurts. The sidebar is a map of the engine. The user's map has three regions: work, setup,
settings. Linear teaches Cmd+K first because the palette is search plus commands; here it is
commands only.

Challenge. Sidebar: Queue, Board, then one Setup entry (the F1 checklist plus both connection
hubs), then Settings, then Help. The palette leads with search (the search initiative) and
lists commands second. The frontend README's "where a surface lives" rules stay valid; they
move one level down.

### F10. J4: getting to green has no single surface

What happens today. A first PR on the local deployment needs a model provider, a runner pool or
container executor, a GitHub token with the right scopes, and optionally an environment
provider and content storage. These are reached through three banners, the Model providers hub,
the Integrations hub, the Infrastructure window (5 tabs), Account settings, and "My setup".
Each tells the truth about its own piece. Nothing shows the whole.

Why it hurts. Hosted benchmarks hide this entirely. A self-hosted product cannot, so it has to
make it one job with a visible finish line. Today the user learns the finish line by triggering
each missing piece's failure.

Challenge. The setup checklist from F1 is the answer. It lists every prerequisite for "a task
can run and merge", shows which are met, and links each row into the existing surface. The
banners, the AI-provider dialogs and the health advisories all become rows in it.

## 6. What to keep, and make primary

- The swimlane model. "Needs you", "In progress", "Not started", with per-lane actionable sort,
  is the queue the benchmarks have. It needs to leave the frame and become the home.
- The outcome summary. PR at the top, requirement coverage, tester verdict, captured views,
  recorded checks. This is a better review surface than a bare diff. It should be one click from
  the queue.
- The assistant. Text-first intake is the benchmark pattern. It is the right first control.
- Basic tier and "hide, never disable". The rule is right; the default surface is still too wide
  because the tier hides overrides, not mechanisms.
- The tutorial chain with stated requirements and the contextual nudge. Keep it out of the
  launch modal.
- The decision modal. Minimal, one question, options. The model for every human checkpoint.

## 7. Proposed direction

Three moves, in order. Each is independently valuable.

1. Queue-first home. A routed queue page across services with the lane actions inline, the
   board as a second page, one attention counter, deep links. Resolves F2, F4, part of F9.
2. Sentence-first intake. Title, description, service; the assistant's prompt box as the entry;
   everything else behind "Change how this runs"; type inferred or toggled. Resolves F3, F7 on
   the intake side.
3. One setup surface. A checklist replacing banners, provider dialogs, advisories and the role
   prompt; operator settings move there. Resolves F1, F10, part of F8.

Then a vocabulary diet across the delivery surface (F6) and the settings regrouping (F8).

## 8. Visuals

Six images accompany this report under [`assets/ux-jtbd/`](./assets/ux-jtbd/). They are
deliberately low fidelity: greyscale, no brand, no component styling, so a reader argues about
structure and not about colour or radius, which #2246 owns.

| File                                                                | What it shows                                                                                                                                                  | Supports   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [`a1-annotated-board.png`](./assets/ux-jtbd/a1-annotated-board.png) | Real first-load screenshot with five callouts: banners covering the canvas, two of the four attention counters, unreadable frames, two switchers above the nav | F1, F2     |
| [`a2-annotated-inbox.png`](./assets/ux-jtbd/a2-annotated-inbox.png) | Real inbox screenshot: "Mark read" as the only visible verb on a parked decision, three counters, the fourth banner, the one item that does carry its action   | F4, F2     |
| [`j1-journey.png`](./assets/ux-jtbd/j1-journey.png)                 | Journey map, open the app to merged PR: surfaces and stops per step today (36) against the proposal (9)                                                        | All        |
| [`w1-queue-home.png`](./assets/ux-jtbd/w1-queue-home.png)           | Move 1: queue-first home, three lanes across services, action inline, one counter, sidebar as Work / Platform / Help                                           | F2, F4, F9 |
| [`w2-intake.png`](./assets/ux-jtbd/w2-intake.png)                   | Move 2: sentence-first intake, service and kind, overrides behind one disclosure                                                                               | F3, F7     |
| [`w3-setup.png`](./assets/ux-jtbd/w3-setup.png)                     | Move 3: one setup checklist with status per prerequisite, replacing banners, dialogs, advisories and the role prompt                                           | F1, F10    |

The sequence a practitioner would follow from here: agree the direction on the annotated
before-images and the journey map first; then iterate the wireframes with the maintainer; then,
and only then, a clickable prototype behind the interface-tier seam so it can be tried on a real
board without committing to it.

## 9. Unresolved questions

Answers I would suggest are in brackets.

1. Does the canvas stay the home, or does the product become routed pages with the canvas as one
   of them? #2246 defers this. [Routed pages. The canvas is a planning view, and the daily job
   is a queue.]
2. Is the role prompt worth keeping at all, given two of three roles are the same surface?
   [Remove it from launch. Keep the designer surface as a sidebar switch.]
3. Should Basic tier hide the pipeline picker on intake and use the workspace default?
   [Yes, in both tiers, behind "Change how this runs".]
4. Is a plan-approval checkpoint (approve the Architect's design) an acceptable replacement for
   choosing a pipeline as the everyday human touchpoint? [Yes for Standard and Adaptive; it is
   what Jules and Devin do, and the engine already produces the artifact.]
5. Who sees setup state: everyone, or only people who can act on it? [Only those with the
   permission; others see "This workspace cannot run tasks yet" once, in the queue.]
6. Where should this report live? [As a tracker in `docs/initiatives/` once a first slice is
   agreed, or as a GitHub issue that #2246's macro-layer follow-up links to.]

## 10. Sources

Benchmarks (read 2026-09-20):

- Devin Agent Command Center: https://docs.devin.ai/desktop/agent-command-center and
  https://fast.io/resources/devin-2-0-guide/
- GitHub Copilot agents panel:
  https://github.blog/news-insights/product-news/agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github/
  and https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent
- OpenAI Codex: https://openai.com/index/introducing-codex/ and
  https://zackproser.com/blog/openai-codex-review-2026
- Google Jules: https://www.sinatra.dev/blog/google-jules-review and
  https://www.digitalapplied.com/blog/google-jules-gemini-async-coding-agent-guide
- Cursor Agents Window and Cloud Agents: https://cursor.com/cloud and
  https://effloow.hashnode.dev/cursor-3-review-background-agents-2026
- Factory: https://docs.factory.ai/factory-app/overview and https://factory.ai/product/web
- Linear Method: https://linear.app/method/introduction and
  https://www.figma.com/blog/the-linear-method-opinionated-software/

cat-factory (this repo and website):

- Website: introduction, core concepts, first task tutorial, designing your board, running
  pipelines, choosing a pipeline pages under https://www.catfactory.ai/guide/
- `frontend/app/README.md`: roles, interface modes, agent tiers, tutorials, task swimlanes,
  key UI surfaces
- `frontend/app/app/modular/nav-contributions.spec.ts`: sidebar and palette membership
- `frontend/app/i18n/locales/en.json`: string counts
- `docs/initiatives/ux-papercuts.md`, `ux-qol-pass.md`, `global-search-and-deep-links.md`,
  `mobile-friendly-frontend.md`, `in-app-assistant.md`
- Issue #2246 (SPA consistency tracker) and its "later phase" note on the macro layer
