# MCP support maturation

Status: **in progress; slices 1 and 2 landed.** Source: the 2026-08-04 review of both MCP surfaces.

## Goal

Take the platform's two MCP surfaces from correct-but-thin to honest, guarded, hosted and
tenant-configurable. The surfaces are: agent kinds CONSUMING MCP tool servers
([ADR 0029](../../backend/docs/adr/0029-agent-kind-capabilities.md), #1451, plus the
capability-credential store, #1620/#1624/#1631), and the public API SERVED over MCP
(`sdk/mcp` = `@cat-factory/mcp-server`, #1643). Every review finding lands in exactly one slice
below or in the deliberately-not-pursued list, so nothing is re-litigated finding by finding.

## Why

Both surfaces are days old and already load-bearing: tool servers are the documented way a
deployment extends its agents, and the MCP server is the documented way an external LLM drives
the platform. The review's verdict was strong foundations (credential hygiene, stated-not-silent
drops, generation drift guards, honest truncation) with the gaps concentrated in four verified
defects and a handful of structural absences:

- **The consuming side breaks its own honesty rule in one spot.** `servableOnThisRun`
  (`backend/packages/server/src/agents/toolServers.ts`) checks harness membership but not
  transport, while the harness's `codexMcpConfigToml` skips every non-stdio server. On a Codex
  run an `http` server is advertised in the prompt ("prefer them over guessing") and never wired.
- **The recommended attachment path escapes both loud channels.** `checkAgentCapabilities`
  iterates `registry.all()` only, and the heavily-used built-ins (`coder`, `ci-fixer`, `tester`,
  `merger`, `conflict-resolver`) are not registry entries, yet `assignToolServers('coder', …)` is
  what the docs recommend and `toolServersFor` serves it. Boot validation
  (`insecure_tool_server_url`, `reserved_credential_key`, `unknown_tool_server`) and the
  capability-credential checklist (`collectDeclaredCapabilityCredentials`, same `all()` walk)
  both skip those declarations. Dispatch-time floors still hold, so this is a loudness gap, not a
  leak, but it defeats the "refused at declaration" layer for the commonest case.
- **The published MCP server sits outside the repo's own publish guards.**
  `check-publish-integrity.mjs`'s `WORKSPACE_GLOBS` and `check-package-catalog.mjs` both omit
  `sdk/*`. The empty-shell guard exists because two packages already shipped hollow, and this
  package is exactly the vulnerable shape: one `bin` entry pointing at a gitignored `dist`.
  Nothing in CI starts the real binary either (no smoketest runner, `bin.ts` untested).
- **The progress guard can abort MCP-heavy runs.** `progress-guard.ts` exempts planning,
  exploration and subagent-dispatch tools from the no-progress signal and has no handling for
  `mcp__*` names, so an edits-expected kind doing legitimate research through a read-only MCP
  server accrues "N tool calls and not one file edit".

Structurally: no hosted MCP endpoint (stdio + npm + a long-lived key in plaintext host config is
the only access path), no OAuth in either direction (which locks out the OAuth-first vendor
ecosystem: Figma, Slack, Atlassian remote MCP), no tenant-level say over WHICH servers apply
(only the credential half is per-workspace), and no operability story (no probe, no `/test`
parity, telemetry records server ids and drop reasons only, the SPA shows a raw `extras` JSON
dump and never uses the word MCP).

## Target patterns

- **Tenant configurability copies the binary generators** (the sibling subsystem, one day older):
  code registry, non-secret snapshot projection, per-step picker, contracts-level vocabulary. See
  [binary-output-foundational-storage.md](./binary-output-foundational-storage.md).
- **The probe copies the `/test` endpoints** every neighbouring connection type already has
  (environments, runners, local models, user secrets).
- **The hosted endpoint mounts what already exists**: `createCatFactoryMcpServer` returns a bare
  `Server` decoupled from transport, and the pinned `@modelcontextprotocol/sdk` 1.30 ships
  `StreamableHTTPServerTransport`.
- **OAuth tokens live in the capability-credential store**
  ([capability-credential-store.md](./capability-credential-store.md)): sealed, per-workspace,
  already composed in front of the environment resolver per key.

## Slices

- [x] **1. Honest wiring: every declared server is either served or stated.** ([#1664](https://github.com/kibertoad/cat-factory/pull/1664))
      The consuming-side defects, together because they are one property enforced at three layers.
      `servableOnThisRun` became transport-aware, so an `http` server on a Codex run is dropped
      WITH a stated reason (`transport_unsupported`, a new member of the unavailability vocabulary)
      instead of advertised and then skipped by `codexMcpConfigToml`. Boot validation gained a
      transport-by-harness rule (`tool_server_unservable`, a warning, `harnesses: ['pi']` included)
      and now validates ASSIGNED capabilities through the new
      `AgentKindRegistry.kindsWithCapabilities()` union helper, with the container warning going
      through `runsInContainer` rather than `registry.requiresContainer` (which answers false for
      every built-in). `collectDeclaredCapabilityCredentials` enumerates the same union.
      `allowedTools` entries are held to `isValidMcpToolName` at all three layers (registration, the
      dispatch that builds the prompt projection, the job boundary), and the server list to
      `TOOL_SERVER_BUDGET`, dropping the excess under `over_budget` rather than refusing the dispatch
      as the context-file corpus does: tool servers are deployment CODE, so boot is where the fault
      is named. BOTH budget dimensions warn at boot, the byte one measured on the declaration
      (`toolServerDeclaredBytes`, a floor on the resolved spec the dispatch measures), and the
      unbounded DROP list is folded into a count past `maxStatedUnavailable` so the runaway
      declaration the cap exists for cannot reach the prompt one line at a time. The progress guard
      exempts `mcp__*` from the no-edit bound and bounds it with its own `maxConsecutiveMcpCalls`
      streak, plus `maxConsecutiveNonActionCalls` across every exempt family, since each per-family
      cap resets on a call outside its family and interleaving two of them tripped nothing.
      Image bumped to 1.89.0, carrying the harness-side test backfill: the `toolServersSection`
      prompt contract, the transport matrix, Codex `config.toml` end to end (asserted from INSIDE
      the run, since the per-run home is wiped in `finally`), and the `allowedTools` boundary.
- [x] **2. The published server: guarded, filterable, structured.** (#1665) Landed as scoped. Two
      decisions it had to make on the way, and the cost it leaves behind, are below.
- [ ] **3. Hosted MCP endpoint.** Mount the existing server behind
      `StreamableHTTPServerTransport` on BOTH facades, behind the public-API key auth and scope
      ladder, with a conformance assertion so the facades cannot drift. This is the adoption
      lever: today "drive cat-factory from Claude" requires npm, a local process and a key pasted
      into host config; a hosted endpoint makes the platform reachable from claude.ai, Claude
      Desktop and hosted agents with zero install. The slice decides statefulness (per-request
      server instance vs a session manager) and how the read-only/group filtering maps onto key
      scopes. The endpoint joins the public surface, so it ships under the stability contract
      from its first release. The stdio binary stays: it is the path that needs no backend
      deployment and the only one for hosts without HTTP MCP support.
- [ ] **4. Tool-server operability.** A probe seam that speaks `initialize` + `tools/list` to a
      declared server, surfaced as the same `/test` shape every neighbouring connection type has,
      plus a Test button beside the capability-credential checklist. The probe is also the first
      thing that can validate `allowedTools` names against reality (today a typo narrows the
      allow-list to a pattern matching nothing while the prompt still advertises the name).
      Dispatch telemetry starts recording what the CLI actually reached (server started, N tools)
      on a typed snapshot field instead of the raw `extras` dump the SPA renders, and an
      unavailable server becomes a stated chip on the run surface rather than a line only the
      agent's own prompt and a backend warn ever see. A body-level capability handshake closes
      the blind-run case the harness CHANGELOG documents (a runner-pool image older than the
      backend parses the body without `mcpServers` and runs with the prompt still promising
      tools). `McpSecretRef` gains the `usage` note the checklist contract already carries but
      the tool-server branch never populates. And the job-body observation seam
      ([capability-credential-store.md](./capability-credential-store.md) slice 3, re-scoped
      there as exactly this) lands here, giving tool servers their first cross-runtime
      conformance assertion. Operator docs close the loop: a "add the Slack MCP server" runbook
      with a worked example beyond `org-advisories`, and the `MCP_*` naming convention documented
      in `docs/environment-variables.md` where operators actually look.
- [ ] **5. Tenant-level configurability.** The binary-generator pattern applied to tool servers:
      a contracts-level non-secret vocabulary, a snapshot projection, per-workspace
      enable/disable, per-step selection via `stepOptions`, and a picker. The SPA finally learns
      the word MCP (i18n). Registration stays code-first on purpose: the deployment declares WHAT
      exists (URL, command, transport, credentials by name), the tenant chooses WHERE it applies
      and supplies values, so the trust boundary does not move. Capability credentials join the
      public API in the same slice, so provisioning stops being SPA-only. This supersedes ADR
      0029's "no per-workspace tool-server UI" non-goal, already half-stale since the credential
      store landed; the ADR's consequences section is updated in the same PR.
- [ ] **6. OAuth, both directions.** Consuming: authorization-code + refresh for remote `http`
      servers, tokens sealed in the per-workspace capability-credential store, the grant flow in
      the same panel. This is the biggest capability unlock on the consuming side: the modern
      vendor MCP ecosystem is OAuth-first, and a static env var or header template cannot reach
      it. Serving: the MCP authorization spec on the hosted endpoint (resource metadata; dynamic
      client registration as scoped), so a host connects without a long-lived key in plaintext
      config. Deliberately last: the consuming half wants slice 5's per-workspace surface for
      grants, and the serving half needs slice 3's endpoint to exist.

## Findings inventory

Every finding from the review, with its disposition. "Slice N" means the slice's checklist above
carries it; "done" means that slice has landed.

| Finding                                                                           | Disposition                   |
| --------------------------------------------------------------------------------- | ----------------------------- |
| Codex+http server advertised in the prompt, dropped by the TOML writer            | Slice 1 (done)                |
| Assigned-to-built-in capabilities skip boot validation and the credential UI      | Slice 1 (done)                |
| `allowedTools`/`harnesses` unvalidated (comma join, impossible harness lists)     | Slice 1 (done)                |
| No cap on server count/size, unlike the context-file corpus                       | Slice 1 (done)                |
| Progress guard counts `mcp__*` calls toward the no-edits abort                    | Slice 1 (done)                |
| Named test gaps (prompt section, harness narrowing, Codex TOML, argv positive)    | Slice 1 (done)                |
| `sdk/mcp` outside publish-integrity and package-catalog guards                    | Slice 2 (done)                |
| No CI run of the real binary; `bin.ts` untested; no smoketest runner              | Slice 2 (done)                |
| API key only via env, plaintext in host config                                    | Slice 2 (key file), slice 6   |
| Tool filtering is group-coarse, startup-only                                      | Slice 2 (done)                |
| Text-only pretty-printed results; no `outputSchema`/`structuredContent`           | Slice 2 (done)                |
| `destructiveHint` unset on the four spending tools                                | Slice 2 (done)                |
| `sdk/AGENTS.md` silent on MCP; no `claude mcp add`; no worked flow; no poll guide | Slice 2 (done)                |
| stdio-only; no hosted endpoint; no backend MCP route                              | Slice 3                       |
| No probe/health check; `allowedTools` never checked against reality               | Slice 4                       |
| Telemetry records ids only; SPA renders raw `extras` JSON                         | Slice 4                       |
| Dropped-server diagnosis reaches the agent and a warn log, no operator surface    | Slice 4                       |
| Older harness image silently drops `mcpServers` (blind run)                       | Slice 4                       |
| `McpSecretRef` lacks the `usage` note the checklist can render                    | Slice 4                       |
| Tool servers asserted nowhere cross-runtime                                       | Slice 4                       |
| No per-workspace/per-step server selection; no wire vocabulary; no SPA visibility | Slice 5                       |
| Capability credentials absent from the public API                                 | Slice 5                       |
| No OAuth for remote tool servers                                                  | Slice 6                       |
| No MCP authorization on the serving side                                          | Slice 6                       |
| `http` conflates streamable HTTP and SSE; fixtures use `/sse` URLs                | Not pursued (below)           |
| No composed tools / auto-pagination in the MCP server                             | Not pursued (below)           |
| Declared `additionalProperties: false` not enforced locally                       | Not pursued (below)           |
| No marketplace/catalog of known vendor servers                                    | Not pursued (below)           |
| Checklist granularity ((workspace, key) sharing, unscoped list)                   | Standing decisions, unchanged |
| Env-fallback default `true`; `allowKeys` unset                                    | Tracked elsewhere (below)     |
| No MCP resources/prompts/elicitation/progress notifications                       | Deferred (below)              |
| Pi has no MCP client                                                              | Standing non-goal (ADR 0029)  |

## Deliberately not pursued

Recorded so the next iteration does not re-propose them.

- **A third `sse` transport member.** The HTTP+SSE transport is legacy in the MCP spec, replaced
  by streamable HTTP, which `kind: 'http'` already means in practice. The fix is documentation
  (state the mapping in the authoring guide) and cleaning the `/sse` URLs out of the fixtures,
  not a vocabulary member that invites new legacy integrations. Revisit only if a server that
  matters ships SSE-only.
- **Composed tools and auto-pagination in the MCP server.** The 1:1-with-HTTP shape is what the
  generator can hold drift-free; a composed "triage this run" tool is authored behaviour with no
  spec to diff against. The cheaper remedies land first: structured output (slice 2) and polling
  guidance in the instructions. Revisit once real transcripts show the round-trip cost dominating.
- **Local enforcement of the input schemas.** Advisory-by-design: the deployment validates, the
  facade passes through, and a second validator would be a second vocabulary to keep in step.
  Already documented in the package README.
- **A marketplace/catalog of known vendor servers.** The skills/tool-servers asymmetry is stated
  in code ("a tool server is deployment infrastructure while a skill is authored content"), and
  slice 5 keeps registration code-first for the same trust-boundary reason. A curated catalog is
  a product decision to take separately if demand shows up.
- **Checklist granularity changes.** The (workspace, key) sharing, the `required` fold and the
  deliberately-unscoped list are standing decisions with their reasoning recorded in
  [capability-credential-store.md](./capability-credential-store.md); nothing in this review
  overturns them.
- **The environment-fallback default and `allowKeys`.** Both are already tracked: the default is
  the product call capability-credential-store slice 4 deliberately did not make, and unset
  `allowKeys` is on the security model's hardening checklist.
- **MCP resources, prompts, elicitation and progress notifications.** Deferred, not refused:
  host support is uneven and none of them gates the flows above. The natural revisit point is
  after slice 3, when hosted sessions make server-side prompts and progress worth having.

## Gotchas already known

- **Any harness-side change is an image bump** (`@cat-factory/executor-harness` version + the
  three pinned tags + `RECOMMENDED_HARNESS_IMAGE`), and a reused tag does not deploy. Slice 1
  bundled its harness edits into one bump (1.89.0); slice 4's handshake is a second.
- **The kernel/harness copies are pinned by conformity tests.** The id pattern, the tool-name
  pattern and the URL rule exist twice on purpose; a validation addition must extend both sides and
  the pinning test, not just kernel.
- **`registry.all()` walks are in more places than validation.** Slice 1 fixed the two found (boot
  validation, the credential checklist) and introduced
  `AgentKindRegistry.kindsWithCapabilities()`; anything new that enumerates "kinds with
  capabilities" must use it, or the same hole reopens.
- **A new unavailability reason owes prose in `UNAVAILABLE_REASONS`** (the exhaustive `Record` in
  `prompts/capabilities.ts`), phrased for the AGENT rather than an operator: it needs to know the
  tool is absent and that trying harder will not produce it. Two reasons deliberately render the
  SAME sentence (`harness_unsupported` / `transport_unsupported`) because the distinction is the
  operator's, carried by the log line and the boot warning.
- **The harness-side stdio-only skips are backstops now, not decisions.** `codexMcpConfigToml` still
  drops an `http` server, but the backend has already dropped it with a reason, so a change that
  makes the harness silently skip something is again the defect slice 1 closed.
- **A new progress-guard EXEMPTION owes two caps, not one.** Its own consecutive-call streak, and a
  place in the shared `maxConsecutiveNonActionCalls` backstop (`isNonActionToolCall`), because every
  per-family streak resets on a call outside its family: two exempt families interleaved trip
  neither, and a run that makes no action call never reaches the no-edit bound either. The
  exemption set and the backstop set must be the SAME predicate, or the guard either misses a loop
  or kills a run for a call the bound says it may make.
- **A cap on one side of a pair needs the other side asking whether it is now unbounded.** The
  dispatch caps the servers it WIRES; the drop list it produces instead had no cap and lands in the
  same prompt, which is why `maxStatedUnavailable` folds it. Same shape as the boot warnings: the
  count dimension had one and the byte dimension did not, so a fat declaration was refused at
  dispatch by a rule boot never mentioned.
- **Slice 3 is public surface from day one.** Paths, auth semantics and filtering behaviour on
  the hosted endpoint fall under the ADR 0032 stability contract immediately; there is no
  internal-first soft launch for an endpoint whose whole point is external callers.

## Slice 2's two decisions, and what they cost

- **An OUTPUT schema is not an input schema reversed.** A caller's MCP client REFUSES a successful
  result with no `structuredContent` for a tool that declares a schema, and VALIDATES the content it
  gets. `/api/v1` is additive forever, so every assertion that validation could turn against a newer
  deployment is dropped on the way out: no `required`, no `enum`, no closed `anyOf`, no bounds, and
  for a union not even `type` (every union on the surface has object variants today, so
  `type: 'object'` would be accurate about the spec as it stands and would still be the assertion a
  future string-or-array variant is rejected by). The known members of a vocabulary go in the field's
  description, where a new member cannot invalidate them. `emit-mcp.mjs` carries this as an
  `INPUT`/`OUTPUT` mode rather than a second renderer.
- **The result cap became a REFUSAL rather than a truncation**, forced by the same obligation: half an
  object cannot satisfy the schema it was cut out of. It is also the better trade on its own terms,
  since the old `[TRUNCATED]` note spent the whole cap delivering "this is not valid JSON, narrow
  instead of reading on".
- **What it costs, for whoever revisits it:** the declared output schemas are about 41 KB of JSON
  across the table, taking `tools/list` from roughly 20 KB to roughly 31 KB on the wire, and the text
  block still accompanies `structuredContent` as the protocol recommends. The compact-JSON change
  offsets part of it on the result side. Two levers if real transcripts show the tool-list read
  dominating, cheapest first: the notification `payload` object is inlined by three tools at ~3.9 KB
  each (29% of the total) and a model cannot act on thirty mutually exclusive payload shapes anyway,
  so rendering it as `{}` reclaims ~12 KB on its own; `debug_get_run` is the single largest entry at
  ~5.9 KB. Dropping the declarations entirely (keeping `structuredContent`) is the full reversal.

## Gotchas slice 2 surfaced

- **A declared `outputSchema` is a CONTRACT the caller enforces, not a hint.** The MCP client throws
  when a schema-carrying tool answers successfully without `structuredContent`, and ajv-validates the
  content against the schema. Anything that shortens, samples or partially renders a result is
  therefore incompatible with declaring one, which is what turned the cap into a refusal. Slice 3's
  hosted endpoint inherits this: the same tool table, the same obligation.
- **`sdk/*` was outside two guards, and the fix is the GLOB, not another entry.** Both
  `check-publish-integrity.mjs` and `check-package-catalog.mjs` named `sdk/typescript` or nothing;
  they now expand `sdk/*`, so the next SDK-family member is covered without anyone remembering. The
  Python/Go/Java clients have no `package.json` and drop out at read time.
- **The MCP phase of `sdk-smoketest` is graded, not compared.** There is one implementation, so it
  does not join `compareReports`; it reuses that module's problem vocabulary only so both phases
  report the same way. It is also the only check that can see a generated output schema disagree with
  what the deployment really answers, which makes it the natural home for slice 3's hosted-endpoint
  assertions too.
- **`pnpm build` on Windows executes zero tasks** (the root script's quoted `--filter` globs survive
  into turbo verbatim), so a local `pnpm check:publish` reports every package as an empty shell. Run
  `pnpm exec turbo run build --filter=./backend/** --filter=./sdk/**` instead.
