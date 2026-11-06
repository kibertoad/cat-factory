# Initiative: Research projects (browser + API exploration → structured learnings)

**Status:** design, no slice landed · **Started:** 2026-11-06

> Tracker for a multi-PR initiative. Read the open decisions first: D1 and D2 shape every slice
> after slice 0. Update the checklist at the end of each PR.

## Goal & rationale

A team about to build a complex third-party integration does not yet know how the vendor works.
Finding out takes two kinds of hands-on work: preparing test data and configuration in the vendor's
UI, and calling the vendor's API to see what it actually returns. A **research project** runs that
work as an agent that drives a real browser AND an HTTP client, and records what it learned as
**structured learnings**: answers to named questions, grouped by topic, each with evidence.

What the platform has today does not cover it:

- **A spike is the closest thing, and it is the wrong shape.** It is a single task-level run that
  clones a repo, answers one research question, and delivers a Markdown file through a PR
  ([spike tracker](./spike-task-support.md)). Research here has no repo, runs many times against
  one evolving body of findings, and has to hold credentials of its own.
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
the platform ships the project, the run, the tools, the credential hand-off and the findings store;
an org supplies the definition saying what to research.

## Model

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
    key: string // the lookup key, same floors as capability credentials
    kind: 'login' | 'api-token' | 'oauth-client' | 'secret'
    label: string
    onboarding?: { url?: string; instructions: string } // what the human does to obtain it
    requiredAtStart: boolean // false: the agent asks for it when it reaches the point of need
  }>
  targets: Array<{ baseUrl: string; surface: 'ui' | 'api' }> // also the allowed origins
  inputs?: TaskTypeFieldDescriptor[] // per-project parameters, the reusable-operation form vocabulary
}
```

The question list is the contract between the definition and its findings. The agent answers by
question id, and the platform computes coverage (answered, partial, unanswered, blocked) from those
judgements, per "the model judges; the platform computes".

### Research project

A workspace-scoped record holding: the definition key and the version it is pinned to, the values
for the definition's `inputs`, optional linked repos (context only, cloned read-only), its own
credential set, a findings-storage override, and its findings history. Follow-up runs belong to
the project.

### Research run

One execution against the project. Its `mode` is one of:

- `initial`: answer every question in the pinned definition.
- `extend`: answer questions added since the last run, by a definition upgrade or added on the run
  itself as ad-hoc questions.
- `clarify`: re-examine questions whose last answer was `partial` or `blocked`, or named ones.
- `refresh`: re-verify every existing answer against the vendor as it is now.

The run's prompt carries the project's current findings, so a follow-up starts from what is known.
A run that parks for a credential and resumes is the SAME run re-dispatching its step; the agent
checkpoints partial findings before it parks, so the resumed dispatch starts from them.

### Findings

Each run writes one immutable **findings revision**, and the project's current findings are the
fold over its revisions by question id, newest answer winning per question. Per question:

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
`summary`. A revision is written once and never upserted, so a replayed write cannot recompute
against a moved fold.

## Design by concern

### 1. Programmatic definitions

Two producers converge on one registry read, the shape the foundational-services catalog already
uses:

- **Code**: a `ResearchDefinitionRegistry` a deployment registers on, injected by reference on both
  `start()` and `startLocal()` like every app-owned registry.
- **Data**: `PUT /api/v1/research-definitions/{key}/versions/{version}` stores an account-scoped
  definition. A published version is immutable (`409 research_definition_version_exists`), so a
  project pinned to it never changes meaning underneath. Listing and reading are `GET` siblings.

The API is the answer to "companies provide definitions programmatically" without a deployment
build: an org's integration team publishes a definition from its own CI. Both producers are read
through a port, because in mothership mode definitions are org state the node must fetch rather
than hold a stale copy of.

### 2. The research agent and its tools

A built-in `researcher` agent kind, `container-explore` on the `ui` image (Playwright and Chromium
are already there), with structured output for the findings shape above.

- **Browser**: the Playwright MCP server (`@playwright/mcp`), preinstalled in `Dockerfile.ui` and
  attached as a stdio tool server. It drives the page through accessibility snapshots rather than
  screenshots, which is cheaper and more reliable than a vision loop, and it takes
  `--allowed-origins` (fed from the definition's `targets`) and a per-job storage-state directory.
  Being a tool-server assignment, a deployment can swap in another browser driver without a code
  change. Preinstalling it is an image change: it bumps `@cat-factory/executor-harness` and the
  pinned tag.
- **Secrets never pass through the model.** Playwright MCP's `browser_type` takes the literal text,
  which would put a password into the model context and the telemetry store. The harness adds a
  small MCP server of its own with two tools that take a credential KEY and inject the value
  harness-side:
  - `fill_secret(ref, key)`: types a stored login field into an element through the same browser
    session.
  - `http_request(method, url, headers, body, auth: { key, scheme })`: sends the request with the
    credential attached, refuses a host outside `targets`, records the redacted exchange as
    evidence, and returns the response to the model.
- **`request_credential(key, reason, observed)`**: the agent calls this when it reaches a point
  that needs a credential the project lacks. The harness records it, the agent checkpoints its
  findings and ends the step. See concern 3.
- **The agent cannot store a credential.** Nothing on the job reaches the credential store's write
  path, and the prompt says not to mint tokens. A value the agent nonetheless meets in the browser
  (a token shown once on a vendor page) is scrubbed from findings with `redactSecrets`, extended to
  the job's known secret values plus a token-shape pass over the evidence.
- **Repo-less dispatch**: a new harness mode `research` whose `repo` is optional and which clones
  each linked repo read-only under `/work/context/<name>`. `ContainerAgentExecutor` resolves repos
  from the project, never from block ancestry, so a project with none dispatches cleanly instead
  of throwing `github_not_connected`.

### 3. The credential hand-off

1. **Pre-dispatch**: every `requiredAtStart` credential must resolve for the project, or the run
   parks before dispatch. Admission is the cheap place to catch it.
2. **Mid-run**: `request_credential` ends the step with `needsCredential: { key, reason, observed }`.
3. **Park**: `CredentialWaitController` generalizes from the personal-subscription lease to a
   discriminated wait: `step.credentialWait` gains `{ subject: 'capability', key, onboarding }`
   beside the existing personal variant, so its `switch` stays total. The run goes `blocked`
   through the same decision park every other wait uses.
4. **Notify**: a new `credential_required` notification type routed through the existing channels
   (in-app, email, Slack, webhook). It names the key and its label, carries the definition's
   onboarding instructions and the agent's `observed` notes (what it saw on the vendor's onboarding
   page), and deep-links to the project's credential panel.
5. **Store**: the human completes the vendor's onboarding flow and saves the value in the
   project's credential set. That write needs `secrets.manage`. A person who is notified but lacks
   it is shown who can store it, never an error.
6. **Confirm**: `POST .../credential/resume` re-checks that the key now resolves and refuses with
   `428 capability_credential_missing` if it does not, so a premature confirm costs a toast and
   never a wasted dispatch. Then the step re-dispatches with the checkpointed findings.

Credentials are stored per PROJECT: a sealed, rev-guarded set copying `CapabilityCredentialsService`
(one blob per project, `SecretCipher` with its own HKDF info tag). Resolution is project first, then
the workspace's capability credentials, so a team-wide sandbox login is stored once and a
project-specific API token stays with its project. Store bucket in mothership mode: `remote`.

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

The account tier lives in `account_settings.config.research`; workspace and project tiers are
nullable columns; one pure resolver lives in kernel (the `risk-policy-tiers.ts` shape). The BACKEND
is not overridable below the account: it is the account's `contentStorage` choice, because a
workspace cannot name a store its account never configured. Two loud refusals instead of silent
truncation:

- A body over the facade's own ceiling (D1 caps a row at 2 MB) is offloaded
  whatever the threshold says, and refused with `findings_too_large_for_inline` when offload is
  disabled or the account's storage is `off`.
- The SPA states where a revision lives (inline or offloaded, and how large), so "small" and
  "missing" never render alike.

### 5. Linking research to tasks

A new linked-context kind beside documents and tracker tasks:

- `POST /api/v1/tasks/{taskId}/research` and the create-time `research: [projectId]` field link a
  project. Only a project with at least one completed revision may be linked
  (`422 research_project_has_no_findings`).
- `resolveLinkedContext` folds the project's current findings at dispatch: the summary and the
  coverage line go into the prompt's linked-context index, the full findings into
  `.cat-context/research/<project>.md`. The revision used is recorded on the step, so a reader can
  tell what the agent saw even after a follow-up run moves the fold.
- A linked project that cannot be read breaks the run naming it, through the same
  `assertContextDocumentsReadable` rule documents use.

### 6. Surfaces

- **SPA**: a Research window (project list, project detail with coverage per topic, findings
  reader with evidence, run history, credential panel, start follow-up). The credential park reuses
  `CredentialWaitNotice`. Tier: the window is `basic`, since starting research and answering its
  credential request is everyday work; findings-storage overrides are `advanced`. Every string
  goes through i18n in all locales.
- **Public API**: definitions (above), projects (create, list, get, link repos), runs (start with
  mode and ad-hoc questions, get, list), findings (current fold, revision by id), credential
  resume. Each endpoint gets a `scripts/sdk/surface.mjs` entry; all additive, OpenAPI minor bump.
- **Website**: a catfactory.ai page for authoring definitions and for the credential hand-off,
  merged before the slice that exposes the API.

## Open decisions

- **D1: what a research run is anchored on.** Executions are block-keyed today
  (`ExecutionInstance.blockId` is required, one live execution per block is a unique index, and
  notifications, RBAC cascade and live events all key on the block).
  - (a) **Recommended:** a project owns a board block of a new `research` level, created with it
    and laid out in a board-level Research lane, outside any service frame. Every engine seam then
    works unchanged: one live run per project is the existing index, follow-up runs re-run the
    block, the inspector and notifications work. The project row is keyed by that block id.
  - (b) A first-class anchor: `ExecutionInstance` gains `{ kind: 'block' | 'research-project' }`.
    Cleaner as a model, but it touches every reader of `blockId` in the engine, the notification
    and live-event plumbing and the SPA stores, which is most of the initiative's risk for no
    capability (a) lacks.
- **D2: where definitions live.** Recommended: both producers (code registry and the public API,
  account-scoped). API-only would force a deployment that ships a definition with its code to
  bootstrap it through its own API; code-only fails the "companies provide definitions
  programmatically" requirement on hosted deployments.
- **D3: credential scope.** Recommended: project-scoped store with workspace fallback (concern 3).
  The alternative, reusing the workspace capability-credential set directly, needs no new table but
  puts every project's vendor tokens in one set with one rev, and makes "is the token configured
  for this project" unanswerable.
- **D4: egress.** Run containers have no egress control today (`security-model.md`). The
  definition's `targets` bound the two harness tools and Playwright's `--allowed-origins`, which
  stops a well-behaved agent; it does not stop shell `curl`. Recommended: ship with that, state it
  in the security model, and do not wait for container egress policy. The research agent handles
  real vendor credentials, so this is the decision most worth a second opinion.

## Slices (each about one PR)

| #   | Slice                                                                                                                                                                               | Status | PR  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 0   | This tracker.                                                                                                                                                                       | done   |     |
| 1   | Contracts + kernel: definition schema, `ResearchDefinitionRegistry` + port, findings schema, the fold, the storage-policy resolver. Pure, unit-tested.                              | todo   |     |
| 2   | Persistence, both facades + conformance: projects, revisions (first write wins), definitions table, project credential store, the policy tiers. Mothership buckets.                 | todo   |     |
| 3   | Harness: `research` mode with optional repos, the secret-injecting MCP server (`fill_secret`, `http_request`, `request_credential`), Playwright MCP in `Dockerfile.ui`. Image bump. | todo   |     |
| 4   | Engine: the `researcher` kind, the research block level and pipeline (D1), repo-less dispatch, findings write with offload, follow-up modes.                                        | todo   |     |
| 5   | Credential hand-off: the generalized `credentialWait`, pre-dispatch admission, `credential_required` notification, resume re-check. Conformance for park → resume.                  | todo   |     |
| 6   | Public API + SDK surface + website page.                                                                                                                                            | todo   |     |
| 7   | SPA: Research window, findings reader, credential panel, follow-up runs; i18n; e2e spec.                                                                                            | todo   |     |
| 8   | Task linking: the `research` linked-context kind, `.cat-context/research/`, recorded revision.                                                                                      | todo   |     |

Slices 1 and 3 are independent and can run in parallel. Slice 5 needs 4. Slice 8 needs only 2.

## Gotchas found during design

- **`AgentRunResult.decision` has no real producer.** Only `FakeAgentExecutor` emits it, so the
  credential request needs its own field on the job result rather than riding a channel the
  harness never fills.
- **A missing capability secret degrades silently today** (`toolServers.ts` drops the server,
  `capabilitySecrets.ts` leaves the variable unset). The research path must not inherit that: a
  declared credential the run needs either resolves or parks.
- **The resume re-dispatches; it never continues a live container.** The follow-ups channel is
  outbound-only by design. Progress across a park therefore exists only in what the agent
  checkpointed, which is why `request_credential` requires a findings checkpoint first.
- **`Dockerfile.ui` is documented as `tester-ui` only.** Reusing it for research changes that
  statement and its size budget; a separate `research` variant is the fallback if the browser
  toolchains diverge.
- **The Postgres blob backend refuses bodies over 16 MiB** and D1 has no blob backend at all, so
  the offload path depends on the account's configured store. A Cloudflare account with storage
  `off` can hold only inline findings, under the D1 row cap.
