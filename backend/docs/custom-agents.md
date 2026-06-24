# Custom agents — shipping company-authored agents without forking

cat-factory is extensible: a deployment can ship its own agent kinds (a compliance
auditor, a security scanner, a bespoke reviewer, a custom migrator) **without forking the
platform and without rebuilding the executor-harness image**. This document is the model
+ the seams. The worked reference is `backend/internal/example-custom-agent`.

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

A deployment registers a kind once at startup (an import side effect), mirroring the
model-provider registry seam (`@cat-factory/provider-bedrock`):

```ts
import { registerAgentKind } from '@cat-factory/agents'
import { registerPipeline } from '@cat-factory/kernel'

registerAgentKind({
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

registerPipeline({
  id: 'pl_org_audit',
  name: 'Org compliance audit',
  agentKinds: ['org-reviewer', 'security-auditor'],
})
```

### `AgentKindDefinition` (in `@cat-factory/agents`)

| Field | Purpose |
|-------|---------|
| `kind` | The free-form agent-kind id used in pipelines + steps. |
| `systemPrompt` | Role prompt (string, or a `(kind) => string` for a family). |
| `userPrompt?` | Custom user-prompt builder; omitted ⇒ the generic block-context prompt. |
| `agent?` | The LLM step's `AgentStepSpec` (`surface`, `output`, `clone`, `infra`). Omitted ⇒ pure pre/post-op work, no LLM. |
| `preOps?` / `postOps?` | `RepoOp[]` — deterministic backend hooks over `RepoFiles`. |
| `presentation?` | Frontend `label`/`icon`/`color`/`category`/`resultView`. |
| `traits?`, `configContributions?`, `webResearchHint?` | Optional capability traits, task-level config params, web-search nudge. |

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
  repo: RepoFiles          // checkout-free repo access, bound to the run's repo
  context: AgentRunContext // run/block/task context (branch, block id, prior outputs)
  branch: string           // the resolved branch (base/pr/work) the op reads/writes
  result?: AgentRunResult  // the finished agent's result — present for postOps only
}
```

`RepoFiles` exposes `getFile`, `listDirectory`, `headSha`, `createBranch`, `commitFiles`,
`openPullRequest` — enough to read a baseline artifact (a pre-op) and render + commit
files (a post-op) without ever cloning.

### Frontend

The workspace snapshot carries `customAgentKinds` (kind + presentation + container flag).
The SPA merges them into its palette catalog on load
(`useAgentsStore().registerCustomKinds`), so a registered kind renders as a first-class
palette block, and its declared `resultView` opens through the same registry the built-ins
use. A `container-explore` structured kind's `result.custom` is recorded on the step and
rendered read-only by the shared `generic-structured` result view — a custom agent gets a
usable result window with **no bespoke UI**.

## The worked example

`backend/internal/example-custom-agent` (`@cat-factory/example-custom-agent`, private)
registers:

- **`org-reviewer`** — an `inline` policy reviewer (no repo, no container).
- **`security-auditor`** — a `container-explore` structured auditor whose `postOp` renders
  `compliance/REPORT.md` from the agent's JSON and commits it via `RepoFiles`, presenting
  through `generic-structured`.
- the **`pl_org_audit`** pipeline chaining them.

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
