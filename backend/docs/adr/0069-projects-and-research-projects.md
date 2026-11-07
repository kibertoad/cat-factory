# ADR 0069: Projects, and research projects as their first kind

- **Status:** Accepted (implemented)
- **Date:** 2026-11-07
- **Context layer:** `@cat-factory/contracts` (`projects.ts`, `research.ts`, `research-view.ts`,
  `credential-wait.ts`, the public projects and board route contracts), `@cat-factory/kernel`
  (`ProjectKindRegistry`, `ResearchDefinitionRegistry`, the project, research and task-project-link
  ports, `resolveFindingsStoragePolicy`), `@cat-factory/orchestration` (`modules/projects/`,
  `modules/research/`, `CredentialWaitController`, `linked-context.ts`), `@cat-factory/server`
  (the project, research and public controllers, `researchJobBody.ts`, the `/internal/*` reads),
  the executor harness's `research` job kind, both runtime facades, and `frontend/app`
  (`components/projects/`, `components/research/`). Product page: the catfactory.ai guide to
  research projects.

## Context

A team about to build a complex third-party integration does not yet know how the vendor works.
Finding out takes hands-on work in two places: preparing test data and configuration in the
vendor's UI, and calling the vendor's API to see what it returns. The work spans several services
or none, runs many times against one evolving body of findings, needs vendor credentials a person
has to create, and produces a durable result that later work must be able to read.

Before this decision none of that had a home:

- Every task belonged to a service, and repo resolution walked a task's ancestry to that service's
  repository. Work spanning several services, or none, had nowhere to live.
- A spike is a single task that clones a repo, answers one question and delivers a Markdown file
  through a pull request. It has the wrong shape for repeated, repo-less, credentialed research.
- No container run worked without a repository: the executor refused, and the harness job parse
  required a repo, branch and token.
- A capability credential a step needed but could not resolve was dropped silently: the tool
  server was withheld and the variable left unset.
- Nothing a run produced could be linked to a later task as context.

Research is the first of a family. Requirements definition has the same shape: a body of tasks
that belongs together, produces a durable result other work consumes, and is owned by no service.

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

A project's kind is registered on the app-owned `ProjectKindRegistry`, injected by reference on
`start()`, `startLocal()` and the Worker. A kind declares the task types its project offers (each
with a default pipeline and a `repoAccess` of `none` or `linked-read-only`) and the project-level
data it keeps (`data: 'research'`, a closed vocabulary the platform implements). In mothership
mode a node reads the kinds over `GET /internal/project-kinds`, and a failed read refuses with
`project_kinds_unreachable`. The platform registers one kind, `research`.

### A research definition says what to find out

A research definition is versioned, org-authored and immutable per version: a key, a brief, topics
of questions with stable ids, the vendor credentials it needs (declared by name, never valued, each
with onboarding instructions and whether it is needed at start), the vendor's `targets`, optional
per-project `inputs` in the descriptor form vocabulary, and per-agent-kind `promptAdditions`.

Definitions come from two producers and are read through one port, `ResearchDefinitionSource`:

- code, on a `ResearchDefinitionRegistry` a deployment registers on (an entry-point option, and
  `GET /internal/research-definitions` for a mothership node);
- data, through `PUT /api/v1/research-definitions/{key}/versions/{version}`, account-scoped. A
  published version is immutable (`research_definition_version_exists`), and a stored key in a
  namespace the registered definitions use is refused (`research_definition_key_registered`).

A research project pins one definition version with its content hash and its input values at
creation. A dispatch whose registered definition no longer hashes to the pin refuses
(`research_definition_changed`) rather than asking a question list the project never agreed to.

### A research task is one run of the `project-researcher` kind

Each research run is a task of the built-in `research` task type, offered only under a project
(`task_type_requires_project` under a service), on the `pl_research` pipeline of the
`project-research` purpose. Its mode selects the questions: `initial` (every question), `extend`
(questions added since the last run, including the task's own ad-hoc questions), `clarify`
(partial or blocked answers, or named ones) and `refresh` (re-verify everything). A follow-up is a
new task in the same project, so the project's task list is its research history. Ad-hoc question
ids are namespaced to their task, and their text is stored on the revision that answers them, so
later `extend`, `clarify` and `refresh` tasks can ask them again.

The `project-researcher` kind runs on the `container-research` surface and the `ui` image, as a
repo-less harness job of kind `research`. One headless Chromium per job serves both the Playwright
MCP server and the harness's own research tool server over CDP. The research tool server keeps
secrets out of the model: `fill_secret` types a stored credential into a page field and
`http_request` attaches one to a request, both harness-side, and both refuse an origin outside the
definition's `targets`. `request_credential` ends the step asking for a credential that does not
resolve. Every response and page value is scrubbed with `redactSecrets` before it reaches the model
or the findings. Egress is not restricted, matching every other container kind; `targets` bound
where a credential may be sent, not where the container may connect.

### Findings are immutable revisions folded by question id

Each research task writes one findings revision on its project: per question a status
(`answered`, `partial`, `unanswered`, `blocked`), an answer, a confidence, evidence and caveats,
plus run-level learnings and a summary. Revisions are ordered by a sequence number each task claims
the first time it starts (`reserveTaskSeq`, read back unchanged on a replay or retry), so two
follow-ups fold in the order they were asked, whatever order they finish in. The current findings
are the fold: a newer answer with content replaces an older one, and a newer `unanswered` or
`blocked` is kept beside an answer with content as a note rather than erasing it. The fold and the
coverage count live in `@cat-factory/contracts`, because the SPA and the backend must agree on
them. A revision is written once and never upserted.

A revision body is stored inline while it is at or under the effective threshold and offloaded to
the account's blob store above it, as a `findings` artifact anchored on the project's root block in
its home workspace, exempt from the age-based sweep and reclaimed with the project. The threshold
policy cascades account, then workspace (the board that started the run), then project, narrowest
set value winning. A body over the runtime's own row ceiling that cannot be offloaded is refused
with `findings_too_large_for_inline`, and an offloaded body the store cannot serve is refused with
`findings_body_unavailable`, never shown as empty.

### A missing capability credential parks the step

Research credentials ride the existing capability credential store, resolved through
`ToolSecretResolver` for the workspace that started the run. A definition is a credential
producer: the `research-definition` subject resolves from the store only (never from the
deployment's environment), and reserved environment keys are refused.

A `requiredAtStart` credential that does not resolve parks the step before any container starts; a
mid-run `request_credential` checkpoints the partial findings on the step and parks it with the
same `CapabilityCredentialMissingError`. `CredentialWaitController` records the wait as a union on
`subject`: `personal` (the existing subscription lease), `capability` (key, declaring subject,
label, onboarding, reason, observed) and `unrecorded` (a wait persisted before waits named their
subject, which cannot be resumed). A capability wait admits any member to resume once the key is
stored, and the resume re-checks the key through the same resolver a dispatch reads, refusing a
premature one with `capability_credential_still_missing`. The park is not research-specific: any
kind declaring a required capability credential can use it.

### A task links projects as read-only context

A task links projects through `POST /workspaces/:ws/blocks/:blockId/projects`, the public
`/api/v1/tasks/{taskId}/projects` routes, the create-time `projects` field and an initiative item's
`spawn.projects`. A link is admitted only for a project of the task's account
(`project_link_invalid`) that has a result to read (`project_has_no_result`), checked by one
service for every door.

At dispatch, `resolveLinkedContext` renders each linked project's current result through a
contributor keyed by its kind's data (`ProjectContextContributors`, a `Record` over the data
vocabulary, so the next kind plugs in there rather than in the resolver). A research project
contributes its folded findings: a summary and coverage line in the prompt's linked-context index,
and the full findings as a `project-<name>.md` file in `.cat-context/`. The step records which
revision each linked project contributed (`contextProjects`). A linked project that cannot be read
breaks the run naming it.

### Surfaces

- The board shows project roots beside service frames, a create form with a definition picker and
  the definition's inputs, a findings reader on a research project (coverage per topic, answers
  with evidence, revision history with where each body lives, credential readiness per key), a
  follow-up form, the findings-storage tiers in advanced mode, and a task inspector panel for
  linked projects. Projects and research are `basic` tier; the storage overrides are `advanced`.
- The public API serves research definitions, projects, project tasks under
  `/api/v1/projects/{projectId}/tasks` (returning `PublicProjectTask` with a `projectId`),
  findings, the credential resume, and task project links. The `/api/v1/tasks/{taskId}` operations
  that answer a `PublicTask` refuse a project task with `task_owned_by_project`, because
  `PublicTask.serviceId` is required and retyping it in place would break the surface; the
  operations that answer no `PublicTask` serve both owners.

## Rationale

- **A peer of services, not a block-less run.** Owning a root block keeps every block-keyed
  mechanism working without a parallel path, and being account-owned and mounted lets one research
  project serve every team that needs it rather than each team re-researching the same vendor.
- **A new block level, not a `frame`.** Many backend checks read a frame as "a service" (the public
  services listing, environments, test secrets, validation). A new level keeps a project out of all
  of them by default, and the exhaustive `Record<BlockLevel, …>` tables force each remaining site
  to classify it.
- **Not an initiative.** An initiative ([ADR 0013](./0013-initiatives-feature.md)) is a
  plan-then-execute machine anchored in one service frame, stored as one rev-guarded blob and
  mirrored into the service's repository. A research project is repo-less, has no plan or phases,
  and stores immutable revisions. The two connect through linking: an initiative consumes a
  research project's findings through `spawn.projects`.
- **Immutable, sequence-ordered revisions.** A replayed write can never recompute against a moved
  fold, and ordering by when a task started rather than when it finished keeps concurrent
  follow-ups deterministic. A per-task claim rather than a per-call increment is what keeps a
  replayed start from taking a second number.
- **The model judges; the platform computes.** The agent states a status per question, and
  coverage is derived in code from those statuses.
- **Secrets stay harness-side.** Playwright MCP's own typing tool takes literal text, which would
  put a password in the model context and the telemetry store, and its `--secrets` substitution
  binds a secret to no origin. An origin-bound tool of our own is the narrowest surface that still
  lets the agent log in.
- **Park, never degrade.** A research run that silently lost a credential would record `blocked`
  answers no human knew to unblock. Parking states what is missing, names who can supply it, and
  resumes the same run.
- **A project contributes by kind.** The resolver asks a contributor keyed by the kind's data, so a
  requirements project adds a member and an implementation instead of a branch on a kind id.

## Consequences

- A project task's run resolves no writable repository; a pipeline step that needs one refuses
  with `project_has_no_writable_repo` at dispatch.
- Capability credentials are workspace-scoped and projects account-scoped, so "configured" is
  stated per board, for the board that will start the run.
- The `ui` runner image carries the research toolchain (Playwright MCP) beside the UI tester's.
  The local native transport ignores the image variant, so an ambient-auth research job runs
  without a browser and the agent is told so.
- The harness writes every context file flat into `.cat-context/`, so a linked project's file is
  named `project-<name>.md` rather than living under a subdirectory, which would need a runner
  image change.
- `PipelineStep.research.checkpoint` is stored untyped and parsed on read: typed through the
  findings schema it made the workspace snapshot type too deep for the compiler.
- The Postgres blob backend refuses bodies over 16 MiB and D1 has no blob backend, so a Cloudflare
  account with content storage off holds only inline findings, under the D1 row cap.
- A project hosting a cross-service initiative is possible (an initiative block under a project
  root spawns there) but unsupported: `resolveRepoTarget` would need a rule naming which linked
  service an item writes to.
