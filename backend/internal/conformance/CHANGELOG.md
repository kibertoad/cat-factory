# @cat-factory/conformance

## 0.27.1

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1
  - @cat-factory/agents@0.110.6
  - @cat-factory/gates@0.8.71
  - @cat-factory/integrations@0.126.1
  - @cat-factory/orchestration@0.202.1
  - @cat-factory/server@0.214.1

## 0.27.0

### Minor Changes

- cec0c3e: Attach spec-sized requirements documents when creating a task over the public API.

  `/api/v1` had no way to give a run a specification. `description` caps at 2,000 characters because
  it is a task's own framing, echoed into every prompt; the 50,000-character `POST /jobs` brief drives
  inline pipelines that never touch a repository; and the app's own attach-a-document flow is
  session-authed. A headless caller holding a PRD could only paste a truncated version of it into a
  field and hope. `POST /api/v1/services/:serviceId/tasks` now takes an ordered `documents` list, each
  entry either NAMING a page in a connected document source (imported and attached, as `ticket`
  already does for a tracker issue) or CARRYING the text itself. The full body reaches agents exactly
  as a document a human attached does: materialised under `.cat-context/` for a container agent,
  folded into the prompt for an inline one.

  Carrying the text needed a document with no source behind it, so `DocumentOrigin` (`DocumentSourceKind`
  plus `upload`) is now what a stored row and its block/role links are keyed by, while everything a
  provider does stays typed against the narrow union. That keeps the missing `upload` provider a
  compile error rather than an `undefined` at whichever call site reaches for it first. An uploaded
  document has no origin URL, and every reader now renders that absence as nothing rather than as
  `Title ()` or a bare `Source:` line.

  One fix rode along, found by the cross-runtime assertion for the new origin rather than by
  reasoning: `urlMatchCandidates` used to hand back `['', '/']` for an empty needle, so `getByUrl`
  would match every row whose stored `url` is empty. Nothing produced such a row before uploads, and
  no caller passes an empty URL today, but "a lookup for nothing resolves to an arbitrary uploaded
  document, which the caller then hands an agent as the page a description pointed at" is not a trap
  to leave armed. It now returns null, and the four repositories that call it answer "no match".

  A document is now attached to at most ONE block, enforced where the link is written rather than at
  the new endpoint. `linkedBlockId` is a single column, so attaching a document another task already
  holds MOVED the link instead of copying it: the earlier task silently lost a document it was created
  with, and nothing in its next run reported the absence. That was reachable from the app's own
  picker too, which offers already-attached documents for re-use. `linkToBlock` now refuses with
  `document_already_linked` and the holder's id, the same rule and shape as one-task-per-ticket, with
  translated SPA copy. Two things keep it from wedging anything: a link naming a DELETED block is not
  a holder (so the guard heals rows left by past deletes), and `removeBlock` now detaches a doomed
  block's documents through the removal cascade, so new ones are not made. Only the link goes; the
  document survives its task.

  Attaching a list is one unit of work rather than a loop: `linkManyToBlock` asserts the block once,
  resolves the whole list through a new batched `DocumentRepository.listByRefs` and writes the links
  through a new `linkBlockMany` (both mirrored D1 ⇄ Drizzle, with cross-runtime assertions, plus
  `detachBlocks` for the cascade). The point method in a loop was three round-trips per document, ten
  of which re-read the same block.

  Worth watching in review: the creation is all-or-nothing. Everything refusable (an unconfigured
  source, an unparseable ref, a page the provider will not serve, an upload that renders to no
  readable text, a document another task holds) is refused before the board changes, and an
  attachment that fails after the task exists takes the task back off the board, because a task
  silently missing part of its spec is the failure this whole surface exists to prevent. Two ordering
  details carry that: uploads are written only after the whole list resolves (an import is idempotent
  on its ref, but every upload mints an id, so an eager write would leave one orphan per retry), and
  the rollback detaches by BLOCK rather than by the refs it resolved (a rollback can be running
  because one of those refs belongs to another task, and clearing it by ref would commit the very
  loss the guard just refused). The attach runs before the ticket claim so that rollback can never
  orphan a claimed ticket. Naming `documents` does not work in mothership mode yet, for the same
  reason `ticket` does not: the document write surface is still `pending` on the persistence
  allow-list, which the new `linkBlockMany`/`detachBlocks` join rather than widen.

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0
  - @cat-factory/integrations@0.126.0
  - @cat-factory/orchestration@0.202.0
  - @cat-factory/server@0.214.0
  - @cat-factory/agents@0.110.5
  - @cat-factory/gates@0.8.70
  - @cat-factory/prompt-fragments@0.15.61

## 0.26.0

### Minor Changes

- 8cbf1a7: Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
  headless.

  `GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
  HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
  alerts to. Until now that endpoint could only be registered over the session-authed
  `/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
  human in a browser to switch on the very channel that exists because there is no browser: the
  delivery contract was headless and its enrolment was not.

  The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
  SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
  invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
  accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
  learn the stored one.

  `PUT`'s `url` becomes optional, on both surfaces, so keep-on-omit is uniform across every field
  rather than every field but one. A mandatory re-send made the routine edit (subscribe to a family)
  carry a value the caller never meant to change, and a client re-sending a URL it cached before
  someone else rotated the receiver would silently redirect the workspace's deliveries back to the
  old endpoint while appearing to add a subscription. `url` is still required on the first `PUT`
  against a workspace with nothing registered, refused with `details.reason: "webhook_url_required"`.
  Relaxing a required field is additive, so no live caller changes.

  Additive on `/api/v1` (OpenAPI `info.version` 1.5.0; main took 1.4.0 for its own additive change
  while this branch was open). The four SDK clients gain a `webhook` resource
  (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/integrations@0.125.0
  - @cat-factory/server@0.213.0
  - @cat-factory/agents@0.110.4
  - @cat-factory/gates@0.8.69
  - @cat-factory/kernel@0.234.2
  - @cat-factory/orchestration@0.201.2
  - @cat-factory/prompt-fragments@0.15.60

## 0.25.4

### Patch Changes

- ee6601e: Post a parked requirements review's questions to the ticket for webhook-dispatched runs too.

  A run started by a per-ticket issue-intake schedule recorded no intake origin, so it read back as
  UI-started and the clarification writeback refused it: the review parked, and the person who filed
  the ticket was never told. The answer channel was already open (ticket-comment replies are ungated
  by intake), but the finding ids an answer has to name are only ever rendered by the question
  comment, so a ticket-driven run could park and stay parked with nothing pointing at the cause.

  Such a run now carries `intakeOrigin: 'tracker'`, and the writeback gate asks the classification
  (`isHeadlessIntake`) rather than comparing against the one origin that shipped first.

  The vocabulary also gains `schedule` for cadence fires and the queue-drain push, so `ui` stops
  being a catch-all for "nothing said" and becomes a positive claim that a human is watching in the
  app. Every unattended start path now names itself; only the in-app start takes the default. The
  field must stay optional for that one caller, so the rule is held by a coverage spec that
  classifies each start path rather than by a typecheck.

  `schedule` is classified NOT headless even though it is unattended. A fire works the schedule's
  reused block, and queue-mode intake replace-links each pick onto it, so a question posted there
  loses its reply channel on the next fire. The classification asks whether the run has a stable
  place to hold a conversation, not whether a human was present.

  No change to runs started in the app or through `/api/v1`. The workspace opt-in
  (`writebackQuestionsOnPark`, off by default) and its per-task override still gate every post; their
  copy now says "outside the app" rather than "through the API".

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/orchestration@0.201.1
  - @cat-factory/server@0.212.1
  - @cat-factory/agents@0.110.3
  - @cat-factory/gates@0.8.68
  - @cat-factory/integrations@0.124.1
  - @cat-factory/kernel@0.234.1
  - @cat-factory/prompt-fragments@0.15.59

## 0.25.3

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0
  - @cat-factory/orchestration@0.201.0
  - @cat-factory/server@0.212.0
  - @cat-factory/integrations@0.124.0
  - @cat-factory/agents@0.110.2
  - @cat-factory/gates@0.8.67
  - @cat-factory/prompt-fragments@0.15.58

## 0.25.2

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/server@0.211.0
  - @cat-factory/contracts@0.231.0
  - @cat-factory/orchestration@0.200.0
  - @cat-factory/agents@0.110.1
  - @cat-factory/gates@0.8.66
  - @cat-factory/integrations@0.123.6
  - @cat-factory/prompt-fragments@0.15.57

## 0.25.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0
  - @cat-factory/agents@0.110.0
  - @cat-factory/server@0.210.0
  - @cat-factory/orchestration@0.199.0
  - @cat-factory/integrations@0.123.5
  - @cat-factory/gates@0.8.65
  - @cat-factory/prompt-fragments@0.15.56

## 0.25.0

### Minor Changes

- e7e4404: Reusable operations, slice 2: one descriptor-driven form vocabulary behind both surfaces that have
  one, and a custom task type's collected values are now checked against what it declares.

  An initiative preset and a custom task type had grown the same feature twice, and the task type was
  the poorer copy: four input types against eight, no defaults, no conditional visibility, no shared
  validation, and two near-identical Vue renderers. So a form an org could express as a preset was
  unexpressible as an operation, and nothing but the create form enforced a `required` marker or an
  option list. `contracts/src/form-fields.ts` is now the union both draw on (the field shape, the
  filled-value bag, and the pure visibility / validation / sanitization / prose-rendering rules), with
  each surface declaring only which input types it admits. `password` is excluded for a task type by
  construction rather than by convention: a collected value is folded into prompts, projected onto the
  board snapshot and captured in telemetry, so a secret belongs in the capability-credential store.

  `taskTypeFields.custom` widens from `string | number` to the shared bag (adding booleans and
  multi-select `string[]`), and the prompt fold renders the new shapes through the same renderer the
  form review uses, so a multi-select reads as its option captions rather than its stored enum values.
  Rows are read back through an unvalidated JSON parse, so nothing existing breaks and there is nothing
  to migrate. Two INTERNAL breaks ride along, in the bounds the shared bag carries that the old
  untyped record did not: a bag KEY is now capped at 80 characters and a string VALUE at 2000, so a
  value longer than that (only reachable through a bespoke `formPanel`, since a declared `maxLength`
  cannot exceed the same bound) is refused on the way in.

  `BoardService.addTask` now validates a registered type's bag against its descriptor and freezes only
  the declared, currently-visible answers, so one rule covers the SPA, the internal API and (from the
  public-API slice) a headless caller. An ABSENT bag is checked against an empty one, because a
  required field is unanswered whether the caller sent `custom: {}` or no `custom` key at all: a check
  the caller can opt out of by sending nothing is not a check. **Behaviour change for a deployment
  that registers an operation with required fields**: any path creating such a task without its
  parameters (an initiative item's `spawn`, a script) now gets a 422 where it previously created a
  task whose operation brief was empty. Three cases still deliberately pass through unchecked: a
  built-in type (schema-typed fields, already validated), a type this process does not register (a
  supported row, since task types are node-local by design and degrading data must not brick
  creation), and a descriptor declaring a bespoke `formPanel`, which owns its own bag.

  The richer vocabulary brings new ways for a descriptor to break itself, so boot validation now
  refuses a create form that structurally cannot be filled: a duplicate field key, an optionless
  `select`/`checkbox-group`, or a `showWhen` gating a field on a key the type does not declare (which
  would hide that field forever). Each is fully known from the registration and silent at run time,
  unlike a `defaultFragmentIds` id, which stays a warning because a tenant-tier fragment is invisible
  at boot. Both surfaces are held to that bar by one checker, so an initiative preset's create form is
  validated at boot for the first time (all three facades pass the registry).

  Behaviour change worth reviewing: a custom task type's `select` field renders as a dropdown rather
  than a button row, since it is now the shared renderer, and a form with many options needed that
  anyway. The path-invalid message moved from `initiative.create.pathInvalid` to `common.pathInvalid`,
  carrying each locale's existing translation.

  One unfilled value is now dropped rather than frozen, on both surfaces. Validation short-circuits on
  a value that says nothing, so a `false` on a text field, a blank string or an empty multi-select
  reached the freeze having passed no type check; sanitization now drops them, which stops a
  wrong-typed answer reaching agents as the operation's own brief (`notes: false` rendered as
  `Notes: No`). The one exception is an explicit `false` on a `checkbox`, which is the opt-OUT of a
  default-ON toggle and the one unfilled value that is an answer.

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0
  - @cat-factory/orchestration@0.198.0
  - @cat-factory/agents@0.109.2
  - @cat-factory/gates@0.8.64
  - @cat-factory/integrations@0.123.4
  - @cat-factory/prompt-fragments@0.15.55
  - @cat-factory/server@0.209.1

## 0.24.0

### Minor Changes

- 10e0341: Answer the pre-dispatch input gate over the public API, and stop it judging blocks that carry no
  authored task input.

  The gate is the one park that turns on the shape of the TASK rather than the pipeline, so the
  public surface's park enumeration (which reads the step chain) could not see it: a `write`-scope
  key could start a title-only task on a pipeline that parks nowhere and get a run stopped before
  its first dispatch, with `GET /api/v1/runs/:runId/decisions` reporting `parked: true`, nothing to
  answer, and cancel as the only exit. The verdict is now a parked decision of its own, resolvable
  at `POST /api/v1/runs/:runId/decisions/input-gate/resolve` with the same `recheck` / `proceed`
  choices the app offers, and admission composes it in, so a key that cannot answer the park is
  refused up front with a message naming it. Additive on `/api/v1`: OpenAPI `info.version` 1.2.0,
  and the four SDK clients gain `decisions.resolveInputGate`.

  `not_applicable` now covers any block whose description is not authored task input, which is the
  block LEVEL plus the recurring task type rather than a task-type list alone. A run started against
  a frame, module, epic or initiative ANCHOR reads the entity it stands for, not the caption on the
  card, so judging that caption parked every initiative planning run on a field the flow never fills
  in. A task the platform merely CREATED with a real brief (an initiative-spawned item, a ticket
  import) is deliberately still judged.

  Advisory findings are also visible at last: they were recorded on the run and reported over the
  API while rendering nowhere, which left `advisory` mode with nothing to watch.

- 10e0341: Add the pre-dispatch input gate: a deterministic structural check of a task's own authored fields,
  run before a run's first agent step is dispatched. A task that states nothing an agent could act
  on now parks having spent nothing, where the cheapest refusal previously cost one requirements-
  review call to report an absence a string comparison already knew about.

  Six V1 findings, three of them blocking: no description, a placeholder-only description
  (`TBD`/`n/a`/`fix it`), a `bug` with no reproduction context, and a `review` task naming no pull
  request; a very short description and a `spike` with no success criteria ride as advisories. The
  check never judges quality or infers intent, which is the reviewer's job.

  **Behaviour change on upgrade.** The gate ships ON (`inputGateMode: 'standard'`), so a run
  started against a title-only task parks on a notice instead of dispatching. Every blocking
  finding names an input a model could not have acted on either, so the gate only replaces a call
  that would have reported the same gap. A workspace can turn it down to `advisory` (record the
  findings, never park) or `off` in Workspace settings. Resolve a parked run by fixing the task and
  re-checking (the fix is re-evaluated, not taken on trust) or by proceeding anyway, which records
  an `overridden` verdict that keeps the waived findings on the run.

  Persistence: a new `input_gate_mode` column on `workspace_settings` (D1 migration `0080` and the
  matching Drizzle migration); the verdict itself rides the run's existing `detail` JSON.

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0
  - @cat-factory/orchestration@0.197.0
  - @cat-factory/server@0.209.0
  - @cat-factory/agents@0.109.1
  - @cat-factory/gates@0.8.63
  - @cat-factory/integrations@0.123.3
  - @cat-factory/prompt-fragments@0.15.54

## 0.23.0

### Minor Changes

- fccb1df: Reusable operations, slice 1: a registered custom task type can now carry its whole bundle, and the
  per-case values a user fills reach the agents that act on them.

  A custom task type's collected `taskTypeFields.custom` bag previously reached ZERO prompts: it rode
  the run context and nothing rendered it, so an operation's brief ("expose CRUD for Order", "auth:
  service-to-service") was invisible to every step in the pipeline. The engine now resolves a labelled
  projection once per dispatch (`AgentRunContext.customTaskType`, joined from the registered
  descriptor by kernel's `describeCustomTaskType`) and the agents package renders it as a
  `## Task parameters` section at all three prompt-assembly points, including the prepend a registered
  kind that authors its own user prompt gets.

  The descriptor gains two optional fields: `defaultFragmentIds`, the operation's standing context,
  unioned onto every new task's own fragment selection at creation, and `presentation.category`, the
  picker grouping axis a later slice renders. Boot validation warns (never refuses) on a
  `defaultFragmentIds` entry the code pool cannot resolve, because an account/workspace-tier fragment
  merges per workspace at run time and is invisible at boot.

  Every existing prompt is byte-identical: the projection is absent whenever a block collected no
  custom values, which is every run of a built-in task type. It is also absent for an un-namespaced
  type, so a built-in carrying a stray `custom` bag renders no section: a custom type is namespaced by
  construction, so the raw-id fallback that honestly names a withdrawn operation would otherwise invent
  one. Seeding the standing context STATES a namespaced type this process does not register, since only
  the id set freezes at creation and that task never gains the operation's fragments later.

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0
  - @cat-factory/agents@0.109.0
  - @cat-factory/orchestration@0.196.0
  - @cat-factory/gates@0.8.62
  - @cat-factory/integrations@0.123.2
  - @cat-factory/prompt-fragments@0.15.53
  - @cat-factory/server@0.208.2

## 0.22.3

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/integrations@0.123.1
  - @cat-factory/agents@0.108.3
  - @cat-factory/gates@0.8.61
  - @cat-factory/kernel@0.228.1
  - @cat-factory/orchestration@0.195.3
  - @cat-factory/prompt-fragments@0.15.52
  - @cat-factory/server@0.208.1

## 0.22.2

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0
  - @cat-factory/integrations@0.123.0
  - @cat-factory/server@0.208.0
  - @cat-factory/agents@0.108.2
  - @cat-factory/gates@0.8.60
  - @cat-factory/orchestration@0.195.2
  - @cat-factory/prompt-fragments@0.15.51

## 0.22.1

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0
  - @cat-factory/agents@0.108.1
  - @cat-factory/gates@0.8.59
  - @cat-factory/integrations@0.122.2
  - @cat-factory/orchestration@0.195.1
  - @cat-factory/prompt-fragments@0.15.50
  - @cat-factory/server@0.207.1

## 0.22.0

### Minor Changes

- 889a497: Couple workspace RBAC to the per-class merge rules, and add a sandboxed run mode.

  A merge preset now carries `classRulesByRole` — the per-change-class auto-merge rules narrowed by
  the workspace role the run's initiator held — and `dryRunRoles`, the roles whose runs are forced
  into dry-run mode: the pipeline runs in full and opens its pull request, but nothing merges. A run
  can also request `mode: 'dry_run'` at start. Both settings default empty, so every existing preset
  resolves to exactly its previous behaviour.

  Narrowing is subtractive by construction: a role entry can make a class stricter than the base
  rules but can never widen one, so a role allowlist is reviewable on its own and no preset edit can
  turn one into a privilege grant. A role that authored nothing for a class, and a run with no role to
  pin at all (a schedule fire, a public-API start, auth-disabled dev), both fall through to the base
  rules rather than being treated as a tier.

  The initiator's role and the run's mode are PINNED on the run at admission rather than re-resolved
  at merge time: the merge settles on the durable driver's path, which has no request context to
  resolve a role from, and a preset edited mid-run must not retroactively re-govern a run already in
  flight. The sandbox is enforced at both exits — the auto-merge and the manual merge endpoint, which
  refuses a dry run's PR with a new `dry_run_not_mergeable` conflict reason, since the review card the
  first one raises is itself a merge button.

  Two new `MergeDecision` reasons ship with it, kept apart from the existing ones because each points
  at a different fix: `role_requires_review` (a teammate on a higher tier can merge this PR as it
  stands) and `dry_run` (the scores were never consulted, so no threshold explains this outcome).

  Wire and schema changes: `RiskPolicy` gains two required fields, `ExecutionInstance` gains optional
  `initiatedByRole` and `mode`, and `merge_threshold_presets` gains a `class_rules_by_role` and a
  `dry_run_roles` column on both runtimes (both with empty defaults, so existing rows need no
  backfill).

  Not yet built: the SPA controls for AUTHORING either preset field and for choosing a dry run on the
  start-run button. Both are already writable over `/workspaces/:ws/risk-policies` and the start
  endpoint respectively, so the capability is reachable today through the API.

- 3605630: Finish the in-app-tutorial initiative (now [ADR 0036](backend/docs/adr/0036-in-app-tutorials.md)):
  make the walkthroughs reach the user who needs one, and measure whether they do.

  The catalogue already made every tour REACHABLE; nothing brought one up. Starting any tour saves the
  launch-prompt answer, which is what stops that prompt returning, so after a user's first tour the
  product never mentioned the tutorial again unless they went looking, and the two tours whose windows
  are transient (answer a parked run, review and merge) were the least likely to be found while they
  applied. So: the finish card now hands off to the one walkthrough the user's own last action
  unlocked, and a contextual offer catches a tour's declared requirements flipping from blocked to
  ready. Four new tours ship with it, the first of which closes the biggest hole in the arc: reading a
  FAILED run (the state a first run reaches most often, and the only one that had no walkthrough),
  plus where runs execute, review-by-panel, and the shared-services catalog.

  Progress now follows the USER rather than the browser, through a new per-user `tutorial_progress`
  table on both facades (`remote` in mothership mode, self-scoped). The browser-persisted store stays
  what the SPA reads and stays fully functional with no accounts, no store wired, or offline; the
  server row is a best-effort mirror. Both id lists are grow-only sets, UNIONED on both sides, because
  two browsers signed in as one person each hold a full copy and each write it back: a
  last-writer-wins replace on either side silently drops what the other learned. "Reset progress" is
  therefore a DELETE. Each push carries the whole local state and reconciles the merged row it gets
  back, so a merge that lost a concurrent writer's ids re-pushes instead of waiting for a local change
  that may never come; a merge whose RESULT would exceed `MAX_TUTORIAL_TOUR_IDS` is refused with
  `details.reason: 'tutorial_progress_too_large'` rather than truncated, since the row rides every
  workspace snapshot.

  Three new operational counters (`tutorial.tour_started` / `_completed` / `_abandoned`, dimensioned
  by tour) answer the question the initiative could not answer about itself. They ride the existing
  `OperationalMetrics` port because there is deliberately only one counter seam; the tour dimension is
  bounded twice, by the wire schema's shape rule and by a per-process distinct-value cap that folds
  the rest onto a visible `other` bucket, since a dimension whose values come from a browser is
  otherwise an unbounded-cardinality hole in an operator's metrics backend.

  New internal routes (not `/api/v1`, so no SDK surface): `GET|PUT|DELETE /tutorial/progress` and
  `POST /tutorial/events`, root-mounted beside `/user-settings`. Root-mounted specifically so they sit
  outside the workspace-RBAC viewer write floor, which a read-only viewer taking a walkthrough would
  otherwise trip. The workspace snapshot gains an optional `tutorialProgress`, and `NavGates` gains
  `boardHasFailedRun`; a deployment that builds its own gates object must add that field.

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/orchestration@0.195.0
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0
  - @cat-factory/agents@0.108.0
  - @cat-factory/server@0.207.0
  - @cat-factory/gates@0.8.58
  - @cat-factory/integrations@0.122.1
  - @cat-factory/prompt-fragments@0.15.49

## 0.21.2

### Patch Changes

- Updated dependencies [bbc51fa]
- Updated dependencies [36b1853]
  - @cat-factory/orchestration@0.194.0
  - @cat-factory/integrations@0.122.0
  - @cat-factory/server@0.206.0
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0
  - @cat-factory/agents@0.107.1
  - @cat-factory/gates@0.8.57
  - @cat-factory/prompt-fragments@0.15.48

## 0.21.1

### Patch Changes

- 413095f: Let a model preset choose the ORDER a model's routes are preferred in, instead of one order compiled into the resolver.

  Which route a model takes was a deployment-wide constant, so a workspace could not have both a compliance preset pinned to a residency-guaranteed route (AWS Bedrock, whose selectability landed in the previous slice) and an everyday preset riding a flat-rate subscription. It is a per-WORKLOAD choice, so the knob is the preset row (`ModelPreset.providerPreference`) rather than a new env var, and it needs no migration of behaviour: a preset stating nothing resolves exactly as before.

  **A preference REORDERS, it never filters.** Routes a preset omits are appended in default order and tried last, so naming three routes cannot make a model whose only route is the fourth unresolvable. That is structural rather than a rule to remember: `orderedModelFlavorPreference` returns a total order over every route, which is also why the editor offers no way to REMOVE one. The write boundary refuses a repeated route (an order cannot say two things about one route) but accepts a partial list.

  **The order rides `ProviderCapabilities`, and it reaches a run by two paths because a capability set is resolved at two different times.** The START GUARD resolves one per run, so it now resolves under the block's own preset and walks each model's routes in the order the dispatch will. A DISPATCH has no capability set of its own — the facade's `resolveBlockModel` closes over the boot-time one — so the order arrives on `AgentRunContext.providerPreference`, resolved ONCE by the engine exactly like the prompt override and the output budget, and the facade folds it onto its captured capabilities per call. Folding rather than replacing is the point: which routes EXIST is a deployment fact (keys, the Bedrock allow-list, the Workers AI binding) and only the ORDER is per preset. Both ends read one preset row, so the guard, the container path, the inline path and the consensus panel cannot disagree about which provider a step ran on.

  **Eight inline callers each carried a byte-identical copy of the step precedence**, which is how a fact like this gets forgotten in seven places. The judge, the fork-decision chat, the iterative reviewers (with their brainstorm and clarity subclasses), the doc and initiative interviewers, the tester QC companion, the bug-hunt assessor and the Kaizen grader now share one `resolveInlineBlockModelRef`, and it takes the model and the route order as ONE dependency rather than two wired side by side. Kaizen is why: it resolved through a seam with no route-order parameter, so it would have taken the model half and silently ignored the other — a compliance preset getting its route for every inline call on a block except its grading.

  **The preset row is read on every dispatch, every inline call and every start guard, so it goes through the app cache seam.** `AppCaches.modelPreset` is the merge preset's `riskPolicy` slice one table over: same key shape (`picked:<id>` / `default`), same wrapped null so an unseeded workspace caches as a value, same invalidate-the-workspace-group on every `ModelPresetService` write, same pass-through on the Worker's isolate-safe profile. The model id and the route order are resolved from ONE read of that row (`resolvePresetRouting`), where asking two collaborators for them read it twice.

  **"Equals the default order" is stored as ABSENT, not as a copy of it.** Reordering back to the default clears the preference, so a preset keeps tracking the shipped order as the product changes it instead of pinning today's wording of it — which matters because that order is itself scheduled to change. For the same reason the default order now lives in ONE place, `DEFAULT_MODEL_FLAVOR_ORDER` in contracts: the preset editor renders the same fold the resolver walks, and a copy in the SPA would let the picker display an order the run does not take.

  Compatibility break to expect: none for existing rows (`provider_preference` is nullable and NULL means the default order), but a stored route the build no longer knows is DROPPED at the read boundary rather than named. That is the opposite disposition from a retired binary modality, and deliberate: the value names a route, so once the route is gone there is no current member a human could re-pick it as, and the surviving entries keep their relative order.

  One limit worth stating plainly: "subscriptions always win" is still applied ON TOP of this order, so on a workspace holding a subscription token a preset promoting AWS Bedrock is overruled for every dual-mode model. Folding that override into the order is the next slice; until then the preset editor warns rather than letting the copy promise a route a connected plan takes back.

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0
  - @cat-factory/agents@0.107.0
  - @cat-factory/orchestration@0.193.0
  - @cat-factory/server@0.205.0
  - @cat-factory/gates@0.8.56
  - @cat-factory/integrations@0.121.2
  - @cat-factory/prompt-fragments@0.15.47

## 0.21.0

### Minor Changes

- 04e44f8: Finish the operator-observability initiative: gate/CI-fixer attempt statistics, a daily run
  rollup behind new 30d/90d dashboard windows, per-account alert-threshold settings, and a
  platform-health alert card that deep-links to the runs it aggregated.

  Three new main-store tables ship with it: `gate_outcomes` (one row per polling gate that reaches a
  terminal verdict), `platform_run_days` (the daily rollup, materialised by the retention sweep) and
  `platform_rollup_state` (how far that sweep has covered, which is a fact about the sweep and so
  cannot be derived from the rolled-up rows). The first two are pruned on their own retention
  windows, `GATE_OUTCOME_RETENTION_DAYS` (90) and `PLATFORM_RUN_DAY_RETENTION_DAYS` (400); the third
  is a single forward-only marker row and is not pruned.

  Breaking (pre-1.0, no migration path offered): the `PlatformObservability` wire shape gains
  required `source`, `rolledUpThrough` and `gates` fields, and `platformObservabilityWindowSchema`
  gains `30d` / `90d`. A `platform_health` notification's `platformWindow` narrows to the
  live-scanned windows only. Any stored projection or client pinned to the old shape must be
  re-read rather than migrated.

  Also breaking for a deployment that assembles its own container: `CoreDependencies.gateOutcomeRepository`
  is REQUIRED, like `logger` and `operationalMetrics` and for the same reason. The engine WRITES this
  projection, and an un-wired writer reads downstream as "no gate on this deployment ever escalated",
  which is indistinguishable from a healthy one. A deployment with no such store passes the new
  `noopGateOutcomeRepository`, which says so in code.

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0
  - @cat-factory/orchestration@0.192.0
  - @cat-factory/server@0.204.0
  - @cat-factory/agents@0.106.8
  - @cat-factory/gates@0.8.55
  - @cat-factory/integrations@0.121.1
  - @cat-factory/prompt-fragments@0.15.46

## 0.20.19

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/orchestration@0.191.0
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0
  - @cat-factory/integrations@0.121.0
  - @cat-factory/server@0.203.0
  - @cat-factory/agents@0.106.7
  - @cat-factory/gates@0.8.54
  - @cat-factory/prompt-fragments@0.15.45

## 0.20.18

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/orchestration@0.190.0
  - @cat-factory/server@0.202.0
  - @cat-factory/agents@0.106.6
  - @cat-factory/kernel@0.221.1
  - @cat-factory/gates@0.8.53
  - @cat-factory/integrations@0.120.1
  - @cat-factory/prompt-fragments@0.15.44

## 0.20.17

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/server@0.201.0
  - @cat-factory/orchestration@0.189.0
  - @cat-factory/integrations@0.120.0
  - @cat-factory/kernel@0.221.0
  - @cat-factory/agents@0.106.5
  - @cat-factory/gates@0.8.52
  - @cat-factory/prompt-fragments@0.15.43

## 0.20.16

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/integrations@0.119.0
  - @cat-factory/server@0.200.0
  - @cat-factory/kernel@0.220.0
  - @cat-factory/agents@0.106.4
  - @cat-factory/gates@0.8.51
  - @cat-factory/orchestration@0.188.3
  - @cat-factory/prompt-fragments@0.15.42

## 0.20.15

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0
  - @cat-factory/server@0.199.0
  - @cat-factory/agents@0.106.3
  - @cat-factory/gates@0.8.50
  - @cat-factory/integrations@0.118.1
  - @cat-factory/orchestration@0.188.2
  - @cat-factory/prompt-fragments@0.15.41

## 0.20.14

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0
  - @cat-factory/integrations@0.118.0
  - @cat-factory/server@0.198.0
  - @cat-factory/agents@0.106.2
  - @cat-factory/orchestration@0.188.1
  - @cat-factory/gates@0.8.49
  - @cat-factory/prompt-fragments@0.15.40

## 0.20.13

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0
  - @cat-factory/orchestration@0.188.0
  - @cat-factory/server@0.197.0
  - @cat-factory/agents@0.106.1
  - @cat-factory/gates@0.8.48
  - @cat-factory/integrations@0.117.2
  - @cat-factory/prompt-fragments@0.15.39

## 0.20.12

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0
  - @cat-factory/agents@0.106.0
  - @cat-factory/orchestration@0.187.0
  - @cat-factory/server@0.196.0
  - @cat-factory/gates@0.8.47
  - @cat-factory/integrations@0.117.1
  - @cat-factory/prompt-fragments@0.15.38

## 0.20.11

### Patch Changes

- 54d531d: Count the deployment's operational EVENTS, and let the health alerts see a dead one.

  The platform-observability projection answers "how are the runs doing" by aggregating
  `agent_runs`. It structurally cannot answer what an operator asks during an incident — how often
  container dispatch is failing, whether the sweeper is re-driving more than it was, whether a queue
  is draining — because none of those are rows in a table. A new kernel `OperationalMetrics` port
  counts them, and the OTLP platform exporter ships them as delta sums beside the existing gauges.
  Wired at the sweepers, the container seam, the trace sinks, the notification webhook and every
  app-cache read; `agent_runs` gained a persisted `redrive_count`, so "was this run re-driven three
  times?" is answerable after the process (or the isolate) that did it is gone.

  `platform_health` gained three conditions. The important one is zero-throughput: every existing
  condition divides by runs and goes silent at zero, so a deployment that stopped accepting work
  read identically to a quiet healthy one. Alongside it, a dominant-failure-kind condition (100%
  `evicted` and 100% `agent` produce the same failure rate and need opposite fixes) and one that
  alerts on the sweepers themselves, since a wedged sweeper makes every other signal stale without
  making any of them fire. A sweep pass reports its rate and its failure streak through ONE call
  (`SweepHealthTracker.recordFailure`), and the Worker drives its crons through a `SweepTick` that
  is the facade-symmetric twin of Node's `startSweeper` — so both runtimes cover the same set of
  sweepers, and the tick's counters are flushed after its passes have settled rather than before.

  Also: retention pruning is now isolated per table (one sick table used to abort the whole pass,
  indefinitely, and report zeroes indistinguishable from an empty table); `/ready` round-trips
  pg-boss's own connection instead of trusting a process-local boolean, and the Worker gained a
  bindings-probing `/ready`; and every pg-boss queue is created with a dead-letter sibling whose
  depth rides the `queue.depth` gauge under `state: dead_letter`, with an hourly sweep logging the
  source queue to go and look at.

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0
  - @cat-factory/agents@0.105.0
  - @cat-factory/orchestration@0.186.0
  - @cat-factory/server@0.195.0
  - @cat-factory/integrations@0.117.0
  - @cat-factory/gates@0.8.46
  - @cat-factory/prompt-fragments@0.15.37

## 0.20.10

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/server@0.194.0
  - @cat-factory/agents@0.104.3
  - @cat-factory/gates@0.8.45
  - @cat-factory/integrations@0.116.4
  - @cat-factory/kernel@0.214.1
  - @cat-factory/orchestration@0.185.2
  - @cat-factory/prompt-fragments@0.15.36

## 0.20.9

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0
  - @cat-factory/agents@0.104.2
  - @cat-factory/gates@0.8.44
  - @cat-factory/integrations@0.116.3
  - @cat-factory/orchestration@0.185.1
  - @cat-factory/server@0.193.1

## 0.20.8

### Patch Changes

- 70b4339: Serve a mothership-mode node's run telemetry back down from the mothership when its own store holds
  none. Telemetry is local-first, captured on the laptop and pruned there on a short window, with a
  finished run's rows carried up by the ingest sweep — both halves of which are about the WRITE
  direction. What that left was a node rendering two kinds of run blank: one whose local rows had been
  pruned, and (the larger case the plan under-stated) one that was never local at all. A mothership-mode
  SPA shows the whole org's board, so most runs a developer opens were driven by a hosted teammate or
  another laptop, and every one of them showed an empty observability panel, a zero token rollup and no
  web-search log — with nothing anywhere reporting a problem, because that is exactly what a run which
  spent nothing looks like.

  `POST /internal/telemetry/read` is the ingest's dual: a machine-authed, account-scoped endpoint
  serving a CLOSED table of per-method-bounded, run-scoped reads. It is its own endpoint rather than
  allow-listed persistence-RPC methods for ADR 0009's reason plus a sharper one — the persistence
  registry resolves a repository WHOLE, so admitting a telemetry repo's reads there would route its
  hot-path writes over the network, which is the entire thing the local-first bucket exists to prevent.
  `listByExecution` is deliberately absent from the table on all three sinks (no cursor, so it is the
  un-resumable bulk read the bucket forbids); the node drains the paged reads instead, which is what
  the two new kernel port methods are for. An over-cap limit is refused, never clamped, and the
  scope-bound workspace is stamped as the call's first argument rather than trusted from the caller.

  On the laptop the rule is local-wins where local is WHOLE — not merely where it is non-empty. The
  distinction is a third blank-run case: the prune deletes by capture time, so a run straddling the
  cutoff keeps its newer rows and loses its older ones, and the store then answers, with nothing
  looking missing, with a strict subset. A short list is bad and the rollup is worse, because a token
  total that is simply too low carries no hint that it is short. A subset is undetectable after the
  fact, so the prune records it as it happens and that record is what makes a local answer
  authoritative: lists stitch across the two stores on the shared keyset, while counts and the rollup
  come wholly from the mothership, since a partial local aggregate and a complete remote one cannot be
  merged. Capture is not decorated at all. A failed fallback throws rather than degrading back into the
  empty answer it was called to replace — the one hot-path caller already treats a metrics read as
  best-effort, so an outage costs a board counter and never a run, and the aggregate reads carry a
  short round-trip budget precisely because that caller awaits them on the emit path.

  A page inside its row cap can still serialize past the response backstop, so that is treated as
  routine rather than as a fault: the mothership still refuses rather than shortening (a truncated page
  is one the node would treat as complete), but under its own code, and the drain re-asks smaller on
  the same cursor, losing nothing. It terminates because the backstop is derived from the two capture
  ceilings rather than picked — a one-row page can never be refused for size.

  Compatibility break: `LlmCallMetricRepository` and `AgentContextSnapshotRepository` each gain a
  required `listRunPage` method, so an out-of-tree implementation of either port must add it. The local
  telemetry store gains a `telemetry_pruned_runs` table, created on open; an existing store simply
  starts recording from its next prune, and until then reports itself complete, which is the same
  answer it gave before.

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0
  - @cat-factory/orchestration@0.185.0
  - @cat-factory/server@0.193.0
  - @cat-factory/agents@0.104.1
  - @cat-factory/gates@0.8.43
  - @cat-factory/integrations@0.116.2

## 0.20.7

### Patch Changes

- f31c644: Serve the foundational-service catalog's `builtin` tier over the mothership machine API. A
  mothership deployment is two processes, so a code-registered estate had to be registered on both
  entry points and the copies matched only while both ran the same build — with a local node one
  build behind being the normal case, and the skew silent (a run's catalog simply omits a service,
  which reads like an Architect judging it irrelevant).

  The tier is now read through the kernel `FoundationalBuiltinSource` port: the in-process registry by
  default, `GET /internal/foundational-services` (+ the batched
  `POST /internal/foundational-services/contracts`) on a mothership-mode node, which no longer consults
  its own registry and warns at boot naming any ids it ignores. The remote read throws rather than
  answering with an empty tier — on the 404 from a mothership older than the node, and on a 200 whose
  payload it cannot read — and the injected context files STATE that outage rather than being omitted
  (`FoundationalCatalogRead` / `FoundationalIndexRead` gain an `unavailable` variant), so a best-effort
  dispatch cannot turn the throw back into "no shared services are registered".

  Compatibility break (pre-1.0, no shim): `FoundationalServiceCatalogService` takes `builtins`
  (a `FoundationalBuiltinSource`) in place of `registry`; wrap a registry with
  `registryBuiltinSource(registry)`. `CoreDependencies.foundationalServiceRegistry` and the facade
  options are unchanged.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/agents@0.104.0
  - @cat-factory/orchestration@0.184.0
  - @cat-factory/server@0.192.0
  - @cat-factory/integrations@0.116.1
  - @cat-factory/contracts@0.210.1
  - @cat-factory/gates@0.8.42
  - @cat-factory/prompt-fragments@0.15.35

## 0.20.6

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0
  - @cat-factory/agents@0.103.0
  - @cat-factory/integrations@0.116.0
  - @cat-factory/server@0.191.2
  - @cat-factory/gates@0.8.41
  - @cat-factory/orchestration@0.183.1

## 0.20.5

### Patch Changes

- Updated dependencies [be7135c]
  - @cat-factory/server@0.191.1

## 0.20.4

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0
  - @cat-factory/integrations@0.115.0
  - @cat-factory/orchestration@0.183.0
  - @cat-factory/server@0.191.0
  - @cat-factory/agents@0.102.0
  - @cat-factory/gates@0.8.40
  - @cat-factory/prompt-fragments@0.15.34

## 0.20.3

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0
  - @cat-factory/agents@0.101.0
  - @cat-factory/gates@0.8.39
  - @cat-factory/integrations@0.114.4
  - @cat-factory/orchestration@0.182.2
  - @cat-factory/prompt-fragments@0.15.33
  - @cat-factory/server@0.190.3

## 0.20.2

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0
  - @cat-factory/agents@0.100.0
  - @cat-factory/gates@0.8.38
  - @cat-factory/integrations@0.114.3
  - @cat-factory/orchestration@0.182.1
  - @cat-factory/prompt-fragments@0.15.32
  - @cat-factory/server@0.190.2

## 0.20.1

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0
  - @cat-factory/agents@0.99.0
  - @cat-factory/orchestration@0.182.0
  - @cat-factory/gates@0.8.37
  - @cat-factory/integrations@0.114.2
  - @cat-factory/prompt-fragments@0.15.31
  - @cat-factory/server@0.190.1

## 0.20.0

### Minor Changes

- 8fbc0b5: Serve the repo-sourced Claude Skills library (ADR 0024) over the mothership-mode persistence RPC —
  catalog reads and the repo-sync surface alike — so a local node with no main database can list,
  sync and RUN a skill.

  This was not a blank panel. `skillResolver` is a hard dependency for a `skill` step (and for the
  declared `{ catalogSkillId }` capabilities of ADR 0029), so an un-routed skill catalog failed the
  dispatch, and it failed partially: a skill with no sibling resources resolved from the catalog
  alone while one with resources threw out of the resource fetch, so the feature read as wired. The
  sync half went remote too — unlike the prompt-fragment library, whose sync stays mothership-owned
  because "a mothership node has no GitHub client", a mothership node now reaches GitHub by token
  delegation, so its skill link/sync/unlink routes were live and broken rather than absent.

  Adds a `skillSource` scope rule: the sync methods carry a source id and nothing else, so nothing
  positional binds them; it resolves the source's owning account server-side (memoised, sharing its
  read with the dispatched call). The global `skillSourceRepository.listByRepo` — the push-webhook
  reverse lookup across every account — stays mothership-internal.

  Adds `accountFieldUpsert` alongside it, for a record-keyed write whose conflict key is the record's
  `id` rather than its `accountId`. `accountField` binds only the account a record DECLARES, which is
  sufficient only while the row is stored under that account — an `ON CONFLICT (id) DO UPDATE` that
  does not re-`SET account_id` instead writes whichever row already holds that id, under its own
  account. The new rule binds the stored row too, so a token scoped to one account can no longer name
  another's source id and repoint their link at a repo it controls (whose `SKILL.md` bodies the other
  tenant's next sync would fold into their catalog as agent instructions); an absent row is a create
  and still passes.

  A misconfiguration now also reports itself correctly: the persistence controller's per-request memo
  overrides are applied only for repositories the deployment actually wires, so a mothership without
  the library answers `... is not wired` instead of a scope 404 that reads as a missing row.

  `GitHubInstallationRepository` gains `listActiveForAccount`, the account-scoped form of the cron
  `listActive`. The account-tier installation lookup every repo-sourced library resolves its GitHub
  credential through read EVERY tenant's installations and filtered in JS — unexposable over an
  account-scoped machine API, and unbindable by any scope rule since the method takes no arguments.
  The narrowing ("bound to the account directly, or to one of its own boards") now runs in SQL on
  both runtimes, ordered so they pick the same row, and the resolver makes one query where it made
  two.

  Both ends of a mothership deployment must have the skill/fragment library enabled: the mothership
  reflects the skill repositories into its machine-API registry only when its own library is
  configured, exactly as it does for fragments.

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/agents@0.98.0
  - @cat-factory/server@0.190.0
  - @cat-factory/integrations@0.114.1
  - @cat-factory/orchestration@0.181.1
  - @cat-factory/contracts@0.206.1
  - @cat-factory/gates@0.8.36
  - @cat-factory/prompt-fragments@0.15.30

## 0.19.0

### Minor Changes

- 5511cdc: Finish the foundational-services catalog: it now has a management surface, a way for a board to opt
  out of an inherited service, and push-driven freshness.

  The SPA gains an account-settings tab and an advanced-tier board panel: register a service with its
  uploaded API contracts, link a repo of service definitions (a folder of them, or an explicit file
  list for one named service), and — on a board — review the merged catalog an Architect is actually
  handed, expanding a contract document through the same lazy read a consumer dispatch makes. Opening
  the catalog still transfers no document body.

  A board opts out of an inherited account service through a new suppression sub-resource
  (`POST`/`DELETE /workspaces/:ws/foundational-services/:id/suppression`, plus a
  `GET /workspaces/:ws/foundational-service-suppressions` list read). It is
  deliberately not a delete: deleting removes the board's own registration and its documents, where a
  suppression destroys nothing and is reversible. Suppressing an id the catalog does not carry, or one
  the board registered itself, is refused rather than silently written.

  Repo sources now also refresh on a GitHub push webhook, alongside the periodic sweep — the same
  fan-out the skill library uses, cutting worst-case staleness from the sweep window to seconds. That
  matters more here than for skills: a stale API contract is handed to a coder as the interface to
  write against.

  Breaking: adds a `hardDelete` method to `FoundationalServiceRepository` and a `listByRepo` to
  `FoundationalServiceSourceRepository`, so an out-of-tree implementation of either port must
  implement them; `GitHubWebhookIngest` likewise gains `queueFoundationalResync`.

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0
  - @cat-factory/agents@0.97.0
  - @cat-factory/integrations@0.114.0
  - @cat-factory/orchestration@0.181.0
  - @cat-factory/server@0.189.0
  - @cat-factory/gates@0.8.35
  - @cat-factory/prompt-fragments@0.15.29

## 0.18.0

### Minor Changes

- 1441041: Let a deployment register its own EXTERNAL TOOLS into the sidebar, opened already scoped to the
  workspace through deployment-declared custom metadata fields.

  Two new data-only `registerAppModule` slots, which only mean anything together:

  - **`externalTools`** — a deployment's own web applications (a map editor, an asset pipeline, an
    admin console) in a new "External tools" sidebar section and the command palette. A tool declares
    a RESOLVER, `(context) => url`, not a link: the context carries the acting user, the open
    workspace and that workspace's custom metadata, so clicking lands on the right state rather than
    the tool's front door. That is the whole point — a static bookmark needs no registration.
  - **`workspaceMetadataFields`** — the custom fields the resolver reads. Declared in CODE (so a
    deployment adds, renames and retires them with no migration); the VALUES are per workspace, typed
    in on a new Metadata tab of Workspace settings and persisted in a `metadata` JSON column on the
    workspace settings row, mirrored across D1 and Postgres.

  The worked example is `deploy/frontend`'s `acme:security` module: a `gameId` field, and a map editor
  that opens on that game.

  Four decisions worth knowing when reading this:

  - **A tool that cannot resolve stays LISTED and explains itself on click**, with `missing-metadata`
    (naming the unfilled fields), `unresolved`, `resolver-failed` and `unsafe-url` as four separate
    causes. Hiding it would make an unconfigured workspace look identical to a deployment that never
    registered the tool — and the person reading the sidebar is usually the one who can fix it.
  - **The resolved URL must be `http(s)`.** It reaches `window.open`, so a `javascript:` URL from a
    mis-built resolver would execute in the SPA's own origin; the scheme allow-list is a boundary,
    not hygiene. Values are operator-typed, so a resolver sets them as query parameters or encoded
    path segments and never builds the ORIGIN from one — a value like `evil.com/x?a=` spliced into a
    host resolves to somebody else's site and still passes the allow-list.
  - **Resolution is TOTAL: a resolver that throws costs its own item and nothing else.** Registered
    tools are projected inside the computed the sidebar, the command palette and the board toolbar
    all render from, so an uncaught throw in a deployment's own resolver would blank all three at
    once. It is caught, reported as `resolver-failed` and the cause logged.
  - **The metadata bag is REPLACED wholesale on save, and a cleared field drops its key** rather than
    storing `''` — otherwise "nobody filled this in" and "somebody entered nothing" both resolve to a
    tool URL with an empty parameter. The editor carries any key it does not render back into the
    patch, so a value written under a retired field survives an unrelated save.

  The backend deliberately validates only the SHAPE of the bag (identifier-shaped keys, bounded values
  and entry count), never the field list: the definitions are code-shipped, so a server-side list would
  disagree with the app the moment either side is deployed alone. The key pattern bars a leading `_`,
  which keeps `__proto__` out — but `constructor` and `toString` are legal field keys, so every read of
  the bag goes through `metadataValue` / `toMetadataBag` and an unfilled field named after an
  `Object.prototype` member reads `undefined` rather than an inherited function.

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0
  - @cat-factory/orchestration@0.180.0
  - @cat-factory/agents@0.96.1
  - @cat-factory/gates@0.8.34
  - @cat-factory/integrations@0.113.9
  - @cat-factory/prompt-fragments@0.15.28
  - @cat-factory/server@0.188.1

## 0.17.0

### Minor Changes

- 0b52df7: Add foundational services: a tiered (account ⊕ workspace) catalog of the shared capabilities an
  organisation already runs — file storage, notifications, audit — each with a description and its
  API contracts (OpenAPI 3.x, `@toad-contracts/core` or `@lokalise/api-contract`), supplied either by
  direct upload or by linking files/folders in a git repo that is cached and auto-refreshed on both
  runtimes.

  The Architect is folded the catalog (identity, capability tags and indexed operation names — never a
  document body) and must declare the service ids its design consumes; the Researcher and Coder are
  then handed the full API contracts of exactly those services, plus an explicit statement of anything
  the design named that the catalog does not contain.

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0
  - @cat-factory/agents@0.96.0
  - @cat-factory/orchestration@0.179.0
  - @cat-factory/server@0.188.0
  - @cat-factory/gates@0.8.33
  - @cat-factory/integrations@0.113.8
  - @cat-factory/prompt-fragments@0.15.27

## 0.16.13

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0
  - @cat-factory/server@0.187.0
  - @cat-factory/agents@0.95.1
  - @cat-factory/gates@0.8.32
  - @cat-factory/integrations@0.113.7
  - @cat-factory/orchestration@0.178.1

## 0.16.12

### Patch Changes

- a7aae8a: Finish the `/api/v1` external surface: a workspace usage read, and an outbound run-lifecycle push
  so an integration stops polling.

  `GET /api/v1/usage` (a `read`-scope key) serves the current billing period as ONE resource: the
  METERED budget position the spend safeguard itself acts on — including `exceeded`, which is what
  pauses runs — plus the per-`(billing, vendor, provider, model)` breakdown behind it. Splitting it
  into two endpoints would let a caller render a breakdown against a budget read a period-roll apart.
  It reads through a new `SpendService.periodUsage`, which resolves ONE `periodStart` for both
  aggregates and still issues them concurrently: composing the response from `status()` +
  `usageBreakdown()` would have reintroduced the same skew inside one request, since each derives its
  own period from the clock.
  Rows keep their `billing` discriminator and are never summed for the caller: a `subscription` row's
  `costEstimate` is illustrative (a flat-rate plan bills nothing per token), so adding it to metered
  spend would report money nobody is billed for. Workspace tier only — the account and user budgets
  are cross-workspace, and a workspace-scoped key must never learn a sibling workspace's spend.

  The workspace's ONE registered outbound endpoint now also delivers run-lifecycle events —
  `run.started`, `run.completed`, `run.failed` — beside the notification cards it already carried,
  reaching the transport through a new kernel `RunLifecycleSink` port. This exists because the HAPPY
  path raises no notification at all: a pipeline whose `merger` merges its own PR settles with an
  empty inbox, which is exactly the outcome a CI system wants to hear about. Same row, same sealed
  secret, same SSRF guard, same retry budget: the retry/signature/redirect core moved to a shared
  `signedDelivery.ts` that both families drive, because everything interesting about a delivery is a
  property of the endpoint rather than the payload.

  **Subscribing is opt-in and empty means NONE**, deliberately the opposite of the sibling
  notification `types` filter — an endpoint registered for parked decisions must not silently start
  receiving an event per run — so an existing webhook keeps byte-for-byte its current behaviour until
  someone sets `runEvents`.

  Worth knowing when reviewing: the two edges hook different places on purpose. `run.started` fires
  from `handOffLiveRun`, the one funnel every start path ends with, and is announced LAST — after the
  block is committed and the durable runner has the run — so a slow or black-holing receiver costs the
  announcement and never the run. It is still exactly once, because the claim that precedes the
  hand-off (`insertLiveRunOrConflict`) is what mints a live run, and a start path added later inherits
  it since skipping the funnel would also skip `startRun`. The terminal edges fire from the engine's
  terminal-emit funnel, because a run reaches `done` from four independent sites and a hook at each
  would compile, pass, and drift the day a fifth is added — the cost is that a durable replay can
  re-emit a settled run, so delivery is **at-least-once** with a `<runId>:<event>` dedupe id in the
  body. **Dedupe on that id, not on the body**: a replay re-stamps `sentAt`/`occurredAt`, so two
  deliveries of one transition are not byte-identical even though everything a receiver routes on is.
  That is a considered departure from the platform's atomic-claim rule: unlike a merge or a posted
  review, a repeat here is collapsed by one id comparison, so it does not earn a claim table and the
  sweeper that would come with it.

  `docs/openapi.json` shrinks by ~17k lines in the same change, with no semantic difference beyond
  the new endpoint. The generator copied every component definition into a `$defs` block on each
  schema it inlined, so the whole component set was duplicated across ten operations and every new
  public DTO cost roughly ten times its size in the committed file. Those `$defs` resolved nothing —
  the refs are rewritten into `#/components/schemas` — and generation now asserts that every `$ref`
  names an emitted component, so a DTO that actually needs hoisting fails the build instead of
  shipping a dangling pointer.

  Schema: `notification_webhooks` gains a `run_events` JSON column (D1 migration 0072 ⇄ Drizzle),
  defaulting to `'[]'`. The webhook repository is now read on the run's terminal path, so it is
  allow-listed for mothership mode (`get`/`put`/`delete`, workspace-scoped) — an un-routed method
  there would have surfaced only as a webhook that silently never fires, since both delivery paths
  are best-effort by contract.

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/agents@0.95.0
  - @cat-factory/contracts@0.203.0
  - @cat-factory/orchestration@0.178.0
  - @cat-factory/server@0.186.0
  - @cat-factory/kernel@0.201.1
  - @cat-factory/integrations@0.113.6
  - @cat-factory/gates@0.8.31
  - @cat-factory/prompt-fragments@0.15.26

## 0.16.11

### Patch Changes

- Updated dependencies [16fd126]
  - @cat-factory/orchestration@0.177.1
  - @cat-factory/integrations@0.113.5
  - @cat-factory/server@0.185.2

## 0.16.10

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/orchestration@0.177.0
  - @cat-factory/agents@0.94.0
  - @cat-factory/kernel@0.201.0
  - @cat-factory/server@0.185.1
  - @cat-factory/gates@0.8.30
  - @cat-factory/integrations@0.113.4

## 0.16.9

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0
  - @cat-factory/orchestration@0.176.0
  - @cat-factory/server@0.185.0
  - @cat-factory/agents@0.93.0
  - @cat-factory/gates@0.8.29
  - @cat-factory/integrations@0.113.3
  - @cat-factory/prompt-fragments@0.15.25

## 0.16.8

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0
  - @cat-factory/orchestration@0.175.0
  - @cat-factory/server@0.184.0
  - @cat-factory/agents@0.92.0
  - @cat-factory/gates@0.8.28
  - @cat-factory/integrations@0.113.2
  - @cat-factory/prompt-fragments@0.15.24

## 0.16.7

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/agents@0.91.0
  - @cat-factory/orchestration@0.174.0
  - @cat-factory/contracts@0.200.0
  - @cat-factory/gates@0.8.27
  - @cat-factory/integrations@0.113.1
  - @cat-factory/server@0.183.1
  - @cat-factory/prompt-fragments@0.15.23

## 0.16.6

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/agents@0.90.0
  - @cat-factory/contracts@0.199.0
  - @cat-factory/integrations@0.113.0
  - @cat-factory/kernel@0.197.0
  - @cat-factory/orchestration@0.173.0
  - @cat-factory/server@0.183.0
  - @cat-factory/gates@0.8.26
  - @cat-factory/prompt-fragments@0.15.22

## 0.16.5

### Patch Changes

- Updated dependencies [550a7fe]
  - @cat-factory/server@0.182.0

## 0.16.4

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0
  - @cat-factory/integrations@0.112.0
  - @cat-factory/server@0.181.0
  - @cat-factory/agents@0.89.1
  - @cat-factory/gates@0.8.25
  - @cat-factory/orchestration@0.172.1
  - @cat-factory/prompt-fragments@0.15.21

## 0.16.3

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0
  - @cat-factory/agents@0.89.0
  - @cat-factory/orchestration@0.172.0
  - @cat-factory/server@0.180.0
  - @cat-factory/gates@0.8.24
  - @cat-factory/integrations@0.111.2

## 0.16.2

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/server@0.179.0
  - @cat-factory/agents@0.88.0
  - @cat-factory/kernel@0.194.0
  - @cat-factory/orchestration@0.171.1
  - @cat-factory/gates@0.8.23
  - @cat-factory/integrations@0.111.1

## 0.16.1

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0
  - @cat-factory/integrations@0.111.0
  - @cat-factory/orchestration@0.171.0
  - @cat-factory/agents@0.87.2
  - @cat-factory/gates@0.8.22
  - @cat-factory/prompt-fragments@0.15.20
  - @cat-factory/server@0.178.2

## 0.16.0

### Minor Changes

- 83fd037: Retire built-in pipelines: remove ones that are no longer relevant through the reseed lifecycle

  A built-in pipeline is copied into every workspace at creation, so withdrawing one from the catalog
  in code did nothing for boards that already had it — `reseed` had no definition left to resolve and
  `remove` refused every built-in, leaving an obsolete pipeline in each existing library permanently
  (and still startable). Retirement closes that gap.

  - Kernel gains a tombstone list (`buildRetiredPipelines` in `domain/seed.ts`, exposed as
    `retiredPipelines()`). Retiring a built-in is TWO edits — delete its definition from the builder
    AND name its id in the tombstone list — and they do different jobs: the deletion is what takes the
    pipeline out of `seedPipelines()` (so it stops being seeded into new workspaces, drops out of the
    catalog versions, and stops being reseedable, with no change at any of its call sites), while the
    tombstone is the separate positive assertion that the id used to be ours and is now obsolete, which
    is what reaches a board that already stored it. Doing only the deletion is the silent no-op this
    release fixes; doing only the tombstone is caught by a kernel unit test and a boot check.
  - `PipelineRegistry` gains `retire(id, { replacedBy })` / `retired()` / `mergeRetired()`, so a
    deployment can withdraw its OWN registered pipelines. `register` and `retire` are inverses for an
    id, and a live catalog entry always wins, so the live and retired sets stay disjoint. A deployment
    cannot withdraw a BUILT-IN this way (that would be a route to emptying the curated palette), and
    `validateRegistrations` now raises `retirement_of_live_pipeline` at boot when a `retire()` call
    names a still-live pipeline, rather than leaving the ignored call to be discovered as a cleanup
    that never appeared.
  - `PipelineService.remove` accepts a built-in only while it is retired (a pipeline the catalog still
    ships stays read-only), and the workspace snapshot ships `retiredPipelines` beside
    `pipelineCatalogVersions`.
  - The SPA's pipeline-health advisory grows a "Retired pipelines" section offering a per-row removal,
    naming the replacement when the catalog declares one — resolved from the stored row when the board
    has one and from the catalog otherwise, since the usual retirement is superseded-by-a-newly-shipped
    built-in, which has no row until someone adds it. A retired pipeline is excluded from every reseed
    offer, including the "new built-ins available" list.

  Also fixes an adjacent gap: deleting a pipeline that a recurring schedule still points at is now
  refused with a 409 naming the fix, for custom pipelines as much as retired built-ins. Previously the
  delete succeeded and every subsequent fire of that schedule failed silently. A paused (`enabled:
false`) schedule blocks the delete too — pausing is not detaching, and the breakage would otherwise
  surface when someone re-enabled it. That refusal and the two pre-existing schedule refusals on
  `update` now carry machine-readable `details.reason` codes (`pipeline_schedule_attached` /
  `pipeline_schedule_requires_recurring` / `pipeline_schedule_intake_unconfigured`), so the SPA words
  them in the user's language instead of surfacing the raw English message.

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0
  - @cat-factory/orchestration@0.170.0
  - @cat-factory/agents@0.87.1
  - @cat-factory/gates@0.8.21
  - @cat-factory/integrations@0.110.5
  - @cat-factory/server@0.178.1
  - @cat-factory/prompt-fragments@0.15.19

## 0.15.5

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0
  - @cat-factory/agents@0.87.0
  - @cat-factory/orchestration@0.169.0
  - @cat-factory/server@0.178.0
  - @cat-factory/gates@0.8.20
  - @cat-factory/integrations@0.110.4
  - @cat-factory/prompt-fragments@0.15.18

## 0.15.4

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0
  - @cat-factory/agents@0.86.0
  - @cat-factory/orchestration@0.168.0
  - @cat-factory/server@0.177.0
  - @cat-factory/gates@0.8.19
  - @cat-factory/integrations@0.110.3

## 0.15.3

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0
  - @cat-factory/agents@0.85.0
  - @cat-factory/prompt-fragments@0.15.17
  - @cat-factory/orchestration@0.167.0
  - @cat-factory/server@0.176.0
  - @cat-factory/gates@0.8.18
  - @cat-factory/integrations@0.110.2

## 0.15.2

### Patch Changes

- 85efc27: Review the initiative plan as a document, not a wall of sections.

  #1498 gave the planner's parked gate a board affordance and an approve / request-changes rail in
  the tracker window. This is the other half: what that rail actually reviews.

  The planner emits its plan as JSON and returns a transcript summary ("Initiative plan drafted.")
  as `step.output`, so the gate parked on a **one-line proposal**. Three consequences, none of them
  visible from the rail itself: there was no document to read (the plan was only ever the tracker's
  structured sections beneath the rail), no way to navigate a long plan, no way to say WHICH part
  needed changing — and, worst, "request changes" handed the planner back that sentence as its
  previous proposal, so the re-plan was near-blind.

  The gate now parks on a markdown rendering of the plan (`renderInitiativePlanForReview`). Its
  headings are load-bearing rather than decorative: the reader's outline parser splits the document
  at each one, which is what makes the rest possible. The tracker's rail renders that document with
  an outline to navigate by and GitHub-style click-to-comment on any block, and sends the anchored
  comments with the feedback — so a re-plan is quoted the planner's own text back at it.

  **What gets rendered is the INGESTED plan, and that is the part worth a reviewer's attention.**
  The obvious home for this was the existing `reviewableArtifactOutput` seam, beside the spec doc
  and the blueprint tree. It is the wrong one: that seam renders the agent's RAW result, which is
  sound only while the committed artifact IS that result — true for those two (the harness commits
  the files; the engine only validates them), false for the plan, which the engine derives at
  ingest. A preset's phase template reorders phases and forces checkpoints, its `seedPlan` hook adds
  and drops items (the tech-migration preset caps coverage items and seeds a confidence case), and a
  re-plan carries over items a previous plan already materialised. Rendering the raw draft would
  show the reviewer a document their approval does not govern — and nothing would fail; they would
  simply approve work they were never shown. So the `initiative-planner`'s post-completion resolver
  authors the rendering off the entity it just committed, and publishes it through the new
  `StepResolution.outputIsRendered`. The renderer takes the shape the draft and the entity share,
  and drops nothing it is handed: an item naming a phase the plan never declared gets its own
  section rather than disappearing between the phases.

  Both review tools are the SAME ones the step reader gives the architect's prose, shared rather
  than re-implemented: `useStepProse` for the outline, the new `useProseComments` for the anchoring
  (the per-block half of `useStepApproval`, which now builds on it), and one global `.reader-prose`
  stylesheet. The stylesheet absorbs the near-identical scoped copies the clarity, requirements and
  brainstorm windows each carried, so all five reader surfaces now share one presentation — those
  three pick up small cosmetic changes (the step reader's spacing and its code/blockquote styling)
  in exchange for no longer being able to drift.

  `useStepProse` also gained an explicit `leadAnchorId`. Its scroll-spy walks anchors in document
  order and stops at the first one it cannot measure, so a consumer that renders the document alone
  — this rail — had its active-section highlight silently pinned to the step reader's details card.

  **Behaviour change worth knowing about at review time:** "approve with corrections" is now REFUSED
  for any step whose output is a rendering of an artifact it already produced — the new
  `PipelineStep.outputIsRendered`, which today covers the initiative plan, the spec doc and the
  blueprint tree. `approveStep` answers 422 with `details.reason: 'proposal_not_editable'` and the
  SPA replaces the button with a note. This looks like a removal but is the opposite: those edits
  were already being silently discarded, because the committed artifact is the ingested one and never
  the text typed over its rendering. It only bites a deployment that gates a `spec-writer` or
  `blueprints` step, where the affordance was accepting corrections and dropping them. Requesting
  changes is the route for a correction. The `task-estimator`'s summary deliberately stays editable
  and the resolver now says why: the flag marks an output an edit cannot REACH, and that summary is
  itself what downstream steps read via `priorOutputs`.

  An alternative considered and rejected: routing the planner step to the generic step reader (by
  dropping its `resultView`), which would have delivered the same tools with no new UI at all. It was
  withdrawn once #1498 landed — that PR deliberately makes the tracker the window the park routes to,
  and two review surfaces for one gate is worse than a slightly larger frontend diff.

  One guard is new and worth keeping in mind when touching enum→i18n lookup tables: a key held in a
  `Record<SomeEnum, string>` is invisible to BOTH i18n drift guards (typed message keys and
  `i18n:check` only see a literal `t('a.b.c')`, and the exhaustive `Record` only proves every enum
  member has an entry, never that the entry still names a live key). `test/i18nKeys` resolves such
  values against the base catalog, and the initiative label tables now assert against it.

- 9794c19: Validate a review task's target pull request when the task is created, and surface that pull
  request in the inspector.

  A `review` task carries a reference to an EXISTING pull request, and until now nothing checked it.
  A typo'd number was accepted silently and only surfaced much later as a run that dispatched a
  container, cloned the repo and found nothing to review. Creation now probes the PR through the
  same run-repo seam the review itself uses (`RepoFiles.getPullRequest`, new and optional on the
  `GitHubClient` / `VcsClient` ports, implemented for GitHub and GitLab), so the reference is checked
  against precisely the repository the reviewer will read.

  Only a POSITIVE "no such pull request" refuses — the provider's own 404, which the new port method
  reports as `null` while every other failure throws. An outage, a revoked token or a rate limit
  answers "unknown", not "absent", so those are logged and the task is created: making task creation
  depend on the provider being up would be a worse failure than the one this prevents. Same for
  every unwired case (no VCS connection, a provider that can't read a PR, a reference with no
  resolvable number) — all pass through unchanged.

  One case that looks like validation but is really a correctness fix: a pasted link belonging to a
  DIFFERENT repository is now refused (`review_pr_repo_mismatch`). The reviewer fetches the PR by
  NUMBER from the service's linked repo (ADR 0023 — a cross-repo `prUrl` is not resolved to another
  repo), so such a link previously reviewed whatever PR happened to carry that number on the linked
  repo, with nothing anywhere saying so.

  A confirmed reference is then rewritten to the provider's own URL for that PR, which is what makes
  the second half possible: the block inspector leads a review task's body with an "Under review"
  panel linking the reviewed pull request. That is the task's SUBJECT and it had no affordance at
  all before — only the Execution panel's link to the PR a run PRODUCED, which a review task never
  has. A task created while no VCS was connected keeps just the number, and the panel renders it as
  text rather than pretending to be a link.

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0
  - @cat-factory/orchestration@0.166.0
  - @cat-factory/server@0.175.0
  - @cat-factory/agents@0.84.2
  - @cat-factory/gates@0.8.17
  - @cat-factory/integrations@0.110.1
  - @cat-factory/prompt-fragments@0.15.16

## 0.15.1

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0
  - @cat-factory/integrations@0.110.0
  - @cat-factory/orchestration@0.165.0
  - @cat-factory/server@0.174.0
  - @cat-factory/agents@0.84.1
  - @cat-factory/gates@0.8.16
  - @cat-factory/prompt-fragments@0.15.15

## 0.15.0

### Minor Changes

- e087b40: Let a workspace rewrite any agent's system prompt from the pipeline builder, and switch back
  through every version it has run.

  The store is an append-only revision log per `(workspace, agent kind)` — the highest revision is
  live — so restoring an older prompt appends a copy of it rather than overwriting, and "back to the
  built-in" is itself a recorded revision (a null text) that keeps the workspace tracking the shipped
  prompt as it improves instead of pinning a stale copy. The composite key doubles as the concurrency
  control: a second editor's save collides and is refused as `prompt_revision_conflict` rather than
  silently winning last-write.

  An override replaces the shipped TRACK prompt only. `systemPromptFor` gained an optional `override`
  argument and still layers the engine-enforced surface directives and trait guidance on top, so a
  workspace cannot edit away the read-only guardrail or the answer-in-your-reply rule. Holding that
  takes two mechanisms, because an invariant reaches a shipped prompt by two routes and only one of
  them survives having the track prompt replaced: `restoreShippedInvariants` puts back a rule a
  built-in track prompt carried INLINE (without it, editing any kind whose deliverable is its reply —
  spec-writer, the testers, the reviewers — silently drops the answer-in-your-reply rule and the run
  fails on an empty visible reply), and `BESPOKE_CONTAINER_SYSTEM_PROMPTS` declares `merger` /
  `on-call` as a `{ role, directives }` pair since those two bypass `systemPromptFor` entirely. The
  editor SHOWS the resulting appended text (`AgentPromptDetail.appendedText`, measured from the real
  composition) rather than describing it, so the promise is checkable rather than taken on trust.

  The engine resolves the live revision once per dispatch onto
  `AgentRunContext.systemPromptOverride` and pins it to `PipelineStep.promptRevision`, which Kaizen
  folds into its `(prompt, agent, model)` combo key — an edited prompt is its own combo rather than
  inheriting a verification the shipped one earned.

  New: the `agent_prompt_revisions` table (D1 migration 0068 ⇄ Drizzle), the `AgentPromptRepository`
  kernel port (remote-bucket for mothership mode), `GET|PUT /workspaces/:ws/agent-prompts[/:agentKind]`
  gated on `settings.manage`, and the `prompt_revision_conflict` conflict reason.

  The Sandbox is the other half of this feature and is now wired to it in both directions. A
  workspace's own prompts are projected into the prompt browser as read-only `workspace` versions
  (synthesized per request from the revision log, with the live one marked), so an experiment can
  measure a candidate against the prompt that is actually running rather than only against what the
  product ships — previously the only control on offer, and silently the wrong one on any workspace
  that had edited a kind. And a version can be PROMOTED to the live prompt:
  `POST /agent-prompts/:kind/promote`, deliberately on the prompt controller so it answers to
  `settings.manage` rather than the sandbox's `integrations.manage`.

  Behaviour change worth knowing: a stored sandbox `systemText` is now the BASE (track) prompt, and
  `SandboxRunService` composes the platform's directives on top at run time through the same
  `systemPromptFor` override path production uses. Previously it sent the stored text raw, so it
  graded a prompt that is never what gets sent — tolerable while the sandbox was a closed loop, and
  not tolerable once a graded candidate can become the live prompt. Existing candidates keep their
  text; their grades shift, because they are now measured on the composed prompt.

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0
  - @cat-factory/agents@0.84.0
  - @cat-factory/orchestration@0.164.0
  - @cat-factory/server@0.173.0
  - @cat-factory/gates@0.8.15
  - @cat-factory/integrations@0.109.6
  - @cat-factory/prompt-fragments@0.15.14

## 0.14.9

### Patch Changes

- 0eacaa2: Move private package registries into the Infrastructure window, and stop requiring package scopes.

  The registries a checkout installs from are part of where agent containers RUN, not an optional
  external system a workspace links in, so they are now a tab of the Infrastructure window
  (alongside Agent containers / Test environments / Shared stacks) rather than an Integrations-hub
  row with a modal of its own. The tab still gates on the module's own probe, so an unconfigured
  backend shows no dead tab. `ui.infrastructureTab` is typed against the window's full tab
  vocabulary rather than the two provider-connection kinds, so the non-connection tabs (shared
  stacks, package registries) are reachable by deep link instead of only by opening the window and
  clicking across.

  Package scopes are now OPTIONAL on an entry, and leaving them empty is often the right answer: an
  npmrc scope mapping is all-or-nothing, so routing `@org` to a private registry makes every
  `@org/*` package resolve from it — which breaks an organisation that publishes part of that scope
  publicly. A scope-less entry still emits the registry host's `_authToken` line, which is all a
  checkout needs whenever the ROUTING is already settled elsewhere: the repository commits its own
  `.npmrc` (project config wins over the user config the harness writes), single dependencies carry
  a named-registry prefix (`"@acme/private": "gh:^1.0.0"` — pnpm >= 11.1.0, pnpm/pnpm#11324), or the
  vendor simply IS the default registry, where a scope mapping back to `registry.npmjs.org` was
  always a no-op and only the credential was missing. The form explains this next to the field and
  previews the scopes it parsed, so an empty save reads as deliberate rather than as a field that
  silently swallowed what was typed.

  Compatibility: a scope-less entry needs harness image `1.73.0` or newer. Note the blast radius —
  an older image does not skip the entry, it fails `parseJob`, so EVERY container dispatch in that
  workspace dies (`packageRegistries[i].scopes must be a non-empty array`), not just dependency
  installs. The backend has no signal for what image a pool pins, so this cannot be gated
  server-side: a self-hosted runner pool must be updated before a workspace configures a scope-less
  entry. Deployments on the managed image are carried by the pin bump in this release.

  Also: a package-registries read that fails for any reason OTHER than the module being
  unconfigured now propagates instead of being swallowed, so the panel reports it. Previously a
  `503` (no module) and an unreachable backend both rendered as an empty, silent surface — and with
  the panel behind an availability-gated tab, the second case had no surface at all.

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/orchestration@0.163.1
  - @cat-factory/agents@0.83.1
  - @cat-factory/gates@0.8.14
  - @cat-factory/integrations@0.109.5
  - @cat-factory/kernel@0.185.1
  - @cat-factory/prompt-fragments@0.15.13
  - @cat-factory/server@0.172.2

## 0.14.8

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/orchestration@0.163.0
  - @cat-factory/kernel@0.185.0
  - @cat-factory/agents@0.83.0
  - @cat-factory/server@0.172.1
  - @cat-factory/gates@0.8.13
  - @cat-factory/integrations@0.109.4

## 0.14.7

### Patch Changes

- 8251a99: Give every request and every container job a correlation id.

  Both facades now mount a shared request middleware as their FIRST middleware — ahead of CORS and
  the per-request container build, so a CORS denial and the Worker's misconfiguration fallback are
  covered too. It adopts a bounded, safe `X-Request-Id` from the caller or mints one, echoes it on
  the response, puts it in **every error envelope**, binds `{ requestId, method, path }` on a
  request-scoped child logger, and emits one line per request: `info` on success, `warn` on a 4xx
  (naming the mapped error code), `error` on a 5xx. Previously only unexpected 500s were logged at
  all, so a 4xx spike — a validation regression, an RBAC denial, a conflict loop — left no
  server-side trace and a user report had nothing to join against. `/health` and `/ready` drop to
  `debug` when they succeed, so an orchestrator's probes don't bury the request stream.

  `X-Request-Id` is allow-listed inbound (so a caller that already has an id propagates it rather
  than the backend minting a second one for the same request) and newly EXPOSED outbound, so a
  browser can read it off the response.

  The **misconfiguration fallback backend** is covered on every facade. The Worker inherits the
  middleware because it serves the fallback from inside `createApp`, but Node/local swap in the
  whole `createMisconfiguredApp` — so that app mounts it itself, or the one deployment shape an
  operator is actively debugging is the only one serving requests with no id and no request line.

  Across the workflow↔container seam, `workspaceId` and `executionId` now ride the agent job body
  and the harness binds them onto its per-job logger beside `jobId` — the two halves of a run
  previously shared no id and were stitched only by a job-id naming convention. This covers EVERY
  dispatcher of the `agent` kind, not just the execution path: `ContainerRepoBootstrapper` and
  `ContainerEnvConfigRepairer` hand-build their bodies, and a bootstrap is a first-class agent run
  (same table, same retry surface), so leaving them out would have left their containers' logs
  joinable to nothing. Neither has a separate execution row, so the job id doubles as the run id.

  `ContainerAgentExecutor` gained a bound logger and logs the seam's transitions (dispatched /
  dispatch-failed / poll-failed / running at `debug` / settled). A dispatch OR poll that throws is
  now reported: those are the failure classes nothing downstream can account for, because the job
  either never gets a handle or the transport fault is recorded against no job at all.

  Only the request PATHNAME is ever logged, never the raw URL, and a client-supplied id is refused
  unless it is short and `[\w\-=]+` — both are untrusted text going straight into a log stream, and
  query strings carry the WebSocket `?ticket=` and OAuth `?code=`. An unexpected fault's STACK is
  scrubbed with `redactSecrets` in its own right, not just its message: a stack's first line is
  `Error: <message>` verbatim, so attaching it raw beside the scrubbed `err` would republish
  exactly what the scrub just removed.

- Updated dependencies [8251a99]
  - @cat-factory/server@0.172.0

## 0.14.6

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0
  - @cat-factory/server@0.171.0
  - @cat-factory/agents@0.82.4
  - @cat-factory/orchestration@0.162.0
  - @cat-factory/gates@0.8.12
  - @cat-factory/integrations@0.109.3

## 0.14.5

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0
  - @cat-factory/orchestration@0.161.0
  - @cat-factory/agents@0.82.3
  - @cat-factory/gates@0.8.11
  - @cat-factory/integrations@0.109.2
  - @cat-factory/prompt-fragments@0.15.12
  - @cat-factory/server@0.170.1

## 0.14.4

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0
  - @cat-factory/orchestration@0.160.0
  - @cat-factory/server@0.170.0
  - @cat-factory/agents@0.82.2
  - @cat-factory/gates@0.8.10
  - @cat-factory/integrations@0.109.1
  - @cat-factory/prompt-fragments@0.15.11

## 0.14.3

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0
  - @cat-factory/integrations@0.109.0
  - @cat-factory/server@0.169.0
  - @cat-factory/agents@0.82.1
  - @cat-factory/gates@0.8.9
  - @cat-factory/orchestration@0.159.2
  - @cat-factory/prompt-fragments@0.15.10

## 0.14.2

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0
  - @cat-factory/server@0.168.0
  - @cat-factory/agents@0.82.0
  - @cat-factory/orchestration@0.159.1
  - @cat-factory/gates@0.8.8
  - @cat-factory/integrations@0.108.1

## 0.14.1

### Patch Changes

- Updated dependencies [b75a08a]
- Updated dependencies [56128e2]
- Updated dependencies [3057db1]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0
  - @cat-factory/integrations@0.108.0
  - @cat-factory/orchestration@0.159.0
  - @cat-factory/server@0.167.0
  - @cat-factory/agents@0.81.1
  - @cat-factory/gates@0.8.7
  - @cat-factory/prompt-fragments@0.15.9

## 0.14.0

### Minor Changes

- 9d965c9: Make linking living fragments from GitHub work from a pasted URL end to end, and explain the
  link button whenever it is inert.

  Three field-reported failures on one surface, fixed together:

  - **Pasting a full GitHub URL into the repo picker found nothing** ("no repositories found
    for <url>"): the picker's realtime search feeds the provider's tokenized name search, which a
    URL never matches. Contracts gains a pure `parseRepoWebUrl` (GitHub `tree`/`blob`/`raw` and
    GitLab `/-/` shapes, subgroups included), and `GitHubSyncService.listAvailableRepos` now
    collapses a pasted URL to its `owner/name` slug AND resolves that slug with a direct
    `getRepo` point-read merged ahead of the search results — a reachable repo resolves even when
    the provider's search misses it.
  - **Bulk-import by directory URL**: the Documents tab takes a pasted GitHub file or folder URL,
    resolves the repo by slug (no search dependency), opens the tree browser at that folder, and
    the browser's multi-file mode gains per-file checkboxes plus a select-all row — so a whole
    directory of documents can be checked and linked as living fragments in one action.
  - **"Link as living fragment" disabled with no explanation**: the button now states, beside it,
    exactly what is missing (no source chosen / no repository / no files ticked / empty ref).
  - **Account-tier repo sources failed with "No GitHub installation is available for this
    scope"** even when the repo was browsable: the account-scope resolver matched only
    `installation.accountId`, which is null for a per-workspace PAT connect and a GitHub account
    id for local PAT mode's synthetic rows. The shared `createTierInstallationResolvers`
    (`@cat-factory/agents`, wired by both facades for fragments AND skills) now falls back
    through the account's own boards, via the new `WorkspaceRepository.listByAccount` (D1 ⇄
    Drizzle, conformance-asserted, and proxied in mothership mode under the `account` scope rule).

### Patch Changes

- Updated dependencies [9d965c9]
- Updated dependencies [8a9f311]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0
  - @cat-factory/agents@0.81.0
  - @cat-factory/integrations@0.107.3
  - @cat-factory/server@0.166.2
  - @cat-factory/orchestration@0.158.0
  - @cat-factory/gates@0.8.6
  - @cat-factory/prompt-fragments@0.15.8

## 0.13.1

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0
  - @cat-factory/orchestration@0.157.0
  - @cat-factory/agents@0.80.1
  - @cat-factory/gates@0.8.5
  - @cat-factory/integrations@0.107.2
  - @cat-factory/prompt-fragments@0.15.7
  - @cat-factory/server@0.166.1

## 0.13.0

### Minor Changes

- df48cb0: Close five gaps in the Ralph loop, of which two silently changed what a run actually did.

  A re-run un-looped the step. `retry.logic.resetStep` rebuilds a step from an explicit field list
  and so DROPPED `step.ralph`. Unlike `step.test` — seeded lazily when the tester's report arrives
  — the loop state is needed BEFORE the dispatch: it is what puts the `validation` block on the job
  body. So a retried or restarted ralph run dispatched a plain coding pass, got no verdict back,
  never fired the `ralph-verdict` interceptor, and finished as an ungated one-shot coder. The
  loop-back reset (`StepGraph.resetStepForRerun`) had the mirror-image bug: it preserved the state
  with `attempts` still at the spent budget, so the re-run's first verdict went straight to
  `exhausted`. Both now go through the pure `restartRalphState` — frozen config kept, counters
  zeroed.

  The validation command starved the inactivity watchdog. `JOB_INACTIVITY_MS` (10 min) is tighter
  than the command's own watchdog (15 min), and a harness-spawned command emits no activity of its
  own, so any validation past ten minutes aborted the iteration as a wedge and made the 15-minute
  watchdog unreachable at stock settings. It now heartbeats at 30s like the two sibling harness-run
  phases.

  `runRalphValidation` was a third copy of what `captured-command.ts` exists to prevent, and had
  drifted in both ways that seam guards: it scrubbed secrets AFTER the rolling truncation with no
  margin (a credential straddling the cut lost its `KEY=` prefix and survived redaction as an
  unrecognised partial — on a tail that reaches the step, the notification and the SPA), and it
  published the full 16k in-container capture where both siblings bound the wire tail. It now runs
  through `runCapturedCommand` at a 4k report budget.

  The loop also gains the no-progress early abort the design had deferred: the harness stamps the
  work branch's HEAD onto the verdict, and two consecutive failing iterations against an unchanged
  head end the loop instead of burning the rest of the budget. It fails open on an unknown head (an
  older harness image never trips it) and is reported distinctly from a spent budget, since only one
  of the two is fixed by raising the budget. Finally, the per-iteration attempt log — which rides
  the run `detail` blob re-serialized on every progress write — is capped, with the dropped count
  recorded and surfaced rather than silently truncated.

  Image-affecting: bumps the runner image to 1.67.0.

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/orchestration@0.156.0
  - @cat-factory/contracts@0.183.0
  - @cat-factory/agents@0.80.0
  - @cat-factory/kernel@0.176.0
  - @cat-factory/server@0.166.0
  - @cat-factory/gates@0.8.4
  - @cat-factory/integrations@0.107.1
  - @cat-factory/prompt-fragments@0.15.6

## 0.12.21

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0
  - @cat-factory/agents@0.79.0
  - @cat-factory/integrations@0.107.0
  - @cat-factory/orchestration@0.155.0
  - @cat-factory/server@0.165.0
  - @cat-factory/gates@0.8.3
  - @cat-factory/prompt-fragments@0.15.5

## 0.12.20

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/integrations@0.106.0
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0
  - @cat-factory/server@0.164.0
  - @cat-factory/agents@0.78.0
  - @cat-factory/orchestration@0.154.0
  - @cat-factory/gates@0.8.2
  - @cat-factory/prompt-fragments@0.15.4

## 0.12.19

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/integrations@0.105.0
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0
  - @cat-factory/orchestration@0.153.1
  - @cat-factory/server@0.163.2
  - @cat-factory/agents@0.77.1
  - @cat-factory/gates@0.8.1
  - @cat-factory/prompt-fragments@0.15.3

## 0.12.18

### Patch Changes

- Updated dependencies [a04f609]
  - @cat-factory/agents@0.77.0
  - @cat-factory/orchestration@0.153.0
  - @cat-factory/server@0.163.1

## 0.12.17

### Patch Changes

- Updated dependencies [71ea4ec]
- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/orchestration@0.152.0
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0
  - @cat-factory/agents@0.76.0
  - @cat-factory/integrations@0.104.0
  - @cat-factory/server@0.163.0
  - @cat-factory/gates@0.8.0
  - @cat-factory/prompt-fragments@0.15.2

## 0.12.16

### Patch Changes

- Updated dependencies [3260f2d]
  - @cat-factory/agents@0.75.2
  - @cat-factory/orchestration@0.151.1
  - @cat-factory/server@0.162.1

## 0.12.15

### Patch Changes

- Updated dependencies [15905ab]
- Updated dependencies [9d8fe9b]
  - @cat-factory/agents@0.75.1
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0
  - @cat-factory/orchestration@0.151.0
  - @cat-factory/server@0.162.0
  - @cat-factory/gates@0.7.43
  - @cat-factory/integrations@0.103.3
  - @cat-factory/prompt-fragments@0.15.1

## 0.12.14

### Patch Changes

- Updated dependencies [2ed7b50]
  - @cat-factory/server@0.161.0

## 0.12.13

### Patch Changes

- Updated dependencies [cf2779a]
- Updated dependencies [5e5d409]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/prompt-fragments@0.15.0
  - @cat-factory/agents@0.75.0
  - @cat-factory/server@0.160.0
  - @cat-factory/kernel@0.170.0
  - @cat-factory/orchestration@0.150.1
  - @cat-factory/gates@0.7.42
  - @cat-factory/integrations@0.103.2

## 0.12.12

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0
  - @cat-factory/orchestration@0.150.0
  - @cat-factory/server@0.159.0
  - @cat-factory/agents@0.74.1
  - @cat-factory/gates@0.7.41
  - @cat-factory/integrations@0.103.1
  - @cat-factory/prompt-fragments@0.14.24

## 0.12.11

### Patch Changes

- Updated dependencies [fb71506]
  - @cat-factory/agents@0.74.0
  - @cat-factory/server@0.158.0
  - @cat-factory/orchestration@0.149.2

## 0.12.10

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0
  - @cat-factory/integrations@0.103.0
  - @cat-factory/agents@0.73.2
  - @cat-factory/gates@0.7.40
  - @cat-factory/orchestration@0.149.1
  - @cat-factory/prompt-fragments@0.14.23
  - @cat-factory/server@0.157.3

## 0.12.9

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/orchestration@0.149.0
  - @cat-factory/agents@0.73.1
  - @cat-factory/gates@0.7.39
  - @cat-factory/integrations@0.102.2
  - @cat-factory/kernel@0.167.1
  - @cat-factory/prompt-fragments@0.14.22
  - @cat-factory/server@0.157.2

## 0.12.8

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/agents@0.73.0
  - @cat-factory/kernel@0.167.0
  - @cat-factory/orchestration@0.148.0
  - @cat-factory/server@0.157.1
  - @cat-factory/gates@0.7.38
  - @cat-factory/integrations@0.102.1
  - @cat-factory/prompt-fragments@0.14.21

## 0.12.7

### Patch Changes

- 8afa4ae: Inbound tracker webhooks: push-driven issue intake, and answering a parked requirements review
  from the ticket.

  Two asymmetries in the task-source layer close together, because they share a transport.

  **1. Intake was pull-only.** An issue entered the system when a recurring `bug-intake` schedule
  fired or a human imported it, so intake latency was the schedule interval and every idle poll cost
  a tracker API call. A new receiver — `POST /webhooks/tasks/:source/:workspaceId` — copies the
  GitHub VCS webhook path step for step: verify HMAC over the RAW body before any parse, ack 202
  fast, hand the parsed event to the facade's queue (a Cloudflare Queue on the Worker ⇄ the pg-boss
  `tracker.sync` queue on Node), and fall back to inline handling when neither is bound.

  **2. The question loop was half-duplex.** `postReviewQuestions` already posted a parked review's
  findings onto the linked issue, each with its stable id — but answers could only arrive in-app or
  over `/api/v1/runs/:runId/decisions`, so a reporter who lives in Jira had to switch surfaces.
  Those ids were designed for exactly this reply path; it is now built. This completes slice 2b of
  `docs/initiatives/headless-clarification-loop.md`.

  **A qualifying issue event FIRES the matching schedule; it does not re-implement intake.** The
  tempting shape — "the event names an issue, so import and link it" — forks a second intake path
  that would drift from `BugIntakeService`'s predicate handling, batched dedup, replace-link, pickup
  mark and block seeding. Instead a pure `issueEventMatchesIntake` predicate decides whether the
  event qualifies for a schedule's `issueIntake` config, and a match calls the same `fire` the cron
  sweeper calls. Consequences, all deliberate: the fired run may pick a **different, older** issue
  than the one that triggered it (intake is oldest-first fair queueing — the webhook drains the queue
  promptly, it does not reorder it); overlap protection is inherited, so a burst of deliveries cannot
  start a second run over a parked one; and the trigger is **non-forced**, so an on-demand schedule is
  never webhook-fired and an individual-usage model still refuses — `force` is the human run-now lever
  and a webhook has no human present. The predicate deliberately **fails open** on a field the payload
  omits: a false positive costs one no-op run, a false negative costs silent intake latency.

  **The recurring schedule is unchanged and stays on** as the reconciliation sweep for missed
  deliveries — the same webhook + sweeper duality as GitHub sync + `sweepStuckRuns`. Push is the fast
  path, never the only path.

  **Ticket replies use an explicit grammar, never natural-language guessing:**

  ```
  @cat-factory answer <itemId> <free text to end of line>
  @cat-factory dismiss <itemId>
  @cat-factory proceed | stop | extra-round
  ```

  Only lines whose first token is the trigger are interpreted, so a human can answer and discuss in
  one comment; an `answer` continues onto following lines until the next trigger. A comment with no
  trigger line is ignored entirely. Every mutation routes through the SAME service methods the SPA
  and `PublicDecisionController` call (`RequirementReviewService.replyToItem` / `setItemStatus`, then
  `executionService.requirementsReview.{incorporate,proceed,resolveExceeded}`), so the park's
  CAS/approval-id arbitration and the task's merge-preset knobs apply identically — there is no
  parallel mutation path into the engine. A reply that leaves nothing open auto-incorporates, and the
  issue gets a follow-up comment naming what was applied, what is still outstanding, and what was
  rejected and why.

  **Configuration is per connection and needs no new table.** The webhook secret rides the
  connection's existing sealed credential bag, managed through
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind `integrations.manage`)
  and returned exactly once. `POST` mints or rotates; `PATCH` edits the reply allow-list WITHOUT
  rotating, because tightening that list is what an operator does when a tracker turns out to be more
  public than they thought and answering it with a silently rotated secret would take deliveries down
  until they re-pasted it into the vendor. The workspace rides the URL path because a tracker delivery carries no
  installation id to resolve one from, and scanning every workspace's connections for one whose
  secret verifies would be a deployment-wide N+1 on every unauthenticated POST. **An unconfigured
  secret fails closed** — an empty HMAC key is one an attacker also has.

  Reply text is untrusted third-party input, and on a public repo anyone can write it. Three layers:
  the platform's own comments are refused first — by the vendor bot flag where there is one, and by
  a structural marker check everywhere, since Linear flags no bots and the default allow-list admits
  any author (an acknowledgement that could re-enter its own ingest is an unbounded comment loop, not
  a duplicate: each carries a fresh comment id, so the ingest claim cannot stop it). Then the
  connection's optional `webhookReplyAllow` list — an
  unauthorized reply is dropped **silently**, with no follow-up, because replying would confirm the
  hook exists and hand an attacker an oracle. Reply text becomes `item.reply`, the same field the SPA
  writes, capped and `redactSecrets`-scrubbed before it persists; the grammar has no verb reaching
  outside the review. Everything rendered back crosses kernel's `hostMarkdown` boundary, exactly like
  the PR verification report.

  Idempotency is an atomic claim on a new `tracker_comment_ingests` table
  (`(workspace, source, externalId, commentId)`, D1 ⇄ Drizzle), taken **before** anything is applied
  — every tracker redelivers and every queue retries, so without it one reporter comment would answer
  the same finding twice. It copies the `review_question_posts` design verbatim, including its answer
  to "what if the claimer dies": a `failed` row is re-claimable, `applied` is terminal, and a
  `pending` one is re-claimable once abandoned. A claim that ERRORS propagates rather than being read
  as "already ingested" — the apply is idempotent precisely so the queue can retry it, and swallowing
  the error would drop a reporter's answer while reporting a successful dedup. Both stores are pinned
  by a new cross-runtime parity
  suite, alongside conformance assertions that drive the whole receiver → gateway → service chain on
  each facade.

  Providers own their vendor parsing behind a new optional `TaskSourceProvider.webhook` capability
  (Jira, Linear and GitHub Issues ship one), exactly as VCS providers own theirs; a source without it
  never receives deliveries. Design, decisions and the per-slice checklist:
  `docs/initiatives/tracker-webhook-intake.md`.

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0
  - @cat-factory/integrations@0.102.0
  - @cat-factory/orchestration@0.147.0
  - @cat-factory/server@0.157.0
  - @cat-factory/agents@0.72.3
  - @cat-factory/gates@0.7.37
  - @cat-factory/prompt-fragments@0.14.20

## 0.12.6

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1
  - @cat-factory/server@0.156.2
  - @cat-factory/agents@0.72.2
  - @cat-factory/gates@0.7.36
  - @cat-factory/integrations@0.101.4
  - @cat-factory/orchestration@0.146.2

## 0.12.5

### Patch Changes

- Updated dependencies [323b6cf]
  - @cat-factory/integrations@0.101.3
  - @cat-factory/orchestration@0.146.1
  - @cat-factory/server@0.156.1

## 0.12.4

### Patch Changes

- f0e9bab: Public API (`/api/v1`) Tier 2: a new `GET /jobs` list, and bounded keyset pagination + filters on
  the service-task list.

  - **`GET /api/v1/jobs`** (new, `read`-scoped) lists the workspace's headless initiative jobs,
    newest first, with `?limit=` / `?cursor=` / `?status=` / `?since=`. It closes the gap where an
    integration that lost its stored job ids — a restart, a redeploy — could never re-discover its
    own in-flight runs, since `GET /jobs/:id` needs an id it no longer has. Scoped exactly like the
    single-job read: the `internal`-anchor predicate is applied **in SQL** (a join to the anchor
    block), so an external key can never enumerate the workspace's ordinary board runs.
  - **`GET /api/v1/services/:serviceId/tasks`** gains `?limit=` / `?cursor=` / `?status=`. It was
    previously unbounded: it read the ENTIRE board and filtered the service subtree in JS, so a
    large service returned every task in one response and paid a full board read per request. The
    bound, the subtree and the status filter now all live in SQL.

  **Breaking wire change:** `GET /api/v1/services/:serviceId/tasks` now returns **at most 50 tasks
  per response** (previously: all of them) and carries a new required `nextCursor` field. A caller
  that relied on one response containing every task must now page until `nextCursor` is null.
  `GET /api/v1/jobs`'s default page is 25; both accept `?limit=` up to a hard ceiling of 100.

  Pagination is **keyset, not offset** — an external caller polls, so an offset page shifts under
  concurrent inserts and a row created between two pages either repeats or is skipped and never
  seen again. The cursor is opaque on the wire and carries the `(sortKey, id)` composite, so a burst
  of runs sharing a millisecond pages correctly instead of losing the ties. A malformed cursor is a
  `400 invalid_cursor`, never a silent re-serve of page 1.

  Job ordering is chronological (`created_at DESC`). **Task ordering is by the stable block id, not
  chronological**, and there is deliberately no `since` filter on the task list: the `blocks` table
  carries no creation timestamp, so a time filter would have to be faked. See
  `docs/initiatives/public-api-expansion.md` for what adding one would cost.

  Backed by two new repository port methods — `ExecutionRepository.listInternal` and
  `BlockRepository.listServiceTasks` — implemented on **both** the D1 and Drizzle stores and pinned
  by new cross-runtime conformance assertions, so a store that ordered differently, dropped the
  `internal` join, or mishandled the keyset fails a test rather than silently mis-serving an
  integration. Each resolves its scope in ONE query (the `internal` anchor join; the frame's modules
  as a subquery rather than a bound id list, which D1's 100-parameter ceiling would reject on a
  service with ~96 modules).

  Two adjacent fixes the lists depend on:

  - `ExecutionInstance.createdAt` is now projected from the `agent_runs.created_at` COLUMN instead of
    the run's `detail` JSON, and an insert adopts the instance's own stamp. The two used to be
    separate `clock.now()` calls milliseconds apart, so a keyset cursor minted from the entity named
    a position slightly ahead of the row it pointed at — silently skipping any run inserted in that
    window whenever two starts landed in the same millisecond. The redundant `detail.createdAt` is
    gone (stale copies on existing rows are simply ignored, then dropped on the next write).
  - `BoardService.addTask` now enforces the same containment rule `canReparent` applies on a move: a
    task may only be created under a service frame or a module. A task parented to an `epic` /
    `initiative` grouping node was structurally orphaned — invisible to any reader that resolves a
    service subtree, including this task list.

  The `human-test` / `visual-confirmation` gate step-state schemas moved out of
  `contracts/src/execution.ts` into their own `human-verdict-gates.ts` module (re-exported from the
  package root, so no import path changes): merging `main` pushed `execution.ts` past the file-size
  budget, and the two human-verdict gates are the cohesive seam — they share a `rounds` history and a
  transient `pendingAction` that the polling gates' `GateStepState` does not have.

- Updated dependencies [0f7cba1]
- Updated dependencies [f0e9bab]
  - @cat-factory/orchestration@0.146.0
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0
  - @cat-factory/server@0.156.0
  - @cat-factory/agents@0.72.1
  - @cat-factory/gates@0.7.35
  - @cat-factory/integrations@0.101.2
  - @cat-factory/prompt-fragments@0.14.19

## 0.12.3

### Patch Changes

- Updated dependencies [45fddb6]
  - @cat-factory/orchestration@0.145.1
  - @cat-factory/server@0.155.1

## 0.12.2

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/orchestration@0.145.0
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0
  - @cat-factory/agents@0.72.0
  - @cat-factory/integrations@0.101.1
  - @cat-factory/server@0.155.0
  - @cat-factory/gates@0.7.34
  - @cat-factory/prompt-fragments@0.14.18

## 0.12.1

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/integrations@0.101.0
  - @cat-factory/contracts@0.169.0
  - @cat-factory/server@0.154.0
  - @cat-factory/orchestration@0.144.0
  - @cat-factory/agents@0.71.0
  - @cat-factory/gates@0.7.33
  - @cat-factory/kernel@0.163.1
  - @cat-factory/prompt-fragments@0.14.17

## 0.12.0

### Minor Changes

- 829a905: Add Claude Opus 5 support: the `claude-opus` catalog entry rolls forward from Opus 4.8 to
  Opus 5, with its own spend pricing and an updated OpenRouter recommended slug.

  - `@cat-factory/kernel`: `MODEL_CATALOG`'s `claude-opus` entry now resolves to Anthropic's
    **Claude Opus 5** — subscription ref `anthropic:claude-opus-5` (Claude Code harness, 1M
    context, previously left implicit) and OpenRouter ref `anthropic/claude-opus-5`. This
    mirrors how the entry already tracked the current Opus across 4.6 → 4.7 → 4.8, so a block
    pinned to `claude-opus` picks up Opus 5 with no migration. **Breaking (pre-1.0,
    acceptable):** Opus 4.8 is no longer a curated catalog entry — a workspace that wants it
    specifically reaches it through the dynamic per-workspace OpenRouter catalog.
  - `@cat-factory/kernel`: the built-in `mdp_claude` model preset is renamed to "Claude
    Opus 5" and its catalog `version` bumped to `2`, so existing workspaces get the usual
    reseed advisory for the built-in they still hold under the old name.
  - `@cat-factory/spend`: adds `anthropic:claude-opus-5` and
    `openrouter:anthropic/claude-opus-5` price entries at Opus-tier list price ($5 in / $25
    out per 1M, ~4.6 / 23 EUR). The Opus 4.8 entries are kept so historical spend rows and
    OpenRouter passthroughs still cost correctly.
  - `@cat-factory/app`: "Enable recommended" in the OpenRouter catalog panel now offers
    `anthropic/claude-opus-5` instead of `anthropic/claude-opus-4.8`, matching the curated
    backend refs.
  - `@cat-factory/cli` / `@cat-factory/local-server` / `@cat-factory/orchestration`: picker
    label and doc comments follow the catalog ("Claude Opus 5").
  - `@cat-factory/conformance`: the model-preset suite asserts the new `mdp_claude` catalog
    version.

### Patch Changes

- Updated dependencies [143e6bb]
- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/orchestration@0.143.1
  - @cat-factory/agents@0.70.1
  - @cat-factory/integrations@0.100.2
  - @cat-factory/kernel@0.163.0
  - @cat-factory/server@0.153.1
  - @cat-factory/gates@0.7.32

## 0.11.76

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/orchestration@0.143.0
  - @cat-factory/contracts@0.168.0
  - @cat-factory/agents@0.70.0
  - @cat-factory/kernel@0.162.0
  - @cat-factory/server@0.153.0
  - @cat-factory/gates@0.7.31
  - @cat-factory/integrations@0.100.1
  - @cat-factory/prompt-fragments@0.14.16

## 0.11.75

### Patch Changes

- df9ca7d: Merge track record: reviewer-effort tags, deterministic change-class classification, and
  per-class auto-merge rules on merge presets.

  The merge decision no longer runs purely on the `merger` agent's self-assessment. Every merge
  decision now persists one row in a new `merge_track_records` table (full D1 ⇄ Drizzle parity)
  carrying the run's **change class**, the merger's scores, the outcome (`pending_review` →
  `auto_merged` / `human_merged` / `external_merged` / `rejected`), and a nullable **reviewer-effort
  tag** (`none` / `minor` / `major`). Per-class rollups are single SQL aggregates behind
  `GET /workspaces/:ws/merge-track-records/rollups`.

  - **Classification** is deterministic backend TypeScript over ONE VCS call (`RepoFiles.listChangedFiles`
    → the pure `classifyChangedFiles`), so it needs no harness change or runner-image bump and works
    identically on a GitLab deployment. Classes are risk-ranked (`docs` < `test` < `dependency` <
    `config` < `source` < `schema`) and a mixed diff takes the highest-ranked class present. An
    unreadable diff yields `unknown`, which never matches a per-class rule.
  - **Per-class rules** on a merge preset: `always` auto-merge, `never` auto-merge, or fall back to the
    score ceilings — resolved with `autoMergeEnabled: false` as the master switch a rule can never
    override.
  - **Effort capture** at the existing decision points: `POST /notifications/:id/act` takes an optional
    `reviewEffort` (one-tap confirm-and-tag, preselected from whether the run's PR review recorded
    findings), `POST /workspaces/:ws/merge-track-records/:id/effort` tags out of band, and a PR merged
    directly on the provider is detected from the webhook ingest and nudged with a dismissible
    `merge_tag_request` card. Tagging is never mandatory: an untagged merge records a null tag.
  - Classification and record writes are **best-effort side channels** — a failure in any part of this
    feature can never fail or block a merge.

  A merge decision's record carries the run's **provider-neutral repo identity** (`repoId` +
  `provider`), captured from the run-repo resolution the classification already performs. That is what
  makes a record attributable: external-merge detection can only look a record up by
  `(repoId, prNumber)`, since a webhook delivery knows nothing else about the run.

  **BREAKING (backend API):** `RepoTarget` (`@cat-factory/server`) and `RunRepoContext`
  (`@cat-factory/kernel`) gain a required `repoId` plus an optional `provider`, in the neutral
  `VcsRepoRef` vocabulary. Both are produced in exactly one place each, so a deployment that builds
  its own `ResolveRepoTarget` / `ResolveRunRepoContext` must supply the id; the compiler points at
  every site.

  A contract route whose request body is ALL-optional now mounts the new `optionalJsonBody`
  middleware (`@cat-factory/server`). A declared `requestBodySchema` otherwise makes the transport
  REQUIRE a body — the validator reads `c.req.json()` before the schema is consulted — so a route that
  merely gained an optional field would start rejecting the body-less calls it had always accepted.
  `POST /blocks/:blockId/merge` and `POST /notifications/:id/act` keep working with no body at all.

  **BREAKING (wire shape):** `RiskPolicy` gains a required `classRules` field (a partial map from
  change class to `thresholds` / `always` / `never`). Per the pre-1.0 policy there is no dual-read
  shim: persisted rows take the `'{}'` column default, which resolves to "use the score ceilings" for
  every class — i.e. byte-for-byte the previous behaviour — but any external consumer of the preset
  wire shape must account for the new field. The built-in preset seeds bump to version 4, so existing
  workspaces are offered a reseed. `notificationTypeSchema` also gains `merge_tag_request`, and
  `MergeDecision.reason` gains `class_auto_merge` / `class_requires_review`; both are closed unions a
  consumer may be switching on exhaustively.

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0
  - @cat-factory/orchestration@0.142.0
  - @cat-factory/integrations@0.100.0
  - @cat-factory/server@0.152.0
  - @cat-factory/agents@0.69.10
  - @cat-factory/gates@0.7.30
  - @cat-factory/prompt-fragments@0.14.15

## 0.11.74

### Patch Changes

- 600a8ad: Headless clarification loop: questions out to the linked tracker issue (slice 2a). When a run
  started through `/api/v1` parks its requirements review on open findings, its questions can now
  be posted onto the task's linked GitHub/Jira/Linear issue — each rendered with the stable finding
  id that `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` takes — so the
  clarification reaches whoever requested the work instead of waiting in an inbox nobody headless
  can see.

  Opt-in per workspace via the new `writebackQuestionsOnPark` tracker setting, with the usual
  per-task `trackerQuestionsOnPark` override; both are exposed in the issue-tracker settings panel
  and the task inspector alongside the existing PR-open/PR-merge writeback toggles. Tasks started in
  the app are deliberately unaffected: the echo fires only for runs whose recorded intake origin is
  `public-api`, and their clarification surface remains the in-app review window.

  The post is driven from the durable execution driver, whose steps replay, so it is made idempotent
  by an atomic claim on a new workspace-scoped `review_question_posts` table keyed by
  `(workspace, review, iteration, issue)` — taken before the comment is attempted, so neither a
  replay nor a crash mid-post can double-post onto an issue a human is reading. A failed post is
  recorded with its error and retried on the next replay rather than being swallowed, and a claim
  abandoned by a poster that died mid-post is re-takeable after `REVIEW_QUESTION_POST_CLAIM_TTL_MS`
  so that iteration's questions are not silently lost. The park is committed before the outbound
  call, so a slow or unavailable tracker can never delay the state change that makes the run
  answerable.

  The comment body is model-authored text landing on a host-parsed (often public) surface, so it is
  rendered through the same untrusted-text boundary as the PR verification report — auto-link
  triggers defused so a finding cannot notify a real account or cross-link an unrelated issue, code
  fences balanced, and secrets scrubbed. That boundary moved from `@cat-factory/orchestration` into
  `@cat-factory/kernel` as the `hostMarkdown` namespace to serve both consumers.

  Breaking (pre-1.0, no migration): `TrackerSettings` gains a required `writebackQuestionsOnPark`
  field and `IssueWritebackProvider` gains a required `postReviewQuestions` method, so a deployment
  with its own implementation of either must add them; `ReviewQuestionPostRepository.claim` takes a
  claim window rather than a bare timestamp; and the `commentOnGitHubIssue` writeback seam must now
  THROW when it cannot resolve the target issue instead of returning quietly (returning is the
  seam's promise that the comment landed). New tables/columns are created by the Cloudflare D1
  migration `0062` and the generated Node Drizzle migration.

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0
  - @cat-factory/integrations@0.99.0
  - @cat-factory/orchestration@0.141.0
  - @cat-factory/server@0.151.0
  - @cat-factory/agents@0.69.9
  - @cat-factory/gates@0.7.29
  - @cat-factory/prompt-fragments@0.14.14

## 0.11.73

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/integrations@0.98.0
  - @cat-factory/server@0.150.0
  - @cat-factory/agents@0.69.8
  - @cat-factory/gates@0.7.28
  - @cat-factory/kernel@0.159.1
  - @cat-factory/orchestration@0.140.1
  - @cat-factory/prompt-fragments@0.14.13

## 0.11.72

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0
  - @cat-factory/integrations@0.97.0
  - @cat-factory/orchestration@0.140.0
  - @cat-factory/agents@0.69.7
  - @cat-factory/gates@0.7.27
  - @cat-factory/server@0.149.1

## 0.11.71

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0
  - @cat-factory/integrations@0.96.0
  - @cat-factory/orchestration@0.139.0
  - @cat-factory/server@0.149.0
  - @cat-factory/agents@0.69.6
  - @cat-factory/gates@0.7.26
  - @cat-factory/prompt-fragments@0.14.12

## 0.11.70

### Patch Changes

- 55e0a85: Headless clarification loop over the public API (slice 1). A run started through `/api/v1`
  can now include the requirements-review loop instead of being refused at admission: a new
  `/api/v1/runs/:runId/decisions` surface lists a run's parked human decisions (review findings
  with stable item ids, iteration/cap, the incorporated document; the proposed implementation
  forks) and answers them — reply, dismiss, incorporate, re-review, proceed, resolve-exceeded,
  choose a fork. Every route delegates to the SAME service methods the SPA controllers call, so
  the park's optimistic-concurrency arbitration and the task's merge-preset knobs apply
  identically whichever surface answers first.

  **Breaking:** the public-API scope ladder gains a `decide` rung between `write` and `admin`
  (`read ⊂ write ⊂ decide ⊂ admin`). Answering a parked decision — and starting a headless run
  on a pipeline that can park at all — requires it; a `write` key sees exactly the previous
  behaviour, refusal included. Existing keys keep their stored scope, so a `write` key that
  should now answer decisions must be re-minted as `decide`.

  Also in this slice: `POST /api/v1/jobs/:id/cancel` (an abandoned park can always be cleared,
  so the in-flight cap stays recoverable — there is deliberately no run-killing park timeout);
  a `decision` frame on both public SSE streams, which now stay open across a park; a new
  per-workspace outbound **notification webhook** (`GET|PUT|DELETE
/workspaces/:ws/notification-webhook`) delivered HMAC-signed as a `NotificationChannel`
  alongside in-app and Slack, so a headless caller learns of a park by push rather than
  polling; and `ExecutionInstance.intakeOrigin` (`ui` | `public-api`), recorded so slice 2 can
  push clarification questions to a tracker issue for headless-origin runs only. A UI-started
  task's behaviour is unchanged throughout.

  The webhook endpoint is held to the same SSRF guard as the other operator-supplied-URL
  integrations, at both boundaries: registration rejects a private/internal/cloud-metadata host,
  and delivery goes through the shared `safeFetch` so the guard re-runs on every redirect hop
  (a public endpoint cannot 302 the signed body at an internal target). Two new optional env
  vars, `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`, widen
  it for a receiver on an internal host or a developer's `localhost`; they are scoped to
  webhooks alone, so they never widen the runner-pool or environment guard. One delivery is
  bounded by a total wall-clock budget rather than an attempt count, because the notification
  fan-out is awaited by the engine step that raises it. The webhook counts as an EXTERNAL
  notification channel, so under mothership mode the mothership — which holds the key its
  signing secret is sealed with — is the side that delivers it.

  Also exported: `assertSafePublicUrl`, the provider-neutral URL guard now shared by the
  environment, runner-pool and notification-webhook integrations (previously an
  environment-labelled private function), so an SSRF bypass is fixed in one place for all of
  them.

  See `docs/initiatives/headless-clarification-loop.md`.

- Updated dependencies [ddcdcd8]
- Updated dependencies [55e0a85]
  - @cat-factory/orchestration@0.138.0
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0
  - @cat-factory/integrations@0.95.0
  - @cat-factory/server@0.148.0
  - @cat-factory/agents@0.69.5
  - @cat-factory/gates@0.7.25
  - @cat-factory/prompt-fragments@0.14.11

## 0.11.69

### Patch Changes

- ecd68c5: PR verification report — the ENGINE now maintains a structured verification report on each
  run's pull request, so a reviewer sees captured facts instead of the agent's own "tests pass"
  prose. It carries the `ci` gate's aggregated verdict (per-check-run names/conclusions +
  `ci-fixer` attempt count), the tester step's structured report, the `deployer` step's
  ephemeral-environment lifecycle (per-frame outcomes + teardown state), the `merger`'s scored
  assessment and the engine's resolved merge decision, run metadata (task, linked tracker issues,
  repo/provider, pipeline, per-step agent kind + resolved model), and a deep link into the run's
  observability panel — as human-readable markdown plus a fenced JSON block validated by the new
  `prVerificationReportSchema`.

  It is written as a marker-delimited region of the PR description and updated **idempotently in
  place**, so a retry or re-run rewrites it instead of appending a second copy, and the agent's own
  description is preserved. Composition happens as each step settles (an engine hook, not a new
  pipeline step), so a run that fails or parks part-way still leaves its evidence on the PR, and a
  section whose producing step didn't run says so explicitly rather than silently vanishing.

  Everything the report interpolates is agent- or human-authored, and a pull-request description is
  a PARSED, potentially PUBLIC surface, so the text boundary is explicit: every free-text field is
  scrubbed with the same `redactSecrets` the telemetry store uses, and every interpolation
  neutralises the host's auto-link triggers (`#123` / `@name` / `!123`, and a closing keyword in
  front of an issue URL — which would otherwise CLOSE that issue when the PR merges), folds
  newlines inside table cells, and balances any code fence the agent left open so the fenced JSON
  block stays extractable. Lists are capped, and what was capped is named in the report's own
  `truncations` log rather than silently shortened.

  New per-workspace setting **`publishPrVerificationReport`** (default on, mirrored D1 ⇄ Drizzle
  with a migration on both runtimes): a workspace that would rather keep its CI verdicts, test
  outcomes and environment URLs off the pull request can decline. Turning it off stops future
  writes; a report already on a PR is left as it is.

  Provider-neutral: it publishes through the facade's ENGINE VCS client, so a GitLab deployment
  gets the report on its merge-request description too. **Breaking for port implementors:**
  `GitHubClient` and `VcsClient` gain a required `getPullRequestBody` method (the read half of the
  read-splice-write upsert), and `PrVerificationReportPublisher` gains a required `resolveTarget`
  (the engine states the repo/provider the ADAPTER resolved, never the run's last dispatch — which
  on a multi-repo task is a peer repo, not the repo whose PR is being written to). Wiring is per facade (Worker ⇄ Node/local) alongside the existing
  merge/mergeability providers; with no VCS client wired the engine behaves exactly as before.
  The SPA gains a narrow boot-time deep-link replay (`?ws=…&block=…&run=…&view=observability`) so
  the report's observability link resolves.

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0
  - @cat-factory/orchestration@0.137.0
  - @cat-factory/server@0.147.0
  - @cat-factory/agents@0.69.4
  - @cat-factory/gates@0.7.24
  - @cat-factory/integrations@0.94.1
  - @cat-factory/prompt-fragments@0.14.10

## 0.11.68

### Patch Changes

- Updated dependencies [16c98f3]
  - @cat-factory/server@0.146.0

## 0.11.67

### Patch Changes

- Updated dependencies [1ffa4fe]
  - @cat-factory/orchestration@0.136.1
  - @cat-factory/server@0.145.1

## 0.11.66

### Patch Changes

- 7c6bd77: Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
  deployment can now connect a workspace to GitLab by pasting a personal access token: the
  token is validated against the account's identity, sealed at rest (a new `access_token`
  column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
  are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
  `ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
  by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
  workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
  (503 until GitLab connect is wired). The connect UI is a follow-up slice.
- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0
  - @cat-factory/integrations@0.94.0
  - @cat-factory/server@0.145.0
  - @cat-factory/orchestration@0.136.0
  - @cat-factory/agents@0.69.3
  - @cat-factory/gates@0.7.23
  - @cat-factory/prompt-fragments@0.14.9

## 0.11.65

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [696da88]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/server@0.144.6
  - @cat-factory/gates@0.7.22
  - @cat-factory/integrations@0.93.0
  - @cat-factory/agents@0.69.2
  - @cat-factory/contracts@0.160.1
  - @cat-factory/orchestration@0.135.5
  - @cat-factory/prompt-fragments@0.14.8

## 0.11.64

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/agents@0.69.1
  - @cat-factory/integrations@0.92.1
  - @cat-factory/kernel@0.154.1
  - @cat-factory/orchestration@0.135.4
  - @cat-factory/server@0.144.5
  - @cat-factory/gates@0.7.21

## 0.11.63

### Patch Changes

- Updated dependencies [ad4c999]
  - @cat-factory/server@0.144.4

## 0.11.62

### Patch Changes

- Updated dependencies [4ceb622]
  - @cat-factory/orchestration@0.135.3
  - @cat-factory/server@0.144.3

## 0.11.61

### Patch Changes

- Updated dependencies [45f21eb]
  - @cat-factory/orchestration@0.135.2
  - @cat-factory/server@0.144.2

## 0.11.60

### Patch Changes

- Updated dependencies [ce1ce11]
  - @cat-factory/agents@0.69.0
  - @cat-factory/server@0.144.1
  - @cat-factory/orchestration@0.135.1

## 0.11.59

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/orchestration@0.135.0
  - @cat-factory/integrations@0.92.0
  - @cat-factory/server@0.144.0
  - @cat-factory/agents@0.68.4
  - @cat-factory/gates@0.7.20
  - @cat-factory/prompt-fragments@0.14.7

## 0.11.58

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/orchestration@0.134.0
  - @cat-factory/agents@0.68.3
  - @cat-factory/gates@0.7.19
  - @cat-factory/integrations@0.91.2
  - @cat-factory/prompt-fragments@0.14.6
  - @cat-factory/server@0.143.2

## 0.11.57

### Patch Changes

- Updated dependencies [8254367]
  - @cat-factory/orchestration@0.133.2
  - @cat-factory/integrations@0.91.1
  - @cat-factory/server@0.143.1
  - @cat-factory/agents@0.68.2

## 0.11.56

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/integrations@0.91.0
  - @cat-factory/server@0.143.0
  - @cat-factory/agents@0.68.1
  - @cat-factory/gates@0.7.18
  - @cat-factory/orchestration@0.133.1
  - @cat-factory/prompt-fragments@0.14.5

## 0.11.55

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0
  - @cat-factory/orchestration@0.133.0
  - @cat-factory/server@0.142.0
  - @cat-factory/integrations@0.90.0
  - @cat-factory/prompt-fragments@0.14.4
  - @cat-factory/gates@0.7.17

## 0.11.54

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/agents@0.67.9
  - @cat-factory/orchestration@0.132.3
  - @cat-factory/server@0.141.3

## 0.11.53

### Patch Changes

- Updated dependencies [2cfae1e]
  - @cat-factory/server@0.141.2
  - @cat-factory/orchestration@0.132.2
  - @cat-factory/agents@0.67.8

## 0.11.52

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/integrations@0.89.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7
  - @cat-factory/gates@0.7.16
  - @cat-factory/orchestration@0.132.1
  - @cat-factory/prompt-fragments@0.14.3
  - @cat-factory/server@0.141.1

## 0.11.51

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/orchestration@0.132.0
  - @cat-factory/server@0.141.0
  - @cat-factory/agents@0.67.6
  - @cat-factory/gates@0.7.15
  - @cat-factory/integrations@0.88.18
  - @cat-factory/prompt-fragments@0.14.2

## 0.11.50

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/server@0.140.7
  - @cat-factory/agents@0.67.5
  - @cat-factory/gates@0.7.14
  - @cat-factory/integrations@0.88.17
  - @cat-factory/orchestration@0.131.7

## 0.11.49

### Patch Changes

- Updated dependencies [e86e95b]
  - @cat-factory/orchestration@0.131.6
  - @cat-factory/server@0.140.6

## 0.11.48

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/server@0.140.5
  - @cat-factory/orchestration@0.131.5
  - @cat-factory/integrations@0.88.16
  - @cat-factory/agents@0.67.4
  - @cat-factory/gates@0.7.13
  - @cat-factory/prompt-fragments@0.14.1

## 0.11.47

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3
  - @cat-factory/server@0.140.4
  - @cat-factory/gates@0.7.12
  - @cat-factory/integrations@0.88.15
  - @cat-factory/orchestration@0.131.4

## 0.11.46

### Patch Changes

- Updated dependencies [b1d1e2c]
  - @cat-factory/prompt-fragments@0.14.0
  - @cat-factory/orchestration@0.131.3
  - @cat-factory/agents@0.67.2
  - @cat-factory/server@0.140.3

## 0.11.45

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/server@0.140.2
  - @cat-factory/integrations@0.88.14
  - @cat-factory/agents@0.67.1
  - @cat-factory/gates@0.7.11
  - @cat-factory/orchestration@0.131.2
  - @cat-factory/prompt-fragments@0.13.48

## 0.11.44

### Patch Changes

- Updated dependencies [90a0c1b]
  - @cat-factory/orchestration@0.131.1
  - @cat-factory/server@0.140.1

## 0.11.43

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/agents@0.67.0
  - @cat-factory/orchestration@0.131.0
  - @cat-factory/server@0.140.0
  - @cat-factory/gates@0.7.10
  - @cat-factory/integrations@0.88.13
  - @cat-factory/kernel@0.148.1
  - @cat-factory/prompt-fragments@0.13.47

## 0.11.42

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/orchestration@0.130.0
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/server@0.139.0
  - @cat-factory/agents@0.66.7
  - @cat-factory/gates@0.7.9
  - @cat-factory/integrations@0.88.12
  - @cat-factory/prompt-fragments@0.13.46

## 0.11.41

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/server@0.138.16
  - @cat-factory/agents@0.66.6
  - @cat-factory/gates@0.7.8
  - @cat-factory/integrations@0.88.11
  - @cat-factory/orchestration@0.129.11

## 0.11.40

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5
  - @cat-factory/orchestration@0.129.10
  - @cat-factory/server@0.138.15

## 0.11.39

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/server@0.138.14
  - @cat-factory/orchestration@0.129.9
  - @cat-factory/agents@0.66.4
  - @cat-factory/gates@0.7.7
  - @cat-factory/integrations@0.88.10
  - @cat-factory/prompt-fragments@0.13.45

## 0.11.38

### Patch Changes

- Updated dependencies [26f7c18]
  - @cat-factory/server@0.138.13
  - @cat-factory/orchestration@0.129.8
  - @cat-factory/integrations@0.88.9

## 0.11.37

### Patch Changes

- Updated dependencies [e4efb5f]
  - @cat-factory/server@0.138.12
  - @cat-factory/orchestration@0.129.7

## 0.11.36

### Patch Changes

- Updated dependencies [972a1bd]
  - @cat-factory/orchestration@0.129.6
  - @cat-factory/integrations@0.88.8
  - @cat-factory/agents@0.66.3
  - @cat-factory/server@0.138.11

## 0.11.35

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/integrations@0.88.7
  - @cat-factory/agents@0.66.2
  - @cat-factory/gates@0.7.6
  - @cat-factory/orchestration@0.129.5
  - @cat-factory/server@0.138.10

## 0.11.34

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/orchestration@0.129.4
  - @cat-factory/agents@0.66.1
  - @cat-factory/server@0.138.9

## 0.11.33

### Patch Changes

- Updated dependencies [8b6fa53]
  - @cat-factory/orchestration@0.129.3
  - @cat-factory/server@0.138.8

## 0.11.32

### Patch Changes

- Updated dependencies [a10bfdf]
- Updated dependencies [a10bfdf]
  - @cat-factory/server@0.138.7
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0
  - @cat-factory/orchestration@0.129.2
  - @cat-factory/gates@0.7.5
  - @cat-factory/integrations@0.88.6

## 0.11.31

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/orchestration@0.129.1
  - @cat-factory/agents@0.65.5
  - @cat-factory/server@0.138.6

## 0.11.30

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/orchestration@0.129.0
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/server@0.138.5
  - @cat-factory/agents@0.65.4
  - @cat-factory/gates@0.7.4
  - @cat-factory/integrations@0.88.5
  - @cat-factory/prompt-fragments@0.13.44

## 0.11.29

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/orchestration@0.128.0
  - @cat-factory/agents@0.65.3
  - @cat-factory/gates@0.7.3
  - @cat-factory/integrations@0.88.4
  - @cat-factory/kernel@0.145.1
  - @cat-factory/prompt-fragments@0.13.43
  - @cat-factory/server@0.138.4

## 0.11.28

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/orchestration@0.127.0
  - @cat-factory/agents@0.65.2
  - @cat-factory/gates@0.7.2
  - @cat-factory/integrations@0.88.3
  - @cat-factory/prompt-fragments@0.13.42
  - @cat-factory/server@0.138.3

## 0.11.27

### Patch Changes

- Updated dependencies [2138e45]
  - @cat-factory/integrations@0.88.2
  - @cat-factory/orchestration@0.126.1
  - @cat-factory/server@0.138.2

## 0.11.26

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/orchestration@0.126.0
  - @cat-factory/server@0.138.1
  - @cat-factory/agents@0.65.1
  - @cat-factory/gates@0.7.1
  - @cat-factory/integrations@0.88.1
  - @cat-factory/prompt-fragments@0.13.41

## 0.11.25

### Patch Changes

- 0abcf31: Add an authored `description` to pipelines and preview a pipeline's steps + description when
  selecting one.

  Pipelines now carry an optional prose `description` (seeded for every built-in, editable on custom
  pipelines in the builder), persisted alongside the step list on both runtimes (D1 + Postgres). The
  pipeline pickers — in the add-task modal and the inspector run settings — are replaced with a rich
  master–detail picker: hovering an option reveals that pipeline's description and its ordered agent
  steps (with human-gated steps flagged), so you can see exactly what a pipeline does before choosing
  it.

  Every built-in pipeline's catalog `version` is bumped by one so existing workspaces are offered a
  reseed that adopts the new descriptions (fresh workspaces get them on seed).

- Updated dependencies [009bc97]
- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/integrations@0.88.0
  - @cat-factory/server@0.138.0
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/orchestration@0.125.0
  - @cat-factory/agents@0.65.0
  - @cat-factory/gates@0.7.0
  - @cat-factory/prompt-fragments@0.13.40

## 0.11.24

### Patch Changes

- Updated dependencies [4dbf0fc]
  - @cat-factory/orchestration@0.124.2
  - @cat-factory/server@0.137.10

## 0.11.23

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/integrations@0.87.0
  - @cat-factory/agents@0.64.2
  - @cat-factory/gates@0.6.1
  - @cat-factory/orchestration@0.124.1
  - @cat-factory/server@0.137.9

## 0.11.22

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/gates@0.6.0
  - @cat-factory/orchestration@0.124.0
  - @cat-factory/agents@0.64.1
  - @cat-factory/integrations@0.86.6
  - @cat-factory/server@0.137.8

## 0.11.21

### Patch Changes

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0
  - @cat-factory/server@0.137.7
  - @cat-factory/orchestration@0.123.8

## 0.11.20

### Patch Changes

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0
  - @cat-factory/server@0.137.6
  - @cat-factory/orchestration@0.123.7

## 0.11.19

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/integrations@0.86.5
  - @cat-factory/orchestration@0.123.6
  - @cat-factory/server@0.137.5
  - @cat-factory/agents@0.62.13
  - @cat-factory/gates@0.5.58

## 0.11.18

### Patch Changes

- Updated dependencies [edfd2f8]
- Updated dependencies [d675cc5]
  - @cat-factory/orchestration@0.123.5
  - @cat-factory/server@0.137.4

## 0.11.17

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/orchestration@0.123.4
  - @cat-factory/contracts@0.148.1
  - @cat-factory/agents@0.62.12
  - @cat-factory/gates@0.5.57
  - @cat-factory/integrations@0.86.4
  - @cat-factory/server@0.137.3
  - @cat-factory/prompt-fragments@0.13.39

## 0.11.16

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/agents@0.62.11
  - @cat-factory/integrations@0.86.3
  - @cat-factory/kernel@0.139.3
  - @cat-factory/orchestration@0.123.3
  - @cat-factory/server@0.137.2
  - @cat-factory/gates@0.5.56

## 0.11.15

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/orchestration@0.123.2
  - @cat-factory/agents@0.62.10
  - @cat-factory/gates@0.5.55
  - @cat-factory/integrations@0.86.2
  - @cat-factory/kernel@0.139.2
  - @cat-factory/prompt-fragments@0.13.38
  - @cat-factory/server@0.137.1

## 0.11.14

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/server@0.137.0
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/integrations@0.86.1
  - @cat-factory/agents@0.62.9
  - @cat-factory/gates@0.5.54
  - @cat-factory/orchestration@0.123.1
  - @cat-factory/prompt-fragments@0.13.37

## 0.11.13

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/orchestration@0.123.0
  - @cat-factory/integrations@0.86.0
  - @cat-factory/server@0.136.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/gates@0.5.53
  - @cat-factory/prompt-fragments@0.13.36

## 0.11.12

### Patch Changes

- Updated dependencies [60c0a1e]
- Updated dependencies [f444062]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/orchestration@0.122.0
  - @cat-factory/integrations@0.85.4
  - @cat-factory/server@0.135.0
  - @cat-factory/agents@0.62.7
  - @cat-factory/gates@0.5.52
  - @cat-factory/kernel@0.138.1
  - @cat-factory/prompt-fragments@0.13.35

## 0.11.11

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/orchestration@0.121.0
  - @cat-factory/server@0.134.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/gates@0.5.51
  - @cat-factory/integrations@0.85.3
  - @cat-factory/prompt-fragments@0.13.34

## 0.11.10

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/server@0.133.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/gates@0.5.50
  - @cat-factory/integrations@0.85.2
  - @cat-factory/kernel@0.137.1
  - @cat-factory/orchestration@0.120.2
  - @cat-factory/prompt-fragments@0.13.33

## 0.11.9

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/server@0.132.0
  - @cat-factory/agents@0.62.4
  - @cat-factory/integrations@0.85.1
  - @cat-factory/orchestration@0.120.1
  - @cat-factory/gates@0.5.49

## 0.11.8

### Patch Changes

- Updated dependencies [27f0ea2]
  - @cat-factory/orchestration@0.120.0
  - @cat-factory/server@0.131.0

## 0.11.7

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/integrations@0.85.0
  - @cat-factory/server@0.130.0
  - @cat-factory/orchestration@0.119.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/gates@0.5.48
  - @cat-factory/prompt-fragments@0.13.32

## 0.11.6

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/orchestration@0.118.0
  - @cat-factory/agents@0.62.2
  - @cat-factory/gates@0.5.47
  - @cat-factory/integrations@0.84.12
  - @cat-factory/server@0.129.2
  - @cat-factory/prompt-fragments@0.13.31

## 0.11.5

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/server@0.129.1
  - @cat-factory/agents@0.62.1
  - @cat-factory/gates@0.5.46
  - @cat-factory/integrations@0.84.11
  - @cat-factory/kernel@0.134.1
  - @cat-factory/orchestration@0.117.1
  - @cat-factory/prompt-fragments@0.13.30

## 0.11.4

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/orchestration@0.117.0
  - @cat-factory/server@0.129.0
  - @cat-factory/integrations@0.84.10
  - @cat-factory/gates@0.5.45
  - @cat-factory/prompt-fragments@0.13.29

## 0.11.3

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/orchestration@0.116.0
  - @cat-factory/server@0.128.0
  - @cat-factory/agents@0.61.2
  - @cat-factory/gates@0.5.44
  - @cat-factory/integrations@0.84.9
  - @cat-factory/prompt-fragments@0.13.28

## 0.11.2

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/server@0.127.1
  - @cat-factory/agents@0.61.1
  - @cat-factory/gates@0.5.43
  - @cat-factory/integrations@0.84.8
  - @cat-factory/orchestration@0.115.1
  - @cat-factory/prompt-fragments@0.13.27

## 0.11.1

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/agents@0.61.0
  - @cat-factory/orchestration@0.115.0
  - @cat-factory/server@0.127.0
  - @cat-factory/gates@0.5.42
  - @cat-factory/integrations@0.84.7
  - @cat-factory/prompt-fragments@0.13.26

## 0.11.0

### Minor Changes

- 1869ad3: Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
  a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
  by a per-task iteration budget and surviving restarts.

  Each iteration is a fresh-context container-coding run that works the task spec; the harness then
  runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
  reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
  a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
  fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
  migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

  - New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
    (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
  - The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
    gained `text`/`number` control types for them.
  - Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
    and pure-logic unit tests.

  Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
  executor-harness image is bumped for the new in-container validation capability.

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/server@0.126.0
  - @cat-factory/orchestration@0.114.0
  - @cat-factory/gates@0.5.41
  - @cat-factory/integrations@0.84.6
  - @cat-factory/prompt-fragments@0.13.25

## 0.10.134

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/server@0.125.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/gates@0.5.40
  - @cat-factory/integrations@0.84.5
  - @cat-factory/kernel@0.129.2
  - @cat-factory/orchestration@0.113.2
  - @cat-factory/prompt-fragments@0.13.24

## 0.10.133

### Patch Changes

- Updated dependencies [6dc444e]
  - @cat-factory/server@0.124.0

## 0.10.132

### Patch Changes

- Updated dependencies [bd0a42a]
  - @cat-factory/server@0.123.1

## 0.10.131

### Patch Changes

- Updated dependencies [745de02]
- Updated dependencies [6108525]
  - @cat-factory/server@0.123.0
  - @cat-factory/orchestration@0.113.1
  - @cat-factory/kernel@0.129.1
  - @cat-factory/agents@0.59.1
  - @cat-factory/gates@0.5.39
  - @cat-factory/integrations@0.84.4

## 0.10.130

### Patch Changes

- Updated dependencies [1b90387]
  - @cat-factory/server@0.122.0

## 0.10.129

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/orchestration@0.113.0
  - @cat-factory/server@0.121.0
  - @cat-factory/gates@0.5.38
  - @cat-factory/integrations@0.84.3
  - @cat-factory/prompt-fragments@0.13.23

## 0.10.128

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/orchestration@0.112.0
  - @cat-factory/server@0.120.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/gates@0.5.37
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1
  - @cat-factory/prompt-fragments@0.13.22

## 0.10.127

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/server@0.119.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/orchestration@0.111.0
  - @cat-factory/gates@0.5.36
  - @cat-factory/integrations@0.84.1
  - @cat-factory/prompt-fragments@0.13.21

## 0.10.126

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/orchestration@0.110.0
  - @cat-factory/integrations@0.84.0
  - @cat-factory/server@0.118.0
  - @cat-factory/gates@0.5.35
  - @cat-factory/prompt-fragments@0.13.20

## 0.10.125

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/orchestration@0.109.0
  - @cat-factory/server@0.117.0
  - @cat-factory/gates@0.5.34
  - @cat-factory/integrations@0.83.3
  - @cat-factory/prompt-fragments@0.13.19

## 0.10.124

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2
  - @cat-factory/orchestration@0.108.1
  - @cat-factory/server@0.116.1

## 0.10.123

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/orchestration@0.108.0
  - @cat-factory/server@0.116.0
  - @cat-factory/integrations@0.83.1
  - @cat-factory/gates@0.5.33
  - @cat-factory/prompt-fragments@0.13.18

## 0.10.122

### Patch Changes

- Updated dependencies [3f3031a]
  - @cat-factory/orchestration@0.107.10
  - @cat-factory/server@0.115.1

## 0.10.121

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0
  - @cat-factory/server@0.115.0
  - @cat-factory/orchestration@0.107.9

## 0.10.120

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/integrations@0.82.0
  - @cat-factory/server@0.114.0
  - @cat-factory/orchestration@0.107.8
  - @cat-factory/agents@0.54.12
  - @cat-factory/gates@0.5.32

## 0.10.119

### Patch Changes

- Updated dependencies [6c4bcef]
- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20
  - @cat-factory/server@0.113.9
  - @cat-factory/agents@0.54.11
  - @cat-factory/gates@0.5.31
  - @cat-factory/orchestration@0.107.7
  - @cat-factory/prompt-fragments@0.13.17

## 0.10.118

### Patch Changes

- Updated dependencies [b34ab46]
  - @cat-factory/server@0.113.8
  - @cat-factory/orchestration@0.107.6

## 0.10.117

### Patch Changes

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19
  - @cat-factory/server@0.113.7
  - @cat-factory/orchestration@0.107.5

## 0.10.116

### Patch Changes

- Updated dependencies [c1028cc]
  - @cat-factory/orchestration@0.107.4
  - @cat-factory/server@0.113.6

## 0.10.115

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/gates@0.5.30
  - @cat-factory/integrations@0.81.18
  - @cat-factory/orchestration@0.107.3
  - @cat-factory/server@0.113.5
  - @cat-factory/prompt-fragments@0.13.16

## 0.10.114

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/orchestration@0.107.2
  - @cat-factory/kernel@0.123.1
  - @cat-factory/server@0.113.4
  - @cat-factory/agents@0.54.9
  - @cat-factory/gates@0.5.29
  - @cat-factory/integrations@0.81.17

## 0.10.113

### Patch Changes

- Updated dependencies [85bf0ef]
  - @cat-factory/server@0.113.3

## 0.10.112

### Patch Changes

- Updated dependencies [17c6808]
  - @cat-factory/server@0.113.2

## 0.10.111

### Patch Changes

- e4c5abe: Type the harness failure-cause wire and consolidate its classifiers (error-message initiative I4).
  The kernel now owns the structured cause vocabulary — `HARNESS_FAILURE_CAUSES` /
  `HarnessFailureCause` / `isHarnessFailureCause` / `failureKindFromHarnessCause`
  (`kernel/src/domain/harness-failure.ts`), kept in step by hand with the dependency-free container
  payloads (executor-harness `FailureCause` plus deploy-harness `DeployFailureCause`, hence the
  `deploy` member) — and the three job-view ports carry the union instead of a bare string
  (`RunnerJobView.failureCause`, the failed `AgentJobUpdate` variant, `PreviewView.failureCause`).
  The mapper's internal `Record<HarnessFailureCause, 'timeout' | 'agent'>` is the drift guard: a new
  union member without a mapping fails the typecheck.

  The three per-flow copies of the cause switch are deleted in favour of that one kernel mapper:
  orchestration's `agentFailureKindFromCause` (a module export of `job.logic.ts`, now removed —
  `RunDispatcher` calls the kernel mapper), the bootstrapper's `bootstrapFailureKindFromCause`, and
  the repairer's `repairFailureKindFromCause`. Each flow keeps its own error-string regex purely as
  the no-cause fallback. `HttpRunnerPoolProvider` now narrows the pool's dot-path-mapped cause
  through `isHarnessFailureCause` (an unknown free-form value degrades to the regex fallback instead
  of riding the wire untyped), and the conformance `FakeAgentExecutor.pollFailCause` option is typed
  to the union. Container eviction stays outside the union (a transport signal —
  `RunnerJobView.evicted`). No executor-harness image bump: the harness sources are untouched.

- Updated dependencies [e4c5abe]
- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/orchestration@0.107.1
  - @cat-factory/server@0.113.1
  - @cat-factory/integrations@0.81.16
  - @cat-factory/agents@0.54.8
  - @cat-factory/gates@0.5.28

## 0.10.110

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/orchestration@0.107.0
  - @cat-factory/integrations@0.81.15
  - @cat-factory/server@0.113.0
  - @cat-factory/agents@0.54.7
  - @cat-factory/gates@0.5.27
  - @cat-factory/prompt-fragments@0.13.15

## 0.10.109

### Patch Changes

- Updated dependencies [5a3fe5d]
- Updated dependencies [2a13ece]
  - @cat-factory/server@0.112.10
  - @cat-factory/kernel@0.121.8
  - @cat-factory/integrations@0.81.14
  - @cat-factory/agents@0.54.6
  - @cat-factory/gates@0.5.26
  - @cat-factory/orchestration@0.106.8

## 0.10.108

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/orchestration@0.106.7
  - @cat-factory/server@0.112.9
  - @cat-factory/integrations@0.81.13
  - @cat-factory/agents@0.54.5
  - @cat-factory/gates@0.5.25

## 0.10.107

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/orchestration@0.106.6
  - @cat-factory/server@0.112.8
  - @cat-factory/agents@0.54.4
  - @cat-factory/gates@0.5.24
  - @cat-factory/integrations@0.81.12

## 0.10.106

### Patch Changes

- Updated dependencies [f8f1aa8]
  - @cat-factory/agents@0.54.3
  - @cat-factory/contracts@0.127.1
  - @cat-factory/gates@0.5.23
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5
  - @cat-factory/orchestration@0.106.5
  - @cat-factory/prompt-fragments@0.13.14
  - @cat-factory/server@0.112.7

## 0.10.105

### Patch Changes

- Updated dependencies [e68c958]
  - @cat-factory/integrations@0.81.10
  - @cat-factory/server@0.112.6
  - @cat-factory/orchestration@0.106.4

## 0.10.104

### Patch Changes

- Updated dependencies [e61c980]
  - @cat-factory/server@0.112.5

## 0.10.103

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/orchestration@0.106.3
  - @cat-factory/integrations@0.81.9
  - @cat-factory/agents@0.54.2
  - @cat-factory/gates@0.5.22
  - @cat-factory/server@0.112.4

## 0.10.102

### Patch Changes

- Updated dependencies [6fc42ed]
  - @cat-factory/server@0.112.3

## 0.10.101

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/orchestration@0.106.2
  - @cat-factory/server@0.112.2
  - @cat-factory/agents@0.54.1
  - @cat-factory/gates@0.5.21
  - @cat-factory/integrations@0.81.8

## 0.10.100

### Patch Changes

- Updated dependencies [3b3bdc8]
  - @cat-factory/server@0.112.1
  - @cat-factory/integrations@0.81.7
  - @cat-factory/orchestration@0.106.1

## 0.10.99

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/orchestration@0.106.0
  - @cat-factory/server@0.112.0
  - @cat-factory/gates@0.5.20
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2
  - @cat-factory/prompt-fragments@0.13.13

## 0.10.98

### Patch Changes

- Updated dependencies [df7a489]
  - @cat-factory/server@0.111.0

## 0.10.97

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/server@0.110.5
  - @cat-factory/orchestration@0.105.6
  - @cat-factory/agents@0.53.6
  - @cat-factory/gates@0.5.19
  - @cat-factory/integrations@0.81.5

## 0.10.96

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/server@0.110.4
  - @cat-factory/agents@0.53.5
  - @cat-factory/gates@0.5.18
  - @cat-factory/integrations@0.81.4
  - @cat-factory/orchestration@0.105.5

## 0.10.95

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4
  - @cat-factory/server@0.110.3
  - @cat-factory/orchestration@0.105.4

## 0.10.94

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/agents@0.53.3
  - @cat-factory/gates@0.5.17
  - @cat-factory/integrations@0.81.3
  - @cat-factory/orchestration@0.105.3
  - @cat-factory/server@0.110.2

## 0.10.93

### Patch Changes

- Updated dependencies [dbfe2e8]
  - @cat-factory/server@0.110.1

## 0.10.92

### Patch Changes

- Updated dependencies [8d65179]
- Updated dependencies [a5dcf7d]
  - @cat-factory/server@0.110.0
  - @cat-factory/kernel@0.119.0
  - @cat-factory/agents@0.53.2
  - @cat-factory/gates@0.5.16
  - @cat-factory/integrations@0.81.2
  - @cat-factory/orchestration@0.105.2

## 0.10.91

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/server@0.109.0
  - @cat-factory/agents@0.53.1
  - @cat-factory/gates@0.5.15
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/orchestration@0.105.1
  - @cat-factory/prompt-fragments@0.13.12

## 0.10.90

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0
  - @cat-factory/orchestration@0.105.0
  - @cat-factory/integrations@0.81.0
  - @cat-factory/server@0.108.0
  - @cat-factory/gates@0.5.14
  - @cat-factory/prompt-fragments@0.13.11

## 0.10.89

### Patch Changes

- Updated dependencies [4b8fc5f]
  - @cat-factory/server@0.107.10

## 0.10.88

### Patch Changes

- Updated dependencies [e254ef5]
  - @cat-factory/orchestration@0.104.1
  - @cat-factory/server@0.107.9

## 0.10.87

### Patch Changes

- 127fe3e: Apriori branches (slice 2): working mode.

  A task's single optional `working` apriori branch now drives the run — the agents start from
  and keep committing into that pre-existing branch instead of minting `cat-factory/<blockId>`,
  and the PR opens from it, the CI gate polls it, and the merger merges it. See
  `docs/initiatives/apriori-branches.md`.

  - **Context**: the engine lifts the block's `aprioriBranches` verbatim onto the agent run
    context (`AgentRunContext.aprioriBranches`), a pure projection like `referenceRepos`.
  - **Work-branch swap**: `ContainerAgentExecutor.buildJobBody` and the two `RunDispatcher`
    repo-op sites (`resolveRepoOpBranch` + the spec-writer `builtInRepoOpBranch`) resolve the
    work branch as `resolveAprioriWorkingBranch(...) ?? cat-factory/<blockId>`, so every
    downstream builder (`newBranch` / `pushBranch` / explore fallback / PR head) rides the
    user's branch. The base-branch rejection is a single shared `resolveAprioriWorkingBranch`
    helper (`@cat-factory/contracts`) so the executor and dispatcher rejections can't drift.
  - **Probe, never create**: an apriori working branch must already exist — it is probed
    (`ensureWorkBranch(..., { create: false })`, or a checkout-free `headSha`), and a missing
    branch fails the dispatch loudly rather than being silently created off base. A working
    branch equal to the repo base is rejected.
  - **Merge teardown guard**: `GitHubPullRequestMerger` only deletes a merged head branch when
    it is a platform `cat-factory/*` branch — a user-provided apriori branch is never torn down
    (reusing a merged apriori branch on a later task intentionally resumes it).
  - **Conformance**: a cross-runtime assertion that a custom kind's post-op commits onto the
    task's apriori working branch instead of `cat-factory/<blockId>` on both stores.

- Updated dependencies [127fe3e]
  - @cat-factory/orchestration@0.104.0
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/server@0.107.8
  - @cat-factory/agents@0.52.9
  - @cat-factory/gates@0.5.13
  - @cat-factory/integrations@0.80.6
  - @cat-factory/prompt-fragments@0.13.10

## 0.10.86

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/server@0.107.7
  - @cat-factory/orchestration@0.103.1
  - @cat-factory/agents@0.52.8
  - @cat-factory/gates@0.5.12
  - @cat-factory/integrations@0.80.5

## 0.10.85

### Patch Changes

- 08a7da2: Apriori branches (slice 1): data model + write-boundary + persistence.

  A task (`Block`) can now name pre-existing branches of its primary target repo via a new
  optional `aprioriBranches` field — an array of `{ name, mode: 'reference' | 'working' }`.
  `reference` branches are read-only context; the single optional `working` branch is the one
  the run keeps building inside (later slices). See `docs/initiatives/apriori-branches.md`.

  - **Contracts**: `aprioriBranchSchema` + `AprioriBranch`, the `aprioriWorkingBranch` /
    `aprioriReferenceBranches` helpers, an `isSafeGitBranchName` git-ref-safety check, the new
    `blockSchema` field, and `aprioriBranches` on `updateBlockSchema` (capped at 20). Re-exported
    from `@cat-factory/kernel`.
  - **Persistence**: a shared `apriori_branches` JSON text column mirroring `reference_repos`
    (empty-array-is-NULL) — D1 migration `0048_apriori_branches.sql` ⇄ Drizzle schema column +
    generated migration, picked up by both stores through the shared `blockFields` mapper.
  - **Write boundary**: `BoardService.updateBlock` drops the field on non-task blocks and enforces
    the cross-entry invariants via `aprioriBranchesError` — at most one `working` entry, no
    duplicate names, the working entry frozen once a PR exists, and no working entry on a
    multi-repo (`involvedServiceIds`) task.
  - **Conformance**: a cross-runtime round-trip asserting the column survives PATCH + snapshot
    read on both stores, clears to absent, and rejects the invalid shapes.

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/orchestration@0.103.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/server@0.107.6
  - @cat-factory/agents@0.52.7
  - @cat-factory/gates@0.5.11
  - @cat-factory/integrations@0.80.4
  - @cat-factory/prompt-fragments@0.13.9

## 0.10.84

### Patch Changes

- 5a4d356: test(conformance): reusable fake gate providers + an on-call assessment channel on the fake agent

  Extract the inline `ci` / `doc-quality` fake gate providers into a shared
  `fakeGateProviders` module (`makeFakeCi` / `makeFakeMergeability` / `makeFakeReleaseHealth` /
  `makeFakeDocQuality`), exported from the package index so both the cross-runtime conformance
  suite and the e2e test backend reuse one implementation instead of copy-pasting per-probe
  verdict queues. `FakeAgentExecutor` gains an `onCallAssessment` option and an `on-call` branch
  so the post-release-health gate's INVESTIGATE-don't-fix helper returns a structured assessment
  (the generic prose fall-through left it null). These back the new operational-gate + agent-loop
  e2e specs (CI→ci-fixer, conflicts→conflict-resolver, post-release-health→on-call, Tester→Fixer,
  companion rework, follow-up gate).

  Adds a cross-runtime conformance assertion for the post-release-health gate: a merged release
  (merger auto-merges → block `done`) whose observability signal probes `regressed` escalates the
  `on-call` helper and raises a `release_regression` notification, driven over the shared
  `makeFakeReleaseHealth`. Both facades enable the observability integration in their test env so the
  gate + its wire-handle + the on-call assessment channel can't drift on only one runtime.

- Updated dependencies [87f835a]
  - @cat-factory/server@0.107.5

## 0.10.83

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/orchestration@0.102.8
  - @cat-factory/server@0.107.4
  - @cat-factory/agents@0.52.6
  - @cat-factory/gates@0.5.10
  - @cat-factory/integrations@0.80.3

## 0.10.82

### Patch Changes

- Updated dependencies [a650396]
  - @cat-factory/orchestration@0.102.7
  - @cat-factory/server@0.107.3

## 0.10.81

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/orchestration@0.102.6
  - @cat-factory/server@0.107.2
  - @cat-factory/agents@0.52.5
  - @cat-factory/gates@0.5.9
  - @cat-factory/integrations@0.80.2
  - @cat-factory/prompt-fragments@0.13.8

## 0.10.80

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/server@0.107.1
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1
  - @cat-factory/orchestration@0.102.5
  - @cat-factory/agents@0.52.4
  - @cat-factory/gates@0.5.8

## 0.10.79

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0
  - @cat-factory/server@0.107.0
  - @cat-factory/agents@0.52.3
  - @cat-factory/gates@0.5.7
  - @cat-factory/orchestration@0.102.4

## 0.10.78

### Patch Changes

- Updated dependencies [51869b8]
- Updated dependencies [2924e32]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/orchestration@0.102.3
  - @cat-factory/agents@0.52.2
  - @cat-factory/gates@0.5.6
  - @cat-factory/integrations@0.79.3
  - @cat-factory/server@0.106.3

## 0.10.77

### Patch Changes

- @cat-factory/orchestration@0.102.2
- @cat-factory/server@0.106.2

## 0.10.76

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/orchestration@0.102.1
  - @cat-factory/kernel@0.115.1
  - @cat-factory/server@0.106.1
  - @cat-factory/agents@0.52.1
  - @cat-factory/gates@0.5.5
  - @cat-factory/integrations@0.79.2

## 0.10.75

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/orchestration@0.102.0
  - @cat-factory/server@0.106.0
  - @cat-factory/gates@0.5.4
  - @cat-factory/integrations@0.79.1
  - @cat-factory/prompt-fragments@0.13.7

## 0.10.74

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0
  - @cat-factory/integrations@0.79.0
  - @cat-factory/orchestration@0.101.0
  - @cat-factory/server@0.105.0
  - @cat-factory/gates@0.5.3
  - @cat-factory/prompt-fragments@0.13.6

## 0.10.73

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0
  - @cat-factory/orchestration@0.100.2
  - @cat-factory/server@0.104.2
  - @cat-factory/contracts@0.121.2
  - @cat-factory/gates@0.5.2
  - @cat-factory/integrations@0.78.8
  - @cat-factory/prompt-fragments@0.13.5

## 0.10.72

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/gates@0.5.1
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1
  - @cat-factory/orchestration@0.100.1
  - @cat-factory/server@0.104.1

## 0.10.71

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/gates@0.5.0
  - @cat-factory/orchestration@0.100.0
  - @cat-factory/server@0.104.0
  - @cat-factory/agents@0.49.2
  - @cat-factory/integrations@0.78.6

## 0.10.70

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/orchestration@0.99.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/gates@0.4.34
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1
  - @cat-factory/prompt-fragments@0.13.4
  - @cat-factory/server@0.103.1

## 0.10.69

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/server@0.103.0
  - @cat-factory/orchestration@0.99.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/gates@0.4.33
  - @cat-factory/integrations@0.78.4
  - @cat-factory/prompt-fragments@0.13.3

## 0.10.68

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/orchestration@0.98.1
  - @cat-factory/agents@0.48.5
  - @cat-factory/server@0.102.1
  - @cat-factory/kernel@0.110.1
  - @cat-factory/gates@0.4.32
  - @cat-factory/integrations@0.78.3

## 0.10.67

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/orchestration@0.98.0
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/server@0.102.0
  - @cat-factory/gates@0.4.31
  - @cat-factory/integrations@0.78.2
  - @cat-factory/prompt-fragments@0.13.2

## 0.10.66

### Patch Changes

- Updated dependencies [35636d5]
  - @cat-factory/agents@0.48.3
  - @cat-factory/orchestration@0.97.2
  - @cat-factory/server@0.101.2

## 0.10.65

### Patch Changes

- 8319e52: Fix a first-sign-in race in `AccountService.ensurePersonalAccount` that 500'd
  `GET /accounts` ("cannot reach backend") on a fresh DB.

  The method was a non-atomic check-then-act: concurrent first-load requests all read
  "no personal account yet", then all `INSERT`, so all but one failed with a duplicate-key
  violation on the personal-account partial unique index (`idx_accounts_personal`) and the
  error surfaced as an unhandled 500.

  The create path is now atomic. A new `AccountRepository.ensurePersonal(account)` port
  inserts-or-returns the surviving row — D1 via `INSERT OR IGNORE`, Postgres via
  `ON CONFLICT DO NOTHING` — so concurrent first-sign-in callers all converge on the same
  account with no rejection. Both runtimes implement it and a cross-runtime conformance
  assertion fires the concurrent resolution and asserts a single account results.

  The sibling paths are unaffected: `createOrg` is a deliberate non-idempotent create (org
  accounts have no such unique index), and `ensureMembership` already writes through an
  idempotent `upsert`.

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/agents@0.48.2
  - @cat-factory/gates@0.4.30
  - @cat-factory/integrations@0.78.1
  - @cat-factory/orchestration@0.97.1
  - @cat-factory/server@0.101.1

## 0.10.64

### Patch Changes

- 7157908: Model presets now support reseeding, mirroring pipelines and merge presets, plus a new
  built-in "Claude Opus 4.8" preset (everything `claude-opus`).

  - Built-in model presets carry stable catalog ids (`mdp_kimi` / `mdp_glm` / `mdp_claude`)
    and a monotonic `version`. The workspace snapshot ships `modelPresetCatalogVersions`, and
    `POST /workspaces/:ws/model-presets/:id/reseed` restores a built-in to the current catalog
    (adopt an update, repair drift, or materialise a new built-in that appeared). The SPA gains
    a once-per-session "model preset updates" advisory (reseed / add) like the pipeline and
    merge-preset ones.
  - The seeded workspace DEFAULT preset is now a deployment fact: Cloudflare and Node default to
    Kimi K2.7 (Cloudflare-runnable on the bare baseline), local mode defaults to Claude Opus 4.8
    (local runs subscription models via the ambient CLI / a leased personal credential). The
    deployment default is applied only at first seed, so a user's later manual default choice is
    always preserved.

  Breaking (pre-1.0, no migration): model presets gain a nullable `version` column
  (D1 `0043_model_preset_versioning`; Drizzle migration). Workspaces seeded before this change
  hold the old index-based preset ids (`mdp-seed-0/1`); they are treated as custom presets, and
  the three stable built-ins are offered via the reseed advisory rather than migrated in place.

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/server@0.101.0
  - @cat-factory/orchestration@0.97.0
  - @cat-factory/integrations@0.78.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/gates@0.4.29
  - @cat-factory/prompt-fragments@0.13.1

## 0.10.63

### Patch Changes

- 629cf90: Initiative presets slice 9: the E2E baseline + a worked-example deployment preset.

  - `@cat-factory/conformance`: `FakeAgentExecutor` gains an `initiativePlan` option so a
    fake-driven initiative-planner step returns a plan draft (the planner otherwise faults a
    planning run) — the seam an e2e/integration test uses to drive create-with-preset → auto-plan
    → spawn.
  - `@cat-factory/node-server`: the initiative-loop sweep interval is now overridable via
    `INITIATIVE_LOOP_INTERVAL_MS` (default 60s unchanged).
  - `@cat-factory/app`: `TaskCard` exposes a behaviour-neutral `data-task-type` attribute (the e2e
    asserts a spawned document task carries its preset decoration).
  - `@cat-factory/example-custom-agent`: adds `preset_org_audit`, a worked-example initiative preset
    registered through the public `registerInitiativePreset` seam.

## 0.10.62

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0
  - @cat-factory/orchestration@0.96.3
  - @cat-factory/server@0.100.2

## 0.10.61

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0
  - @cat-factory/prompt-fragments@0.13.0
  - @cat-factory/orchestration@0.96.2
  - @cat-factory/server@0.100.1

## 0.10.60

### Patch Changes

- Updated dependencies [cb088c7]
- Updated dependencies [b3bd653]
  - @cat-factory/agents@0.46.0
  - @cat-factory/server@0.100.0
  - @cat-factory/orchestration@0.96.1

## 0.10.59

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0
  - @cat-factory/orchestration@0.96.0
  - @cat-factory/server@0.99.8

## 0.10.58

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1
  - @cat-factory/orchestration@0.95.3
  - @cat-factory/server@0.99.7

## 0.10.57

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0
  - @cat-factory/prompt-fragments@0.12.0
  - @cat-factory/orchestration@0.95.2
  - @cat-factory/server@0.99.6
  - @cat-factory/gates@0.4.28
  - @cat-factory/integrations@0.77.8

## 0.10.56

### Patch Changes

- Updated dependencies [4a7fca0]
  - @cat-factory/prompt-fragments@0.11.0
  - @cat-factory/agents@0.43.1
  - @cat-factory/orchestration@0.95.1
  - @cat-factory/server@0.99.5

## 0.10.55

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/orchestration@0.95.0
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0
  - @cat-factory/server@0.99.4
  - @cat-factory/gates@0.4.27
  - @cat-factory/integrations@0.77.7

## 0.10.54

### Patch Changes

- Updated dependencies [cd60892]
  - @cat-factory/orchestration@0.94.0
  - @cat-factory/server@0.99.3

## 0.10.53

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0
  - @cat-factory/orchestration@0.93.1
  - @cat-factory/server@0.99.2
  - @cat-factory/gates@0.4.26
  - @cat-factory/integrations@0.77.6

## 0.10.52

### Patch Changes

- f7f9a9e: Technological-migration initiative — slice T2: phase-template ingest normalization.

  The generic counterpart to T1's planner prompt fold: when an initiative preset declares a
  `phaseTemplate`, the plan draft is now normalized against it at ingest, BEFORE the preset's own
  `seedPlan` hook. This is plan-SHAPE enforcement only (which phases the plan presents, and in what
  order) and stays deliberately separate from `seedPlan`'s per-item decoration.

  - **orchestration**: new pure `normalizeDraftAgainstPhaseTemplate(template, draft)`
    (`initiative.logic.ts`) — matches planned phases to template phases by `id` VERBATIM, reorders
    them into template order (preserving the planner's `title`/`goal`), appends any extra phases
    after the template ones when `allowAdditionalPhases` is set, and throws `ValidationError` on a
    missing `required` phase or a disallowed extra (an id-less phase counts as an extra). Wired into
    `InitiativeService.seedPlanDraft` ahead of the `seedPlan` hook and gated on the resolved preset's
    `phaseTemplate`, so a preset with no template (including `preset_generic`) ingests byte-for-byte
    as before. Pure + deterministic, so re-ingesting the same draft stays idempotent.
  - **orchestration**: `validatePlanDraft` now also rejects a dependency that points FORWARD into a
    later phase. Phases execute in declared order, so an earlier-phase item depending on a
    later-phase one can never resolve and deadlocks the loop — a general invariant, but the T2 phase
    reorder can turn a planner-consistent draft into a violating one, so it's caught loudly at the
    ingest trust boundary instead of stalling silently at run time.
  - **orchestration**: `seedPlanDraft` now RE-NORMALIZES the `seedPlan` hook's output against the
    template (idempotent), symmetric with the existing re-parse-for-path-safety: a hook that touched
    phases can no longer bypass the template's shape enforcement.
  - **conformance**: `defineInitiativeSuite` now drives `InitiativeService.ingestPlan` over each
    facade's real store — asserting an out-of-order plan is reordered into template order and
    persisted, and a plan missing a required phase is rejected with nothing written — so the two
    stores can't drift on a template-shaped plan.

- Updated dependencies [f7f9a9e]
  - @cat-factory/orchestration@0.93.0
  - @cat-factory/server@0.99.1

## 0.10.51

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0
  - @cat-factory/orchestration@0.92.0
  - @cat-factory/server@0.99.0
  - @cat-factory/gates@0.4.25
  - @cat-factory/prompt-fragments@0.10.27

## 0.10.50

### Patch Changes

- Updated dependencies [8f7af8e]
- Updated dependencies [8f7af8e]
  - @cat-factory/integrations@0.77.4
  - @cat-factory/server@0.98.3
  - @cat-factory/orchestration@0.91.1

## 0.10.49

### Patch Changes

- 4a3e536: Initiative presets — slice 5: loop/ingest glue (spawn decoration + `seedPlan` at ingest).

  - **contracts** (`initiativeItemSpawnSchema`): the spawn bag now carries an optional `taskType`, so
    a preset's `seedPlan` can declare a spawned item's kind (`document`/`bug`/`spike`/…) exactly as
    the create-task form does.
  - **orchestration** (`InitiativeLoopService.buildTaskBlock`): a spawned item's preset-authored
    `spawn` bag is now folded onto the task block, so a planned item comes out as a first-class
    TYPED task rather than a bare description block — its `taskType` (so a doc task classifies as
    `document`, not the default `feature` — `taskType`-keyed per-type task limits and the SPA's
    document affordances now apply), the doc task's `taskTypeFields` (`docKind`/`targetPath`/…),
    best-practice `fragmentIds`, and per-agent `agentConfig`. Each is additive + sparse (an empty bag
    is omitted), mirroring `BoardService.addTask`, so a decoration-less item (the generic / no-preset
    case) spawns a block byte-identical to before. A `document`-typed spawn with no explicit
    `fragmentIds` inherits the default writing-style fragments, exactly as `BoardService.addTask`
    seeds them for a board-created document task. The per-run gate override (`spawn.gates`, slice 2)
    is unchanged.
  - **orchestration** (`applyPlanDraft`): the draft item's `spawn` decoration is now carried onto the
    persisted item (it follows the draft like the other content fields), so `buildTaskBlock` can read
    it. A re-plan refreshing an already-materialised item is harmless — its block was decorated when
    it spawned.
  - **orchestration** (`InitiativeService.ingestPlan`): runs the resolved initiative preset's
    `seedPlan` post-processor over the parsed draft BEFORE `applyPlanDraft`. The preset is resolved
    from the entity's FROZEN `presetId`/`presetInputs`, so reading it outside the CAS `mutate` is
    race-free and (being pure) replay-safe. The hook's output is RE-PARSED through the strict schema:
    a `seedPlan` bug can't persist a malformed draft, and an unsafe spawn `targetPath` (from a hook OR
    the planner) is rejected by `taskTypeFieldsSchema`'s `isSafeDocPath` check — it can never escape
    the repo. Absent preset / no `seedPlan` ⇒ the draft is applied unchanged (byte-for-byte the
    pre-slice-5 path).
  - **conformance**: asserts a preset-authored item `spawn` bag (task type, typed-task fields,
    fragments, agent config, gate override) round-trips through the initiative store intact on both
    runtimes — a store that dropped it would silently spawn a bare block instead of a first-class doc
    task.

- Updated dependencies [4a3e536]
  - @cat-factory/orchestration@0.91.0
  - @cat-factory/contracts@0.117.0
  - @cat-factory/server@0.98.2
  - @cat-factory/agents@0.40.13
  - @cat-factory/gates@0.4.24
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4
  - @cat-factory/prompt-fragments@0.10.26

## 0.10.48

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/gates@0.4.23
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3
  - @cat-factory/orchestration@0.90.1
  - @cat-factory/prompt-fragments@0.10.25
  - @cat-factory/server@0.98.1

## 0.10.47

### Patch Changes

- bc77f89: Initiative presets — slice 3: create/planning integration.

  - **contracts**: `createInitiativeSchema` gains optional `presetId` + `presetInputs` (validated
    against the resolved descriptor at create and frozen on the entity). New
    `probeInitiativePresetContract` (`POST /workspaces/:ws/initiative-presets/:presetId/probe`,
    body `{ frameId }` → the detected `InitiativePresetInputs`). The workspace snapshot gains
    `initiativePresets: InitiativePresetDescriptor[]`. New pure helpers
    `sanitizeInitiativePresetInputs` (reduce a form to its known, visible fields) and
    `renderInitiativePresetValue` (option-label-aware value rendering), shared by the create flow.
  - **orchestration** (`InitiativeService.create`): resolves + validates the preset (an unknown id
    or an invalid form is a create-time `ValidationError`, so nothing is written), and — only when a
    preset resolves — persists `presetId` + the SANITIZED `presetInputs` (known, currently-visible
    fields only, so a hidden field's unvalidated value can never freeze, and a form posted with no
    `presetId` is dropped). For a `skip`-interview preset it seeds the `qa` digest from the filled
    form (one answered exchange per visible, filled field via the new pure `seedPresetInterviewQa`)
    and templates the goal (the human's description wins, else the preset's stated purpose). Absent
    `presetId` ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`AgentContextBuilder`): an initiative planning step's context now folds in the
    preset `{ label, promptAddition }` resolved for the RUNNING kind — set ONLY when that kind has
    steering — so the analyst/planner prompts carry the preset's per-kind steering. The generic
    preset registers no steering, so the generic planning prompt is unchanged.
  - **kernel**: `AgentRunContext.initiative` gains an optional `preset` sub-object carrying the
    preset `label` + the per-kind `promptAddition` (the frozen form reaches the prompt via `qa`).
  - **server**: the shared `WorkspaceController` attaches `initiativePresets`
    (`initiativePresetDescriptors()`) to the snapshot on both the create + read handlers (so both
    facades advertise it), and `InitiativeController` serves the probe endpoint — resolving the
    frame's repo through the existing `resolveRunRepoContext` seam and running the preset's `detect`
    hook, returning `{}` (descriptor defaults) whenever GitHub is unwired / the frame has no linked
    repo / the preset has no probe hook, so it never blocks create. The initiative planning prompts
    render the folded-in preset steering.
  - **app**: the SPA hydrates `initiativePresets` from the snapshot and starts planning with the
    initiative's preset descriptor's `planningPipelineId` (the generic/absent preset keeps
    `pl_initiative`) instead of a hardcoded id. A NAMED preset that hasn't hydrated resolves to
    `null` (not the generic pipeline), so "Run planning" stays disabled rather than silently
    launching the interviewer over an already-seeded skip-interview initiative.

  Conformance: a shared assertion that both facades advertise the built-in generic preset on the
  snapshot (create + read), binding `pl_initiative` and the interviewer.

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/orchestration@0.90.0
  - @cat-factory/server@0.98.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/gates@0.4.22
  - @cat-factory/integrations@0.77.1
  - @cat-factory/prompt-fragments@0.10.24

## 0.10.46

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/orchestration@0.89.0
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/server@0.97.2
  - @cat-factory/agents@0.40.10
  - @cat-factory/gates@0.4.21
  - @cat-factory/kernel@0.104.1
  - @cat-factory/prompt-fragments@0.10.23

## 0.10.45

### Patch Changes

- a869ae9: Initiative presets — slice 2: the per-run gate-override engine seam.

  - **orchestration** (`ExecutionService.start`): a new optional `gatesOverride` argument — one
    boolean per pipeline step, indexed by the pipeline's ORIGINAL step index exactly like
    `pipeline.gates` — that REPLACES the pipeline's declared approval gates for a single run. It is
    copied onto the run's steps (`requiresApproval`, `gatesOverride?.[i] ?? pipeline.gates?.[i]`), so
    a retry/restart — which re-drive the STORED steps — preserve it with no extra persistence. A
    length that doesn't match the pipeline's step count is rejected up front (a `ValidationError`)
    before any side effects. Absent ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`InitiativeLoopService`): a spawned item's preset-authored `spawn.gates` is
    threaded straight into `ExecutionService.start` as that run's gate override, so a spawned task
    gates (or doesn't) per the preset's human-review mapping instead of the pipeline default.

  Conformance: a new `startExecution` harness probe (start a run through the real `ExecutionService`
  with an optional gate override — a path no HTTP route exposes) plus shared assertions that an
  override flips a step's approval gate on/off, round-trips `requiresApproval` through each store, and
  rejects a mismatched-length override — run identically on the Cloudflare (D1) and Node/local
  (Postgres) facades.

- Updated dependencies [a869ae9]
  - @cat-factory/orchestration@0.88.0
  - @cat-factory/server@0.97.1

## 0.10.44

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/server@0.97.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/integrations@0.76.0
  - @cat-factory/orchestration@0.87.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/gates@0.4.20
  - @cat-factory/prompt-fragments@0.10.22

## 0.10.43

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/server@0.96.0
  - @cat-factory/orchestration@0.86.0
  - @cat-factory/agents@0.40.8
  - @cat-factory/gates@0.4.19
  - @cat-factory/integrations@0.75.1
  - @cat-factory/prompt-fragments@0.10.21

## 0.10.42

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0
  - @cat-factory/orchestration@0.85.0
  - @cat-factory/server@0.95.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/gates@0.4.18
  - @cat-factory/prompt-fragments@0.10.20

## 0.10.41

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/orchestration@0.84.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/gates@0.4.17
  - @cat-factory/kernel@0.101.2
  - @cat-factory/prompt-fragments@0.10.19
  - @cat-factory/server@0.94.3

## 0.10.40

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6
  - @cat-factory/orchestration@0.83.2
  - @cat-factory/server@0.94.2

## 0.10.39

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/orchestration@0.83.1
  - @cat-factory/integrations@0.73.5
  - @cat-factory/agents@0.40.5
  - @cat-factory/gates@0.4.16
  - @cat-factory/prompt-fragments@0.10.18
  - @cat-factory/server@0.94.1

## 0.10.38

### Patch Changes

- Updated dependencies [c66362f]
  - @cat-factory/server@0.94.0

## 0.10.37

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/orchestration@0.83.0
  - @cat-factory/server@0.93.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/gates@0.4.15
  - @cat-factory/integrations@0.73.4
  - @cat-factory/prompt-fragments@0.10.17

## 0.10.36

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/orchestration@0.82.0
  - @cat-factory/server@0.92.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/gates@0.4.14
  - @cat-factory/integrations@0.73.3
  - @cat-factory/prompt-fragments@0.10.16

## 0.10.35

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/orchestration@0.81.0
  - @cat-factory/server@0.91.0
  - @cat-factory/contracts@0.108.1
  - @cat-factory/agents@0.40.2
  - @cat-factory/gates@0.4.13
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15

## 0.10.34

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1
  - @cat-factory/orchestration@0.80.1
  - @cat-factory/server@0.90.3

## 0.10.33

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/orchestration@0.80.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/gates@0.4.12
  - @cat-factory/server@0.90.2
  - @cat-factory/prompt-fragments@0.10.14

## 0.10.32

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/orchestration@0.79.1
  - @cat-factory/server@0.90.1
  - @cat-factory/gates@0.4.11
  - @cat-factory/prompt-fragments@0.10.13

## 0.10.31

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0
  - @cat-factory/orchestration@0.79.0
  - @cat-factory/server@0.90.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/gates@0.4.10
  - @cat-factory/prompt-fragments@0.10.12

## 0.10.30

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/server@0.89.0
  - @cat-factory/orchestration@0.78.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/gates@0.4.9
  - @cat-factory/prompt-fragments@0.10.11

## 0.10.29

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/server@0.88.0
  - @cat-factory/orchestration@0.77.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/gates@0.4.8
  - @cat-factory/integrations@0.70.1
  - @cat-factory/prompt-fragments@0.10.10

## 0.10.28

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/integrations@0.70.0
  - @cat-factory/orchestration@0.76.0
  - @cat-factory/server@0.87.0
  - @cat-factory/agents@0.39.1
  - @cat-factory/gates@0.4.7
  - @cat-factory/prompt-fragments@0.10.9

## 0.10.27

### Patch Changes

- Updated dependencies [c435c09]
  - @cat-factory/server@0.86.0

## 0.10.26

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/agents@0.39.0
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/orchestration@0.75.0
  - @cat-factory/server@0.85.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/gates@0.4.6
  - @cat-factory/prompt-fragments@0.10.8

## 0.10.25

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/gates@0.4.5
  - @cat-factory/orchestration@0.74.3
  - @cat-factory/prompt-fragments@0.10.7
  - @cat-factory/server@0.84.3

## 0.10.24

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0
  - @cat-factory/orchestration@0.74.2
  - @cat-factory/server@0.84.2

## 0.10.23

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/gates@0.4.4
  - @cat-factory/integrations@0.67.1
  - @cat-factory/orchestration@0.74.1
  - @cat-factory/prompt-fragments@0.10.6
  - @cat-factory/server@0.84.1

## 0.10.22

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0
  - @cat-factory/integrations@0.67.0
  - @cat-factory/orchestration@0.74.0
  - @cat-factory/server@0.84.0
  - @cat-factory/gates@0.4.3
  - @cat-factory/prompt-fragments@0.10.5

## 0.10.21

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/gates@0.4.2
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/orchestration@0.73.1
  - @cat-factory/prompt-fragments@0.10.4
  - @cat-factory/server@0.83.2

## 0.10.20

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/orchestration@0.73.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/gates@0.4.1
  - @cat-factory/server@0.83.1
  - @cat-factory/prompt-fragments@0.10.3

## 0.10.19

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/gates@0.4.0
  - @cat-factory/server@0.83.0
  - @cat-factory/integrations@0.65.3
  - @cat-factory/orchestration@0.72.1

## 0.10.18

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/orchestration@0.72.0
  - @cat-factory/server@0.82.0
  - @cat-factory/gates@0.3.2
  - @cat-factory/integrations@0.65.2

## 0.10.17

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/gates@0.3.1
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/orchestration@0.71.1
  - @cat-factory/prompt-fragments@0.10.2
  - @cat-factory/server@0.81.1

## 0.10.16

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/integrations@0.65.0
  - @cat-factory/orchestration@0.71.0
  - @cat-factory/server@0.81.0
  - @cat-factory/agents@0.34.0
  - @cat-factory/gates@0.3.0
  - @cat-factory/prompt-fragments@0.10.1

## 0.10.15

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/server@0.80.0
  - @cat-factory/integrations@0.64.0
  - @cat-factory/orchestration@0.70.1
  - @cat-factory/agents@0.33.1
  - @cat-factory/gates@0.2.88

## 0.10.14

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0
  - @cat-factory/agents@0.33.0
  - @cat-factory/orchestration@0.70.0
  - @cat-factory/server@0.79.4

## 0.10.13

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/orchestration@0.69.1
  - @cat-factory/gates@0.2.87
  - @cat-factory/server@0.79.3

## 0.10.12

### Patch Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
  app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

  - New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
    named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
    behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
    invalidation bus, never a data tier; with no notification factory injected the
    loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
    machinery so ioredis never enters the module graph outside the Node facade's
    REDIS_URL-gated wiring.
  - `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
    (group = workspace id), and every fragment write path — create / update / remove /
    createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
    sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
    `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
  - Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
    each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
    overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
    ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
    write — the same gating and resilience pattern as the realtime propagator. Local
    mode stays bare in-memory (single-node by construction).
  - Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
    cross-instance state) is pass-through, since an isolate has no cross-isolate
    invalidation bus. Documented in the caching package README.
  - Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
    catalog on all three runtimes (Worker/Node/local).
  - Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
    in-memory `isEntryStillCurrentFn` support: a cache profile may set
    `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
    `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
    the probe reports the source unmoved, and fall back to a full background reload
    otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
    `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0
  - @cat-factory/orchestration@0.69.0
  - @cat-factory/gates@0.2.86
  - @cat-factory/integrations@0.62.1
  - @cat-factory/server@0.79.2

## 0.10.11

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/gates@0.2.85
  - @cat-factory/orchestration@0.68.1
  - @cat-factory/prompt-fragments@0.9.55
  - @cat-factory/server@0.79.1

## 0.10.10

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/integrations@0.61.0
  - @cat-factory/server@0.79.0
  - @cat-factory/orchestration@0.68.0
  - @cat-factory/agents@0.30.4
  - @cat-factory/gates@0.2.84
  - @cat-factory/prompt-fragments@0.9.54

## 0.10.9

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/orchestration@0.67.0
  - @cat-factory/server@0.78.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/gates@0.2.83
  - @cat-factory/integrations@0.60.2
  - @cat-factory/prompt-fragments@0.9.53

## 0.10.8

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/orchestration@0.66.0
  - @cat-factory/server@0.77.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/gates@0.2.82
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52

## 0.10.7

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/integrations@0.60.0
  - @cat-factory/orchestration@0.65.0
  - @cat-factory/server@0.76.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/gates@0.2.81
  - @cat-factory/prompt-fragments@0.9.51

## 0.10.6

### Patch Changes

- Updated dependencies [0477068]
  - @cat-factory/server@0.75.2

## 0.10.5

### Patch Changes

- Updated dependencies [4a59f45]
  - @cat-factory/server@0.75.1

## 0.10.4

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/orchestration@0.64.0
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/integrations@0.59.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/server@0.75.0
  - @cat-factory/gates@0.2.80
  - @cat-factory/prompt-fragments@0.9.50

## 0.10.3

### Patch Changes

- Updated dependencies [7fa7578]
- Updated dependencies [f372f4e]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/orchestration@0.63.0
  - @cat-factory/server@0.74.0
  - @cat-factory/agents@0.29.1
  - @cat-factory/gates@0.2.79
  - @cat-factory/integrations@0.58.1
  - @cat-factory/prompt-fragments@0.9.49

## 0.10.2

### Patch Changes

- Updated dependencies [6917962]
  - @cat-factory/server@0.73.1

## 0.10.1

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/integrations@0.58.0
  - @cat-factory/server@0.73.0
  - @cat-factory/orchestration@0.62.0
  - @cat-factory/gates@0.2.78
  - @cat-factory/prompt-fragments@0.9.48

## 0.10.0

### Minor Changes

- ca5c3e8: Initiatives (slice 1 of 4): the long-running, multi-task counterpart to a task — see
  `docs/initiatives/initiatives-feature.md` for the full multi-slice plan.

  - **New `initiative` block level** — a container block under a service frame (created via the
    new "Create initiative" button in the frame header, next to add-task/import-task). Tasks a
    later slice's execution loop spawns link back via the new `blocks.initiative_id` membership
    column (epic-style). D1 migration `0035_initiatives.sql` ⇄ Drizzle schema, shared mapper.
  - **New `initiatives` entity + store** — the DB row is the source of truth (phases, items with
    planner-authored estimates + dependencies, the execution policy with estimate→pipeline rules,
    decisions / deviations / follow-ups / caveats), guarded by a `rev` compare-and-swap so the
    loop has a single logical writer. Mirrored D1 ⇄ Drizzle repositories with a cross-runtime
    conformance suite (CRUD, doc round-trip, CAS conflict, `blocks.initiative_id`).
  - **Initiative Planning pipeline skeleton (`pl_initiative`)** — `initiative-planner` (a
    read-only structured container explore that drafts the multi-phase plan, gated for human
    approval) + `initiative-committer` (a deterministic engine step that flips the entity to
    `executing` and commits the rendered tracker to `docs/initiatives/<slug>/` — canonical
    `initiative.json` + human `tracker.md` + `version.json`, hash-short-circuited and
    replay-safe, following the blueprint artifact pattern). A bidirectional guard in the
    engine's shared `assertRunnable` makes `pl_initiative` the ONLY pipeline runnable on an
    initiative block (and vice versa), across start/retry/restart.
  - **API + snapshot + realtime** — `POST/GET /workspaces/:ws/initiatives` (+ by-block read),
    the snapshot's optional `initiatives` field, and a new `initiative` WorkspaceEvent pushed
    from both runtimes' publishers.
  - **Frontend** — the Create Initiative modal + frame-header button, the initiative board card,
    an inspector body (run planning / open tracker) and the read-only Initiative Tracker window
    (`initiative-tracker` result view), with the `initiative.*` i18n namespace across all 8
    locales.

  Later slices add the interactive planning interview, the execution loop (just-in-time task
  spawning with estimate-gated pipeline selection), and follow-up/deviation harvesting.

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/orchestration@0.61.0
  - @cat-factory/server@0.72.0
  - @cat-factory/gates@0.2.77
  - @cat-factory/integrations@0.57.2
  - @cat-factory/prompt-fragments@0.9.47

## 0.9.102

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/orchestration@0.60.4
  - @cat-factory/server@0.71.2

## 0.9.101

### Patch Changes

- Updated dependencies [803fa76]
  - @cat-factory/server@0.71.1

## 0.9.100

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/server@0.71.0
  - @cat-factory/gates@0.2.76
  - @cat-factory/integrations@0.57.1
  - @cat-factory/orchestration@0.60.3
  - @cat-factory/prompt-fragments@0.9.46

## 0.9.99

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/server@0.70.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/gates@0.2.75
  - @cat-factory/orchestration@0.60.2

## 0.9.98

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/gates@0.2.74
  - @cat-factory/orchestration@0.60.1
  - @cat-factory/agents@0.26.17
  - @cat-factory/integrations@0.56.5
  - @cat-factory/prompt-fragments@0.9.45
  - @cat-factory/server@0.69.1

## 0.9.97

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/orchestration@0.60.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/server@0.69.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/gates@0.2.73
  - @cat-factory/integrations@0.56.4
  - @cat-factory/prompt-fragments@0.9.44

## 0.9.96

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/orchestration@0.59.2
  - @cat-factory/server@0.68.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/gates@0.2.72
  - @cat-factory/integrations@0.56.3
  - @cat-factory/prompt-fragments@0.9.43

## 0.9.95

### Patch Changes

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/server@0.68.1
  - @cat-factory/kernel@0.70.1
  - @cat-factory/orchestration@0.59.1
  - @cat-factory/agents@0.26.14
  - @cat-factory/gates@0.2.71

## 0.9.94

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0
  - @cat-factory/orchestration@0.59.0
  - @cat-factory/server@0.68.0
  - @cat-factory/agents@0.26.13
  - @cat-factory/gates@0.2.70
  - @cat-factory/integrations@0.56.1

## 0.9.93

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/server@0.67.0
  - @cat-factory/agents@0.26.12
  - @cat-factory/gates@0.2.69
  - @cat-factory/kernel@0.69.8
  - @cat-factory/orchestration@0.58.1
  - @cat-factory/prompt-fragments@0.9.42

## 0.9.92

### Patch Changes

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/orchestration@0.58.0
  - @cat-factory/server@0.66.7
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/gates@0.2.68

## 0.9.91

### Patch Changes

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10
  - @cat-factory/orchestration@0.57.7
  - @cat-factory/server@0.66.6

## 0.9.90

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/server@0.66.5
  - @cat-factory/orchestration@0.57.6
  - @cat-factory/agents@0.26.9
  - @cat-factory/gates@0.2.67
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41

## 0.9.89

### Patch Changes

- Updated dependencies [6347d0e]
- Updated dependencies [6439181]
  - @cat-factory/server@0.66.4

## 0.9.88

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/server@0.66.3
  - @cat-factory/agents@0.26.8
  - @cat-factory/gates@0.2.66
  - @cat-factory/kernel@0.69.5
  - @cat-factory/orchestration@0.57.5
  - @cat-factory/prompt-fragments@0.9.40

## 0.9.87

### Patch Changes

- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/server@0.66.2
  - @cat-factory/orchestration@0.57.4

## 0.9.86

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/orchestration@0.57.3
  - @cat-factory/integrations@0.54.1
  - @cat-factory/server@0.66.1
  - @cat-factory/agents@0.26.6
  - @cat-factory/gates@0.2.65
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39

## 0.9.85

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/server@0.66.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/gates@0.2.64
  - @cat-factory/kernel@0.69.3
  - @cat-factory/orchestration@0.57.2
  - @cat-factory/prompt-fragments@0.9.38

## 0.9.84

### Patch Changes

- d7f6e1c: Correctness fixes across the engine, the Node facade, and the SPA stores:

  - **Engine:** `finalizeMerge` and the merger resolver are now idempotent under
    durable-driver replays — a re-resolved merger step on an already-`done` (= merged)
    block is a no-op instead of re-merging, downgrading the block to `pr_ready`, and
    raising a spurious `merge_review` notification. `approveStep` now runs under the same
    optimistic-concurrency write as its siblings (`resolveDecision`/`requestStepChanges`),
    so an approve holding a stale snapshot can no longer resurrect a run a racing reject
    already failed (it now returns 409).
  - **CI gate (behavior change):** a check run concluding `stale` (superseded by GitHub)
    no longer fails the CI gate — previously it looped the `ci-fixer` against a check it
    could never fix until the attempt budget failed the run. `cancelled`/`timed_out`/
    `action_required` still fail the gate.
  - **Node facade parity:** the retention sweep now prunes the `github_commits`
    projection to `retention.commitMs` (previously it grew without bound; the Worker
    already pruned it), and a new every-2-min GitHub reconcile sweeper re-syncs stale
    repo projections and tombstones uninstalled installations — the backstop for missed
    webhooks the Worker's `github-reconcile` cron already provided.
  - **SPA stores:** the execution store now reconciles snapshots/events monotonically by
    the run's `rev` (a lagging refresh can no longer revert a just-terminal run to
    `running`), the requirements/clarity/brainstorm stores guard live-event upserts by
    `updatedAt` (out-of-order events no longer revert just-submitted answers), and
    `board.moveBlock`/`updateBlock` roll their optimistic mutation back on API failure.

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/orchestration@0.57.1
  - @cat-factory/contracts@0.80.1
  - @cat-factory/integrations@0.53.2
  - @cat-factory/server@0.65.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/gates@0.2.63
  - @cat-factory/prompt-fragments@0.9.37

## 0.9.83

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/orchestration@0.57.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/gates@0.2.62
  - @cat-factory/integrations@0.53.1
  - @cat-factory/prompt-fragments@0.9.36
  - @cat-factory/server@0.65.1

## 0.9.82

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/orchestration@0.56.0
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/server@0.65.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/gates@0.2.61
  - @cat-factory/prompt-fragments@0.9.35

## 0.9.81

### Patch Changes

- Updated dependencies [16ee6cc]
- Updated dependencies [16ee6cc]
  - @cat-factory/orchestration@0.55.1
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/server@0.64.4
  - @cat-factory/agents@0.26.1
  - @cat-factory/gates@0.2.60
  - @cat-factory/integrations@0.52.2
  - @cat-factory/prompt-fragments@0.9.34

## 0.9.80

### Patch Changes

- Updated dependencies [6da6637]
  - @cat-factory/server@0.64.3

## 0.9.79

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/orchestration@0.55.0
  - @cat-factory/gates@0.2.59
  - @cat-factory/integrations@0.52.1
  - @cat-factory/prompt-fragments@0.9.33
  - @cat-factory/server@0.64.2

## 0.9.78

### Patch Changes

- Updated dependencies [08be94c]
  - @cat-factory/orchestration@0.54.1
  - @cat-factory/server@0.64.1

## 0.9.77

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [456a992]
- Updated dependencies [1d2684f]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/server@0.64.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/orchestration@0.54.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/gates@0.2.58
  - @cat-factory/prompt-fragments@0.9.32

## 0.9.76

### Patch Changes

- Updated dependencies [3135ae8]
  - @cat-factory/server@0.63.3

## 0.9.75

### Patch Changes

- Updated dependencies [39534d6]
  - @cat-factory/server@0.63.2

## 0.9.74

### Patch Changes

- Updated dependencies [eab2b60]
  - @cat-factory/server@0.63.1

## 0.9.73

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/server@0.63.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/gates@0.2.57
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/orchestration@0.53.2
  - @cat-factory/prompt-fragments@0.9.31

## 0.9.72

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/orchestration@0.53.1
  - @cat-factory/agents@0.24.15
  - @cat-factory/gates@0.2.56
  - @cat-factory/integrations@0.51.3
  - @cat-factory/server@0.62.3
  - @cat-factory/prompt-fragments@0.9.30

## 0.9.71

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/orchestration@0.53.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/gates@0.2.55
  - @cat-factory/integrations@0.51.2
  - @cat-factory/prompt-fragments@0.9.29
  - @cat-factory/server@0.62.2

## 0.9.70

### Patch Changes

- Updated dependencies [d4d4cbc]
  - @cat-factory/server@0.62.1
  - @cat-factory/integrations@0.51.1
  - @cat-factory/orchestration@0.52.1

## 0.9.69

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/integrations@0.51.0
  - @cat-factory/server@0.62.0
  - @cat-factory/orchestration@0.52.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/gates@0.2.54
  - @cat-factory/prompt-fragments@0.9.28

## 0.9.68

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/server@0.61.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/gates@0.2.53
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/orchestration@0.51.7
  - @cat-factory/prompt-fragments@0.9.27

## 0.9.67

### Patch Changes

- Updated dependencies [37c488f]
  - @cat-factory/server@0.60.3

## 0.9.66

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1
  - @cat-factory/orchestration@0.51.6
  - @cat-factory/server@0.60.2

## 0.9.65

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/gates@0.2.52
  - @cat-factory/kernel@0.63.3
  - @cat-factory/orchestration@0.51.5
  - @cat-factory/prompt-fragments@0.9.26
  - @cat-factory/server@0.60.1

## 0.9.64

### Patch Changes

- Updated dependencies [79a0f48]
- Updated dependencies [91f876b]
  - @cat-factory/integrations@0.49.0
  - @cat-factory/server@0.60.0
  - @cat-factory/orchestration@0.51.4

## 0.9.63

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/server@0.59.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/gates@0.2.51
  - @cat-factory/orchestration@0.51.3
  - @cat-factory/prompt-fragments@0.9.25

## 0.9.62

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1
  - @cat-factory/orchestration@0.51.2
  - @cat-factory/server@0.59.1

## 0.9.61

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/server@0.59.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/gates@0.2.50
  - @cat-factory/kernel@0.63.1
  - @cat-factory/orchestration@0.51.1
  - @cat-factory/prompt-fragments@0.9.24

## 0.9.60

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/orchestration@0.51.0
  - @cat-factory/server@0.58.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/gates@0.2.49
  - @cat-factory/integrations@0.47.1
  - @cat-factory/prompt-fragments@0.9.23

## 0.9.59

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/server@0.57.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/gates@0.2.48
  - @cat-factory/kernel@0.62.4
  - @cat-factory/orchestration@0.50.1
  - @cat-factory/prompt-fragments@0.9.22

## 0.9.58

### Patch Changes

- Updated dependencies [3ec9c90]
  - @cat-factory/server@0.56.1

## 0.9.57

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/integrations@0.46.0
  - @cat-factory/orchestration@0.50.0
  - @cat-factory/server@0.56.0
  - @cat-factory/agents@0.24.6
  - @cat-factory/gates@0.2.47
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21

## 0.9.56

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/orchestration@0.49.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/gates@0.2.46
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20
  - @cat-factory/server@0.55.2

## 0.9.55

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/orchestration@0.48.2
  - @cat-factory/agents@0.24.4
  - @cat-factory/gates@0.2.45
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19
  - @cat-factory/server@0.55.1

## 0.9.54

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/server@0.55.0
  - @cat-factory/contracts@0.65.0
  - @cat-factory/orchestration@0.48.1
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/gates@0.2.44
  - @cat-factory/prompt-fragments@0.9.18

## 0.9.53

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/integrations@0.43.0
  - @cat-factory/orchestration@0.48.0
  - @cat-factory/server@0.54.0
  - @cat-factory/agents@0.24.2
  - @cat-factory/gates@0.2.43
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17

## 0.9.52

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/server@0.53.0
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/gates@0.2.42
  - @cat-factory/integrations@0.42.1
  - @cat-factory/orchestration@0.47.1
  - @cat-factory/prompt-fragments@0.9.16

## 0.9.51

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/agents@0.24.0
  - @cat-factory/orchestration@0.47.0
  - @cat-factory/integrations@0.42.0
  - @cat-factory/server@0.52.0
  - @cat-factory/gates@0.2.41
  - @cat-factory/prompt-fragments@0.9.15

## 0.9.50

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/gates@0.2.40
  - @cat-factory/integrations@0.41.1
  - @cat-factory/orchestration@0.46.1
  - @cat-factory/server@0.51.3
  - @cat-factory/prompt-fragments@0.9.14

## 0.9.49

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/integrations@0.41.0
  - @cat-factory/orchestration@0.46.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/gates@0.2.39
  - @cat-factory/server@0.51.2
  - @cat-factory/prompt-fragments@0.9.13

## 0.9.48

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/orchestration@0.45.3
  - @cat-factory/server@0.51.1
  - @cat-factory/gates@0.2.38

## 0.9.47

### Patch Changes

- Updated dependencies [bd23c46]
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/server@0.51.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/gates@0.2.37
  - @cat-factory/orchestration@0.45.2
  - @cat-factory/prompt-fragments@0.9.12

## 0.9.46

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0
  - @cat-factory/orchestration@0.45.1
  - @cat-factory/server@0.50.3

## 0.9.45

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/orchestration@0.45.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/server@0.50.2
  - @cat-factory/gates@0.2.36
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11

## 0.9.44

### Patch Changes

- Updated dependencies [1ff013f]
  - @cat-factory/server@0.50.1
  - @cat-factory/orchestration@0.44.1
  - @cat-factory/gates@0.2.35

## 0.9.43

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/kernel@0.56.0
  - @cat-factory/server@0.50.0
  - @cat-factory/orchestration@0.44.0
  - @cat-factory/integrations@0.38.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/gates@0.2.34
  - @cat-factory/prompt-fragments@0.9.10

## 0.9.42

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/orchestration@0.43.4
  - @cat-factory/integrations@0.37.1
  - @cat-factory/agents@0.22.5
  - @cat-factory/gates@0.2.33
  - @cat-factory/server@0.49.6

## 0.9.41

### Patch Changes

- Updated dependencies [0dd9532]
  - @cat-factory/server@0.49.5

## 0.9.40

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/integrations@0.37.0
  - @cat-factory/orchestration@0.43.3
  - @cat-factory/server@0.49.4
  - @cat-factory/agents@0.22.4
  - @cat-factory/gates@0.2.32
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9

## 0.9.39

### Patch Changes

- Updated dependencies [123336c]
  - @cat-factory/server@0.49.3

## 0.9.38

### Patch Changes

- Updated dependencies [4ec514a]
  - @cat-factory/server@0.49.2

## 0.9.37

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/server@0.49.1
  - @cat-factory/agents@0.22.3
  - @cat-factory/gates@0.2.31
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/orchestration@0.43.2
  - @cat-factory/prompt-fragments@0.9.8

## 0.9.36

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/integrations@0.36.0
  - @cat-factory/server@0.49.0
  - @cat-factory/agents@0.22.2
  - @cat-factory/gates@0.2.30
  - @cat-factory/kernel@0.55.1
  - @cat-factory/orchestration@0.43.1
  - @cat-factory/prompt-fragments@0.9.7

## 0.9.35

### Patch Changes

- d5a0637: Close the GitLab-vs-GitHub provider parity gaps so a GitLab deployment behaves like a GitHub
  one across every runtime facade.

  - **Facade parity (the showstopper):** the engine's CI / mergeability / PR-review gate
    providers, the PR merger, the branch updater and the checkout-free `RepoFiles` resolvers are
    now wired from a GitLab-backed client on the **Node and Cloudflare** facades too — previously
    only local mode bridged GitLab into the gates, so a stock GitLab-only Node/CF deployment did
    not gate on real CI or merge for real. Both facades now build the engine VCS client via the
    shared `buildGitLabEngineClient` (GitHub App wins when both are configured).
  - **Review provider:** `FetchGitLabClient` now implements the human-review reads
    (`getPullRequestBaseRef`, `listRequestedReviewers`, `listPullRequestReviews` +
    `getRequiredApprovingReviewCount` from GitLab approvals, `listReviewThreads` /
    `replyToReviewThread` / `resolveReviewThread` over resolvable MR discussions, plus
    `listIssueComments`).
  - **Branch update:** new optional `VcsClient.rebasePullRequest` / `GitHubClient.rebasePullRequest`
    — GitLab has no server-side merge-branch-into-branch endpoint, so the conflicts / human-testing
    gate's "pull latest base" action advances a GitLab MR branch by rebasing it; `GitHubBranchUpdater`
    prefers rebase when the client exposes it and falls back to `mergeBranch` (GitHub) otherwise.
  - **Conformance:** the cross-provider VCS client suite now asserts GitHub and GitLab normalise the
    human-review gate inputs identically and exposes the correct branch-advancing capability per
    provider; a reusable `FakeVcsClient` drives the real gate / merge / branch-update providers
    through the GitLab-backed adapter.
  - **Rebase verdict robustness:** the GitLab MR-rebase poll now sleeps before each status read (so
    a not-yet-started async rebase is never mistaken for a finished one) and decides the outcome by
    whether the source-branch head actually advanced, ignoring the persisted `merge_error` field
    (shared with merge attempts) unless the branch did not move. Covered by poll-transition,
    stale-`merge_error`, conflict and up-to-date tests.
  - **Accurate required-approval count:** `getRequiredApprovingReviewCount` now reads the effective
    per-MR `approvals_required` (it accounts for the rule on the MR's target branch) when the PR
    number is known, falling back to the project default; the port carries the PR number alongside
    the branch (GitHub still reads branch protection and ignores it).
  - **Node facade wiring:** the GitLab-backed engine client feeds only the gate / merge / RepoFiles
    seams; GitHub-issue-specific consumers (the GitHub Issues task source, issue writeback) stay
    gated on a real GitHub client, so a GitLab-only Node deployment no longer offers a
    non-functional "GitHub Issues" task source (parity with the Worker).

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/server@0.48.4
  - @cat-factory/orchestration@0.43.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/gates@0.2.29
  - @cat-factory/integrations@0.35.4
  - @cat-factory/prompt-fragments@0.9.6

## 0.9.34

### Patch Changes

- Updated dependencies [b76f303]
  - @cat-factory/orchestration@0.42.1
  - @cat-factory/server@0.48.3

## 0.9.33

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/orchestration@0.42.0
  - @cat-factory/server@0.48.2
  - @cat-factory/agents@0.22.0
  - @cat-factory/gates@0.2.28
  - @cat-factory/integrations@0.35.3
  - @cat-factory/prompt-fragments@0.9.5

## 0.9.32

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2
  - @cat-factory/orchestration@0.41.4
  - @cat-factory/server@0.48.1

## 0.9.31

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/server@0.48.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/gates@0.2.27
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/orchestration@0.41.3
  - @cat-factory/prompt-fragments@0.9.4

## 0.9.30

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/kernel@0.53.0
  - @cat-factory/integrations@0.35.0
  - @cat-factory/server@0.47.0
  - @cat-factory/orchestration@0.41.2
  - @cat-factory/agents@0.21.16
  - @cat-factory/gates@0.2.26
  - @cat-factory/prompt-fragments@0.9.3

## 0.9.29

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/server@0.46.3
  - @cat-factory/orchestration@0.41.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/gates@0.2.25
  - @cat-factory/prompt-fragments@0.9.2

## 0.9.28

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/orchestration@0.41.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/gates@0.2.24
  - @cat-factory/prompt-fragments@0.9.1
  - @cat-factory/server@0.46.2

## 0.9.27

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/prompt-fragments@0.9.0
  - @cat-factory/server@0.46.1
  - @cat-factory/orchestration@0.40.2
  - @cat-factory/agents@0.21.13
  - @cat-factory/gates@0.2.23

## 0.9.26

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/server@0.46.0
  - @cat-factory/orchestration@0.40.1
  - @cat-factory/agents@0.21.12
  - @cat-factory/gates@0.2.22
  - @cat-factory/prompt-fragments@0.8.9

## 0.9.25

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/kernel@0.48.0
  - @cat-factory/server@0.45.0
  - @cat-factory/integrations@0.31.0
  - @cat-factory/orchestration@0.40.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/gates@0.2.21
  - @cat-factory/prompt-fragments@0.8.8

## 0.9.24

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/server@0.44.0
  - @cat-factory/orchestration@0.39.2
  - @cat-factory/agents@0.21.10
  - @cat-factory/gates@0.2.20
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7

## 0.9.23

### Patch Changes

- Updated dependencies [2961b05]
  - @cat-factory/server@0.43.0

## 0.9.22

### Patch Changes

- Updated dependencies [5ad45de]
  - @cat-factory/orchestration@0.39.1
  - @cat-factory/server@0.42.1

## 0.9.21

### Patch Changes

- Updated dependencies [3d0b85c]
  - @cat-factory/server@0.42.0
  - @cat-factory/integrations@0.29.0
  - @cat-factory/orchestration@0.39.0

## 0.9.20

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/server@0.41.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/gates@0.2.19
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/orchestration@0.38.1
  - @cat-factory/prompt-fragments@0.8.6

## 0.9.19

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/server@0.41.0
  - @cat-factory/orchestration@0.38.0
  - @cat-factory/agents@0.21.8
  - @cat-factory/gates@0.2.18
  - @cat-factory/prompt-fragments@0.8.5

## 0.9.18

### Patch Changes

- Updated dependencies [0784fe0]
- Updated dependencies [0784fe0]
  - @cat-factory/orchestration@0.37.3
  - @cat-factory/server@0.40.3

## 0.9.17

### Patch Changes

- Updated dependencies [5e54936]
- Updated dependencies [5e54936]
  - @cat-factory/orchestration@0.37.2
  - @cat-factory/server@0.40.2

## 0.9.16

### Patch Changes

- Updated dependencies [cc101a7]
  - @cat-factory/orchestration@0.37.1
  - @cat-factory/server@0.40.1

## 0.9.15

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/orchestration@0.37.0
  - @cat-factory/kernel@0.46.0
  - @cat-factory/integrations@0.27.0
  - @cat-factory/server@0.40.0
  - @cat-factory/agents@0.21.7
  - @cat-factory/gates@0.2.17
  - @cat-factory/prompt-fragments@0.8.4

## 0.9.14

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/integrations@0.26.5
  - @cat-factory/orchestration@0.36.5
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6
  - @cat-factory/gates@0.2.16
  - @cat-factory/prompt-fragments@0.8.3

## 0.9.13

### Patch Changes

- @cat-factory/agents@0.21.5
- @cat-factory/gates@0.2.15
- @cat-factory/integrations@0.26.4
- @cat-factory/kernel@0.45.4
- @cat-factory/orchestration@0.36.4
- @cat-factory/prompt-fragments@0.8.2

## 0.9.12

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/orchestration@0.36.3
  - @cat-factory/agents@0.21.4
  - @cat-factory/gates@0.2.14
  - @cat-factory/integrations@0.26.3

## 0.9.11

### Patch Changes

- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/gates@0.2.13
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/orchestration@0.36.2
  - @cat-factory/prompt-fragments@0.8.1

## 0.9.10

### Patch Changes

- Updated dependencies [5363166]
- Updated dependencies [5363166]
  - @cat-factory/orchestration@0.36.1
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/gates@0.2.12
  - @cat-factory/integrations@0.26.1

## 0.9.9

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/kernel@0.45.0
  - @cat-factory/integrations@0.26.0
  - @cat-factory/orchestration@0.36.0
  - @cat-factory/prompt-fragments@0.8.0
  - @cat-factory/agents@0.21.1
  - @cat-factory/gates@0.2.11

## 0.9.8

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/orchestration@0.35.1

## 0.9.7

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/orchestration@0.35.0
  - @cat-factory/gates@0.2.10
  - @cat-factory/integrations@0.25.2
  - @cat-factory/prompt-fragments@0.7.41

## 0.9.6

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/gates@0.2.9
  - @cat-factory/integrations@0.25.1
  - @cat-factory/orchestration@0.34.1

## 0.9.5

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/integrations@0.25.0
  - @cat-factory/orchestration@0.34.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/gates@0.2.8
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40

## 0.9.4

### Patch Changes

- Updated dependencies [6903cd7]
  - @cat-factory/orchestration@0.33.0

## 0.9.3

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/gates@0.2.7
  - @cat-factory/integrations@0.24.1
  - @cat-factory/orchestration@0.32.1
  - @cat-factory/prompt-fragments@0.7.39

## 0.9.2

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/orchestration@0.32.0
  - @cat-factory/integrations@0.24.0
  - @cat-factory/gates@0.2.6
  - @cat-factory/prompt-fragments@0.7.38

## 0.9.1

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/orchestration@0.31.0
  - @cat-factory/gates@0.2.5
  - @cat-factory/integrations@0.23.5
  - @cat-factory/prompt-fragments@0.7.37

## 0.9.0

### Minor Changes

- 6d829bb: Make invalid-state pipelines more robust. On app open, a startup advisory surfaces pipelines that
  reference a nonexistent agent kind or have an invalid shape (delete a custom one, reseed a built-in)
  and built-in pipelines whose seeded definition is newer than the stored copy (reseed to adopt it).

  Built-in pipelines now carry a per-pipeline `version` (persisted on both runtimes via a new D1
  migration and a Drizzle column), the snapshot ships the current catalog versions
  (`pipelineCatalogVersions`), and a new `POST /workspaces/:ws/pipelines/:id/reseed` endpoint restores a
  built-in's canonical definition while preserving its labels/archive state.

  BREAKING: existing workspaces' persisted built-in pipelines have no stored `version`, so they read as
  "update available" once until reseeded — intentional adoption of the now-versioned definitions.

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/kernel@0.40.0
  - @cat-factory/orchestration@0.30.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/gates@0.2.4
  - @cat-factory/integrations@0.23.4
  - @cat-factory/prompt-fragments@0.7.36

## 0.8.7

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/kernel@0.39.0
  - @cat-factory/orchestration@0.29.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/gates@0.2.3
  - @cat-factory/integrations@0.23.3
  - @cat-factory/prompt-fragments@0.7.35

## 0.8.6

### Patch Changes

- @cat-factory/agents@0.18.3
- @cat-factory/gates@0.2.2
- @cat-factory/integrations@0.23.2
- @cat-factory/kernel@0.38.1
- @cat-factory/orchestration@0.28.3
- @cat-factory/prompt-fragments@0.7.34

## 0.8.5

### Patch Changes

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2
  - @cat-factory/orchestration@0.28.2

## 0.8.4

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/gates@0.2.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/orchestration@0.28.1
  - @cat-factory/prompt-fragments@0.7.33

## 0.8.3

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/gates@0.2.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/orchestration@0.28.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/prompt-fragments@0.7.32

## 0.8.2

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/integrations@0.22.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/orchestration@0.27.1
  - @cat-factory/agents@0.17.2
  - @cat-factory/gates@0.1.13
  - @cat-factory/prompt-fragments@0.7.31

## 0.8.1

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/kernel@0.35.0
  - @cat-factory/orchestration@0.27.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/gates@0.1.12
  - @cat-factory/integrations@0.21.7
  - @cat-factory/prompt-fragments@0.7.30

## 0.8.0

### Minor Changes

- 9f7ee39: Add "Requirements brainstorm" and "Architecture brainstorm" agents — structured-dialogue
  gates that PROPOSE options with explicit trade-offs and let a human converge on a direction,
  rather than doing all the work themselves or expecting the work done upfront.

  - One shared, stage-discriminated engine (`BrainstormService` over the existing
    `IterativeReviewService`), driven through the generic `ReviewGateController`. Two agent kinds
    (`requirements-brainstorm`, `architecture-brainstorm`) reuse it via a stage-bound repository
    adapter.
  - Persistence: a new `brainstorm_sessions` table keyed per (block, **stage**) — a block may hold
    a live requirements AND a live architecture session at once — mirrored across both runtimes
    (D1 + Drizzle/Postgres) with a cross-runtime conformance suite.
  - Handoffs (DB session state → next stage's prompt): `requirements-brainstorm` → the
    requirements review (its converged direction becomes the reviewed subject);
    `architecture-brainstorm` → the architect (surfaced additively as a prior output).
  - Pipelines: both steps are added to `pl_full` and `pl_fullstack` but **disabled by default**
    (opt-in per pipeline) — existing runs are unchanged.
  - Frontend: a shared brainstorm window (option cards with trade-offs → choose/steer/dismiss →
    incorporate → re-run), wired through the result-view seam, the workspace stream, and the
    palette catalog.

  Breaking: adds a new required table on both runtimes (`brainstorm_sessions` D1 migration +
  Drizzle migration) and a new optional `ExecutionEventPublisher.brainstormSessionChanged` event.
  No data migration — pre-1.0, stale state is acceptable.

  The brainstorm iteration cap reuses the merge preset's `maxRequirementIterations` /
  `maxRequirementConcernAllowed` knobs (no new preset field).

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/orchestration@0.26.0
  - @cat-factory/integrations@0.21.6
  - @cat-factory/gates@0.1.11
  - @cat-factory/prompt-fragments@0.7.29

## 0.7.44

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/orchestration@0.25.1

## 0.7.43

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0
  - @cat-factory/orchestration@0.25.0
  - @cat-factory/gates@0.1.10
  - @cat-factory/integrations@0.21.5
  - @cat-factory/prompt-fragments@0.7.28

## 0.7.42

### Patch Changes

- Updated dependencies [18f6b3b]
  - @cat-factory/integrations@0.21.4
  - @cat-factory/orchestration@0.24.2

## 0.7.41

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/kernel@0.32.0
  - @cat-factory/orchestration@0.24.1
  - @cat-factory/agents@0.15.2
  - @cat-factory/gates@0.1.9
  - @cat-factory/integrations@0.21.3
  - @cat-factory/prompt-fragments@0.7.27

## 0.7.40

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/orchestration@0.24.0
  - @cat-factory/agents@0.15.1
  - @cat-factory/gates@0.1.8
  - @cat-factory/integrations@0.21.2
  - @cat-factory/prompt-fragments@0.7.26

## 0.7.39

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/orchestration@0.23.0
  - @cat-factory/gates@0.1.7
  - @cat-factory/integrations@0.21.1
  - @cat-factory/prompt-fragments@0.7.25

## 0.7.38

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/integrations@0.21.0
  - @cat-factory/orchestration@0.22.0
  - @cat-factory/agents@0.14.9
  - @cat-factory/gates@0.1.6
  - @cat-factory/prompt-fragments@0.7.24

## 0.7.37

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/orchestration@0.21.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/gates@0.1.5
  - @cat-factory/integrations@0.20.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23

## 0.7.36

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/orchestration@0.21.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/integrations@0.20.0
  - @cat-factory/agents@0.14.7
  - @cat-factory/gates@0.1.4
  - @cat-factory/prompt-fragments@0.7.22

## 0.7.35

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/kernel@0.27.0
  - @cat-factory/integrations@0.19.0
  - @cat-factory/orchestration@0.20.0
  - @cat-factory/agents@0.14.6
  - @cat-factory/gates@0.1.3
  - @cat-factory/prompt-fragments@0.7.21

## 0.7.34

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/orchestration@0.19.2
  - @cat-factory/agents@0.14.5
  - @cat-factory/gates@0.1.2
  - @cat-factory/integrations@0.18.3

## 0.7.33

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/agents@0.14.4
  - @cat-factory/gates@0.1.1
  - @cat-factory/integrations@0.18.2
  - @cat-factory/orchestration@0.19.1

## 0.7.32

### Patch Changes

- f4f954b: Dogfood the extensible-gates seam: the built-in polling-gate suite (`ci`, `conflicts`,
  `post-release-health` + the `on-call` escalation) is no longer hard-coded in the engine —
  it ships as a new **`@cat-factory/gates`** package authored ENTIRELY through the public
  `registerGate` seam, depending only on kernel + contracts. If the platform's own gates can
  be expressed as an external package, so can any deployment's.

  **Breaking (pre-1.0, no migration):** the `ci` / `conflicts` / `post-release-health`
  providers leave the engine. `ciStatusProvider`, `mergeabilityProvider`,
  `releaseHealthProvider` and `incidentEnrichment` are removed from
  `ExecutionServiceDependencies` / `CoreDependencies`; a deployment now wires them into the
  gate suite via the exported `wireCiStatusProvider` / `wireMergeabilityProvider` /
  `wireReleaseHealthProvider` / `wireIncidentEnrichment` handles after
  `import '@cat-factory/gates'`. The merge collaborators (`pullRequestMerger`,
  `branchUpdater`) stay on the engine.

  - **gates (new)**: the three gate factories + the four provider wire-handles +
    `registerBuiltinGates()`, registered as an import side effect. Each gate is a
    pass-through until its provider is wired, so a bare import is always safe. Also exports
    `applyGateProviders(overrides)` + the `GateProviderOverrides` bag: a facade build resets
    the deployment-global providers up-front then re-wires from config, and this is the seam
    that re-applies explicit/faked providers AFTER that wiring (so they survive the Worker's
    per-request rebuild and override a config-wired provider) — used by the cross-runtime
    conformance suite to drive the externalized `ci` gate over a controlled verdict.
  - **kernel**: the pure gate logic (`aggregateCi`/`classifyReleaseHealth`/… +
    `renderReleaseEvidence`) and the gate/helper agent-kind constants move into
    `domain/gate-logic.ts` so a gate package can author a gate without depending on the
    engine. New `GateDefinition.resolveHelperCompletion` hook (+ `GateHelperJobResult` /
    `GateHelperCompletionArgs`): the seam an INVESTIGATE-don't-fix helper (`on-call`) needs
    to settle a gate without re-probing — the real gap the dogfood surfaced.
  - **orchestration**: the three inline gates + the bespoke `resolveOnCallStep` /
    `raiseReleaseRegression` / `enrichIncident` / `raiseCiFailed` branches are deleted; the
    engine builds its gate registry purely from what's registered, and drives an on-call-style
    helper completion through the generic `resolveHelperCompletion` hook. The **`merger`**
    step resolver stays a privileged built-in (reclassified): it owns terminal block status
    and executes a policy-gated real merge — a different archetype from the light, externally
    authorable resolvers, so it keeps its engine-internal access rather than the public seam.
  - **worker / node-server**: each facade `import`s `@cat-factory/gates` and wires its
    existing provider impls (`GitHubCiStatusProvider`, `RegistryReleaseHealthProvider`, …)
    via the `wireX` handles instead of threading them through the engine. `local-server`
    inherits this through `buildNodeContainer`.
  - **conformance**: a new cross-runtime assertion drives the externalized built-in `ci`
    gate (green pass-through, red → ci-fixer → re-probe) over a faked provider on both
    runtimes; the registered-gate test now restores the built-ins after clearing the shared
    registry.

- Updated dependencies [f4f954b]
  - @cat-factory/gates@0.1.0
  - @cat-factory/kernel@0.25.0
  - @cat-factory/orchestration@0.19.0
  - @cat-factory/agents@0.14.3
  - @cat-factory/integrations@0.18.1

## 0.7.31

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/kernel@0.24.0
  - @cat-factory/integrations@0.18.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/orchestration@0.18.1
  - @cat-factory/prompt-fragments@0.7.20

## 0.7.30

### Patch Changes

- 7346a4f: Make the polling **Gate** and **StepCompletionResolver** mechanisms externally
  extensible, so a company-authored deployment package can register its OWN full-blown gate
  (deterministic probe + helper/companion agent + exhaustion handling) or step resolver
  purely via an import side effect — exactly the way it already registers a custom agent
  kind. No fork, no engine patch, and no executor-harness image change (pure backend TS).

  - **kernel**: new `domain/gate-registry.ts` (`registerGate(kind, factory)` +
    `GateDefinition`/`GateContext`/`GateProbe`/`recordGateAttempt`/…) and
    `domain/step-resolver-registry.ts` (`registerStepResolver(kind, factory)` +
    `StepCompletionResolver`/`ResolverContext`/…), moved out of orchestration so an
    extension package depends only on kernel + agents. `RaiseNotificationInput` moved to
    `ports/notification-channel.ts` so the runtime-neutral `GateContext` can build one. A
    registered gate/resolver is a `(ctx) => Definition` factory the engine invokes once at
    registry-build time — solving the `this`-capture the built-in gates rely on while
    keeping them inline and unchanged.
  - **orchestration**: `ExecutionService.buildGateRegistry()` /
    `buildStepResolverRegistry()` now merge the deployment-registered factories with the
    built-ins (registered replaces built-in of the same kind, last-wins) via new
    `makeGateContext()`/`makeResolverContext()` seams; the gate/resolver types are
    re-exported from the package index for discovery.
  - **example-custom-agent**: registers a `license-check` gate (escalating to a new
    `license-fixer` agent kind) + an auditor step resolver + a `wireLicenseProvider` seam,
    proving a custom gate ships with zero engine changes.
  - **conformance**: a new cross-runtime assertion drives a registered custom gate
    (pass-through, escalate-then-pass) and a registered step resolver on both runtimes.

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/orchestration@0.18.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/integrations@0.17.1

## 0.7.29

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/integrations@0.17.0
  - @cat-factory/orchestration@0.17.0
  - @cat-factory/prompt-fragments@0.7.19

## 0.7.28

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/orchestration@0.16.0
  - @cat-factory/integrations@0.16.1
  - @cat-factory/prompt-fragments@0.7.18

## 0.7.27

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/integrations@0.16.0
  - @cat-factory/orchestration@0.15.0

## 0.7.26

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/kernel@0.19.0
  - @cat-factory/orchestration@0.14.0
  - @cat-factory/integrations@0.15.0
  - @cat-factory/agents@0.11.16
  - @cat-factory/prompt-fragments@0.7.17

## 0.7.25

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/kernel@0.18.0
  - @cat-factory/orchestration@0.13.0
  - @cat-factory/integrations@0.14.0
  - @cat-factory/agents@0.11.15
  - @cat-factory/prompt-fragments@0.7.16

## 0.7.24

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/kernel@0.17.0
  - @cat-factory/integrations@0.13.0
  - @cat-factory/orchestration@0.12.0
  - @cat-factory/agents@0.11.14
  - @cat-factory/prompt-fragments@0.7.15

## 0.7.23

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13
  - @cat-factory/orchestration@0.11.1
  - @cat-factory/integrations@0.12.4
  - @cat-factory/prompt-fragments@0.7.14

## 0.7.22

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/orchestration@0.11.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12
  - @cat-factory/integrations@0.12.3
  - @cat-factory/prompt-fragments@0.7.13

## 0.7.21

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/integrations@0.12.2
  - @cat-factory/orchestration@0.10.9

## 0.7.20

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/integrations@0.12.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/orchestration@0.10.8

## 0.7.19

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/integrations@0.12.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/orchestration@0.10.7
  - @cat-factory/prompt-fragments@0.7.12

## 0.7.18

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8
  - @cat-factory/orchestration@0.10.6

## 0.7.17

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/kernel@0.14.0
  - @cat-factory/integrations@0.11.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/orchestration@0.10.5
  - @cat-factory/prompt-fragments@0.7.11

## 0.7.16

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/orchestration@0.10.4
  - @cat-factory/kernel@0.13.4
  - @cat-factory/integrations@0.10.4

## 0.7.15

### Patch Changes

- @cat-factory/agents@0.11.5
- @cat-factory/integrations@0.10.3
- @cat-factory/kernel@0.13.3
- @cat-factory/orchestration@0.10.3
- @cat-factory/prompt-fragments@0.7.10

## 0.7.14

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/orchestration@0.10.2
  - @cat-factory/integrations@0.10.2
  - @cat-factory/prompt-fragments@0.7.9

## 0.7.13

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/orchestration@0.10.1
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3
  - @cat-factory/integrations@0.10.1

## 0.7.12

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/kernel@0.13.0
  - @cat-factory/integrations@0.10.0
  - @cat-factory/orchestration@0.10.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/prompt-fragments@0.7.8

## 0.7.11

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1
  - @cat-factory/orchestration@0.9.1

## 0.7.10

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/orchestration@0.9.0
  - @cat-factory/integrations@0.9.0
  - @cat-factory/prompt-fragments@0.7.7

## 0.7.9

### Patch Changes

- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/integrations@0.8.3
  - @cat-factory/kernel@0.11.1
  - @cat-factory/orchestration@0.8.1

## 0.7.8

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/kernel@0.11.0
  - @cat-factory/orchestration@0.8.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/integrations@0.8.2
  - @cat-factory/prompt-fragments@0.7.6

## 0.7.7

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/agents@0.9.0
  - @cat-factory/integrations@0.8.1
  - @cat-factory/kernel@0.10.1
  - @cat-factory/orchestration@0.7.7
  - @cat-factory/prompt-fragments@0.7.5

## 0.7.6

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/kernel@0.10.0
  - @cat-factory/integrations@0.8.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/orchestration@0.7.6
  - @cat-factory/prompt-fragments@0.7.4

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/integrations@0.7.5
  - @cat-factory/orchestration@0.7.5

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/orchestration@0.7.4
  - @cat-factory/integrations@0.7.4
  - @cat-factory/prompt-fragments@0.7.3

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/integrations@0.7.3
  - @cat-factory/orchestration@0.7.3

## 0.7.2

### Patch Changes

- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/integrations@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/orchestration@0.7.2
  - @cat-factory/prompt-fragments@0.7.2

## 0.7.1

### Patch Changes

- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/integrations@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/orchestration@0.7.1
  - @cat-factory/prompt-fragments@0.7.1

## 0.7.0

### Minor Changes

- 7cf2a2d: Improve the pipeline builder experience:

  - **Grouped, collapsible agent palette** — archetypes are now organized into
    meaningful categories (Review & triage, Design & research, Implementation,
    Testing, Documentation, Gates & observability) that collapse/expand, with the
    collapsed state remembered across builder opens.
  - **Pipeline labels + archive/unarchive** — pipelines (built-in and custom) carry
    free-form labels and an archived flag for organizing the library: filter by
    label, hide archived behind a toggle, and archive without deleting. Exposed via
    a new `PATCH /workspaces/:ws/pipelines/:id/organize` endpoint (the only mutation
    a read-only built-in accepts). New `pipelines.labels` / `pipelines.archived`
    columns mirror across D1 and Drizzle/Postgres.
  - **Dependent companions are now gated toggles on their producer** — the three
    companions (reviewer→coder, architect-companion→architect, spec-companion→
    spec-writer) leave the free palette and are attached to their producer step in
    the builder. Each can be optionally **gated on the task estimate** (run only when
    complexity/risk/impact ≥ a threshold, OR across axes) via a new per-step
    `gating` array; a gated step is transparently skipped at runtime when the
    estimate falls below the bar. A pipeline with any enabled gating **requires a
    `task-estimator` earlier in the chain** or it refuses to save/start. Gating is
    additionally restricted to **companion steps** (skipping a producer would starve
    its downstream steps) and **requires at least one axis threshold** (an enabled gate
    with none would always skip); both are enforced by the shared `validatePipelineShape`
    at save, clone, and run start. A companion must now run **immediately after** an
    enabled producer it can review — `validatePipelineShape` enforces strict adjacency
    (over the enabled subset) on every facade, matching the builder, which surfaces
    companions as toggles attached to their producer. A pipeline that slips another step
    between a producer and its companion is rejected at save / clone / run start.

  **Breaking (pre-1.0, no migration):** the `Pipeline` wire shape gains optional
  `gating`, `labels`, and `archived` fields, and `PipelineStep` gains `gating` /
  `skipped`. The built-in pipelines are unchanged in behaviour.

### Patch Changes

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- Updated dependencies [fe53445]
- Updated dependencies [8eed38c]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [3e7ab89]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [ec0c416]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [14840ec]
- Updated dependencies [4030da2]
- Updated dependencies [268c15d]
- Updated dependencies [c9d3f49]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [794b628]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [1a0686f]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [f9d3647]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [c664fe6]
- Updated dependencies [7d5e060]
- Updated dependencies [4a08935]
- Updated dependencies [2796a42]
- Updated dependencies [6406c8c]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [ba1c0cf]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [cc39497]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [2ab06b5]
- Updated dependencies [21ca647]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [e0230a0]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [b98923c]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/integrations@0.7.0
  - @cat-factory/orchestration@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
