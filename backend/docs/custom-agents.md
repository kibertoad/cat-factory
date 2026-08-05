# Custom agents: shipping company-authored agents without forking

cat-factory is extensible: a deployment can ship its own agent kinds (a compliance
auditor, a security scanner, a bespoke reviewer, a custom migrator) **without forking the
platform and without rebuilding the executor-harness image**. This document is the model:
the seams. The worked reference is `backend/internal/example-custom-agent`.

> For the ergonomics layered on these seams: provider tokens, schema-driven structured
> output, boot-time registration validation, and the surface-driven prompt/`resultView`
> wiring: see [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md).
> For AUTHORING the role itself (how the final system prompt is composed around your
> text, and how to write the kind's skills and tool-server definitions) see
> [`custom-agent-roles.md`](./custom-agent-roles.md).
> For the full MCP tool-server model (registration, harness support, credentials, the
> probe, security posture, limits) see [`mcp-tool-servers.md`](./mcp-tool-servers.md).

## The governing principle

> **Zero `switch(agentKind)` in the container.** The harness is a generic
> LLM-over-a-checkout runner. All mechanical/deterministic work is backend TypeScript.

Closing a capability gap for a new agent means adding a backend repo-op function (plain,
reusable TS): **never** per-agent container code, **never** an image rebuild for a new
agent.

## The three stages

Every agent decomposes into three stages; the container runs only the middle one:

1. **`preOps`**: deterministic backend TypeScript run BEFORE the agent step. Reads a
   targeted, known subset of the repo (and may commit) over the checkout-free
   [`RepoFiles`](../packages/kernel/src/ports/repo-files.ts) port: **no checkout**.
2. **`agent`**: an optional LLM step on one of three surfaces:
   - `inline`: a one-shot LLM call over the block context; no repo, no container.
   - `container-explore`: a read-only clone; returns prose, or (for
     `output.kind === 'structured'`) a parsed JSON object surfaced as `result.custom`.
   - `container-coding`: clones, edits a working tree, commits + pushes (optionally
     opens a PR).
3. **`postOps`**: deterministic backend TypeScript run AFTER the agent returns. Parses
   the structured output (`ctx.result.custom`), renders artifact files and commits them
   via `RepoFiles`.

`preOps`/`postOps` are plain functions (`RepoOp`), so a custom agent ships its mechanical
logic as ordinary backend code that runs identically on every runtime facade (Cloudflare
Worker, Node, local): `RepoFiles` talks only HTTP (the GitHub Git Data + contents API),
so the Worker's lack of a filesystem never matters.

## The seams

A deployment registers a kind by reference on the facade's app-owned registries at startup
(the same app-owned-DI seam as the model-provider `CompositeModelProvider`): a deployment
news the registries, registers its extensions on them, and injects the SAME instances into
`buildContainer`/`createApp`/`start()`:

```ts
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { PipelineRegistry } from '@cat-factory/kernel'

// The `agentKindRegistry` / `pipelineRegistry` here are the instances the facade injects.
agentKindRegistry.register({
  kind: 'security-auditor',
  systemPrompt: 'You are a security auditor. … Return ONLY a JSON object { … }.',
  // The optional LLM step's surface + output/clone spec.
  agent: {
    surface: 'container-explore',
    output: { kind: 'structured', shapeHint: '{ "risk": number, "findings": [...] }' },
    clone: { branch: 'pr' },
  },
  // Deterministic backend hooks (RepoOp[]) - run on the backend, never in the container.
  // postOps consume `ctx.result.custom`, render files, and commit via `ctx.repo`.
  postOps: [renderComplianceReportPostOp],
  // Frontend display metadata → serialised into the workspace snapshot so the kind
  // becomes a first-class palette block + result view.
  presentation: {
    label: 'Security Auditor',
    icon: 'i-lucide-shield-check',
    color: '#ef4444',
    description: 'Read-only security audit; renders a compliance report into the repo.',
    category: 'review',
    // How specialist the kind is: `basic` puts it in the palette's default view, `advanced`
    // only at the widest setting. Omitted ⇒ `intermediate` (see `DEFAULT_AGENT_TIER`).
    tier: 'intermediate',
    resultView: 'generic-structured',
  },
})

pipelineRegistry.register({
  id: 'pl_org_audit',
  name: 'Org compliance audit',
  agentKinds: ['org-reviewer', 'security-auditor'],
})
```

### `AgentKindDefinition` (in `@cat-factory/agents`)

| Field                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                                | The free-form agent-kind id used in pipelines + steps.                                                                                                                                                                                                                                                                                                                     |
| `systemPrompt`                                        | Role prompt (string, or a `(kind) => string` for a family).                                                                                                                                                                                                                                                                                                                |
| `userPrompt?`                                         | Custom user-prompt builder; omitted ⇒ the generic block-context prompt.                                                                                                                                                                                                                                                                                                    |
| `agent?`                                              | The LLM step's `AgentStepSpec` (`surface`, `output`, `clone`, `infra`). Omitted ⇒ pure pre/post-op work, no LLM.                                                                                                                                                                                                                                                           |
| `preOps?` / `postOps?`                                | `RepoOp[]`: deterministic backend hooks over `RepoFiles`.                                                                                                                                                                                                                                                                                                                  |
| `presentation?`                                       | Frontend `label`/`icon`/`color`/`category`/`tier`/`resultView`.                                                                                                                                                                                                                                                                                                            |
| `traits?`, `configContributions?`, `webResearchHint?` | Optional capability traits, task-level config params, web-search nudge.                                                                                                                                                                                                                                                                                                    |
| `skills?` / `toolServers?`                            | The procedural playbooks the kind applies and the MCP tool servers it may call: see "Capabilities: skills and tools" below.                                                                                                                                                                                                                                                |
| `standardsDelivery?`                                  | `'prompt'` (default) folds a `code-aware`/`doc-aware` kind's resolved standards into its system prompt; `'context-files'` skips that fold: the kind's own preOp MUST write them as `.cat-context/standard-<id>.md` files (see `pr-reviewer`). Right for a kind that DELEGATES review to subagents, so the delegating agent isn't charged for every standard on every turn. |

**`standardsDelivery: 'context-files'`** is for a kind that fans work out to subagents. Because an
agentic loop re-sends its whole prompt every turn, folding the standards into a delegating agent's
prompt pays for them on every turn while the subagents that actually apply them never receive them.
Declaring `'context-files'` stops the fold; the kind's preOp writes the standards as
`.cat-context/` files (index `standards.md` + one `standard-<id>.md` each) and its prompt points the
agent at them. If that preOp does not run (e.g. GitHub unwired, so the engine skips the kind's repo
hooks) the engine falls back to folding, so the standards are never lost through both channels.

A `container-*` surface implies the container requirement automatically
(`registeredKindRequiresContainer`), so `requiresContainer` need not be set alongside it.

## Variations of an EXISTING kind (alternate prompts, programmatically)

Not every deployment-specific agent is a new agent. "The Coder, but test-first", "the PR reviewer,
but with our security lens", "the merger, but treat schema changes as high risk" are all the SAME
kind told to be something else. For those, register a **variant** rather than a kind:

```ts
agentKindRegistry.registerVariant({
  id: 'acme:coder-tdd',
  baseKind: 'coder',
  // APPENDED to whatever base prompt the step runs under. Prefer this.
  promptAddition: 'House rule for this step: work test-first. …',
  // …or REPLACE the shipped track prompt outright, when the role genuinely differs:
  // systemPrompt: 'You are …',
  presentation: { label: 'TDD-first', description: 'The Coder, required to land a failing test.' },
})
```

A pipeline step selects one through its **step options**, parallel to `agentKinds` exactly like
every other per-step knob: the step's kind is still `coder`:

```ts
pipelineRegistry.register({
  id: 'pl_acme_apply',
  name: 'Acme apply',
  agentKinds: ['coder', 'conflicts', 'ci', 'merger'],
  stepOptions: [{ agentVariantId: 'acme:coder-tdd' }, null, null, null],
})
```

**A variant is deliberately NOT a kind, and that is the whole safety property.** A kind id is what
every engine decision keys off: the harness dispatch shape, the read-only guardrail, companion
targeting, gatability, multi-repo fan-out, the merger's terminal status, the SPA's palette entry
and result view, and the built-in kinds are not registry entries yet (see Status / scope), so a
brand-new id silently misses every switch that has not been migrated. It would not fail; it would
dispatch down the generic path and quietly do the wrong thing. Because a varied step records the
BASE kind, every one of those decisions is byte-for-byte what that kind always did.

The corollary: **a variation that needs different BEHAVIOUR is a different kind**, and belongs on
`register` above. If you find yourself wanting a variant to clone differently, return a different
shape, or be picked up by a different resolver, you want a kind.

What you get for free, because a variant's prompt rides the same seam a per-workspace prompt
override does (`AgentRunContext.systemPromptOverride`, resolved once per dispatch by the engine):

- **The engine invariants survive it.** The surface directives, the trait guidance and
  `restoreShippedInvariants` are re-applied on top, so a variant can no more delete the read-only
  guardrail or the answer-in-your-reply rule than a workspace can. A variant of a BESPOKE-prompt
  kind (`merger`, `on-call`, the inline reviewers) replaces only its ROLE half, so its parsed
  output contract is likewise untouchable.
- **Every executor honours it identically** (container, inline and consensus alike) with no
  branch of their own.
- **A workspace override still wins**, being the narrower tier; a variant's `promptAddition` then
  folds on top of the workspace's text rather than the shipped text, which is why an addition is
  the safe default: it keeps applying as the product edits the prompt and as a workspace edits it.

A variant applies only to the step's OWN kind. A helper dispatched off that step (a gate's
`ci-fixer`, the `fork-proposer`) is a different agent and does not inherit it, so there is
deliberately no way to vary a helper's prompt: it has no step of its own to select one on.

**What cannot be varied (yet): the inline ENGINE kinds**; the requirements + clarity reviewers,
both brainstorm stages and their rework editors. `IterativeReviewService` drives those as bare
inline calls and composes their prompt from `(workspace, kind)` with no step in hand, so a variant
selected on one could never reach the model. Registering one is a BOOT error and selecting one is
refused at pipeline save, rather than validating and silently doing nothing; vary those kinds with a
per-workspace prompt override instead. This does not extend to `merger` and `on-call`: they carry
bespoke prompts too, but they dispatch through the engine like any container kind, so a variant
applies to their ROLE half normally.

Boot validation refuses a variant whose `baseKind` is unknown, one that sets neither prompt field
(it would run as the stock kind, silently), one varying an inline-engine kind, and a registered
pipeline selecting a variant of the wrong kind: skipping a DISABLED step, exactly as pipeline save
and run start do for workspace-authored pipelines.

### What was ASKED for vs what RAN

`stepOptions.agentVariantId` is the ask. Because a workspace override displaces a variant's
`systemPrompt`, and because an id can be withdrawn mid-run, the ask is not proof the variant's text
reached the prompt, so the dispatch pins what it actually did onto
`PipelineStep.promptVariant`: `{ id, applied, fingerprint? }`, where `applied` is `full` /
`addition-only` / `superseded` / `withdrawn`. Every losing disposition is also `warn`ed at the fold.

**Read the pin, never the ask**, anywhere you report or key on a varied step. The run views do
(reporting the variant beside the model as "Prompt variant", with a note naming the disposition when
it did not fully apply), and so does Kaizen's combo key, which folds in the `fingerprint` of the
text the variant CONTRIBUTED rather than its id, so re-registering an id to re-word a variant starts
a fresh streak instead of inheriting the one the previous wording earned. A variant that contributed
nothing does not enter the key at all: the key describes the text that ran.

## Capabilities: skills and tools

Beyond its prompt, a kind declares WHAT IT KNOWS (skills: procedural playbooks) and WHAT IT CAN
REACH (tool servers: MCP). Design record: [ADR 0029](./adr/0029-agent-kind-capabilities.md).
Field-by-field authoring guidance for both (and for the role prompt they accompany):
[`custom-agent-roles.md`](./custom-agent-roles.md).

```ts
// Reusable definitions register on the SAME injected registry, then any number of kinds
// reference them by id. Register these BEFORE the kinds that name them - boot validation
// reports an unresolved reference as a startup error.
agentKindRegistry.registerSkill({
  id: 'org-security-review',
  name: 'org-security-review',
  description: 'The org security-review playbook.',
  instructions: '1. Start from the diff…', // the SKILL.md body
  resources: [{ relPath: 'severity.md', content: '# Severity rubric…' }],
})

agentKindRegistry.registerToolServer({
  id: 'org-advisories',
  label: 'Org advisory database',
  // Not decoration: an agent handed a tool it wasn't told the purpose of tends not to use it.
  guidance: 'Look up a dependency here before judging whether a version bump is risky.',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', '@example-org/advisories-mcp'] },
  allowedTools: ['lookup_advisory'], // omit ⇒ every tool the server exposes
  secretKeys: [{ key: 'ORG_ADVISORY_TOKEN' }], // by NAME; the value is resolved at dispatch
})

agentKindRegistry.register({
  kind: 'security-auditor',
  systemPrompt: '…',
  agent: { surface: 'container-explore' },
  skills: ['org-security-review'],
  toolServers: ['org-advisories'],
})

// Attach either to a BUILT-IN kind without redefining it - the `assignTraits` analogue.
agentKindRegistry.assignSkills('coder', ['org-security-review'])
agentKindRegistry.assignToolServers('pr-reviewer', ['org-advisories'])
```

### Skills

A skill ref takes three forms, all resolving to the same payload so nothing downstream branches on
where it came from:

| Form                            | Meaning                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `'my-skill'`                    | A **bundled** skill registered with `registerSkill`.                                             |
| `{ id, name, description, … }`  | A bundled skill declared **inline** (one kind's own playbook).                                   |
| `{ catalogSkillId, optional? }` | An account-tier **repo-synced** skill (ADR 0024), resolved through the engine's `skillResolver`. |

A **bundled** skill ships in the deployment's own code: no skill library, no GitHub connection, no
sync; installing the package installs the playbook. A **catalog** skill is tenant-authored content
and needs the library configured; it is a hard dispatch failure when it cannot resolve, unless the
ref declares `optional: true` (which is how a kind says "apply the house playbook if this deployment
has one"). A catalog skill's version is pinned per run onto `step.skillVersions`; a bundled one has
no pin, because its version is the deployment's.

This is distinct from the built-in `skill` KIND, which runs ONE skill picked per step
(`stepOptions.skillId`). A kind that declares skills and a step that picks one run both, deduped by
id, with the kind's own first.

The harness installs them **harness-aware**: natively under `CLAUDE_CONFIG_DIR/skills/<name>/` for
claude-code (the CLI loads them and invokes them on its own judgement), or
`.cat-context/skill/<name>/` plus the full instructions folded into the prompt for Pi/codex and for
an AMBIENT claude-code run (which has no isolated config home to install into).

### Tool servers (MCP)

A tool server is `stdio` (a child process in the run container) or `http` (a remote endpoint) an
agent kind may call. **The full model lives in [`mcp-tool-servers.md`](./mcp-tool-servers.md)**:
the no-fork registration path, harness and transport support, the unavailability vocabulary, the
credential rules, the operability probe, the security posture, the current limits, and the Slack
runbook. Field-by-field authoring:
[`custom-agent-roles.md`](./custom-agent-roles.md#tool-servers-authoring-the-mcp-definition).
What matters from THIS doc's altitude:

- **Credentials are declared BY NAME** (`secretKeys`) and resolved at dispatch through the kernel
  `ToolSecretResolver` port; the VALUE rides the job body's dedicated `mcpServers` field only,
  never `AgentRunContext`, a prompt, or the telemetry snapshot. A workspace's own stored value
  wins over the deployment's environment, per key
  ([`capability-credential-store.md`](../../docs/initiatives/capability-credential-store.md)).
- **A declared server that cannot be wired for a run is STATED to the agent** (a closed reason
  vocabulary rendered in the prompt's tool-server section) and recorded on the run's context
  snapshot, never silently dropped.
- **`allowedTools` is SCOPING, never a security boundary.**
- **A dispatch is budgeted** (`TOOL_SERVER_BUDGET`): the excess is dropped under `over_budget`,
  and both budget dimensions warn at boot.

The worked example (`backend/internal/example-custom-agent`) registers both capability families: a
bundled `org-security-review` skill and an `org-advisories` tool server, declared on
`security-auditor`.

### Binary-output generators (the `binary-output` trait)

A kind whose deliverable is BINARY artifacts (an image generator is the canonical case) opts in
with `registerAgentKind({ traits: ['binary-output'] })`. No built-in kind carries the trait. What
it buys (full design: `docs/initiatives/binary-output-foundational-storage.md`):

- **Storage is a FOUNDATIONAL SERVICE the step selects**, never the platform's own artifact
  store (that store holds run evidence such as screenshots, not product deliverables). The pipeline
  step sets `stepOptions.binaryOutput.storageServiceId` to a catalog service carrying the
  `asset-storage` capability tag, plus optional `contextServiceIds`: catalog services the agent
  consults for generation SCOPE (an entity inventory that knows what exists, what lacks an asset,
  and how each thing is described).
- **The engine injects `.cat-context/binary-output/`**: a brief naming the selected services and
  one file per resolved API contract. A step with a missing/unresolvable selection is refused at
  save + admission; a gap that appears mid-run (a catalog edit) is STATED in the brief, and an
  absent brief itself means "storage could not be provided": the trait guidance tells the agent
  to refuse and report rather than guess at an endpoint.
- **What GENERATES the artifacts is a separate registry**, selected on the same step:
  `stepOptions.binaryOutput.generatorIds` names integrations from the deployment's own
  `BinaryGeneratorRegistry` (image / music / video APIs registered in CODE, like the agent-kind
  registry itself), and `.modalities` states the content types the step must deliver. Admission
  refuses an unregistered id or a content type nothing selected produces, under its OWN
  `binary_output_generator_invalid` reason: kept apart from the storage refusal because that one
  is fixed in the workspace catalog and this one in the deployment's build.
- **The agent declares what it stored** in a fenced ` ```binary-outputs ` block (`none`, or a
  JSON array of `{ service, location, generator?, entity?, contentType?, description? }`),
  recorded onto `PipelineStep.binaryOutputs` with degrade-loudly bookkeeping (undeclared /
  parse-failed / invalid / omitted / unknown-service and unknown-generator ids).
- **The STORAGE service's credentials are not this feature's job**: the contract says HOW to call
  it; a credential rides the existing capability seams (a tool server's named secret, test
  secrets), and a missing one follows the standing rule: stated to the agent, reported as a named
  omission. A GENERATIVE INTEGRATION's credential IS, because the agent writes that request
  itself: it is declared by name on the registration, resolved per dispatch through the same
  `ToolSecretResolver` port (with a `binary-generator` subject), and delivered as an environment
  variable of that one job's agent process. The VALUE never reaches a prompt or the telemetry
  snapshot: only the variable's NAME does, so the agent knows what to read.

### How the engine runs the hooks

`ExecutionService` runs a registered kind's `preOps` before the agent step dispatches, and
its `postOps` after the step's result is recorded: both over a per-run `RepoFiles` bound
to the run's installation + repo. The binding comes from the facade-wired
`resolveRunRepoContext` (composed from the GitHub client + the same `resolveRepoTarget` the
container executor uses; see `makeResolveRunRepoContext` in `@cat-factory/server`). When
GitHub isn't connected (tests / no client wired) the hooks are skipped, so the engine runs
unchanged without the feature.

The `RepoOpContext` a hook receives:

```ts
interface RepoOpContext {
  repo: RepoFiles // checkout-free repo access, bound to the run's repo
  context: AgentRunContext // run/block/task context (branch, block id, prior outputs)
  branch: string // the resolved branch (base/pr/work) the op reads/writes
  result?: AgentRunResult // the finished agent's result - present for postOps only
}
```

`RepoFiles` exposes `getFile`, `listDirectory`, `headSha`, `createBranch`, `commitFiles`,
`openPullRequest`: enough to read a baseline artifact (a pre-op) and render + commit
files (a post-op) without ever cloning.

### Frontend

The workspace snapshot carries `customAgentKinds` (kind + presentation + container flag).
The SPA hydrates them as a per-workspace **remote capability manifest**
(`useAgentsStore().hydrateCustomKinds`) (modeled as a `RemoteModuleManifest` and merged with
built-ins + any CODE-shipped consumer kinds) so a registered kind renders as a first-class
palette block, and its declared `resultView` opens through the modular `resultViews` slot the
built-ins use. A `container-explore` structured kind's `result.custom` is recorded on the step
and rendered read-only by the shared `generic-structured` result view: a custom agent gets a
usable result window with **no bespoke UI**. A `resultView` id may be a built-in
(`generic-structured`, …) or a consumer-namespaced id (`<ns>:<name>`) that a deployment pairs
with its own frontend component contributed to the `resultViews` slot via `registerAppModule`
(see the modular-vue adoption, `docs/initiatives/modular-vue-adoption.md`). The full
consumer-side extension surface (custom task types, interactive phases for consumer
agents, overlays, notification kinds) is designed in
`docs/initiatives/frontend-extension-mechanism.md`.

## Judges: an evaluator that can BLOCK or BOUNCE a run

An agent kind produces work; a **judge** decides whether the work is acceptable. It is the
fourth step-taxonomy bucket (agents / polling gates / one-shot engine steps / judges) and the
seam to reach for when a deployment wants its own rubric-based evaluator over a run's output:
scope adherence, house engineering standards, doc completeness.

Why it is not one of the other seams: a `StepCompletionResolver` returns a `StepResolution`
(reshape output / own terminal status) and **cannot park or loop the run**, and a
`GateDefinition`'s `probe()` is a cheap programmatic precheck with a `pending` state and a helper
container to escalate to; neither shape fits "run an LLM assessment, compare the score to the
task's tolerance, and act".

A judge registration supplies ONLY its differentiators; the engine's one generic driver owns the
state machine, the threshold comparison, the park, the bounce budget, persistence and emission:

```ts
import type { JudgeRegistry } from '@cat-factory/kernel'

// The `judgeRegistry` here is the instance the facade injects (`CoreDependencies.judgeRegistry`).
judgeRegistry.register('scope-adherence', () => ({
  kind: 'scope-adherence',
  rubric: {
    id: 'rubric_scope_adherence',
    name: 'Scope adherence',
    body: 'Score how faithfully the change implements the task AS ASKED, and nothing beyond it. …',
    // Optional: a workspace overrides the body by authoring a prompt-library fragment with this
    // id - so a rubric needs no storage of its own.
    fragmentId: 'frag_org_scope_adherence',
  },
  // Optional: your own valibot schema's parser (kernel carries no valibot dep). Defaults to the
  // contract's `judgeVerdictSchema` (score + summary + findings).
  parseVerdict: scopeVerdict.parse,
  // What a verdict BELOW the task's threshold does: park for a human, bounce the producing step
  // with the findings as its rework brief, or fail the run.
  onFail: 'bounce',
  bounceTargets: ['coder'],
  presentation: {
    label: 'Scope Adherence',
    icon: 'i-lucide-scale',
    color: '#f59e0b',
    description: '…',
  },
}))
```

What you do NOT write: the assessment call (the engine's `JudgeAssessor`, built from the
model-provider deps the facade already wires), the threshold (the merge preset's `judgeMinScore`,
so a TASK can relax it), the bounce budget (`judgeMaxBounces`), the park + its `judge_review`
card, the persistence (all state rides `step.judge`, so it is runtime-symmetric with no table),
the result window (the shared `judge` view), or the PR-report section.

Three rules worth knowing before you register one:

- **Unwired is a pass-through.** With no assessment model configured, every judge step records
  `status: 'skipped'` with a note and advances, so adding a judge to a pipeline can never break
  a deployment that has no model for it.
- **A failing verdict never advances silently.** A bounce with a spent budget, or with no
  preceding producing step to bounce to, degrades to a **park** and records why.
- **An unreadable assessment is a FAILING verdict**, not a crashed run: a thrown parse or a
  provider outage becomes a score-0 verdict that reaches a human. For a gate that blocks work,
  "I could not tell" must land on the cautious side.

Full design + the deliberate non-goals (the `merger` is NOT rewritten onto this):
[`../../docs/initiatives/judge-registry.md`](../../docs/initiatives/judge-registry.md).

## The worked example

`backend/internal/example-custom-agent` (`@cat-factory/example-custom-agent`, private)
registers:

- **`org-reviewer`**: an `inline` policy reviewer (no repo, no container).
- **`org:coder-tdd`**: a VARIANT of the built-in `coder` (not a new kind): a `promptAddition`
  requiring a failing test before the fix, selected by the `pl_org_apply` pipeline's Coder step
  through its `stepOptions`.
- **`security-auditor`**: a `container-explore` structured auditor whose `postOp` renders
  `compliance/REPORT.md` from the agent's JSON and commits it via `RepoFiles`, presenting
  through `generic-structured`. It also declares both CAPABILITIES: a bundled
  `org-security-review` skill (the org playbook, shipped in the package's own code) and an
  `org-advisories` MCP tool server whose credential is resolved at dispatch.
- **`org-researcher`**: a `container-coding` structured researcher (the producing kind of the
  `preset_org_research` initiative preset) that returns a `GO`/`GO_WITH_CAVEATS`/`NO_GO` verdict
  and whose `postOp` renders the canonical feasibility report onto the PR branch it opened. It is
  `container-coding` (not `container-explore`) so it opens a real, mergeable PR: the only way a
  post-op-rendered artifact reaches a later initiative phase's clone (see
  [`initiative-presets.md`](./initiative-presets.md) → "Cross-phase artifacts").
- **`scope-adherence`**: a rubric **judge** (`registerExampleScopeJudge`) that scores the Coder's
  work against "implement what was asked and nothing else", sends it back to the Coder with the
  findings as its rework brief on a miss, and parks a human once the task's rework budget is spent.
- **`org:introduce-api`**: a REUSABLE OPERATION (`src/introduce-api.ts`), the vehicle for canned
  work an org runs again and again with per-case input. It is a custom TASK TYPE carrying the
  whole bundle: the small create form whose values reach every agent's prompt, the standing
  context (`defaultFragmentIds`: the org's API guidelines, auth requirements and shared-services
  map), and `defaultPipelineId: pl_org_introduce_api`, whose design + build steps run under the
  `org:architect-api` / `org:coder-api` variants. That pipeline registers `builtin: true` with an
  explicit `version`, the shape that makes it a read-only template the org can roll out and later
  update ([`pipeline-catalog-lifecycle.md`](./pipeline-catalog-lifecycle.md)). Design and the
  boundary against initiative presets (which are the vehicle when the work must be PLANNED and
  decomposed):
  [`../../docs/initiatives/reusable-operations.md`](../../docs/initiatives/reusable-operations.md).
- the **`pl_org_audit`**, **`pl_org_scope`**, **`pl_org_research`**, **`pl_org_apply`** and
  **`pl_org_introduce_api`** pipelines chaining them, plus
  the **`preset_org_audit`** and **`preset_org_research`** initiative presets (see
  [`initiative-presets.md`](./initiative-presets.md)).

A deployment opts in by importing it once for its side effect (e.g. from `deploy/local`):

```ts
import '@cat-factory/example-custom-agent'
```

…then `linkRepo`s a target repo and runs `pl_org_audit`. It proves a brand-new
repo-writing agent ships with **zero** harness changes.

## Status / scope

- The extension framework (the three-stage model, the registry seams, live pre/post-op
  execution wired symmetrically across all three facades, the data-driven palette + the
  generic result view) is in place and covered by the cross-runtime conformance suite.
- **The built-in agents (blueprints/spec-writer/coder/merger/…) are NOT yet migrated** to
  this model: their rendering still lives in the executor-harness today. Converting them
  one at a time behind the harness acceptance suite + smoketests, and then deleting the
  bespoke harness handlers, is the remaining strangler work (it must be parity-gated and
  image-bumped per conversion, which is why it is sequenced as its own follow-up).
