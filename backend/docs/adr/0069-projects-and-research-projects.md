# ADR 0069: Projects, and research projects as their first kind

- **Status:** Accepted (implemented)
- **Date:** 2026-11-07
- **Context layer:** `@cat-factory/contracts` (`projects.ts`, `project-definitions.ts`,
  `project-outcomes.ts`, `project-view.ts`, `public-projects.ts`, and the research kind's
  `research.ts` and `research-view.ts`), `@cat-factory/kernel` (`ProjectKindRegistry`,
  `ProjectDefinitionRegistry`, `ProjectKindModule` and its registry, the research kind's module,
  the project definition, record and task-project-link ports, `resolveOutcomeStoragePolicy`),
  `@cat-factory/orchestration` (`modules/projects/`, `CredentialWaitController`,
  `linked-context.ts`), `@cat-factory/server` (the project, outcome-storage and public
  controllers, `projectJobBody.ts`, the `/internal/*` reads), the executor harness's `project` job
  kind, both runtime facades, and `frontend/app` (`components/projects/`, the `projectViews` slot,
  `components/research/`). Product page: the catfactory.ai guide to research projects.

## Context

A team about to build a complex third-party integration does not yet know how the vendor works.
Finding out takes hands-on work in two places: preparing test data and configuration in the
vendor's UI, and calling the vendor's API to see what it returns. The work spans several services
or none, runs many times against one evolving body of results, needs vendor credentials a person
has to create, and produces a durable result that later work must be able to read.

Research is the first of a family. Architectural design, requirements drafting and other
solutioning have the same shape: a body of tasks that belongs together, produces a durable result
other work consumes, and is owned by no service. They differ in what the result holds and how
successive results combine, and in nothing the platform has to understand to store, order, size,
reclaim, serve or link them.

Before this decision none of that had a home:

- Every task belonged to a service, and repo resolution walked a task's ancestry to that service's
  repository. Work spanning several services, or none, had nowhere to live.
- A spike is a single task that clones a repo, answers one question and delivers a Markdown file
  through a pull request. It has the wrong shape for repeated, repo-less, credentialed work.
- No container run worked without a repository: the executor refused, and the harness job parse
  required a repo, branch and token.
- A capability credential a step needed but could not resolve was dropped silently: the tool
  server was withheld and the variable left unset.
- Nothing a run produced could be linked to a later task as context.

## Decision

### Projects are account-owned peers of services

A project owns a root block (level and type `project`) whose tasks are ordinary blocks beneath it,
so the engine's block-keyed machinery (executions, one live run per block, notifications, the
inspector, live events, RBAC) works unchanged. It is account-owned and mounted onto boards exactly
as a service is: a mount names a subject (`subjectKind` `service` or `project`, plus `subjectId`),
blocks and runs carry the owning subject's id as `owner_id`, and the workspace-delete cascade
re-homes a mounted project to a surviving board before it runs.

A project links to zero or more services as read-only context. `resolveRepoTarget` stops at a
project root and refuses with `project_has_no_writable_repo`; a project's tasks read the linked
services' repositories as reference checkouts and never write to one.

### A kind is a descriptor and a module; the platform knows neither's content

A project's kind has two halves, both injected by reference on `start()`, `startLocal()` and the
Worker:

- its **descriptor**, on the `ProjectKindRegistry`: the task types its projects offer (each with a
  default pipeline and a `repoAccess` of `none` or `linked-read-only`) and whether a project pins a
  definition (`definition: 'required' | 'optional'`, absent for a kind that pins none). In
  mothership mode a node reads the descriptors over `GET /internal/project-kinds`, and a failed
  read refuses with `project_kinds_unreachable`;
- its **module**, on the `ProjectKindModuleRegistry`: the code that understands the kind's content.
  It validates a definition's `spec`, decodes an outcome body, plans a task and writes its agent's
  brief, finishes a task into an outcome body, names the artifacts a body references, summarizes a
  definition for a picker, and optionally computes the project's `view`, renders it as linked
  context (`renderContext`) and declares the schemas of its spec, body and view.

The engine owns everything else about a project task's run: the pin and its hash check, the task's
sequence claim, the state fixed on the step, the outcome write and its storage placement, and the
credential park. It calls a module only where content matters. The platform registers one kind,
`research`, and a deployment registers its own the same way.

### Definitions are an envelope with an opaque spec

A project definition is versioned and immutable per version. Its envelope is the platform's: the
kind, a key, a version, a title, the credentials its runs need (declared by name, never valued,
each with onboarding instructions and whether it is needed at start), the `targets` a credential
may be sent to, optional per-project `inputs` in the descriptor form vocabulary, and per-agent-kind
`promptAdditions`. Its `spec` is the kind's, validated by the kind's module.

Definitions come from two producers and are read through one port, `ProjectDefinitionSource`, keyed
by kind:

- code, on a `ProjectDefinitionRegistry` a deployment registers on, which validates each definition
  with its kind's module at registration (an entry-point option, and
  `GET /internal/project-definitions` for a mothership node);
- data, through `PUT /api/v1/project-kinds/{kind}/definitions/{key}/versions/{version}`,
  account-scoped. The same validation applies (`project_definition_invalid` with each problem), a
  published version is immutable (`project_definition_version_exists`), and a stored key in a
  namespace the registered definitions of that kind use is refused
  (`project_definition_key_registered`).

A project of a kind that pins a definition pins one version with its content hash and its input
values at creation. A dispatch whose registered definition no longer hashes to the pin refuses
(`project_definition_changed`) rather than running a definition the project never agreed to.

### Outcomes are immutable revisions in streams

Each project task writes one outcome on its project: an envelope (stream, sequence number, intent
in the kind's vocabulary, the body's schema version, the task, the pinned definition, the artifacts
it references) and a body the kind owns. Outcomes are ordered by a sequence number each task claims
the first time it starts (`reserveTaskSeq`, read back unchanged on a replay or retry), so two
follow-ups fold in the order they were asked, whatever order they finish in. An outcome is written
once and never upserted. A kind that needs two kinds of result writes two streams rather than one
body with two jobs, and `schemaVersion` lets a kind change its body shape and still read what it
wrote before.

How outcomes combine is the main way kinds differ, so the current state is the kind's `view`.
Research folds answers per question id: a newer answer with content replaces an older one, and a
newer `unanswered` or `blocked` is kept beside it as a note rather than erasing it. A design or a
requirements draft would more naturally take the newest outcome as the document.

`ProjectOutcomeStore` is the one reader and writer of outcome bodies, for every kind, holding a body
as opaque JSON. A body is stored inline while it is at or under the effective threshold and
offloaded to the account's blob store above it, as an `outcome` artifact anchored on the project's
root block in its home workspace, exempt from the age-based sweep, reclaimed with the project and
carried with it when its home board is deleted. The threshold policy cascades account, then
workspace (the board that started the run), then project, narrowest set value winning. A body over
the runtime's own row ceiling that cannot be offloaded is refused with
`outcome_too_large_for_inline`, and an offloaded body the store cannot serve is refused with
`outcome_body_unavailable` on a run's read and listed as unreadable on a reader's.

### Research is the built-in kind

A research definition's spec is a brief and topics of questions with stable ids. Each research run
is a task of the built-in `research` task type, offered only under a project
(`task_type_requires_project` under a service), on the `pl_research` pipeline. Its mode selects the
questions: `initial` (every question), `extend` (questions not asked before, including the task's
own ad-hoc questions), `clarify` (partial or blocked answers, or named ones) and `refresh`
(re-verify everything); a mode that selects nothing refuses with `research_nothing_to_ask`. A
follow-up is a new task in the same project, so the project's task list is its research history.
Ad-hoc question ids are namespaced to their task, and their text is stored on the outcome that
answers them. The research outcome body records, per question, a status (`answered`, `partial`,
`unanswered`, `blocked`), an answer, a confidence, evidence and caveats, plus run-level learnings
and a summary.

The `project-researcher` kind runs on the `container-project` surface and the `ui` image, as a
repo-less harness job of kind `project`. One headless Chromium per job serves both the Playwright
MCP server and the harness's access tool server over CDP. The access tool server keeps secrets out
of the model: `fill_secret` types a stored credential into a page field and `http_request` attaches
one to a request, both harness-side, and both refuse an origin outside the definition's `targets`.
`request_credential` ends the step asking for a credential that does not resolve. Every response
and page value is scrubbed with `redactSecrets` before it reaches the model or the outcome. Egress
is not restricted, matching every other container kind; `targets` bound where a credential may be
sent, not where the container may connect. None of the job kind, the tool server or the surface
is research-specific.

### A missing capability credential parks the step

A definition's credentials ride the existing capability credential store, resolved through
`ToolSecretResolver` for the workspace that started the run. A definition is a credential producer:
the `project-definition` subject (`<kind>/<key>`) resolves from the store only (never from the
deployment's environment), and reserved environment keys are refused.

A `requiredAtStart` credential that does not resolve parks the step before any container starts; a
mid-run `request_credential` checkpoints the partial result on the step (merged later by the
kind's module) and parks it with the same `CapabilityCredentialMissingError`.
`CredentialWaitController` records the wait as a union on `subject`: `personal` (the existing
subscription lease), `capability` (key, declaring subject, label, onboarding, reason, observed) and
`unrecorded` (a wait persisted before waits named their subject, which cannot be resumed). A
capability wait admits any member to resume once the key is stored, and the resume re-checks the
key through the same resolver a dispatch reads, refusing a premature one with
`capability_credential_still_missing`.

### A task links projects as read-only context

A task links projects through `POST /workspaces/:ws/blocks/:blockId/projects`, the public
`/api/v1/tasks/{taskId}/projects` routes, the create-time `projects` field and an initiative item's
`spawn.projects`. A link is admitted only for a project of the task's account
(`project_link_invalid`) that has a result to read, meaning at least one outcome
(`project_has_no_result`), checked by one service for every door.

At dispatch, every linked project's current result is rendered by its kind's module
(`renderContext`) from its decoded outcomes and pinned definition; a kind without one contributes
the newest outcome of each stream as recorded. Each contributes a summary and a coverage line to
the prompt's linked-context index and the full result as a `project-<name>.md` file in
`.cat-context/`, scrubbed of secrets. Research contributes its folded findings with coverage of the
pinned definition. The step records which outcome each linked project contributed
(`contextProjects`). A linked project that cannot be read breaks the run naming it.

### Surfaces

- The board shows project roots beside service frames and a create form that lists the picked
  kind's definitions with the summary its module writes. Any project opens into one takeover: the
  pin, the reader its kind contributes to the `projectViews` slot (a generic one showing the newest
  outcome per stream when it contributes none), the outcome history with where each body lives,
  credential readiness per key, and the outcome-storage tiers in advanced mode. The research reader
  shows coverage per topic, answers with evidence and learnings, and starts follow-ups. A task
  inspector panel holds linked projects. Projects are `basic` tier; the storage overrides are
  `advanced`.
- The public API serves the project kinds with the JSON Schemas of each kind's spec, outcome body
  and view; definitions per kind; projects with their pin; project tasks under
  `/api/v1/projects/{projectId}/tasks` (returning `PublicProjectTask` with a `projectId`); outcomes
  and the kind's view; the credential resume; and task project links. A spec, a body and a view are
  opaque in the spec, so a new kind needs no SDK release and the SDKs carry no kind's types. The
  `/api/v1/tasks/{taskId}` operations that answer a `PublicTask` refuse a project task with
  `task_owned_by_project`, because `PublicTask.serviceId` is required and retyping it in place would
  break the surface; the operations that answer no `PublicTask` serve both owners.

## Rationale

- **A peer of services, not a block-less run.** Owning a root block keeps every block-keyed
  mechanism working without a parallel path, and being account-owned and mounted lets one project
  serve every team that needs it rather than each team redoing the same work.
- **A new block level, not a `frame`.** Many backend checks read a frame as "a service" (the public
  services listing, environments, test secrets, validation). A new level keeps a project out of all
  of them by default, and the exhaustive `Record<BlockLevel, …>` tables force each remaining site
  to classify it.
- **The kind knows its content; the platform does not.** Storage, ordering, placement, retention,
  credentials, the public API and linking are the same for every kind, so they are written once
  against an envelope and an opaque body. What differs (validating a spec, folding outcomes,
  briefing an agent, rendering context) is a module method, so a second kind adds a module and a
  reader component rather than a branch on a kind id in the engine, the stores, the SDKs or the
  SPA.
- **Not an initiative.** An initiative ([ADR 0013](./0013-initiatives-feature.md)) is a
  plan-then-execute machine anchored in one service frame, stored as one rev-guarded blob and
  mirrored into the service's repository. A project is repo-less, has no plan or phases, and stores
  immutable outcomes. The two connect through linking: an initiative consumes a project's result
  through `spawn.projects`.
- **Immutable, sequence-ordered outcomes.** A replayed write can never recompute against a moved
  fold, and ordering by when a task started rather than when it finished keeps concurrent
  follow-ups deterministic. A per-task claim rather than a per-call increment is what keeps a
  replayed start from taking a second number.
- **The model judges; the platform computes.** Research's agent states a status per question, and
  coverage is derived in code from those statuses.
- **Secrets stay harness-side.** Playwright MCP's own typing tool takes literal text, which would
  put a password in the model context and the telemetry store, and its `--secrets` substitution
  binds a secret to no origin. An origin-bound tool of our own is the narrowest surface that still
  lets the agent log in.
- **Park, never degrade.** A run that silently lost a credential would record `blocked` answers no
  human knew to unblock. Parking states what is missing, names who can supply it, and resumes the
  same run.

## Consequences

- A project task's run resolves no writable repository; a pipeline step that needs one refuses
  with `project_has_no_writable_repo` at dispatch.
- Capability credentials are workspace-scoped and projects account-scoped, so "configured" is
  stated per board, for the board that will start the run.
- A kind with no module in a process lists no pinnable definitions there and cannot be published
  to, because its definitions cannot be validated; its outcomes are still served as stored.
- The JSON Schemas a kind serves state its shapes, not every rule: a refinement such as unique
  question ids has no JSON Schema form, and the kind still enforces it when it parses.
- The `ui` runner image carries the browser toolchain (Playwright MCP) beside the UI tester's.
  The local native transport ignores the image variant, so an ambient-auth project job runs
  without a browser and the agent is told so.
- The harness writes every context file flat into `.cat-context/`, so a linked project's file is
  named `project-<name>.md` rather than living under a subdirectory, which would need a runner
  image change.
- `PipelineStep.project.plan` and `.checkpoint` are stored untyped and parsed by the kind's module
  on read: typing them per kind made the workspace snapshot type too deep for the compiler.
- The Postgres blob backend refuses bodies over 16 MiB and D1 has no blob backend, so a Cloudflare
  account with content storage off holds only inline outcomes, under the D1 row cap.
- A project hosting a cross-service initiative is possible (an initiative block under a project
  root spawns there) but unsupported: `resolveRepoTarget` would need a rule naming which linked
  service an item writes to.
