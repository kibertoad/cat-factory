# ADR 0029: Agent-kind capabilities; declared skills and tool servers (MCP)

- **Status:** Accepted (implemented)
- **Date:** 2026-07-28
- **Context layer:** backend (`@cat-factory/kernel`, `@cat-factory/contracts`, `@cat-factory/agents`,
  `@cat-factory/orchestration`, `@cat-factory/server`, both runtime facades) +
  `@cat-factory/executor-harness`

## Context

A deployment could register its own agent KINDS (ADR 0028 / `custom-agents.md`) but could not give
one the two things that most change what an agent can actually do:

- **Skills.** Repo-sourced Claude Skills (ADR 0024) existed, but only as the built-in `skill` agent
  kind running ONE skill picked per step (`stepOptions.skillId`). A custom kind could not say "my
  work is always done according to this playbook", and a deployment shipping an agent package had
  no way to ship its playbook with it: the skill had to be authored in a customer repo and synced,
  which a fresh deployment with no skill library configured cannot do at all.
- **Tools.** There was no MCP support anywhere. The only extra capability an agent could be given
  was proxy-backed web search, hard-wired end to end. A company agent that needs to read its own
  issue tracker, advisory database or internal service had no seam short of forking the harness.

## Decision

An agent kind DECLARES capabilities; the platform resolves them per dispatch.

- **Declaration** is on `AgentKindDefinition`: `skills?: AgentKindSkillRef[]` and
  `toolServers?: AgentKindToolRef[]`. Each ref is a registered id, an inline definition, or (skills
  only) `{ catalogSkillId }` for a repo-synced one. Reusable definitions are registered on the SAME
  app-owned `AgentKindRegistry` (`registerSkill` / `registerToolServer`), and
  `assignSkills` / `assignToolServers` attach them to an EXISTING kind: the seam that gives the
  built-in `coder` the house playbook or the org's MCP server without redefining it. Both mirror the
  registry's existing `registerTrait` / `assignTraits` pair.
- **Skills resolve in the ENGINE** (`resolveRunSkills`, called by `AgentContextBuilder`) onto
  `AgentRunContext.skills` (the kind's declarations then the step's pick, deduped by id) with
  catalog versions pinned onto `step.skillVersions`. A BUNDLED skill (shipped in the deployment's
  code) resolves with no library, no GitHub and no pin.
- **Tool servers resolve in the CONTAINER EXECUTOR** (`resolveToolServers`), because what is
  possible depends on the resolved HARNESS, on whether the run uses the developer's own ambient CLI
  login, and on the facade-wired credential resolver: none of which the runtime-neutral engine
  knows. The result splits in two: the non-secret
  `toolServers` / `unavailableToolServers` projection folded onto the prompt context (and therefore
  into the agent-context snapshot), and the secret-bearing `mcpServers` job-body field.
- **Credentials** are declared BY NAME (`secretKeys`) and resolved through the new kernel
  `ToolSecretResolver` port. Both facades wire `createEnvToolSecretResolver` (read off the
  deployment's own environment) by default.
- **The harness materialises, never decides**: `skills[]` installs natively under
  `CLAUDE_CONFIG_DIR/skills/<name>/` for claude-code, else `.cat-context/skill/<name>/`;
  `mcpServers[]` becomes a per-run `--mcp-config` file (with `--strict-mcp-config`) for claude-code
  and `[mcp_servers.*]` blocks in the per-run `CODEX_HOME/config.toml` for Codex.
- **Boot validation** (`validateRegistrations`) errors on an unregistered skill/tool id or a
  malformed MCP server id, and warns when tool servers are declared on a non-container kind.

## Rationale

- **Capabilities live with the kind registry, not in two new registries.** Traits already
  established that a capability OF an agent kind belongs on that registry; adding two more
  app-owned registries would mean two more `CoreDependencies` fields threaded through three facades
  for data with the same lifecycle and the same injection point.
- **Bundled skills exist because the catalog cannot serve a shipped agent.** The catalog is
  per-tenant runtime data behind a GitHub sync; a package's own playbook is deployment-static code.
  Both resolve to the identical `ResolvedSkill`, so nothing downstream branches on origin.
- **`skill` became `skills` everywhere rather than a second parallel field.** Backwards
  compatibility is a non-goal, and a dispatch that could carry a step's pick AND a kind's playbooks
  with two disjoint mechanisms would double every rendering, materialisation and pinning path.
  `step.skillVersion` likewise became `skillVersions` (step JSON, so no migration).
- **Tool servers are filtered in the executor, and their absence is STATED.** Pi has no MCP client
  and an ambient Codex run has no per-run config home to write servers into. Dropping a server
  silently would let an agent plan around a tool that was never there and discover the gap
  mid-run; the prompt's "not available on this run" line is what makes that a planning input.
- **A required credential that does not resolve DROPS the server.** Handing an agent a tool whose
  first call 401s is worse than telling it the tool is absent, so `required` defaults to true.
- **The credential is a PORT, not a table.** Reading declared keys off the deployment environment
  makes a tool server usable with no new storage, migration or UI; a deployment needing
  per-workspace credentials implements the port, and nothing else in the dispatch path changes.
- **The prompt fold sits at the container-dispatch chokepoint** (`buildKindBody`), like the
  effort-report guidance, so a registered kind with its own `userPrompt` builder cannot bypass it.

## Consequences

- **Runtime symmetry** holds by construction: no table, no migration, no repository method; the
  capability state rides the run context, the step JSON and the job body. Both facades wire the
  same default credential resolver, and a conformance assertion pins that a registered kind's
  declared skill reaches the dispatched run context on every runtime.
- **Mothership mode** is unaffected for the same reason: nothing here is a persisted repository
  call, so there is no `REMOTE_PERSISTENCE_METHODS` entry to classify.
- **Codex is stdio-only**, so an HTTP tool server is skipped in its config rather than rendered as
  a broken block; declare `harnesses: ['claude-code']` on such a server so the drop is reported to
  the agent as unavailable rather than being invisible.
- **`allowedTools` is SCOPING, not a security boundary, and it is stated in the prompt on every
  harness.** It is additionally sent to claude-code's `--allowedTools`, but only when a server
  actually narrows something, and always together with the CLI's built-in tool names: an allow-list
  is WHOLE-SESSION, not MCP-scoped, so a list of bare `mcp__*` patterns would leave the agent
  unable to read, edit or build anything. Whether the CLI treats the list as a gate at all is
  permission-mode dependent (the run uses `bypassPermissions`, under which an allow-list grants
  rather than gates) and is not a contract we control, so the harness is written to be correct
  either way. Codex cannot express a per-tool restriction at all. A server whose other tools an
  agent kind must genuinely never reach should not be wired for that kind.
- **An HTTP tool server must be `https`, or loopback.** Its resolved credential rides the request as
  a header, so cleartext off-box would put it on the wire. Enforced twice on purpose: at
  registration (`insecure_tool_server_url`, where the failure names the registration that caused it)
  and again at the harness job boundary (which a body arriving by another route would otherwise
  skip). Loopback is exempt so a sidecar server with no certificate stays usable.
- **The default credential resolver is a TRUST BOUNDARY.** A definition names both the key it wants
  and the endpoint it talks to, so `createEnvToolSecretResolver` lets a registration pair any
  deployment environment variable with a transport that ships it somewhere. On Node that grants
  nothing new (in-process code can read `process.env` directly); on the Worker it is a genuine
  widening, since `env` is not otherwise ambient to a registration. Acceptable when every agent
  package is the deployment's own, and `{ allowKeys }` is the lever when it is not. The
  recommended convention is a dedicated `MCP_…` prefix.
- **A capability declared on a NON-container kind is inert, and boot says so**
  (`tool_servers_without_container` / `skills_without_container`, both warnings). Only a container
  dispatch installs a skill or wires a tool server. The skills case is the sharper one: a
  non-optional `{ catalogSkillId }` on an inline kind fails every dispatch of that kind on a
  deployment with no skill library, for a skill that could never have reached the model.
- **Image bump required**: the harness gained the `skills` / `mcpServers` body fields, so a
  deployment must roll a new `@cat-factory/executor-harness` tag for capabilities to reach a
  container. A self-hosted runner pool left on an older image silently drops both fields: see the
  changeset for why the claude-code case is a blind run rather than a failed one.
- **Deliberately not pursued.** No per-workspace tool-server UI or credential store (the resolver
  port is the seam for one); no MCP for Pi (it has no client); the built-in agents' migration onto
  the custom-agent model remains separate strangler work.
