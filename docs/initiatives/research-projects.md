# Initiative: Projects, starting with research projects (browser + API exploration → structured learnings)

**Status:** design, no slice landed · **Started:** 2026-11-06

> Tracker for a multi-PR initiative. Read "Model" and "Decisions" first: the project concept
> shapes every slice. Update the checklist at the end of each PR.

## Goal & rationale

A team about to build a complex third-party integration does not yet know how the vendor works.
Finding out takes two kinds of hands-on work: preparing test data and configuration in the vendor's
UI, and calling the vendor's API to see what it actually returns. A **research project** runs that
work as an agent that drives a real browser AND an HTTP client, and records what it learned as
**structured learnings**: answers to named questions, grouped by topic, each with evidence.

Research is the first of a family. Work like requirements definition has the same shape: a body of
tasks that belongs together, produces a durable result other work consumes, and is not owned by
any one service. So the initiative introduces a general **project** concept, a peer of the
service, and ships research as its first kind.

What the platform has today does not cover it:

- **Every task belongs to a service.** Tasks are blocks under a service frame, and repo resolution
  walks a task's ancestry to that frame's `Service.repoGithubId`. Work that spans several services,
  or none, has no place to live.
- **A spike is the closest thing, and it is the wrong shape.** It is a single task-level run that
  clones a repo, answers one research question, and delivers a Markdown file through a PR
  ([spike tracker](./spike-task-support.md)). Research here has no repo of its own, runs many times
  against one evolving body of findings, and needs vendor credentials.
- **No container run works without a repo.** `ContainerAgentExecutor` throws `github_not_connected`
  when `resolveRepoTarget` finds none, and the harness job parse requires `repo`, `branch` and
  `ghToken` (`executor-harness/src/job.ts`).
- **A missing credential never parks a run.** A tool server whose secret is unset is dropped as
  `missing_secret` and the agent is told it is unavailable; a capability secret arrives as an unset
  variable. `CredentialWaitController` parks and resumes, but only for the personal-subscription
  password lease.
- **The browser is a tester-only image variant.** `Dockerfile.ui` ships Playwright and Chromium for
  `tester-ui`; agents drive it from the shell. No browser tool server exists.
- **Nothing a run produces can be linked to a later task as context.** `resolveLinkedContext` reads
  imported documents and tracker tasks only.

The motivating consumer is the connector-research phase of the org-side integration initiative
described in [custom initiative definitions](./custom-initiative-definitions.md). That initiative
already decided cat-factory ships mechanisms and no domain content, and the same rule holds here:
the platform ships projects, the research run, the tools, the credential hand-off and the findings
store; an org supplies the definition saying what to research.

## Model

### Project

A project is a peer of a service, built on the same shape:

```ts
interface Project {
  id: string
  accountId: string
  kind: string // 'research' today; a registered project kind
  title: string
  frameBlockId: string // the root frame block it owns; its tasks are blocks beneath it
  serviceIds: string[] // linked services, zero or more
  createdAt: number
}
```

- **It owns its tasks.** Tasks are ordinary blocks under the project's frame, so the engine's
  block-keyed machinery works unchanged: executions, one live run per block, notifications, the
  inspector, live events and RBAC.
- **It survives its home board's deletion, as a shared service does.** Its frame block lives in
  one workspace, and the workspace-delete cascade re-homes a shared mounted subject
  (`MountRehome`) to a surviving mounting board before it runs. Without that, deleting the board
  that homes a project destroys it for every team that mounts it.
- **It is account-owned and mounted onto boards**, as a service is. A mount names a subject
  (`subjectKind` of `service` or `project`, plus `subjectId`), keeping the rule that a frame's
  position lives on the mount and every frame read projects through `applyMountLayout`. Blocks
  and runs carry an `owner_id`: the id of the mounted subject they belong to. Subject ids are
  globally unique (`svc_…`, `prj_…`), so the owner stamp needs no kind of its own.
- **Its root block is a `project`-level block of type `project`, not a `frame`.** Roughly fifty
  backend checks read `level === 'frame'` as "this is a service" (the public `/api/v1/services`
  listing, task creation under a service, environment, test-secret and validation setup). A new
  level keeps a project out of all of them by default, and the exhaustive `Record<BlockLevel, …>`
  and `Record<BlockType, …>` tables force each remaining site to classify it.
- **It links to services without being inside one.** A link is context: the project's tasks may
  read the linked services' repos and see their descriptions, and the board draws the link. A
  project with no links is valid.
- **Its repo resolution is its own.** `resolveRepoTarget` stops at a project root and refuses with
  `project_has_no_writable_repo`: a project has no repository to write to. Its linked services'
  repos are read-only context, resolved by their own read (slice 5), never a guessed checkout. A
  kind offers only task types that write to no repo (`repoAccess: 'none' | 'linked-read-only'`).
- **A kind is registered**, through a `ProjectKindRegistry` beside `TaskTypeRegistry`, injected by
  reference on both `start()` and `startLocal()`. A kind declares the task types its project
  offers, their default pipelines, the project-level data it keeps, and its result view. A run
  resolves it, so in mothership mode it is org state read over its own `/internal/*` route.
  Research is the only kind this initiative ships; requirements definition is the next candidate
  and is out of scope here.

### Research definition

A versioned, org-authored description of one kind of research. A definition says what to find
out, never how to find it out:

```ts
interface ResearchDefinition {
  key: string // namespaced, e.g. 'acme:content-integration'
  version: number // immutable once published; a change is a new version
  title: string
  brief: string // the goal, in prose, for the agent and the human
  topics: Array<{
    id: string // stable across versions, so findings merge by id
    title: string
    questions: Array<{ id: string; question: string; answerHint?: string }>
  }>
  credentials: Array<{
    // declared BY NAME, never valued
    key: string // a capability-credential lookup key
    kind: 'login' | 'api-token' | 'oauth-client' | 'secret'
    label: string
    onboarding?: { url?: string; instructions: string } // what the human does to obtain it
    requiredAtStart: boolean // false: the agent asks for it when it reaches the point of need
  }>
  targets: Array<{ baseUrl: string; surface: 'ui' | 'api' }> // where the vendor lives
  inputs?: TaskTypeFieldDescriptor[] // per-project parameters, the reusable-operation form vocabulary
  promptAdditions?: Record<string, string> // org steering per agent kind, as initiative presets carry
}
```

The question list is the contract between the definition and its findings. The agent answers by
question id, and the platform computes coverage (answered, partial, unanswered, blocked) from those
judgements, per "the model judges; the platform computes".

A research project pins one definition key and version and holds the values for its `inputs`.

### Research tasks

Each research run is a task in the project, of the `research` task type, carrying a `mode`:

- `initial`: answer every question in the pinned definition.
- `extend`: answer questions added since the last run, by a definition upgrade or added on the task
  itself as ad-hoc questions.
- `clarify`: re-examine questions whose last answer was `partial` or `blocked`, or named ones.
- `refresh`: re-verify every existing answer against the vendor as it is now.

A follow-up is a new task in the same project, so the project's task list is its research history.
The task's prompt carries the project's current findings, so a follow-up starts from what is
known. A task that parks for a credential and resumes is the SAME run re-dispatching its step. The
agent checkpoints partial findings on the step before it parks, so the resumed dispatch starts
from them; a checkpoint is step state and never a revision, which keeps one revision per task.
Ad-hoc question ids are namespaced to their task (`adhoc:<taskId>:<n>`), so a later definition
version can never reuse one.

### Findings

Each research task writes one immutable **findings revision** on the project, and the project's
current findings are the fold over its revisions by question id. Revisions are ordered by a
per-project sequence each TASK claims the first time it starts (a replayed or retried start
reads back the same number), so two follow-ups that run at once fold in the
order they were asked, whatever order they finish in. Per question, a newer `answered` or
`partial` answer replaces an older one; a newer `unanswered` or `blocked` never replaces an
answer with content (`answered` or `partial`) and is kept beside it as a note, so a `refresh` that ran out of budget or lost a
login cannot erase what an earlier run established. Per question:

```ts
interface QuestionFinding {
  questionId: string
  status: 'answered' | 'partial' | 'unanswered' | 'blocked'
  answer: string // Markdown
  confidence: 'high' | 'medium' | 'low'
  evidence: Array<
    | { kind: 'http-exchange'; ref: string } // recorded request/response, redacted
    | { kind: 'screenshot'; artifactId: string }
    | { kind: 'url'; url: string }
    | { kind: 'repo-path'; repoId: string; path: string }
  >
  caveats: string[]
  blockedOn?: { credentialKey: string } // a 'blocked' answer names what it waited for
}
```

Plus run-level `learnings` (things the agent found that no question asked about) and a prose
`summary`. The fold and the coverage count live in `@cat-factory/contracts` (`foldFindings`,
`researchCoverage`), because the SPA's findings reader and the backend must agree on them. A revision is written once and never upserted, so a replayed write cannot recompute
against a moved fold.

## Design by concern

### 1. Programmatic definitions

Two producers converge on one registry read, the shape the foundational-services catalog already
uses:

- **Code**: a `ResearchDefinitionRegistry` a deployment registers on, injected by reference on both
  `start()` and `startLocal()` like every app-owned registry.
- **Data**: `PUT /api/v1/research-definitions/{key}/versions/{version}` stores an account-scoped
  definition. A published version is immutable (`409`, reason
  `research_definition_version_exists`), so a project pinned to it never changes meaning
  underneath. Listing and reading are `GET` siblings.

The API lets an org's integration team publish a definition from its own CI without a deployment
build; the registry lets a deployment ship definitions with its code. The two key spaces never
overlap: a stored key must carry the account's own namespace, and a `PUT` naming a key the
registry holds is refused (`409`, reason `research_definition_key_registered`). Code cannot be
held immutable by a store, so a project pinned to a registered definition also records the
definition's content hash, and a dispatch whose registered body no longer matches it refuses
rather than running a question list the project never agreed to. Both are read through a
port, because in mothership mode definitions are org state the node must fetch rather than hold a
stale copy of.

### 2. The research agent and its tools

A built-in `project-researcher` agent kind, on a `container-research` surface and the `ui` image (Playwright and Chromium
are already there), with structured output for the findings shape above.

- **Browser**: the Playwright MCP server (`@playwright/mcp`), preinstalled in `Dockerfile.ui` and
  attached as a stdio tool server. The harness starts one headless Chromium per job, with a
  per-job profile and remote debugging, and points Playwright MCP at it with `--cdp-endpoint`, so
  the research tool server reaches the same session over CDP and a login made in one is seen by
  the other. It drives the page through accessibility snapshots rather than screenshots.
  Preinstalling it is an image change: it bumps `@cat-factory/executor-harness` and the pinned tag.
- **Secrets never pass through the model.** Playwright MCP's `browser_type` takes the literal text,
  which would put a password into the model context and the telemetry store. The harness adds a
  small MCP server of its own with tools that take a credential KEY and inject the value
  harness-side:
  - `fill_secret(credentialKey, field, label | selector)`: types one field of a stored credential
    (`username`, `password`, or the whole `value`) into a field named by its label or a CSS
    selector, through the same browser session. Playwright MCP's own `--secrets` substitution is
    not used, because it binds a secret to no origin.
  - `http_request(method, url, headers, body, auth: { key, scheme })`: sends the request with the
    credential attached, records the redacted exchange as evidence, and returns the scrubbed
    response to the model. For an `oauth-client` credential the harness performs the token
    exchange itself and attaches the access token, so a minted token never reaches the model.
- **A credential is sent only to its vendor.** Both tools refuse when the page or URL origin is
  not one of the definition's `targets`. The agent reads untrusted vendor pages, and a prompt
  injected there could otherwise point `http_request` at a host of its choosing with the
  credential attached. The refusal is reported to the agent, never silent.
- **`request_credential(key, reason, observed)`**: the agent calls this when it reaches a point
  that needs a credential that does not resolve. The harness records it, the agent checkpoints its
  findings and ends the step. See concern 3.
- **The agent cannot store a credential.** Nothing on the job reaches the credential store's write
  path, and the prompt says not to mint tokens. Every `http_request` response, and every value the
  agent meets in the browser (a token shown once on a vendor page), is scrubbed with
  `redactSecrets`, extended to the job's known secret values plus a token-shape pass, before it
  reaches the model or the findings.
- **Repo-less dispatch**: a harness job kind `research` of its own, beside `agent` and `inline`,
  since every `agent` flow is built around a repository it clones and may push to. The project's
  linked repos ride the existing `referenceRepos` job field, which already clones a repo
  read-only with no branch or PR.
- **Egress is not restricted.** Run containers reach any host the hosting network allows, as every
  other kind does today. The definition's `targets` tell the agent where to browse and bound where
  a credential may be sent (above); they do not bound the container's network.
  `security-model.md` states this for research runs in the slice that ships the kind.

### 3. Credentials and the hand-off

Credentials ride the existing **capability credential store** ([ADR 0041](../../backend/docs/adr/0041-capability-credential-store.md)),
resolved through `ToolSecretResolver` for the workspace the run was started on. No new store.

- **Declared, so they show up where operators already look.** A research definition is a new
  credential producer: `ToolSecretSubject` gains `research-definition`, and
  `collectDeclaredCapabilityCredentials` enumerates the definitions in use, so the existing
  checklist panel lists each key with its label and onboarding instructions.
- **A stored definition's keys resolve from the store only.** Today only code-registered producers
  declare credentials (a stored foundational-service row may not, because the resolver reads a
  declared key off the deployment's environment). A definition published through the API is the
  first stored declarer, so the `research-definition` subject resolves with `environmentFallback`
  off, and a key in the reserved set `docs/environment-variables.md` lists is refused at publish.
  Otherwise an account admin could name one of the deployment's own environment variables and have
  `http_request` send it to a target they chose.
- **"Configured for this project"** means every key the project's pinned definition declares
  resolves for the run's workspace. The project view states it per key.

The hand-off:

1. **Pre-dispatch**: every `requiredAtStart` credential must resolve, or the dispatch throws
   `CapabilityCredentialMissingError` and the step parks before any container starts.
2. **Mid-run**: `request_credential` ends the step with `needsCredential: { key, reason, observed }`,
   which the research executor raises as the same error after checkpointing its findings.
3. **Park**: `CredentialWaitController` recognises both refusals in one place. The persisted wait is
   a union on `subject`: `personal` (`{ raisedAt }`), and `capability` (`{ key, declaredBy, label,
   onboarding, reason, observed }`), where `declaredBy` names the declaring subject so the resume
   asks the resolver about the same one. A row stored before waits had a `subject` decodes as
   `unrecorded`, never as `personal`; it cannot be resumed (`credential_wait_unrecorded`) and its run
   is restarted. The run goes `blocked` through the same decision park every other wait uses, and
   `async` dispatch sites rethrow the error rather than classify it as a dispatch failure.
4. **Notify**: the park raises the run's existing waiting notification, through the existing
   channels, with a message naming the key and its label. The run panel's credential notice shows
   the definition's onboarding instructions and link, the agent's `observed` notes, and a button to
   the capability-credentials panel.
5. **Store**: the human completes the vendor's onboarding flow and saves the value through the
   existing `PUT /capability-credentials/:key`, which needs `secrets.manage`.
6. **Confirm**: `POST .../credential/resume` re-checks that the key now resolves, through the same
   resolver a dispatch reads, and refuses with `capability_credential_still_missing` if it does not,
   so a premature confirm costs a toast and never a wasted dispatch. Then the step re-dispatches.
   A personal wait admits only the run's initiator (its lease reads that person's activation); a
   capability wait admits any member, because the person who stored the key is rarely the initiator.
   The public decisions surface reports a capability wait as `capability_credential_missing`.

The generalized park is not research-specific: any kind declaring a required capability credential
can use it, which closes the silent `missing_secret` degradation for kinds that opt in.

### 4. Findings storage

A revision's body is stored inline in `research_findings_revisions` while it is at or under the
effective threshold, and in the account's blob store above it, the row then holding the
`BinaryArtifactStore` id. A new `findings` artifact kind, exempt from the age-based retention sweep
and reclaimed with its project.

The policy cascades account → workspace → project, narrowest set value winning, with absence (never
a stored null) meaning inherit:

```ts
interface FindingsStoragePolicy {
  inlineMaxBytes: number // capped by the facade ceiling below
  offload: 'enabled' | 'disabled'
}
```

All three tiers live in one `findings_storage_policies` table keyed by `(owner_kind, owner_id)`, so
one repository and one RPC rule serve them; one pure resolver lives in kernel
(`resolveFindingsStoragePolicy`). A project is
account-owned and mounted on several boards, so the workspace tier read is the workspace that
started the run. The BACKEND is not overridable below the account: it is the account's
`contentStorage` choice, because a workspace cannot name a store its account never configured. Two
loud refusals instead of silent truncation:

- A body over the facade's own ceiling (D1 caps a row at 2 MB) is offloaded whatever the threshold
  says, and refused with `findings_too_large_for_inline` when offload is disabled or the account's
  storage is `off`.
- The SPA states where a revision lives (inline or offloaded, and how large), so "small" and
  "missing" never render alike.

### 5. Linking a project to a task

A new linked-context kind beside documents and tracker tasks:

- `POST /api/v1/tasks/{taskId}/projects` and the create-time `projects: [projectId]` field link a
  project to any task, in any service or project; `POST /api/v1/tasks/{taskId}/projects/detach`
  unlinks it, the shape `documents/detach` already has. A research project may be linked once it
  has at least one revision (`422`, reason `project_has_no_result`).
- `resolveLinkedContext` folds the project's current findings at dispatch: the summary and the
  coverage line go into the prompt's linked-context index, the full findings into
  `.cat-context/projects/<project>.md`. The revision used is recorded on the step, so a reader can
  tell what the agent saw even after a follow-up moves the fold.
- What a project contributes as context is its kind's to render, so a requirements project later
  plugs in through the same kind registration.
- A linked project that cannot be read breaks the run naming it, through the same
  `assertContextDocumentsReadable` rule documents use.

### 6. Surfaces

- **SPA**: a project frame on the board beside service frames, with its task swimlanes and its
  links to services drawn. The research project's frame opens a findings reader (coverage per
  topic, answers with evidence, revision history), and offers "start follow-up" with a mode. The
  credential park reuses `CredentialWaitNotice`. Tier: projects and research are `basic`, since
  starting research and answering its credential request is everyday work; findings-storage
  overrides are `advanced`. Every string goes through i18n in all locales.
- **Public API**: projects (create, list, get, link and unlink services, mount), definitions (above),
  project tasks (below), findings (current fold, revision by id), credential resume. Each endpoint
  gets a `scripts/sdk/surface.mjs` entry; all additive, OpenAPI minor bump.
- **Project tasks get their own public resource.** `PublicTask.serviceId` is a required string,
  and eight `/api/v1` operations return `PublicTask` (`GET`/`PATCH /tasks/{taskId}`, `start`,
  `stop`, `retry`, the two dependency calls, `POST /services/{serviceId}/tasks`). A project task
  has no service to put there, and making the field nullable retypes it in place, which ADR 0034
  forbids. So project tasks live under `/api/v1/projects/{projectId}/tasks` (create with mode and
  ad-hoc questions, list, get, start, stop, retry), returning a `PublicProjectTask` that carries
  `projectId`. Those `/api/v1/tasks/{taskId}` operations refuse a project task with `422`, reason
  `task_owned_by_project`, rather than answering with an invented `serviceId`. The operations that
  return no `PublicTask` (`events`, `run`, document and project linking) serve both owners. One
  task shape with an `owner` field is a v2 change, made only when a `/api/v2` exists for its own
  reasons.
- **Website**: a catfactory.ai page for projects, authoring research definitions and the credential
  hand-off, merged before the slice that exposes the API.

## Decisions

- **Projects are a peer of services, not a block level and not a block-less run.** A project owns
  a frame and its tasks, so the engine stays block-keyed, and it links to zero or more services
  rather than living inside one.
- **Definitions come from code and from the public API**, read through one port.
- **Credentials use the existing capability credential store**; research definitions declare their
  keys into it.
- **No egress restriction for research runs**, matching every other container kind.
- **A project is not an initiative, and research is not an initiative preset.** An initiative
  ([ADR 0013](../../backend/docs/adr/0013-initiatives-feature.md)) is a plan-then-execute machine
  anchored inside one service frame: its loop spawns tasks under that frame, its entity is one
  rev-CAS blob, and it commits a mirror into the service's repo. A research project is
  repo-less, account-owned, has no plan or phases, and stores immutable revisions folded by
  question id. Making initiatives frame-less and repo-less would rewrite their core, and research
  would carry a planning pipeline with nothing to plan. The two connect through linking instead
  (slice 9): an initiative CONSUMES a research project's findings, as the connector initiative in
  [custom initiative definitions](./custom-initiative-definitions.md) does with its research
  phase.
- **What projects reuse from initiatives**: the descriptor form vocabulary and its renderer
  (`descriptorFieldEntries`, `DescriptorFields.vue`) for definition `inputs`; the app-owned
  registry shape of `InitiativePresetRegistry` for `ProjectKindRegistry`; per-agent-kind
  `promptAdditions` on a research definition for org steering of the `project-researcher`, rather than
  folding it into `brief`; and the `followUps` shape (open, promoted, dismissed) for run
  `learnings`, so a learning can later be promoted into an ad-hoc question.

Still open:

- **Project ownership.** Recommended: account-owned and mounted, exactly as a service is, so one
  research project serves every team that needs it. The alternative, workspace-owned, is simpler
  (no mount generalization) but means a second team re-researches the same vendor.

## Slices (each about one PR)

| #   | Slice                                                                                                                                                                                                                                                                                                                                        | Status    | PR    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----- |
| 0   | This tracker.                                                                                                                                                                                                                                                                                                                                | done      | #2501 |
| 1a  | Generalize the owner stamp and the mount: `blocks`/`agent_runs` `owner_id`, `workspace_mounts` (`subject_id`), `MountRehome`, owner- and subject-keyed port methods. A refactor with no behaviour change, both facades.                                                                                                                      | in review | #2504 |
| 1b  | Projects, both facades + conformance: `Project` entity, the `project` block level and type, `subjectKind` on the mount, `ProjectKindRegistry`, project creation, task admission, re-home, service links, repo resolution through a project root. Mothership buckets.                                                                         | in review | #2505 |
| 1c  | SPA: project roots on the board, create a project, link services, mount; i18n.                                                                                                                                                                                                                                                               | in review | #2506 |
| 2   | Contracts + kernel for research: definition schema, `ResearchDefinitionRegistry` + content hash, findings schema, the fold, the storage-policy resolver. Pure, unit-tested. The definition read port lands with its implementation in slice 3, and the registry is wired on `start()`/`startLocal()` in slice 5, where a run first reads it. | in review | #2503 |
| 3   | Research persistence, both facades + conformance: definitions table, findings revisions (first write wins), the policy tiers. Mothership buckets.                                                                                                                                                                                            | in review | #2507 |
| 4   | Harness: `research` mode with optional repos (linked repos as `referenceRepos`), the secret-injecting MCP server (`fill_secret`, `http_request`, `request_credential`) with its target-origin check and response scrub, Playwright MCP in `Dockerfile.ui`. Image bump.                                                                       | in review | #2508 |
| 5a  | Engine groundwork: the `ResearchDefinitionSource` read port (registry plus store, `/internal/research-definitions` for a mothership node), the registry option on every entry point, a research kind pinning its definition at project creation, the per-task findings sequence claim. Conformance.                                          | in review | #2510 |
| 5b  | Engine: the `project-researcher` kind, the `research` task type and pipeline, repo-less dispatch, findings write with offload, follow-up modes.                                                                                                                                                                                              | in review | #2511 |
| 5c  | Findings offload to the blob store (the revision row records which store and workspace hold the body), and the definition picker on the create-project form with the definitions read it lists from.                                                                                                                                         | todo      |       |
| 6   | Credential hand-off: the `research-definition` credential subject (store-only, reserved keys refused), the generalized `credentialWait` and its resume rule, the capability variant of `CredentialWaitNotice`, pre-dispatch admission, `credential_required` notification, resume re-check. Conformance.                                     | in review | #2509 |
| 7   | Public API + SDK surface + website page, including the `/api/v1/projects/{projectId}/tasks` resource and the `task_owned_by_project` refusal.                                                                                                                                                                                                | todo      |       |
| 8   | SPA: project frames, findings reader, follow-ups; i18n; e2e spec.                                                                                                                                                                                                                                                                            | todo      |       |
| 9   | Task linking: the `projects` linked-context kind, `.cat-context/projects/`, recorded revision. An optional `projects` field on `InitiativeItemSpawn`, so tasks an initiative spawns carry a research project as linked context.                                                                                                              | todo      |       |

Slices 1, 2 and 4 are independent and can run in parallel. Slice 5 needs 1 to 4 and 6: the
`project-researcher` kind ships after the park, so a research run never meets a missing credential with
nowhere to wait. Slice 9 needs 1, 2, 3 and 5, since a project is linkable only once a research
run has written a revision.

## Gotchas found during design

- **The checkpoint rides the step as `unknown`.** Typing `PipelineStep.research.checkpoint` through
  the findings schema made the workspace snapshot's type too deep for the compiler to instantiate,
  so the step holds it untyped and the engine parses it with `findingsRevisionBodySchema` on read.
- **A research task's description is not its brief.** The input gate exempts the `research` type,
  as it does `bug-fishing`: the questions, targets and vendor live on the pinned definition.
- **Findings are stored inline until 5c.** The revision row names an offloaded body by artifact id
  alone, and the artifact store is workspace-scoped, so offloading needs the row to record which
  store holds it. Until then a body over the runtime's row ceiling is refused with
  `findings_too_large_for_inline` rather than truncated.

- **The agent kind is `project-researcher`.** A `researcher` kind already exists: the repo-reading
  investigator the `pl_complex` pipeline runs before design. Reusing the name would collide in the
  agent-kind registry, so the research-project kind takes its own.
- **A project kind declares the data it keeps** (`data: 'research'`), a closed vocabulary the
  platform implements, rather than a switch on the kind id in `ProjectService`. A kind keeping
  research data refuses a create without a definition to pin, and a kind keeping none refuses one
  that names a definition.

- **Repo resolution has deliberately no fallback** ("NO first repo"). A project frame resolving to
  its linked services' repos is a new, explicit rule, and a project task whose type needs a
  writable repo must be refused at admission, never pointed at a guessed one.
- **A project frame is the host cross-service initiatives lack.** An initiative spans one service
  frame today because its loop spawns tasks under the initiative block's `parentId`
  (`InitiativeLoopService`). That lookup is generic, so an initiative block under a project frame
  would spawn there; the open rule is `resolveRepoTarget`, where a project frame resolves to its
  linked services' repos as read-only context. Slice 1 keeps that resolution a single, explicit
  rule, so a later initiative under a project can name which linked service an item writes to
  instead of gaining a second resolution path. Supporting it is out of scope here.
- **A root block id names a subject only among the board's own mounts.** Seeded boards share
  frame ids (`blk_auth`), so the workspace-delete re-home plan keeps a candidate only when it is
  in the board's account AND mounted on the board. Before projects, the plan matched by frame id
  alone and could re-home another board's service.
- **The mount carries layout for a shared frame.** Generalizing it to projects keeps
  `applyMountLayout` on every frame-returning read; a project frame read that skips it jumps on
  the board.
- **Capability credentials are workspace-scoped, projects are account-scoped.** A project mounted
  on two boards resolves credentials from whichever workspace started the run, so the project view
  states "configured" per workspace, never globally.
- **`AgentRunResult.decision` has no real producer.** Only `FakeAgentExecutor` emits it, so the
  credential request needs its own field on the job result rather than riding a channel the
  harness never fills.
- **A missing capability secret degrades silently today** (`toolServers.ts` drops the server,
  `capabilitySecrets.ts` leaves the variable unset). The research path must not inherit that: a
  declared credential the run needs either resolves or parks.
- **`PublicTask.serviceId` is required.** Every public task today belongs to a service, so a
  project task cannot ride the existing `/api/v1/tasks` shapes without a breaking retype. Hence
  the separate project-task resource in concern 6.
- **The resume re-dispatches; it never continues a live container.** The follow-ups channel is
  outbound-only by design. Progress across a park therefore exists only in what the agent
  checkpointed, which is why `request_credential` requires a findings checkpoint first.
- **`Dockerfile.ui` is documented as `tester-ui` only.** Reusing it for research changes that
  statement; a separate `research` variant is the fallback if the browser toolchains diverge.
- **The Postgres blob backend refuses bodies over 16 MiB** and D1 has no blob backend at all, so
  the offload path depends on the account's configured store. A Cloudflare account with storage
  `off` can hold only inline findings, under the D1 row cap.
