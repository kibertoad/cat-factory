# Custom agents: shipping company-authored agents without forking

cat-factory is extensible: a deployment can ship its own agent kinds (a compliance
auditor, a security scanner, a bespoke reviewer, a custom migrator) **without forking the
platform and without rebuilding the executor-harness image**. This document is the model:
the seams. The worked reference is `backend/internal/example-custom-agent`.

> **Authoring one is documented on the website**:
> [Custom Agents & Gates](https://www.catfactory.ai/extend/custom-agents.html) walks an author
> through registering a kind, a gate or a judge from a deployment repository, with
> [Integration Manifests](https://www.catfactory.ai/extend/manifests.html) beside it. That page
> owns the registration example, the `AgentKindDefinition` field table, the surfaces, the
> structured-output schema story, packaging and boot validation. This page is the ENGINE design
> behind those seams: what each registry owns, how the hooks are bound and run, and the
> invariants a new capability has to keep.

> For the ergonomics layered on these seams: provider tokens, schema-driven structured
> output, boot-time registration validation, and the surface-driven prompt/`resultView`
> wiring: see [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md).
> For AUTHORING the role itself (how the final system prompt is composed around your
> text, and how to write the kind's skills and tool-server definitions) see
> [`custom-agent-roles.md`](./custom-agent-roles.md).
> For the full MCP tool-server model (registration, harness support, credentials, the
> probe, security posture, limits) see [`mcp-tool-servers.md`](./mcp-tool-servers.md).
> A deployment's own TASK TYPES register on the same kind of app-owned registry, and one
> carrying a per-case form plus its standing context plus its own canned pipeline is a
> **reusable operation**: see [`reusable-operations.md`](./reusable-operations.md).

## The governing principle

> **Zero `switch(agentKind)` in the container.** The harness is a generic
> LLM-over-a-checkout runner. All mechanical/deterministic work is backend TypeScript.

Closing a capability gap for a new agent means adding a backend repo-op function (plain,
reusable TS): **never** per-agent container code, **never** an image rebuild for a new
agent.

## The three stages

`preOps` (backend TS, before the LLM step) → `agent` (the optional LLM step, on an `inline`,
`container-explore` or `container-coding` surface) → `postOps` (backend TS, after it returns).
The container runs only the middle stage. The website's
[mental model](https://www.catfactory.ai/extend/custom-agents.html#the-mental-model-three-stages)
is the account to read; what matters here is the port the hooks run over:
[`RepoFiles`](../packages/kernel/src/ports/repo-files.ts), which talks only HTTP (the GitHub Git
Data + contents API). That is why a hook is runtime-neutral by construction and the Worker's lack
of a filesystem never enters the design.

## The seams

A deployment registers a kind by reference on the facade's app-owned registries at startup
(the same app-owned-DI seam as the model-provider `CompositeModelProvider`): a deployment
news the registries, registers its extensions on them, and injects the SAME instances into
`buildContainer`/`createApp`/`start()`. The registration shape and every `AgentKindDefinition`
field are on the website's
[registration seam](https://www.catfactory.ai/extend/custom-agents.html#the-registration-seam).
Two things a field table cannot carry:

**`standardsDelivery: 'context-files'`** is for a kind that fans work out to subagents. Because an
agentic loop re-sends its whole prompt every turn, folding the standards into a delegating agent's
prompt pays for them on every turn while the subagents that actually apply them never receive them.
Declaring `'context-files'` stops the fold; the kind's preOp writes the standards as
`.cat-context/` files (index `standards.md` + one `standard-<id>.md` each) and its prompt points the
agent at them. If that preOp does not run (e.g. GitHub unwired, so the engine skips the kind's repo
hooks) the engine falls back to folding, so the standards are never lost through both channels.

**A `container-*` surface implies the container requirement automatically**
(`registeredKindRequiresContainer`), so `requiresContainer` is derived rather than declared: a kind
cannot end up dispatching inline because its author forgot the flag.

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
every engine decision keys off: the dispatch shape, the read-only guardrail, companion targeting,
gatability, multi-repo fan-out, the merger's terminal status, the SPA's palette entry and result
view. A brand-new id gets the DEFAULTS for every one of those, and defaults are answers, not
absences: it would not fail, it would dispatch as a work-branch implementer and quietly do the
wrong thing. Because a varied step records the BASE kind, every one of those decisions is
byte-for-byte what that kind always did.

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
REACH (tool servers: MCP). Both register on the same injected `AgentKindRegistry` and are referenced
by id, or attached to a built-in kind with `assignSkills` / `assignToolServers`; the website's
[skills and tool servers](https://www.catfactory.ai/extend/custom-agents.html#skills-and-tool-servers)
section is the authoring account. Design record:
[ADR 0029](./adr/0029-agent-kind-capabilities.md). Field-by-field authoring guidance for both (and
for the role prompt they accompany): [`custom-agent-roles.md`](./custom-agent-roles.md).

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
agent kind may call. **[`mcp-tool-servers.md`](./mcp-tool-servers.md) is the authority for all of
it**: the no-fork registration path, harness and transport support, the unavailability vocabulary,
the credential rules and their resolution order, the OAuth connect flow, the operability probe, the
security posture, the current limits, and the Slack runbook. Read it before changing anything that
declares, resolves or dispatches a server; from this doc's altitude the only thing to know is that a
tool server is a capability on the same registry as a skill, resolved in the container EXECUTOR
rather than the engine, because what is servable depends on the resolved harness.

### Binary-output generators (the `binary-output` trait)

A kind whose deliverable is BINARY artifacts (an image generator is the canonical case) opts in with
`registerAgentKind({ traits: ['binary-output'] })`; no built-in kind carries the trait. Two registries
meet on such a step and keeping them apart is the design: WHERE the artifacts are stored is a
**foundational service the step selects** (never the platform's own artifact store, which holds run
evidence), and WHAT generates them is the deployment's own `BinaryGeneratorRegistry`. The full model
(the injected `.cat-context/binary-output/` brief, the closed content-type vocabulary, the two
separate admission refusals, the declared-outputs block and its degrade-loudly bookkeeping, and why
a generator's credential is this feature's job where a storage service's is not) is
[`binary-output-foundational-storage.md`](../../docs/initiatives/binary-output-foundational-storage.md).

## How the engine runs the hooks

`ExecutionService` runs a registered kind's `preOps` before the agent step dispatches, and
its `postOps` after the step's result is recorded: both over a per-run `RepoFiles` bound
to the run's installation + repo. The binding comes from the facade-wired
`resolveRunRepoContext` (composed from the GitHub client + the same `resolveRepoTarget` the
container executor uses; see `makeResolveRunRepoContext` in `@cat-factory/server`). When
GitHub isn't connected (tests / no client wired) the hooks are skipped, so the engine runs
unchanged without the feature.

The `RepoOpContext` a hook receives, and the `RepoFiles` methods it may call, are documented on the
website's [`RepoFiles` port](https://www.catfactory.ai/extend/custom-agents.html#the-repofiles-port)
section; the port itself is
[`packages/kernel/src/ports/repo-files.ts`](../packages/kernel/src/ports/repo-files.ts).

## Frontend

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
(see [ADR 0049](./adr/0049-modular-vue-adoption.md), the modular-vue adoption). The full
consumer-side extension surface (custom task types, interactive phases for consumer
agents, overlays, notification kinds) is designed in
`docs/initiatives/frontend-extension-mechanism.md`.

## Judges: an evaluator that can BLOCK or BOUNCE a run

An agent kind produces work; a **judge** decides whether the work is acceptable. It is the
fourth step-taxonomy bucket (agents / polling gates / one-shot engine steps / judges), registered on
the injected `JudgeRegistry` and driven by one generic engine machine that owns the state machine,
the threshold comparison, the park, the bounce budget, persistence and emission.

Why it is not one of the other seams: a `StepCompletionResolver` returns a `StepResolution`
(reshape output / own terminal status) and **cannot park or loop the run**, and a
`GateDefinition`'s `probe()` is a cheap programmatic precheck with a `pending` state and a helper
container to escalate to; neither shape fits "run an LLM assessment, compare the score to the
task's tolerance, and act".

Registering one (the factory, the `JudgeDefinition` fields, the rubric-fragment override and the
per-task threshold knobs) is on the website's
[Custom judges](https://www.catfactory.ai/extend/custom-gates.html#custom-judges). The engine design
and every decision behind it, including the model-pin precedence (D9: a task's pinned model, then a
workspace preset override naming the judge's own kind, then the registration's `modelId`, then the
preset's base model, with an unservable pin STATED as `unavailable` rather than swapped) and the
deliberate non-goals (the `merger` is NOT rewritten onto this):
[`judge-registry.md`](../../docs/initiatives/judge-registry.md).

## The worked example

`backend/internal/example-custom-agent` (`@cat-factory/example-custom-agent`, private) is the
executable copy of this page and the place to read a real registration: an `inline` policy reviewer,
a `container-explore` structured auditor whose `postOp` renders and commits a report (declaring both
capability families: a bundled skill and an MCP tool server), a `container-coding` researcher, a
VARIANT of the built-in `coder`, a rubric `scope-adherence` judge, a REUSABLE OPERATION bundling a
task type with its own form, standing context and canned pipeline, plus the pipelines and initiative
presets chaining them.

A deployment opts in by importing it once for its side effect (e.g. from `deploy/local`):

```ts
import '@cat-factory/example-custom-agent'
```

…then `linkRepo`s a target repo and runs `pl_org_audit`. It proves a brand-new
repo-writing agent ships with **zero** harness changes.

## The container image a kind runs in

A kind declares the executor image its jobs need by NAME (`AgentStepSpec.image`). Three names are
the platform's own: `default` (spelled by omission), `ui` (Playwright + a browser, what `tester-ui`
runs on) and `deploy` (the k8s-CLI image the environment provisioner dispatches, which a kind may
not claim). Anything else is a DEPLOYMENT's variant, mapped to an image by its runner backend:

| backend               | where the name is mapped                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes / EKS pool | the runner config's `imageVariants` (`{ "pixel-tools": "ghcr.io/acme/pixel:2" }`)                                                                                                   |
| local Docker          | `LOCAL_HARNESS_IMAGE_VARIANTS=pixel-tools=ghcr.io/acme/pixel:2,fonts=…` (each name held to the same slug shape a declaration is; a rejected entry is named in a boot warning)       |
| Cloudflare            | a `[[containers]]` class (subclass the exported `RunContainer`) plus a durable-object binding named `RUNNER_CONTAINER_PIXEL_TOOLS`, because a Container's image is pinned per CLASS |
| manifest-driven pool  | forwarded verbatim as `{{input.image}}`; the pool maps it                                                                                                                           |

Two rules make this safe, and both were learned the hard way.

**A variant is part of the CONTAINER's identity, not a dispatch-time hint.** The container is per
run on every backend, so a run's steps share one, and a step declaring a different image needs its
own: `containerKeyForRef` qualifies the run id with the variant, and the ref carries it so the
poll and release sites address the container the dispatch started. It is DERIVED from the step's
agent kind at both sites rather than remembered between them, because the poll rebuilds its handle
from the persisted step alone, in another process after a durable replay. Keyed on the run id
alone, a later step re-attached to whatever the run's first step created: a browser-driven tester
running on an image with no browser.

Because the key is two facts in one string, `containerKeyForRef` REFUSES to mint one it cannot read
back (`container_key_not_reversible`). Only the producer can check that: the reader holds no ref, so
it cannot tell a run id that merely looks variant-qualified from one that is, and a key it splits
wrongly names a run that does not exist, which is what makes the orphan sweep delete a live
container. No run-id scheme in the platform can trip it today; a future one that wants a `:` finds
out at the first dispatch instead of weeks later.

**A backend with no image for a variant REFUSES the dispatch** (`runner_image_unwired`) rather than
falling back to its default. The platform's own variants say what a deployment loses by leaving
them unwired; a deployment's own gets the shared message, because nothing here knows what the image
carried. That asymmetry is the point: an unwired `ui` costs a browser the tester discovers it needs
after paying for a checkout, an install and the model's first turns, and an unwired `pixel-tools`
costs a tool nothing in the platform can even name, so the job would report a missing result with
no cause anywhere. The one deliberate fallback left is `deploy`, whose harness preflights for its
own CLIs and reports them.

Which half a name falls in is asked through `isPlatformImageVariant`, never by respelling the
platform's names, and each backend's platform half is an EXHAUSTIVE switch over
`PlatformImageVariant`. So publishing a fourth platform image fails every backend's build until it
says which image serves it: a backend that respelled the names would instead route the new image
into the deployment half and refuse it as unwired on the one runtime that ships it, and nothing
would fail at compile time.

Boot refuses a kind that declares `default` or `deploy`, or a name that is not a lower-kebab slug
(the name is a map key and half a container's identity, so it is held to the shape every other
registered id is). It does not refuse a name no backend maps: which backends a workspace runs on is
not knowable at boot, and a deployment that binds the image on its pool and not on its laptop is an
ordinary state, not a misregistration.

**What this does NOT do is install anything.** There is no `tools:` declaration and no per-kind
package manifest: that would put the platform in the business of resolving software supply chains,
and the first kind needing a system library or a private registry would need an escape hatch that
is "name your own image" with more steps. The image IS the dependency declaration. Where the tool
ships as WASM or a static binary small enough for the base image, exposing it from the harness is
still the cheaper answer and needs no variant at all.

## Status / scope

- The extension framework (the three-stage model, the registry seams, live pre/post-op
  execution wired symmetrically across all three facades, the data-driven palette + the
  generic result view) is in place and covered by the cross-runtime conformance suite.
- **The built-in agents run on this model too.** Every container kind the platform ships
  (`coder`, the testers, the fixers, the conflict-resolver, `merger`, `on-call`, the read-only
  explorers, `blueprints`, `spec-writer`, the initiative kinds) is an ordinary
  `registerAgentKind` entry declaring the same `AgentStepSpec` a deployment's own kind
  declares. There is no `switch (agentKind)` in the dispatch path and none in the harness: the
  harness is one generic `agent` kind, and WHAT each agent does is data the backend carries in
  the job body. The practical consequences:
  - **A deployment can attach a capability to any built-in.** `assignSkills('coder', …)` and
    `assignToolServers('merger', …)` reach the prompt of every kind, where `merger` and
    `on-call` used to bypass the shared prompt chain and silently drop them.

    In MOTHERSHIP mode those assignments are read from the mothership over
    `GET /internal/agent-kinds` and MERGED with this node's own registry, because they are pure
    data (a `SKILL.md` payload; a transport plus a credential's NAME) while the kind's executable
    half is not. So the kind CATALOG stays node-local, exactly like task types and pipelines, and a
    step naming a kind this build lacks still fails loudly at admission; what would otherwise be
    silent — a node one build behind dispatching `coder` without the org's playbook — is not.
    Design: [`docs/initiatives/mothership-mode.md`](../../docs/initiatives/mothership-mode.md).

  - **A new kind is a registration, not an image bump.** The clone/PR/infra vocabulary the
    built-ins use is the public one: `clone.requirePr` and `clone.prFallback` (an in-place
    fixer with no PR to fix), `clone.mergeBase` (a resolver that merges base in first),
    `testInfra` (stand the service's test dependencies up), `image: 'ui'` (the browser image),
    `localWrites` (an explore kind that writes in its own tree, so the read-only guardrail
    would misread as a refusal to run), and `standardsDelivery: 'none'` (a kind that judges
    rather than produces).
  - **A kind's own prompt can name a branch.** `userPrompt` receives an `AgentDispatchContext`
    (`baseBranch` / `workBranch` / `multiRepo`) on a container dispatch, and `userPromptSuffix`
    appends to the generic block-context prompt instead of replacing it. A suffix ENDS the
    prompt: it is applied after the human's revision feedback and after any folded-in context
    files, both of which append too, so a reply-shape instruction stays the last thing read.
  - **A built-in's structured reply reaches its engine channel through `mapStructuredResult`**
    on the definition (`mergeAssessment`, `testReport`, `spec`, …). A kind that declares none
    surfaces its parsed JSON on `result.custom`, which is what a custom kind's post-op reads.
- What the built-ins still keep that a registered kind does not: their ROLE prompts, which are
  owned by the shipped tracks (`baseSystemPromptFor`) rather than restated on the definition,
  and their palette entries, which are first-class in the SPA's own catalog rather than
  projected through `customAgentKinds`.
