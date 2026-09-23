# `docs/`

Repo-wide documentation. Backend-specific reference lives next to the backend in
[`backend/docs/`](../backend/docs); the design records it accumulates are in
[`backend/docs/adr/`](../backend/docs/adr).

## Where does a new doc go?

**Ownership follows the READER, not the topic.** Before adding a page here, decide which of two
surfaces it belongs to:

- **[catfactory.ai](https://www.catfactory.ai/)** (repo:
  [kibertoad/cat-factory-website](https://github.com/kibertoad/cat-factory-website)) is for anyone
  who acts WITHOUT cloning this repo: deployers, operators, workspace users, and integrators
  building on the public API, the SDKs, MCP or manifests. The test: can the reader act on the page
  with no checkout?
- **This repository** is for anyone changing the code: flow docs, ADRs, initiative trackers,
  `AGENTS.md` maps, package `README`s, and this repository's own process. The test: is the doc
  updated in the same PR as the code it describes?

Where a topic serves both, split it by DEPTH and never by copy: the website page owns the
user-facing account, and the doc here keeps the internal design plus a link. Two parallel full
accounts is the failure mode this rule exists to end, so a doc here that needs user-level context
links the website section rather than restating it.

Four kinds of doc stay in this repo whatever their audience: a package `README` that ships in a
published tarball (it has to be self-contained), generated reference such as
[`openapi.json`](./openapi.json), GitHub-native files like `CONTRIBUTING.md`, and **a doc a CI guard
reads** ([`environment-variables.md`](./environment-variables.md) is the worked case: the guard's
value is that it fires in the PR that adds the variable, so the doc has to live in that PR's repo).

The full model, its named exceptions and the findings behind them:
[ADR 0051](../backend/docs/adr/0051-documentation-repo-website-split.md).

## Feature guide

**Using a capability is documented on [catfactory.ai](https://www.catfactory.ai/), not here.** This
repository documents how each one is BUILT. The rule is the reader: anyone who can act without
cloning this repo reads the website, and a doc here links it rather than restating it
([ADR 0051](../backend/docs/adr/0051-documentation-repo-website-split.md) is the model).

| Capability                       | Using it                                                                                                                                                                             | How it is built                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boards, services & repo linkage  | [Designing your board](https://www.catfactory.ai/guide/designing-your-board.html)                                                                                                    | [`CLAUDE.md` → Board / service / repo-linkage model](../CLAUDE.md)                                                                                                                                        |
| Execution & real-time events     | [Running pipelines](https://www.catfactory.ai/guide/running-pipelines.html)                                                                                                          | [Backend → Execution & real-time events](../backend/README.md)                                                                                                                                            |
| Model support & subscriptions    | [Model providers](https://www.catfactory.ai/guide/model-providers.html)                                                                                                              | [`model-support.md`](../backend/docs/model-support.md)                                                                                                                                                    |
| Requirements review              | [Requirements](https://www.catfactory.ai/guide/requirements.html)                                                                                                                    | [`requirements-review.md`](../backend/docs/requirements-review.md)                                                                                                                                        |
| Authentication & SSO             | [Enterprise SSO](https://www.catfactory.ai/deploy/sso.html) · [Configuration → Authentication](https://www.catfactory.ai/deploy/configuration.html#authentication)                   | [`auth.md`](../backend/docs/auth.md)                                                                                                                                                                      |
| Public API, SDKs, MCP            | [Public API](https://www.catfactory.ai/extend/public-api.html) · [SDKs](https://www.catfactory.ai/extend/sdks.html) · [MCP server](https://www.catfactory.ai/extend/mcp-server.html) | [reference](../backend/docs/public-api.md) · [`sdk/README.md`](../sdk/README.md) · [ADR 0030](../backend/docs/adr/0030-public-api-surface.md)                                                             |
| Source control (GitHub, GitLab)  | [GitHub App](https://www.catfactory.ai/deploy/github-app.html) · [support matrix](https://www.catfactory.ai/reference/vcs-support-matrix.html)                                       | [design](../backend/docs/github-integration.md) · [runbook](../backend/docs/github-operations.md) · [provider layer](../backend/docs/vcs-providers.md)                                                    |
| Document & task sources          | [Documents](https://www.catfactory.ai/guide/documents.html) · [Issue sources](https://www.catfactory.ai/guide/issue-sources.html)                                                    | [`document-sources.md`](../backend/docs/document-sources.md)                                                                                                                                              |
| Ephemeral environments           | [Environments](https://www.catfactory.ai/operate/environments.html)                                                                                                                  | [`environments-integration.md`](../backend/docs/environments-integration.md) · [native adapters](../backend/docs/native-environment-adapter.md) · [self-tests](../backend/docs/environment-self-tests.md) |
| Prompt fragments                 | [Prompt fragments](https://www.catfactory.ai/guide/prompt-fragments.html)                                                                                                            | [ADR 0006](../backend/docs/adr/0006-prompt-fragment-library.md)                                                                                                                                           |
| Self-hosted runner pools         | [Runner pools](https://www.catfactory.ai/operate/runner-pools.html) · [Kubernetes layout](https://www.catfactory.ai/deploy/kubernetes-topology.html)                                 | [protocol](../backend/docs/runner-pool-integration.md) · [Kubernetes backend](../backend/docs/kubernetes-topology.md) · [ADR 0004](../backend/docs/adr/0004-self-hosted-runner-pool.md)                   |
| Custom agents, gates & providers | [Custom agents & gates](https://www.catfactory.ai/extend/custom-agents.html) · [Custom providers](https://www.catfactory.ai/extend/custom-providers.html)                            | [`custom-agents.md`](../backend/docs/custom-agents.md) · [roles](../backend/docs/custom-agent-roles.md) · [ergonomics](../backend/docs/custom-agent-gate-ergonomics.md)                                   |
| Storage, retention & upgrades    | [Upgrades & data retention](https://www.catfactory.ai/operate/upgrades-and-retention.html)                                                                                           | [`storage-and-retention.md`](../backend/docs/storage-and-retention.md) · [custom artifact stores](../backend/docs/custom-binary-stores.md)                                                                |
| Observability & telemetry        | [Observability](https://www.catfactory.ai/operate/observability.html)                                                                                                                | [`llm-telemetry.md`](../backend/docs/llm-telemetry.md) · [`reports.md`](../backend/docs/reports.md) · [`debug-api.md`](../backend/docs/debug-api.md)                                                      |
| The agent trust boundary         | [Agent isolation](https://www.catfactory.ai/reference/agent-isolation.html) · [Security model](https://www.catfactory.ai/reference/security-model.html)                              | [`security-model.md`](../backend/docs/security-model.md)                                                                                                                                                  |

Two capabilities have no website page because nobody outside this repo operates them: container
reaping ([`container-reaping.md`](../backend/docs/container-reaping.md)) and benchmarking
([`benchmark-harness` README](../backend/internal/benchmark-harness/README.md)).

## Design docs by topic

The deeper docs under [`backend/docs/`](../backend/docs), grouped by area, each paired with the
website page for using it where one exists. The design records behind them are the numbered ADRs
in [`backend/docs/adr/`](../backend/docs/adr); the file names are the index.

### Integrations & features

- [Model support: selection, fallbacks, harnesses & provisioning](../backend/docs/model-support.md)
  (using it: [Model providers](https://www.catfactory.ai/guide/model-providers.html))
- [Authentication: the sign-in legs and how a session is ended](../backend/docs/auth.md)
  (setting it up: [Enterprise SSO](https://www.catfactory.ai/deploy/sso.html))
- [GitHub integration: design](../backend/docs/github-integration.md) ·
  [operations runbook](../backend/docs/github-operations.md) ·
  [App Manifest](../backend/docs/github-app-manifest.html)
- [Document sources](../backend/docs/document-sources.md) ·
  [design context (Figma, Zeplin)](../backend/docs/figma-claude-design-context.md)
  (using them: [Issue & document sources](https://www.catfactory.ai/guide/issue-sources.html) ·
  [Design context](https://www.catfactory.ai/guide/design-context.html))
- [In-app assistant: one typed request, one action performed](../backend/docs/in-app-assistant.md)
  (using it: [Ask the Assistant](https://www.catfactory.ai/guide/assistant.html))
- [Bug hunt: rate a tracker board's unassigned bugs and pick one](../backend/docs/bug-hunt.md)
- [Bug fishing expedition: a multi-angle hunt for unreported defects](./initiatives/bug-fishing-expedition.md)
- [Public API (`/api/v1`): endpoint reference](../backend/docs/public-api.md) ·
  [surface version history](../backend/docs/public-api-versions.md)
  (using it: [Public API](https://www.catfactory.ai/extend/public-api.html))
- [SDK clients (TypeScript / Python / Go / Java+Kotlin): generation & releases](../sdk/README.md)
  (using them: [SDKs](https://www.catfactory.ai/extend/sdks.html))
- [MCP server: the public API as tools an MCP host can drive](../sdk/mcp/README.md)
  (using it: [MCP server](https://www.catfactory.ai/extend/mcp-server.html))
- [Remote run debugging API: telemetry + logs for an agent diagnosing a run](../backend/docs/debug-api.md)
- [Ephemeral environments](../backend/docs/environments-integration.md) ·
  [native adapters](../backend/docs/native-environment-adapter.md) ·
  [environment self-tests + the agent dry run](../backend/docs/environment-self-tests.md)
  (the manifest format: [Integration manifests](https://www.catfactory.ai/extend/manifests.html))
- [Self-hosted runner pool](../backend/docs/runner-pool-integration.md) ·
  [the Kubernetes runner backend](../backend/docs/kubernetes-topology.md)
  (laying out the cluster: [Kubernetes layout](https://www.catfactory.ai/deploy/kubernetes-topology.html))
- [The provider-neutral VCS layer](../backend/docs/vcs-providers.md)
  (what each provider supports: [support matrix](https://www.catfactory.ai/reference/vcs-support-matrix.html))

### Agents & pipelines

- [Cookbook: the short recipe per pipeline edit, in the builder](https://www.catfactory.ai/guide/cookbook.html)
  (product docs, task-indexed rather than architecture-indexed)
- [Custom agents: ship your own agent kinds without forking](../backend/docs/custom-agents.md) ·
  [authoring a role](../backend/docs/custom-agent-roles.md) ·
  [gate & agent ergonomics](../backend/docs/custom-agent-gate-ergonomics.md)
- [Reusable operations: canned, parameterized units of work](../backend/docs/reusable-operations.md) ·
  [initiative presets, when the work must be planned](../backend/docs/initiative-presets.md)
  (packaging one: [Reusable operations](https://www.catfactory.ai/extend/reusable-operations.html))
- [Inline use cases: non-container model work published on `/api/v1`](../backend/docs/inline-use-cases.md)
  (authoring one: [Inline use cases](https://www.catfactory.ai/extend/inline-use-cases.html))
- [Per-workspace agent prompt overrides](../backend/docs/agent-prompt-overrides.md)
- [Requirements review: the inline review-and-answer loop](../backend/docs/requirements-review.md)
- [Consensus panels: running a review as several models](../backend/docs/consensus-panels.md)
- [Task assessment: the forecast, and the measurement after the change lands](../backend/docs/task-assessment.md)
  (using both: [Choosing a pipeline](https://www.catfactory.ai/guide/choosing-a-pipeline.html#estimating-and-gating-expensive-steps))
- [Agent-written PR descriptions](../backend/docs/pipeline-pr-descriptions.md)
- [Test-verified bug fix: verify from the repository, use the environment as a launch check](../backend/docs/test-verified-bugfix.md)
- [Built-in pipeline catalog lifecycle](../backend/docs/pipeline-catalog-lifecycle.md)
- [Execution state machine](./execution-state-machine.md)

### Operations

- [Security model: what stands between an agent and your repository](../backend/docs/security-model.md)
  (the operator hardening checklist: [Security model](https://www.catfactory.ai/reference/security-model.html))
- [Environment variables: every knob, and which are reserved](./environment-variables.md)
  (the canonical list; the website renders it at [Environment variables](https://www.catfactory.ai/reference/environment-variables.html))
- [Structured logging: the `Logger` port and what gets bound where](../backend/docs/logging.md)
- [LLM telemetry: what every model call records, and where it lands](../backend/docs/llm-telemetry.md)
- [Reports: where the spend and the work actually go](../backend/docs/reports.md)
- [Storage & retention](../backend/docs/storage-and-retention.md)
  (the windows an operator sets: [Upgrades & data retention](https://www.catfactory.ai/operate/upgrades-and-retention.html))
- [Custom binary artifact stores](../backend/docs/custom-binary-stores.md)
- [Container reaping & deletion](../backend/docs/container-reaping.md)

## The split inside this directory

The split that matters first is by AUDIENCE: everything under
[`internal/`](./internal) is about developing THIS repository (its release
process, its CI tooling, its own cleanup backlog) and describes nothing a
deployment or an integration can use. Everything else describes the platform.

Past that, this directory holds three different kinds of document, and mistaking
one for another is the usual way to be misled:

## Reference

Describes how the platform behaves **today**, and is updated by the change that
would otherwise outdate it.

- [`glossary.md`](./glossary.md): the code-level naming map. Block vs task vs
  card, directory ⇄ package names, runner/executor/transport, and where gates,
  agent kinds and migration parity live. Read this first if a term is ambiguous;
  the PRODUCT vocabulary is the website's
  [Glossary](https://www.catfactory.ai/reference/glossary.html).
- [`environment-variables.md`](./environment-variables.md): every configuration
  variable, and which names are reserved so they can never be resolved into an
  agent process. The canonical list, read by `scripts/check-reserved-env-keys.mjs`
  and rendered onto the website by its `scripts/sync-env-vars.mjs`.
- [`flow-index.md`](./flow-index.md): one entry per runtime flow, each naming what
  the flow is, its deadliest trap and the doc that owns it. The map to read
  before changing a pipeline you have not touched before; the step vocabulary
  it assumes is
  [`backend/docs/step-taxonomy.md`](../backend/docs/step-taxonomy.md).
- [`capabilities.md`](./capabilities.md): everything the platform does, one entry
  per capability, grouped by what it is for. The long form of the root README's tour.
- [`repository-layout.md`](./repository-layout.md): every workspace package, its
  role and where it is published. CI-guarded by `scripts/check-package-catalog.mjs`.
- [`execution-state-machine.md`](./execution-state-machine.md): the run
  lifecycle, its states and transitions, and why it is not XState.
- [`benchmarks/`](./benchmarks): agent benchmark runs and candidate models.

## In-flight initiatives

Trackers for multi-PR work **in progress**. Each describes a target state that
is only partly built, so none of them describes what ships today. Index, reading
guide and lifecycle: [`initiatives/README.md`](./initiatives/README.md).

(These are contributor material too, but they stay here rather than under
`internal/`: essentially every flow doc and CLAUDE.md entry links them, and
moving the tree would rewrite those references, generated CHANGELOGs included,
for no reader's benefit.)

## Contributor-only: [`internal/`](./internal)

How this repository is developed, released and kept honest. Nothing here is part
of the product.

- [`internal/running-tests.md`](./internal/running-tests.md): getting a green
  suite off a CI runner. The Postgres the two facade suites need, and the two
  traps that make a working tree look broken when only a database is missing.
- [`internal/releases.md`](./internal/releases.md): changesets, the runner-image
  rollout recipe, and the checklist for a newly published package.
- [`internal/mutation-testing.md`](./internal/mutation-testing.md): the nightly
  Stryker flow, which packages it mutates, and how to read a score.
- [`internal/dogfooding.md`](./internal/dogfooding.md): cat-factory developing
  cat-factory, and the per-PR preview stacks under
  [`deploy/preview`](../deploy/preview).
- [`internal/localization.md`](./internal/localization.md): i18n status and the
  migration plan.
- [`internal/external-api-sweep.md`](./internal/external-api-sweep.md): every
  hand-written third-party API call checked against the vendor's live docs, with a
  verdict each. **Regenerated wholesale** by the `external-api-sweep` skill, so it
  is always the latest sweep rather than a point-in-time record; its header carries
  the commit swept, because "still correct" is a claim about a tree.
- [`internal/kaizen-tracker.md`](./internal/kaizen-tracker.md): what the
  platform's own post-run graders have recommended about the agents this repo
  ships, deduplicated into themes and checked against HEAD. **Appended to** by the
  `kaizen-sweep` skill, which drains a deployment's Kaizen backlog through
  `/api/v1/kaizen/entries`; the entry ledger at the foot of it is what keeps a
  sweep incremental, so an entry is read and judged exactly once.

### Point-in-time records

Written against the repo as it stood on a date, and deliberately **not**
maintained afterwards. Useful as history and as a list of things somebody once
found; check anything you plan to act on against the current code first.

- [`internal/code-quality-observability-extensibility-review-2026-07.md`](./internal/code-quality-observability-extensibility-review-2026-07.md)
- [`internal/race-condition-audit-2026-07.md`](./internal/race-condition-audit-2026-07.md)
- [`internal/pr-review-run-efficiency-and-parking-fixes-2026-07.md`](./internal/pr-review-run-efficiency-and-parking-fixes-2026-07.md)
- [`internal/refactoring-candidates.md`](./internal/refactoring-candidates.md): a
  standing backlog of structural cleanups, referenced by the file-size ratchet's
  comments.
- [`internal/modularisation.md`](./internal/modularisation.md): the
  modularisation tracker.
- [`internal/layered-loader-upstream-gaps.md`](./internal/layered-loader-upstream-gaps.md):
  what the Worker pull-coherency slice had to hand-roll around layered-loader
  16.1, as candidates for a first-class home upstream.
- [`internal/handover/`](./internal/handover): notes and reference material
  handed between agent sessions on a specific piece of work.
