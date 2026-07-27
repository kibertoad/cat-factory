# Custom agents — shipping company-authored agents without forking

cat-factory is extensible: a deployment can ship its own agent kinds (a compliance
auditor, a security scanner, a bespoke reviewer, a custom migrator) **without forking the
platform and without rebuilding the executor-harness image**. This document is the model

- the seams. The worked reference is `backend/internal/example-custom-agent`.

> For the ergonomics layered on these seams — provider tokens, schema-driven structured
> output, boot-time registration validation, and the surface-driven prompt/`resultView`
> wiring — see [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md).

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
  presentation: { label: 'Scope Adherence', icon: 'i-lucide-scale', color: '#f59e0b', description: '…' },
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
  through `generic-structured`.
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
