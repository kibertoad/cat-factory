# Initiative: Projects, starting with research projects (browser + API exploration → structured learnings)

**Status:** in progress, slices 0 to 3 on the stack base · **Started:** 2026-11-06

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
the platform ships projects, the research run, the tools, the credential hand-off and a store for
project outcomes; an org supplies the definition saying what to research.

The same rule holds one level down, between the platform and its own project kinds. Research is
one thing a project can produce; an architecture design, a requirements draft or any other
solutioning work produces the same kind of durable result. So the platform stores, orders, sizes,
reclaims and serves what a project produces without knowing what it is, and each project kind owns
the shape of its content. Nothing below the kind registration names research.

## Model

### Project

A project is a peer of a service, built on the same shape:

```ts
interface Project {
  id: string
  accountId: string
  kind: string // 'research' today; a registered project kind
  title: string
  rootBlockId: string // the root block it owns; its tasks are blocks beneath it
  serviceIds: string[] // linked services, zero or more
  createdAt: number
}
```

- **It owns its tasks.** Tasks are ordinary blocks under the project's root block, so the engine's
  block-keyed machinery works unchanged: executions, one live run per block, notifications, the
  inspector, live events and RBAC.
- **It survives its home board's deletion, as a shared service does.** Its root block lives in
  one workspace, and the workspace-delete cascade re-homes a shared mounted subject
  (`MountRehome`) to a surviving mounting board before it runs. Without that, deleting the board
  that homes a project destroys it for every team that mounts it.
- **It is account-owned and mounted onto boards**, as a service is. A mount names a subject
  (`subjectKind` of `service` or `project`, plus `subjectId`), keeping the rule that a root block's
  position lives on the mount and every root read projects through `applyMountLayout`. Blocks
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
  kind can declare no writing access (`repoAccess: 'none' | 'linked-read-only'`), and a run step
  that needs a checkout to push to is refused when it dispatches.
- **A kind is registered**, through a `ProjectKindRegistry` beside `TaskTypeRegistry`, injected by
  reference on both `start()` and `startLocal()`. A kind declares the task types its project
  offers and their default pipelines, and supplies the code that understands its content (below).
  A run resolves it, so in mothership mode it is org state read over its own `/internal/*` route.
  Research is the only kind this initiative ships; requirements definition is the next candidate
  and is out of scope here.

### Definitions, pins and outcomes

Three concepts carry everything a project keeps. The platform owns how each is stored and the
rules it obeys; it never reads a kind's content.

```ts
interface ProjectDefinition {
  kind: string // the project kind this definition is for
  key: string // namespaced, e.g. 'acme:content-integration'
  version: number // immutable once published; a change is a new version
  title: string
  credentials: Array<{
    // declared BY NAME, never valued
    key: string // a capability-credential lookup key
    kind: 'login' | 'api-token' | 'oauth-client' | 'secret'
    label: string
    onboarding?: { url?: string; instructions: string } // what the human does to obtain it
    requiredAtStart: boolean // false: the agent asks for it when it reaches the point of need
  }>
  targets: Array<{ baseUrl: string; surface: 'ui' | 'api' }> // the only origins a credential reaches
  inputs: TaskTypeFieldDescriptor[] // per-project parameters, the reusable-operation form vocabulary
  promptAdditions: Record<string, string> // org steering per agent kind, as initiative presets carry
  spec: unknown // the kind's own content, validated by the kind
}

interface ProjectPin {
  projectId: string
  definitionKey: string
  definitionVersion: number
  definitionHash: string // content hash, so a code-registered definition edited in place refuses
  inputs: Record<string, unknown>
}

interface ProjectOutcomeMeta {
  id: string
  projectId: string
  stream: string // a named sequence within the project; 'main' for a kind that declares one
  seq: number // per-project, across streams, taken when the writing work STARTED
  intent: string // what the writing task asked for, in the kind's vocabulary
  schemaVersion: number // the version of the kind's body schema it was written in
  taskId: string | null // null for an outcome no task produced
  definitionKey: string | null // null for a pinless kind
  definitionVersion: number | null
  artifactRefs: string[] // blobs the body references, so cascades find them unread
  createdAt: number
}
```

- **A definition** is the versioned template a project of some kind pins. The envelope is the part
  the platform acts on: credentials feed the credential hand-off, targets bound where a credential
  may be sent, inputs render through the descriptor form, prompt additions steer the kind's agent.
  These are not research concepts: any kind whose runs reach an external system needs them.
  `spec` is opaque and its kind validates it. A kind with nothing to template pins nothing.
- **A pin** is a project's choice of one definition version, with its input values.
- **An outcome** is one immutable revision in one of the project's streams, written once (first
  write wins) by the work that produced it. Its body is opaque JSON, inline in its row or
  offloaded to the account's blob store (concern 4).

What the platform cannot do without understanding content, the kind supplies when it registers:

```ts
interface ProjectKindModule<Spec, Body, View> {
  kind: string
  parseSpec(definition: ProjectDefinition): ParseResult<Spec> // at registration and publish
  parseOutcome(schemaVersion: number, body: unknown): ParseResult<Body> // before every write
  fold(stream: string, revisions: ProjectOutcome<Body>[]): View // the stream's current state
  summarize(view: View): { headline: string; progress?: { done: number; total: number } }
  renderContext(view: View): { index: string; files: Record<string, string> } // concern 5
  artifactRefs(body: Body): string[]
}
```

How revisions combine is the main way kinds differ. Research merges answers per question id. An
architecture design or a requirements draft is more naturally "the newest revision is the
document". So `fold` is the kind's, and a kind that wants neither writes its own reducer. Progress
is `summarize().progress`, which lets the board, notifications and the context index show
"34 of 50" without knowing it counts questions. A kind that needs two kinds of output (a draft
and its open questions) writes two streams rather than one body with two jobs. `schemaVersion`
lets a kind change its body shape and still read what it wrote before.

The spec validator is the one piece that lands before its first reader: the
`ProjectDefinitionRegistry` takes one `ProjectDefinitionSpecValidator` per kind at construction
and refuses a definition whose kind has none. The rest of the module lands with the slice that
first calls it.

### Research definition

The research kind's `spec`, inside the envelope above. A research definition says what to find
out, never how to find it out:

```ts
interface ResearchSpec {
  brief: string // the goal, in prose, for the agent and the human
  topics: Array<{
    id: string // stable across versions, so findings merge by id
    title: string
    questions: Array<{ id: string; question: string; answerHint?: string }>
  }>
}
```

The research kind also requires at least one target, since a research run browses and calls the
vendor. The question list is the contract between the definition and its findings. The agent
answers by question id, and the platform computes coverage (answered, partial, unanswered,
blocked) from those judgements, per "the model judges; the platform computes".

### Research tasks

Each research run is a task in the project, of the `research` task type, carrying a `mode`. The
mode is the research kind's outcome `intent` vocabulary:

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

Findings are the research kind's outcome body. Each research task writes one outcome revision
(a **findings revision**) on the project's `main` stream, and the project's current findings are
the research kind's fold over those revisions by question id. Revisions are ordered by the
per-project sequence taken when the TASK starts, so two follow-ups that run at once fold in the
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
`summary`. The schemas, the fold and the coverage count live in `@cat-factory/contracts`
(`research.ts`: `foldFindings`, `researchCoverage`, `findingsArtifactRefs`), because the SPA's
findings reader and the backend must agree on them. That module is the research kind's, built on
the generic contracts (`project-definitions.ts`, `project-outcomes.ts`); nothing in the platform
imports it except the kind's own registration. A revision is written once and never upserted, so
a replayed write cannot recompute against a moved fold.

## Design by concern

### 1. Programmatic definitions

Two producers converge on one registry read, the shape the foundational-services catalog already
uses:

- **Code**: a `ProjectDefinitionRegistry` a deployment registers on, injected by reference on both
  `start()` and `startLocal()` like every app-owned registry. It validates the envelope and hands
  `spec` to the kind's validator.
- **Data**: `PUT /api/v1/project-kinds/{kind}/definitions/{key}/versions/{version}` stores an
  account-scoped definition, validated by the same kind validator. A published version is
  immutable (`409`, reason `project_definition_version_exists`), so a project pinned to it never
  changes meaning underneath. Listing and reading are `GET` siblings.

The API lets an org's integration team publish a definition from its own CI without a deployment
build; the registry lets a deployment ship definitions with its code. The two key spaces never
overlap: a stored key must carry the account's own namespace, and a `PUT` naming a key the
registry holds for that kind is refused (`409`, reason `project_definition_key_registered`). Code
cannot be held immutable by a store, so a pin records the definition's content hash, and a
dispatch whose registered body no longer matches it refuses rather than running a definition the
project never agreed to. Both are read through a port, because in mothership mode definitions are
org state the node must fetch rather than hold a stale copy of.

### 2. The research agent and its tools

A built-in `researcher` agent kind, `container-explore` on the `ui` image (Playwright and Chromium
are already there), with structured output for the findings shape above.

The harness half below is not research's: it is a `project` job kind that any project kind's run
uses, carrying only the targets it may reach, the credentials for them and whether it needs a
browser. What the agent does, and how it reports what a missing credential blocked, is in the
prompt the kind writes. A requirements kind with no targets dispatches the same job with an empty
target list.

- **Browser**: the Playwright MCP server (`@playwright/mcp`), preinstalled in `Dockerfile.ui` and
  attached as a stdio tool server. The harness starts one headless Chromium per job, with a
  per-job profile and remote debugging, and points Playwright MCP at it with `--cdp-endpoint`, so
  the access tool server reaches the same session over CDP and a login made in one is seen by
  the other. It drives the page through accessibility snapshots rather than screenshots.
  Preinstalling it is an image change: it bumps `@cat-factory/executor-harness` and the pinned tag.
- **Secrets never pass through the model.** Playwright MCP's `browser_type` takes the literal text,
  which would put a password into the model context and the telemetry store. The harness adds a
  small MCP server of its own, the access tool server, with tools that take a credential KEY and inject the value
  harness-side:
  - `fill_secret(credentialKey, field, label | selector)`: types one field of a stored credential
    (a login's `username` or `password`, any other kind's `value`) into a field named by its label
    or a CSS selector, through the same browser session. Playwright MCP's own `--secrets`
    substitution is not used, because it binds a secret to no origin.
  - `http_request(method, url, headers, body, auth: { key, scheme })`: sends the request with the
    credential attached, records the redacted exchange as evidence, and returns the scrubbed
    response to the model. For an `oauth-client` credential the harness performs the token
    exchange itself and attaches the access token, so a minted token never reaches the model.
- **The values stay in the harness process.** The agent has a shell, so a config file or a child
  process the agent CLI spawns is readable by the model. The tool server is served on loopback
  from the harness process with a per-job token, and the CLI spawns only a stdio bridge holding
  that URL and token, which grant the tools and no value. A value typed into a page stays in that
  page, which the agent can script (Playwright MCP's `browser_evaluate`, or CDP from its shell):
  `fill_secret` keeps the stored value out of the model context and the telemetry store, and does
  not hide a field the model can read back.
- **A credential is sent only to its vendor.** Both tools refuse when the page or URL origin is
  not one of the definition's `targets`, and `http_request` hands a redirect back rather than
  following it. The agent reads untrusted vendor pages, and a prompt
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
- **Repo-less dispatch**: a harness job kind `project` of its own, beside `agent` and `inline`,
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

- **Declared, so they show up where operators already look.** A project definition is a new
  credential producer, whatever its kind: `ToolSecretSubject` gains `project-definition`, and
  `collectDeclaredCapabilityCredentials` enumerates the definitions in use, so the existing
  checklist panel lists each key with its label and onboarding instructions.
- **A stored definition's keys resolve from the store only.** Today only code-registered producers
  declare credentials (a stored foundational-service row may not, because the resolver reads a
  declared key off the deployment's environment). A definition published through the API is the
  first stored declarer, so the `project-definition` subject resolves with `environmentFallback`
  off, and a key in the reserved set `docs/environment-variables.md` lists is refused at publish.
  Otherwise an account admin could name one of the deployment's own environment variables and have
  `http_request` send it to a target they chose.
- **"Configured for this project"** means every key the project's pinned definition declares
  resolves for the run's workspace. The project view states it per key.

The hand-off:

1. **Pre-dispatch**: every `requiredAtStart` credential must resolve, or the dispatch throws
   `CapabilityCredentialMissingError` and the step parks before any container starts.
2. **Mid-run**: `request_credential` ends the step with `needsCredential: { key, reason, observed }`,
   which the project run's executor raises as the same error after checkpointing what it has.
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

### 4. Outcome storage

Five tables serve every kind: `project_definitions` (keyed by account, kind, key and version),
`project_pins`, `project_outcome_seqs` (the atomic per-project counter, an upsert, so a pinless
project sequences too), `project_outcomes` and `outcome_storage_policies`. Ports: a
`ProjectDefinitionRepository`, a `ProjectRecordRepository` for a project's pin, sequence and
outcomes (and their reclaim), and an `OutcomeStoragePolicyRepository`.

An outcome's body is stored inline in `project_outcomes` while it is at or under the effective
threshold, and in the account's blob store above it, the row then holding the
`BinaryArtifactStore` id. The offloaded body is a new `outcome` artifact kind, exempt from the
age-based retention sweep. The project reclaim deletes it together with every id in the row's
`artifactRefs`; both arrive with the offload write in slice 5, since nothing offloads before it.

The policy cascades account → workspace → project, narrowest set value winning, with absence (never
a stored null) meaning inherit:

```ts
interface OutcomeStoragePolicy {
  inlineMaxBytes: number // capped by the facade ceiling below
  offload: 'enabled' | 'disabled'
}
```

All three tiers live in one `outcome_storage_policies` table keyed by `(owner_kind, owner_id)`, so
one repository and one RPC rule serve them; one pure resolver lives in kernel
(`resolveOutcomeStoragePolicy`, `placeOutcomeBody`). A project is
account-owned and mounted on several boards, so the workspace tier read is the workspace that
started the run. The BACKEND is not overridable below the account: it is the account's
`contentStorage` choice, because a workspace cannot name a store its account never configured. Two
loud refusals instead of silent truncation:

- A body over the facade's own ceiling (D1 caps a row at 2 MB) is offloaded whatever the threshold
  says, and refused with `outcome_too_large_for_inline` when offload is disabled or the account's
  storage is `off`.
- The SPA states where a revision lives (inline or offloaded, and how large), so "small" and
  "missing" never render alike.

Bodies are validated by the kind's `parseOutcome` before the write. In mothership mode that runs
on the node, before the persistence RPC: the mothership may be a build behind and need not run the
kind's code, and the store it writes to does not read the body.

### 5. Linking a project to a task

A new linked-context kind beside documents and tracker tasks:

- `POST /api/v1/tasks/{taskId}/projects` and the create-time `projects: [projectId]` field link a
  project to any task, in any service or project; `POST /api/v1/tasks/{taskId}/projects/detach`
  unlinks it, the shape `documents/detach` already has. A research project may be linked once it
  has at least one revision (`422`, reason `project_has_no_result`).
- `resolveLinkedContext` folds the project's outcomes at dispatch through its kind's `fold`, and
  the kind's `renderContext` decides what goes into the prompt's linked-context index and what
  into `.cat-context/projects/<project>/`. For research that is the summary and the coverage line,
  and the full findings. The revision used is recorded on the step, so a reader can tell what the
  agent saw even after a follow-up moves the fold.
- The platform never renders a project's content itself, so a requirements project later plugs in
  through its own kind module with no change here.
- A linked project that cannot be read breaks the run naming it, through the same
  `assertContextDocumentsReadable` rule documents use.

### 6. Surfaces

- **SPA**: a project root on the board beside service frames, with its task swimlanes and its
  links to services drawn. A project's root opens its kind's outcome view, contributed through
  `registerAppModule` and keyed by kind, with a generic fallback (Markdown or a JSON tree) so a
  new kind is readable before anyone writes a view for it. The research kind's view is a findings
  reader (coverage per topic, answers with evidence, revision history) that offers "start
  follow-up" with a mode. The
  credential park reuses `CredentialWaitNotice`. Tier: projects and research are `basic`, since
  starting research and answering its credential request is everyday work; outcome-storage
  overrides are `advanced`. Every string goes through i18n in all locales.
- **Public API**: projects (create, list, get, link and unlink services, mount), definitions (above),
  project tasks (below), outcomes (list, revision by id, and the current folded view per stream),
  credential resume. An outcome is served as its envelope plus `{ kind, schemaVersion, body }`
  with the body opaque, and each kind's body and view JSON schemas are served from
  `GET /api/v1/project-kinds/{kind}`. The SDKs therefore carry no research classes; a typed
  client for one kind is generated from that kind's schema by whoever needs it. Each endpoint gets
  a `scripts/sdk/surface.mjs` entry; all additive, OpenAPI minor bump.
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

- **Projects are a peer of services, not a service and not a block-less run.** A project owns
  a root block and its tasks, so the engine stays block-keyed, and it links to zero or more services
  rather than living inside one.
- **The platform stores project content without understanding it.** Definitions, pins, outcome
  revisions and storage policy are generic tables and ports, and a project kind supplies the code
  that validates, folds, summarizes and renders its content. The alternative is typed tables per
  kind (`research_definitions`, `findings_revisions` with a `mode` column), which buys SQL-level
  typing of a body nothing queries by field and costs a parallel set of tables, ports, RPC rules,
  routes, SDK models and SPA views for every new kind. Typed columns stay where the platform acts
  on the value: `seq`, `stream`, `intent`, sizes, artifact refs.
- **A second kind keeps the abstraction honest.** The persistence conformance suite writes a
  research kind and a pinless `notes` kind with unrelated body shapes through the same
  repositories, so a store that grows to understand one kind's content fails a test instead of a
  review.
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
  `promptAdditions` on a research definition for org steering of the `researcher`, rather than
  folding it into `brief`; and the `followUps` shape (open, promoted, dismissed) for run
  `learnings`, so a learning can later be promoted into an ad-hoc question.

Still open:

- **Project ownership.** Recommended: account-owned and mounted, exactly as a service is, so one
  research project serves every team that needs it. The alternative, workspace-owned, is simpler
  (no mount generalization) but means a second team re-researches the same vendor.

## Slices (each about one PR)

| #   | Slice                                                                                                                                                                                                                                                                                                                                                                     | Status    | PR           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------ |
| 0   | This tracker.                                                                                                                                                                                                                                                                                                                                                             | done      | #2501        |
| 1a  | Generalize the owner stamp and the mount: `blocks`/`agent_runs` `owner_id`, `workspace_mounts` (`subject_id`), `MountRehome`, owner- and subject-keyed port methods. A refactor with no behaviour change, both facades.                                                                                                                                                   | done      | #2504        |
| 1b  | Projects, both facades + conformance: `Project` entity, the `project` block level and type, `subjectKind` on the mount, `ProjectKindRegistry`, project creation, task admission, re-home, service links, repo resolution through a project root. Mothership buckets.                                                                                                      | done      | #2505        |
| 1c  | SPA: project roots on the board, create a project, link services, mount; i18n.                                                                                                                                                                                                                                                                                            | done      | #2506        |
| 2   | Contracts + kernel: the generic project definition envelope and `ProjectDefinitionRegistry` with per-kind spec validators and the content hash, the outcome envelope, the outcome-storage policy resolver; the research kind's spec, findings body and fold. Pure, unit-tested. The registry is wired on `start()`/`startLocal()` in slice 5, where a run first reads it. | done      | #2503, #2507 |
| 3   | Project outcome persistence, both facades + conformance against two kinds: definitions, pins, the outcome sequence, outcome revisions (first write wins), the policy tiers. Mothership buckets.                                                                                                                                                                           | done      | #2507        |
| 4   | Harness: the `project` job kind with no checkout (linked repos as `referenceRepos`), the access tool server (`fill_secret`, `http_request`, `request_credential`) with its target-origin check and response scrub, Playwright MCP in `Dockerfile.ui`. Image bump.                                                                                                         | in review | #2508        |
| 5   | Engine: the `ProjectKindModule` registration (outcome schema, fold, summary, context renderer, artifact refs), the research kind's module, the `researcher` kind, the `research` task type and pipeline, repo-less dispatch, outcome write with offload, the `outcome` artifact kind and its project reclaim, follow-up modes.                                            | todo      |              |
| 6   | Credential hand-off: the `project-definition` credential subject (store-only, reserved keys refused), the generalized `credentialWait` and its resume rule, the capability variant of `CredentialWaitNotice`, pre-dispatch admission, `credential_required` notification, resume re-check. Conformance.                                                                   | in review | #2509        |
| 7   | Public API + SDK surface + website page, including the `/api/v1/projects/{projectId}/tasks` resource and the `task_owned_by_project` refusal.                                                                                                                                                                                                                             | todo      |              |
| 8   | SPA: the kind-keyed outcome view seam with its generic fallback, the research findings reader, follow-ups; i18n; e2e spec.                                                                                                                                                                                                                                                | todo      |              |
| 9   | Task linking: the `projects` linked-context kind rendered by each kind's `renderContext`, `.cat-context/projects/`, recorded revision. An optional `projects` field on `InitiativeItemSpawn`, so tasks an initiative spawns carry a project as linked context.                                                                                                            | todo      |              |

Slices 1 (1a to 1c, in order), 2 and 4 are independent and can run in parallel. Slice 5 needs 1 to 4 and 6: the
`researcher` kind ships after the park, so a research run never meets a missing credential with
nowhere to wait. Slice 9 needs 1, 2, 3 and 5, since a project is linkable only once a research
run has written a revision.

## Gotchas found during design

- **Repo resolution has deliberately no fallback** ("NO first repo"). A project root resolving to
  its linked services' repos is a new, explicit rule, and a project task whose type needs a
  writable repo must be refused at admission, never pointed at a guessed one.
- **A project root is the host cross-service initiatives lack.** An initiative spans one service
  frame today because its loop spawns tasks under the initiative block's `parentId`
  (`InitiativeLoopService`). That lookup is generic, so an initiative block under a project root
  would spawn there; the open rule is `resolveRepoTarget`, where a project root resolves to its
  linked services' repos as read-only context. Slice 1 keeps that resolution a single, explicit
  rule, so a later initiative under a project can name which linked service an item writes to
  instead of gaining a second resolution path. Supporting it is out of scope here.
- **A root block id alone does not name a subject.** Seeded boards share frame ids (`blk_auth`),
  so a reader narrows the candidates: the layout projection by the board's own mounts, and the
  workspace-delete re-home plan by the owner stamp on the board's own root row, which is what the
  re-home moves. The plan never re-homes another board's service, and still re-homes a shared
  subject its home board has unmounted.
- **The mount carries layout for a shared root.** Generalizing it to projects keeps
  `applyMountLayout` on every root-returning read; a project root read that skips it jumps on
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
  `off` can hold only inline outcomes, under the D1 row cap.
- **A persisted kind vocabulary is not the platform's to decode.** `intent` and `stream` are
  stored as plain strings, so a research mode retired later is the research kind's to name as
  retired when it reads its own rows; a platform-side enum over them would make every new kind a
  platform change.
- **The outcome sequence outlives no project.** `deleteByProjects` drops the counter with the
  outcomes, so a project id reused after deletion (none is today) would start again at 1 rather
  than collide with a stale counter.
