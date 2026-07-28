# Custom agents — shipping company-authored agents without forking

cat-factory is extensible: a deployment can ship its own agent kinds (a compliance
auditor, a security scanner, a bespoke reviewer, a custom migrator) **without forking the
platform and without rebuilding the executor-harness image**. This document is the model

- the seams. The worked reference is `backend/internal/example-custom-agent`.

> For the ergonomics layered on these seams — provider tokens, schema-driven structured
> output, boot-time registration validation, and the surface-driven prompt/`resultView`
> wiring — see [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md).
> For AUTHORING the role itself — how the final system prompt is composed around your
> text, and how to write the kind's skills and tool-server definitions — see
> [`custom-agent-roles.md`](./custom-agent-roles.md).

## The governing principle

> **Zero `switch(agentKind)` in the container.** The harness is a generic
> LLM-over-a-checkout runner. All mechanical/deterministic work is backend TypeScript.

Closing a capability gap for a new agent means adding a backend repo-op function (plain,
reusable TS) — **never** per-agent container code, **never** an image rebuild for a new
agent.

## The three stages

Every agent decomposes into three stages; the container runs only the middle one:

1. **`preOps`** — deterministic backend TypeScript run BEFORE the agent step. Reads a
   targeted, known subset of the repo (and may commit) over the checkout-free
   [`RepoFiles`](../packages/kernel/src/ports/repo-files.ts) port — **no checkout**.
2. **`agent`** — an optional LLM step on one of three surfaces:
   - `inline` — a one-shot LLM call over the block context; no repo, no container.
   - `container-explore` — a read-only clone; returns prose, or (for
     `output.kind === 'structured'`) a parsed JSON object surfaced as `result.custom`.
   - `container-coding` — clones, edits a working tree, commits + pushes (optionally
     opens a PR).
3. **`postOps`** — deterministic backend TypeScript run AFTER the agent returns. Parses
   the structured output (`ctx.result.custom`), renders artifact files and commits them
   via `RepoFiles`.

`preOps`/`postOps` are plain functions (`RepoOp`), so a custom agent ships its mechanical
logic as ordinary backend code that runs identically on every runtime facade (Cloudflare
Worker, Node, local) — `RepoFiles` talks only HTTP (the GitHub Git Data + contents API),
so the Worker's lack of a filesystem never matters.

## The seams

A deployment registers a kind by reference on the facade's app-owned registries at startup
(the same app-owned-DI seam as the model-provider `CompositeModelProvider`) — a deployment
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
  // Deterministic backend hooks (RepoOp[]) — run on the backend, never in the container.
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

| Field                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                                | The free-form agent-kind id used in pipelines + steps.                                                                                                                                                                                                                                                                                                                      |
| `systemPrompt`                                        | Role prompt (string, or a `(kind) => string` for a family).                                                                                                                                                                                                                                                                                                                 |
| `userPrompt?`                                         | Custom user-prompt builder; omitted ⇒ the generic block-context prompt.                                                                                                                                                                                                                                                                                                     |
| `agent?`                                              | The LLM step's `AgentStepSpec` (`surface`, `output`, `clone`, `infra`). Omitted ⇒ pure pre/post-op work, no LLM.                                                                                                                                                                                                                                                            |
| `preOps?` / `postOps?`                                | `RepoOp[]` — deterministic backend hooks over `RepoFiles`.                                                                                                                                                                                                                                                                                                                  |
| `presentation?`                                       | Frontend `label`/`icon`/`color`/`category`/`resultView`.                                                                                                                                                                                                                                                                                                                    |
| `traits?`, `configContributions?`, `webResearchHint?` | Optional capability traits, task-level config params, web-search nudge.                                                                                                                                                                                                                                                                                                     |
| `skills?` / `toolServers?`                            | The procedural playbooks the kind applies and the MCP tool servers it may call — see "Capabilities: skills and tools" below.                                                                                                                                                                                                                                                |
| `standardsDelivery?`                                  | `'prompt'` (default) folds a `code-aware`/`doc-aware` kind's resolved standards into its system prompt; `'context-files'` skips that fold — the kind's own preOp MUST write them as `.cat-context/standard-<id>.md` files (see `pr-reviewer`). Right for a kind that DELEGATES review to subagents, so the delegating agent isn't charged for every standard on every turn. |

**`standardsDelivery: 'context-files'`** is for a kind that fans work out to subagents. Because an
agentic loop re-sends its whole prompt every turn, folding the standards into a delegating agent's
prompt pays for them on every turn while the subagents that actually apply them never receive them.
Declaring `'context-files'` stops the fold; the kind's preOp writes the standards as
`.cat-context/` files (index `standards.md` + one `standard-<id>.md` each) and its prompt points the
agent at them. If that preOp does not run (e.g. GitHub unwired, so the engine skips the kind's repo
hooks) the engine falls back to folding, so the standards are never lost through both channels.

A `container-*` surface implies the container requirement automatically
(`registeredKindRequiresContainer`), so `requiresContainer` need not be set alongside it.

## Capabilities: skills and tools

Beyond its prompt, a kind declares WHAT IT KNOWS (skills — procedural playbooks) and WHAT IT CAN
REACH (tool servers — MCP). Design record: [ADR 0029](./adr/0029-agent-kind-capabilities.md).
Field-by-field authoring guidance for both (and for the role prompt they accompany):
[`custom-agent-roles.md`](./custom-agent-roles.md).

```ts
// Reusable definitions register on the SAME injected registry, then any number of kinds
// reference them by id. Register these BEFORE the kinds that name them — boot validation
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

// Attach either to a BUILT-IN kind without redefining it — the `assignTraits` analogue.
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
sync — installing the package installs the playbook. A **catalog** skill is tenant-authored content
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

A tool server is `stdio` (a child process in the run container) or `http` (a remote endpoint). Its
credentials are declared BY NAME and resolved at dispatch by the facade-wired kernel
`ToolSecretResolver`; both facades wire `createEnvToolSecretResolver`, which reads each key off the
deployment's own environment. A deployment needing PER-WORKSPACE credentials implements the port
itself — nothing else in the dispatch path changes. A secret value never reaches
`AgentRunContext`, a prompt, or the telemetry snapshot: it rides the job body's dedicated
`mcpServers` field, exactly like the tester's `testSecrets`.

Rules worth knowing before declaring one:

- **A dropped server is STATED, never silent.** A server the harness cannot serve (Pi has no MCP
  client; an ambient Codex run has no per-run config home) or whose required credential did not
  resolve is reported to the agent as unavailable in the prompt's tool-server section. Silence
  would let the agent plan around a tool that was never there and discover the gap mid-run.
- **A required credential that does not resolve DROPS the server** — `required` defaults to true,
  because a tool whose first call 401s is worse than one the agent was told it does not have.
- **Codex is stdio-only.** An `http` server is skipped in its config; declare
  `harnesses: ['claude-code']` on such a server so the drop is reported rather than invisible.
- **An `http` server must be `https`, or loopback.** Its credential rides the request as a header,
  so a cleartext off-box endpoint is refused at registration (`insecure_tool_server_url`) and again
  at the harness boundary. A sidecar on `http://127.0.0.1:…` is fine.
- **Tool servers need a container surface.** An inline LLM step has no agent CLI to wire them into;
  boot validation warns about that combination. The same warning covers `skills`, for the same
  reason.
- **`allowedTools` is SCOPING, not a security boundary.** It is always stated in the prompt, and
  additionally passed to claude-code's `--allowedTools` — but whether that CLI list gates depends
  on the run's permission mode, and Codex cannot express a per-tool restriction at all. If an agent
  kind must never reach a server's other tools, do not wire that server for that kind.
- **Mind what `secretKeys` can reach.** The default resolver reads any key off the deployment
  environment, and a definition also names the endpoint the value is sent to. If a deployment
  installs agent packages it did not author, wire
  `createEnvToolSecretResolver(env, { allowKeys: [...] })` and keep the credentials behind an
  `MCP_…` prefix. See ADR 0029 → Consequences.

The worked example (`backend/internal/example-custom-agent`) registers both: a bundled
`org-security-review` skill and an `org-advisories` tool server, declared on `security-auditor`.

### How the engine runs the hooks

`ExecutionService` runs a registered kind's `preOps` before the agent step dispatches, and
its `postOps` after the step's result is recorded — both over a per-run `RepoFiles` bound
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
  result?: AgentRunResult // the finished agent's result — present for postOps only
}
```

`RepoFiles` exposes `getFile`, `listDirectory`, `headSha`, `createBranch`, `commitFiles`,
`openPullRequest` — enough to read a baseline artifact (a pre-op) and render + commit
files (a post-op) without ever cloning.

### Frontend

The workspace snapshot carries `customAgentKinds` (kind + presentation + container flag).
The SPA hydrates them as a per-workspace **remote capability manifest**
(`useAgentsStore().hydrateCustomKinds`) — modeled as a `RemoteModuleManifest` and merged with
built-ins + any CODE-shipped consumer kinds — so a registered kind renders as a first-class
palette block, and its declared `resultView` opens through the modular `resultViews` slot the
built-ins use. A `container-explore` structured kind's `result.custom` is recorded on the step
and rendered read-only by the shared `generic-structured` result view — a custom agent gets a
usable result window with **no bespoke UI**. A `resultView` id may be a built-in
(`generic-structured`, …) or a consumer-namespaced id (`<ns>:<name>`) that a deployment pairs
with its own frontend component contributed to the `resultViews` slot via `registerAppModule`
(see the modular-vue adoption, `docs/initiatives/modular-vue-adoption.md`). The full
consumer-side extension surface — custom task types, interactive phases for consumer
agents, overlays, notification kinds — is designed in
`docs/initiatives/frontend-extension-mechanism.md`.

## Judges — an evaluator that can BLOCK or BOUNCE a run

An agent kind produces work; a **judge** decides whether the work is acceptable. It is the
fourth step-taxonomy bucket (agents / polling gates / one-shot engine steps / judges) and the
seam to reach for when a deployment wants its own rubric-based evaluator over a run's output —
scope adherence, house engineering standards, doc completeness.

Why it is not one of the other seams: a `StepCompletionResolver` returns a `StepResolution`
(reshape output / own terminal status) and **cannot park or loop the run**, and a
`GateDefinition`'s `probe()` is a cheap programmatic precheck with a `pending` state and a helper
container to escalate to — neither shape fits "run an LLM assessment, compare the score to the
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
    // id — so a rubric needs no storage of its own.
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
  `status: 'skipped'` with a note and advances — so adding a judge to a pipeline can never break
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

- **`org-reviewer`** — an `inline` policy reviewer (no repo, no container).
- **`security-auditor`** — a `container-explore` structured auditor whose `postOp` renders
  `compliance/REPORT.md` from the agent's JSON and commits it via `RepoFiles`, presenting
  through `generic-structured`. It also declares both CAPABILITIES: a bundled
  `org-security-review` skill (the org playbook, shipped in the package's own code) and an
  `org-advisories` MCP tool server whose credential is resolved at dispatch.
- **`org-researcher`** — a `container-coding` structured researcher (the producing kind of the
  `preset_org_research` initiative preset) that returns a `GO`/`GO_WITH_CAVEATS`/`NO_GO` verdict
  and whose `postOp` renders the canonical feasibility report onto the PR branch it opened. It is
  `container-coding` (not `container-explore`) so it opens a real, mergeable PR — the only way a
  post-op-rendered artifact reaches a later initiative phase's clone (see
  [`initiative-presets.md`](./initiative-presets.md) → "Cross-phase artifacts").
- **`scope-adherence`** — a rubric **judge** (`registerExampleScopeJudge`) that scores the Coder's
  work against "implement what was asked and nothing else", sends it back to the Coder with the
  findings as its rework brief on a miss, and parks a human once the task's rework budget is spent.
- the **`pl_org_audit`**, **`pl_org_scope`**, **`pl_org_research`** and **`pl_org_apply`** pipelines chaining them, plus
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
  one at a time behind the harness acceptance suite + smoketests — and then deleting the
  bespoke harness handlers — is the remaining strangler work (it must be parity-gated and
  image-bumped per conversion, which is why it is sequenced as its own follow-up).
