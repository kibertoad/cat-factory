# Defining custom agent roles: prompt, skills, and tool servers

> **Authoring a custom agent is on the website**:
> [Custom Agents](https://www.catfactory.ai/extend/custom-agents.html) owns registering a
> kind and declaring its capabilities. This page is the ROLE layer under it: what to write
> in a prompt and what the platform composes around it.

The ROLE a custom agent kind carries: what to write in its system prompt and what the
platform composes AROUND that text, how to author the skills (procedural playbooks) it
declares, and the behaviour knobs beyond the prompt.

It sits between three neighbouring docs and deliberately restates none of them:

- [`custom-agents.md`](./custom-agents.md): the extension MODEL: the three stages
  (preOps / agent / postOps), the registry seams, how the engine and harness run a
  registered kind, and the frontend surface. Read it first; this doc assumes it.
- [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md): provider
  tokens, schema-driven structured output (`defineStructuredOutput`), and boot-time
  registration validation.
- [`mcp-tool-servers.md`](./mcp-tool-servers.md): the full tool-server (MCP) model:
  registration, harness support, credentials, the probe, security posture and limits.
  Authoring one is the website's; the section below keeps only what the platform does with
  a declaration.

The design record for capabilities is
[ADR 0029](./adr/0029-agent-kind-capabilities.md); the worked example every section
below refers to is
[`backend/internal/example-custom-agent`](../internal/example-custom-agent/src/index.ts).

## What a "role" is

A role is everything a kind brings to a dispatch beyond its mechanical hooks: the system
prompt (who the agent is and what its deliverable looks like), an optional user-prompt
builder (how the task context is framed), its **traits** (checkable capabilities the
engine and prompt composer key off), its **skills** (playbooks it always applies), its
**tool servers** (MCP endpoints it may call), and a handful of per-kind knobs
(`webResearchHint`, `tuning`, `configContributions`). All of it lives on one
`AgentKindDefinition` (`packages/agents/src/agents/kinds/registry.ts`) and is registered
by reference on the app-owned `AgentKindRegistry`.

## The system prompt

### What you write is the BASE, not the whole prompt

`systemPromptFor` (`packages/agents/src/agents/catalog.ts`) assembles the final system
prompt in layers. Knowing the layers tells you what to leave OUT of your own text:

1. **Base prompt resolution.** The built-in tracks are consulted first (companions, the
   four standard phases, the tester/fixer, acceptance, mock, and business-logic tracks)
   and only then the registry. Two consequences:
   - **You cannot shadow a built-in track's prompt by registering its id.** Registering
     `kind: 'architect'` leaves the architect track's prompt in place (your `systemPrompt`
     is ignored); what DOES attach to a built-in kind is capabilities and traits; see
     "Extending built-in kinds" below. Pick a fresh id for a new role.
   - An UNREGISTERED, non-built-in kind falls back to a generic role line (the standard
     final-answer directive still appends), so a typo'd kind id in a pipeline doesn't
     crash: it just runs a bland agent. Boot validation catches the typo when the facade
     supplies `knownAgentKinds`.
2. **Surface-driven directives.** For a registered kind, the read-only guardrail and
   `FINAL_ANSWER_IN_REPLY` are appended automatically off `agent.surface` (the table is in
   [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md#prompt--resultview-wiring)).
   Precisely: the guardrail fires for the `container-explore` surface (plus a hard-coded
   set of built-in read-only kind ids), and the final-answer auto-append applies only when
   the base prompt came from the registry; the built-in tracks manage their own.
   **Never paste either directive into your own prompt**: you would double-apply it, and
   your copy would not track future platform wording.
3. **Trait guidance.** Every trait the kind carries that defines `guidance` contributes a
   block (e.g. `spec-aware` appends the in-repo `spec/` reading instructions). See
   "Traits" below.
4. **Engine folds at dispatch** (not part of `systemPromptFor`, but part of what the model
   reads): the service's selected best-practice standards for `code-aware` / `doc-aware`
   kinds (full or `brief` per the `brief-standards` trait, unless
   `standardsDelivery: 'context-files'`), the web-search guidance when the deployment
   enables it (steered by your `webResearchHint`), the tool-servers section (below), and,
   on harnesses without native skill support, the declared skills' instructions.

So the text you author should carry ONLY the role: who the agent is, what it must do, and
what its deliverable looks like. The plumbing statements are all supplied.

### Writing the role text

The built-in kinds and the worked example converge on a few conventions worth copying:

- **Second person, deliverable first.** "You are a security auditor. Explore the
  repository (read-only) and assess …": the first sentence is the identity, the second
  the job. An agent whose prompt buries the deliverable under context tends to produce
  context.
- **A structured kind's prompt states the JSON contract in-line**, mirroring the
  `structuredOutput` schema: `Return ONLY a JSON object: { "risk": 0..1, … }`. The schema
  drives the engine's `shapeHint` and repair call, but the prompt is what the model reads
  first: keep the two in step (they live a few lines apart in the example precisely so a
  drift is visible in one diff).
- **State the constraint the surface can't imply.** A `container-coding` fixer that must
  not open a PR says so ("Commit and push your changes; do NOT open a pull request": the
  `license-fixer` example); a coding kind whose canonical artifact is rendered by a
  post-op tells the agent to commit a working draft and skip the formatting (the
  `org-researcher` example, and see its file header for why the draft is load-bearing).
- **Don't restate what a skill will carry.** Procedure ("check X, then Y, rate against
  Z") belongs in a skill, where claude-code loads it on demand instead of paying for it
  on every turn; the prompt keeps the role and points at nothing: the platform renders
  the skill's presence itself.
- **The function form serves a family.** `systemPrompt: (kind) => string` receives the
  kind id, so one definition object (spread into several `register` calls) can phrase a
  family of related kinds without duplicating the shared text.

Registered prompts are not covered by the `kinds/versions.ts` version-bump rule (that
applies to the built-in versioned prompts); your package's own release discipline governs
prompt changes.

## The user prompt

Most kinds should NOT set `userPrompt`. The default generic builder
(`buildBaseUserPrompt` in `catalog.ts`) already renders the pipeline name, block
title/type/description, linked context documents, environment and involved-services
sections, resolved decisions, and every prior step's output, which is the right framing
for a kind that "does its job against the task".

Write a custom `userPrompt(context)` only when the DEFAULT FRAMING is wrong for the role
(e.g. the kind must see exactly one prior output, or needs the block fields arranged as a
brief). The contract when you do:

- **You take over the task framing entirely.** None of the generic sections render;
  anything you need (`context.block`, `context.priorOutputs`, `context.decisions`,
  linked context) you render yourself from `AgentRunContext`.
- **Two things still happen around your text.** Initiative-preset steering
  (`promptAdditions` for your kind, on an initiative-spawned run) is prepended BEFORE your
  prompt: standing org methodology frames the role before the task text, and you cannot
  opt out of it. Human revision feedback (a rejected gated proposal's previous text +
  reviewer comments) is appended AFTER it. Both are empty on the common path, so your
  prompt is byte-for-byte your own on a plain run.

## Traits

A trait is a checkable capability marker; some also carry prompt guidance
(`packages/agents/src/agents/kinds/traits.ts`). The website's
[trait table](https://www.catfactory.ai/extend/custom-agents.html#traits) lists every one the
platform reads and what it does. Two composition rules it does not carry, because both are about
what the ENGINE does with the fold rather than about picking a trait:

- **Pick `brief-standards` by loop length, not prestige.** A `code-aware` kind that edits code over
  many turns should carry it (the built-in coder/fixers do), because the system prompt is re-sent
  every turn; a reviewer or planner that runs few turns benefits from the full standard text and
  should not.
- **`standardsDelivery: 'context-files'` is orthogonal**: it stops the fold entirely and makes YOUR
  preOp responsible for writing the standards as `.cat-context/` files (the delegating-agent case;
  see [`custom-agents.md` → The seams](./custom-agents.md#the-seams) for why the fold is skipped
  and what happens when that preOp does not run).

A pure MARKER trait (no `guidance`) is only useful if your own backend code checks it via
`hasTrait` / `traitsFor`: the engine knows nothing about it, so registering one and expecting a
behaviour change is the mistake this sentence exists to prevent.

## Skills: authoring the playbook

A skill is a procedural playbook: HOW work of some shape is done, as content. It differs
from prompt text in when it is read: on claude-code it installs as a native skill the
CLI loads on its own judgement (keyed off the `description`), so a long procedure costs
nothing until it is needed; on other harnesses the instructions fold into the prompt.
The forms a `skills` ref can take, the resolution/materialisation model and the
dispatch-failure semantics of catalog refs are covered in
[`custom-agents.md` → Capabilities](./custom-agents.md#capabilities-skills-and-tools);
this section is about writing a good `BundledSkillDefinition`
(`packages/agents/src/agents/kinds/capabilities.ts`).

| Field          | What it actually does                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | The registry key (`skills: ['<id>']` refs it) and the id reported on the run. Stable; renaming it orphans every kind that refs it (an unknown id is a boot error).                                 |
| `name`         | Becomes the native skill DIRECTORY name (`CLAUDE_CONFIG_DIR/skills/<name>/` or `.cat-context/skill/<name>/`) and the `SKILL.md` frontmatter `name`. Keep it filesystem-safe (kebab-case).          |
| `description`  | The frontmatter `description`, i.e. **the trigger**: what claude-code matches against when deciding to load the skill. Write it as "when this applies", not as a title.                            |
| `instructions` | The `SKILL.md` body: the procedure itself.                                                                                                                                                         |
| `resources`    | Sibling files materialised alongside the skill (`relPath` + `content`). For reference material the procedure points at (rubrics, templates, checklists) that would bloat the instructions in-line. |

Authoring guidance, distilled from the `org-security-review` example:

- **Write a procedure, not a persona.** Numbered steps, in execution order, each an
  imperative. The ROLE lives in the kind's system prompt; the skill assumes the role is
  already established.
- **Scope the input explicitly** ("start from the diff, not the whole repo"): an agent
  applying a playbook over-collects unless told what the unit of work is.
- **Reference resources by their `relPath`** ("rate each finding against `severity.md`"):
  the files land beside `SKILL.md`, so a bare relative name is how the agent finds them.
- **Include the negative-space rule.** The example ends with "never invent a finding to
  have something to report: an empty findings list on a clean change is the correct
  answer." A playbook that only lists what to do teaches the model that output volume is
  success.
- **Keep one skill per playbook.** Several kinds sharing a procedure ref one registered
  id; a procedure used by exactly one kind can be declared inline on that kind. Don't
  merge unrelated procedures into one skill to save a registration: the CLI loads a
  skill whole.

Ordering and dedup, when several sources declare skills for one dispatch: at the REF
level the kind's OWN `skills` come first, then any `assignSkills` additions, then (on
the built-in `skill` kind ONLY) the step's picked skill (`stepOptions.skillId`; a
step-level pick on any other kind contributes nothing). All are deduplicated by id. One
caveat on the RESOLVED order (`run-skills.ts`): every bundled skill materialises before
any `{ catalogSkillId }` ref, so declaration order is only preserved among refs of the
same form; a kind mixing bundled and catalog refs should not rely on its listed order
across the two.

## Tool servers: authoring the MCP definition

The whole authoring surface is on the website:
[Give Agents External Tools (MCP)](https://www.catfactory.ai/extend/tool-servers.html) owns
registering a server, the harness matrix, `allowedTools`, the credential rules (including the
reserved-lookup-key floor and `envName`) and OAuth end to end. The design behind those rules is
[`mcp-tool-servers.md`](./mcp-tool-servers.md) and [ADR 0029](./adr/0029-agent-kind-capabilities.md).

Three field-level facts sit under that page rather than on it, each because it is about how the
platform reads a declaration rather than about writing one:

- **`guidance` is load-bearing, not decoration.** It is rendered verbatim as the one sentence under
  the server's bullet, competing with the rest of the prompt for attention, so phrase it as a
  decision rule ("look up X here before doing Y"). An agent handed a tool it was not told the
  purpose of tends not to use it.
- **`harnesses` NARROWS and can never widen.** Pi has no MCP client regardless of what a definition
  says, so the field's only effect is to exclude.
- **`oauth` carries two fields the website's walkthrough does not need.** `resource` is the RFC 8707
  resource indicator, defaulting to the server's own url, which is right whenever the server is its
  own resource; `header` / `headerTemplate` default to `Authorization` / `Bearer {value}`, and a
  `secretKeys` entry naming the SAME header is a boot WARNING rather than an error, because the
  granted token wins and the static credential reaches the server as nothing.

### What the agent actually sees

`toolServersSection` (`packages/agents/src/agents/prompts/capabilities.ts`) renders a
`## Tool servers` section into every dispatch that declared any:

- Each WIRED server: its label, whether it "runs in your sandbox" (stdio) or is a "remote
  service" (http), your `guidance` verbatim, and, when `allowedTools` narrowed them,
  the exact `mcp__<id>__<tool>` names, matching what the CLI shows in its tool list.
- Each server that could NOT be wired: its label plus an agent-phrased reason ("not
  supported by the agent runtime this run uses" / "its credential is not configured for
  this deployment"), with an explicit instruction not to plan around it.

Read your `guidance` in that frame when writing it: it appears as the one sentence under
the server's bullet, competing with the rest of the prompt for attention.

### Repointing without forking

`registerToolServer` replaces by id, so a deployment that installs a third-party agent
package can re-register the same server id with its own endpoint/transport AFTER the
package's registration runs: every kind referencing the id picks up the replacement.
The same last-write-wins holds for `registerSkill` (swap a shipped playbook for the house
version) and `register` (kinds). Order your composition root accordingly: package
registrations first, deployment overrides second.

## Extending built-in kinds

`assignSkills` / `assignToolServers` / `assignTraits` are on the website's
[custom-agents page](https://www.catfactory.ai/extend/custom-agents.html#skills-and-tool-servers).
What it does not say, and what a change here has to keep true: all three are ADDITIVE and dedup
against the kind's own declarations, assigned skills come AFTER the kind's own at the ref level (so
a built-in's ordering is preserved, subject to the bundled-before-catalog caveat above), and there
is no "unassign". Narrowing a built-in kind means defining your own kind instead.

## Behaviour knobs beyond the prompt

- **`webResearchHint`**: one clause completing "Use it mainly to …", folded into the
  web-search guidance when the deployment enables search (e.g. "verify the vendor's
  current API contract before generating a client"). Omit for the generic hint; don't
  write a paragraph: it is spliced into a sentence.
- **`tuning.guardLimits`**: per-kind loosening of the harness anti-rabbithole guards
  (`maxToolCallsWithoutEdit`, `maxConsecutiveErrors`, `maxConsecutiveWebCalls`,
  `maxConsecutiveMcpCalls`, `maxConsecutiveNonActionCalls`). **Loosen-only**: the harness
  clamps each override up to its own base, so a value tighter than the default no-ops.
  Declare one only with a documented reason the kind's NORMAL pattern trips a default
  guard (the built-in `researcher` raises the consecutive-web cap because a real survey IS
  many searches in a row). Raising a per-family cap past
  `maxConsecutiveNonActionCalls` (200) does nothing on its own: that one bounds the exempt
  families together, so a kind that genuinely needs a longer uninterrupted research run
  raises both.
- **`configContributions`**: task-level config descriptors surfaced on task creation and
  the inspector, editable until the kind's step starts. Give each descriptor
  `agentKind: <your kind>` so the freeze targets the right step.

## Registration order, validation, and seeing what a run received

Order matters inside your `register*` entry point:

1. `registerSkill` / `registerToolServer` (and `registerTrait`): the shared definitions.
2. `register` / `registerAll`: the kinds that reference them by id.
3. `pipelineRegistry.register`: the pipelines that chain the kinds.

Boot validation (`validateRegistrationsOnce`, see the ergonomics doc) then cross-checks:
an unresolved skill/tool id, a malformed MCP server id, or an insecure HTTP tool-server
URL (`insecure_tool_server_url`, re-checked at the container job boundary; the
`register*` calls themselves validate nothing) is a startup ERROR; skills or
tool servers on a non-container kind warn (`skills_without_container` /
`tool_servers_without_container`) because only a container dispatch can install or wire
them. A dispatch that still meets an unknown id (registration raced past validation)
DROPS it rather than failing the run.

To verify which tool servers a dispatch actually got, read the STEP: `step.toolServers`
holds the servers it wired and the ones it dropped with the reason, on every container
dispatch and for as long as the run exists. The step detail renders them as chips, and
`GET /api/v1/debug/runs/:runId` serves the same record as `steps[].toolServers`.

To verify the rest of what a dispatch contained, use the run's agent-context snapshot (the
Observability panel, or `GET /workspaces/:ws/executions/:executionId/agent-context`: gated
on `LLM_RECORD_PROMPTS` + the workspace's `storeAgentContext`): it captures the composed
system and user prompts (so you can see the directive/trait/standards layers around your
text) and the injected `.cat-context/*` file bodies. Credentials never appear in either: a
tool-server secret rides only the job body.

## Authoring checklist

1. Pick a fresh kind id (a built-in track's id cannot be re-prompted) and a surface; let
   the surface supply the read-only/final-answer directives.
2. Write the role text: identity + deliverable, the JSON contract for a structured kind,
   any constraint the surface can't imply. No plumbing directives, no procedure.
3. Move procedure into a skill: trigger-shaped `description`, numbered `instructions`,
   rubrics/templates as `resources`, a negative-space rule.
4. Declare tool servers with decision-rule `guidance`; secrets by name under an `MCP_`
   prefix (`header`/`headerTemplate` for HTTP), `required` left true unless genuinely
   optional.
5. Declare traits (`code-aware`/`spec-aware`/`brief-standards` as applicable); consider
   `webResearchHint` and loosen-only `tuning` only with a concrete reason.
6. Register definitions before kinds, kinds before pipelines; deployment overrides after
   package registrations. Boot validation and the agent-context snapshot are the check
   that what you wrote is what a run receives.
