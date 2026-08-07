# MCP support maturation

Status: **in progress; slices 1, 2, 3, 4, slice 5's HANDSHAKE and RUN-RECORD halves and slice 7's CONSUMING half landed.** Sources: the 2026-08-04 review of both MCP
surfaces, and the 2026-08-05 follow-up review of one question through the same material: how well
a deployment can add EXTERNAL tool servers programmatically, without forking. That review's
verdict and its new findings are folded in below (the inventory rows marked 2026-08-05, slice 8,
and the criticality notes on slices 5 and 7); its documentation findings landed with it as
[`backend/docs/mcp-tool-servers.md`](../../backend/docs/mcp-tool-servers.md), the consuming-side
authority doc split out of `custom-agents.md`.

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
  `WebStandardStreamableHTTPServerTransport` (the `Request → Response` sibling of the Node-only
  `StreamableHTTPServerTransport`, which is what let slice 3 land in the shared controller layer).
- **OAuth tokens live in the capability-credential store**
  ([ADR 0041](../../backend/docs/adr/0041-capability-credential-store.md)): sealed, per-workspace,
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
- [x] **3. Hosted MCP endpoint.** `POST /api/v1/mcp`, mounted by `PublicMcpController` in the
      SHARED controller layer, so both facades serve it from one implementation rather than two that
      could drift. `handleMcpHttpRequest` lives in `sdk/mcp` beside the server it wraps, which is
      what keeps the MCP SDK (and its Node-reaching types) out of the backend's Web-standard HTTP
      layer and makes the endpoint something any deployment of this API can stand up. Tool calls
      reach `/api/v1` through `http/loopback.ts` under the CALLER's forwarded key, so nothing is
      reachable there that the same key could not reach with `curl`. The three decisions the slice
      owed, and the two things it turned out not to need, are below.
- [x] **4. Tool-server operability: the PROBE.** The half of the original slice 4 that answers
      "does this declared server actually work". Split from the run-surface half below because they
      are two properties settled from two different sources (a live request now, versus what a past
      run recorded), and because one PR carrying both would have been twice the reviewable size.
      Landed: `GET /workspaces/:ws/tool-servers` (the inventory, which existed in no form at all) and
      `POST /workspaces/:ws/tool-servers/:id/test`, both `secrets.manage`-gated INCLUDING the read; a
      hand-rolled Streamable-HTTP client; the `allowedTools` reconciliation, gated on a COMPLETE tool
      list so a paginated tail cannot make a working tool read as missing; `McpSecretRef.usage`,
      declared in kernel and populated into the checklist the contract already had a field for; the
      Test button and the inventory rendered above the credential checklist; and the operator docs
      (the Slack runbook, the `MCP_*` convention). Its four decisions are below.
- [ ] **5. Run-surface observability for tool servers. The HANDSHAKE and RUN-RECORD halves have
      landed; the CLI-OBSERVED half has not.**
      **Handshake (done):** the harness reports the job-body capability field names it parses
      (`mcpServers`, `skills`) on `/health` and on the `POST /jobs` acceptance; `RunnerTransport`
      gained a `RunnerDispatchAck` return every harness-speaking transport forwards; and the
      dispatch site holds the body it just sent to that answer. The answer is THREE-STATE and that
      is the design, not a hedge: `unsupported` refuses the dispatch (releasing the job the harness
      already started) as an `UnavailableError` whose `runner_image_capability` reason makes the
      step a `preflight` fault, while `unknown` proceeds and is reported through a warn line plus
      `container.capability_unknown`. Its decisions and the gotchas it surfaced are below. Image
      bumped to 1.93.0.
      **Run record (done):** what a dispatch DECIDED is now a typed record on the step itself
      (`step.toolServers`: the wired servers, and the dropped ones each with their reason), carried
      on the job handle and folded by `recordDispatchAttribution`, rendered as chips on the step
      detail with translated copy per reason in all ten locales. The reason vocabulary moved into
      `@cat-factory/contracts` and kernel's `UnavailableToolServer` is typed against it, so the two
      sides cannot drift into a member that renders blank. The duplicated entries in the
      agent-context snapshot's untyped `extras` bag were deleted rather than kept beside it. The
      job-body observation seam landed with it
      (the last open slice of the capability-credential store, whose tracker this PR converts to
      [ADR 0041](../../backend/docs/adr/0041-capability-credential-store.md)): a
      `toolServerDispatch()` harness probe over each facade's OWN composed credential chain,
      giving tool servers and capability credentials their first cross-runtime assertions. Its
      decisions are below.
      **CLI-observed (open):** what the agent's CLI actually reached (server started, N tools),
      read off the CLI's own startup report and folded onto the same record beside what the
      platform decided. Split from the record half because it is a HARNESS change and therefore an
      image bump, and because the two answer different questions: the record says why the platform
      withheld a tool, while this says a wired server failed to start anyway. Nothing blocks it:
      the record is the field it extends, and the probe already diagnoses the same condition
      interactively, which is why it ranked below the two halves that shipped.
      Ordering note: the handshake went first because the 2026-08-05 review rated the blind run the
      likeliest failure an adopting deployment actually hits, and unlike the chips it needed no wire
      vocabulary; the chips came second because slice 4 is where that vocabulary now exists
      (`@cat-factory/contracts`'s `tool-servers.ts`), so this extended one rather than inventing a
      second.
- [ ] **6. Tenant-level configurability.** The binary-generator pattern applied to tool servers:
      a contracts-level non-secret vocabulary, a snapshot projection, per-workspace
      enable/disable, per-step selection via `stepOptions`, and a picker. The SPA finally learns
      the word MCP (i18n). Registration stays code-first on purpose: the deployment declares WHAT
      exists (URL, command, transport, credentials by name), the tenant chooses WHERE it applies
      and supplies values, so the trust boundary does not move. Capability credentials join the
      public API in the same slice, so provisioning stops being SPA-only. This supersedes ADR
      0029's "no per-workspace tool-server UI" non-goal, already half-stale since the credential
      store landed and now further so, since slice 4 gave the SPA a read-only tool-server surface; the ADR's consequences section is updated in the same PR.
- [ ] **7. OAuth, both directions.** The CONSUMING half has landed; the SERVING half has not.
      **Consuming (done):** `McpOAuthConfig` on a remote (`http`) declaration, with both the
      `authorization_code` grant (a `secrets.manage` holder presses Connect, PKCE, refresh) and the
      `client_credentials` grant (no browser, no UI, for an internal or partner server on a
      deployment with nobody to press a button). Endpoints are DISCOVERED per the MCP authorization
      spec (RFC 9728 → RFC 8414 → OIDC discovery) with a declaration override; grants are sealed
      per (workspace, server) in a store of their own; the dispatch mints and refreshes the access
      token through the kernel `McpOAuthTokenSource` port and folds it into the job body's header,
      never a prompt. The unavailability vocabulary gained `oauth_not_connected` and
      `oauth_token_failed`, the probe gained the matching verdicts, and the tool-server row gained
      Connect / Reconnect / Disconnect. It did NOT wait for slice 6 (see the criticality note the
      2026-08-05 review left), and did not need it: the grant is per workspace already, because the
      credential half always was. Its decisions and the gotchas it surfaced are below.
      **Serving (open):** the MCP authorization spec on the hosted endpoint (protected-resource
      metadata; dynamic client registration as scoped), so a host connects without a long-lived key
      in plaintext config. It needs slice 3's endpoint, which exists, so nothing blocks it.
- [ ] **8. Adoption loudness and `stdio` operability.** (2026-08-05 review) Two small items that
      decide whether a deployment learns its ceiling at boot or from a run. A boot warning when NO
      harness the deployment can resolve serves ANY registered server (a Pi-only deployment
      registering tool servers today finds out one run prompt at a time, `tool_server_unservable`
      being per definition rather than per deployment). And the `stdio` class's operational story:
      the docs half landed with this review (`mcp-tool-servers.md` → Operating `stdio` servers:
      pin the package version, pre-bake into the runner image for the cold start, verify from a
      run), and a mechanical warm-up (installing declared `stdio` packages before the agent's
      first turn, the dependency-prepopulation analogue) is the candidate follow-up if cold-start
      or registry-outage failures show up in practice; it is a harness change, so an image bump.

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
| API key only via env, plaintext in host config                                    | Slice 2 (key file), slice 7   |
| Tool filtering is group-coarse, startup-only                                      | Slice 2 (done)                |
| Text-only pretty-printed results; no `outputSchema`/`structuredContent`           | Slice 2 (done)                |
| `destructiveHint` unset on the four spending tools                                | Slice 2 (done)                |
| `sdk/AGENTS.md` silent on MCP; no `claude mcp add`; no worked flow; no poll guide | Slice 2 (done)                |
| stdio-only; no hosted endpoint; no backend MCP route                              | Slice 3 (done)                |
| No probe/health check; `allowedTools` never checked against reality               | Slice 4 (done)                |
| No inventory: a registration attached to no kind is invisible                     | Slice 4 (done)                |
| `McpSecretRef` lacks the `usage` note the checklist can render                    | Slice 4 (done)                |
| The credential checklist's READ was documented as gated and was not               | Slice 4 (done)                |
| Telemetry records ids only; SPA renders raw `extras` JSON                         | Slice 5 (run record done)     |
| Dropped-server diagnosis reaches the agent and a warn log, no operator surface    | Slice 5 (done)                |
| Older harness image silently drops `mcpServers` (blind run)                       | Slice 5 (handshake done)      |
| Tool servers asserted nowhere cross-runtime                                       | Slice 5 (done)                |
| No per-workspace/per-step server selection; no wire vocabulary; no SPA visibility | Slice 6                       |
| Capability credentials absent from the public API                                 | Slice 6                       |
| No OAuth for remote tool servers                                                  | Slice 7 (consuming half done) |
| No MCP authorization on the serving side                                          | Slice 7                       |
| `http` conflates streamable HTTP and SSE; fixtures use `/sse` URLs                | Not pursued (below)           |
| No composed tools / auto-pagination in the MCP server                             | Not pursued (below)           |
| Declared `additionalProperties: false` not enforced locally                       | Not pursued (below)           |
| No marketplace/catalog of known vendor servers                                    | Not pursued (below)           |
| Checklist granularity ((workspace, key) sharing, unscoped list)                   | Standing decisions, unchanged |
| Env-fallback default `true`; `allowKeys` unset                                    | Tracked elsewhere (below)     |
| No MCP resources/prompts/elicitation/progress notifications                       | Deferred (below)              |
| Pi has no MCP client                                                              | Standing non-goal (ADR 0029)  |

From the 2026-08-05 external-servers review (dispositions follow the same vocabulary):

| Finding (2026-08-05)                                                           | Disposition                   |
| ------------------------------------------------------------------------------ | ----------------------------- |
| Blind run (stale runner image) is the likeliest adopter failure; land it first | Slice 5 (handshake done)      |
| OAuth is THE external-vendor gap; intermediate deployment-level flow is viable | Slice 7 (consuming half done) |
| No boot signal when no resolvable harness serves any registered server         | Slice 8                       |
| `stdio`: per-run `npx` cold start, no pre-run verification, no warm-up story   | Slice 8 (docs half done)      |
| Consuming-side docs buried in `custom-agents.md`; no single authority doc      | Done (`mcp-tool-servers.md`)  |
| `security-model.md` silent on MCP tool RESULTS as an untrusted-input source    | Done (same change)            |
| Silent last-write-wins on a re-registered tool-server id                       | Not pursued (below)           |
| `TOOL_SERVER_BUDGET` is a fixed constant with no deployment knob               | Not pursued (below)           |

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
  [ADR 0041](../../backend/docs/adr/0041-capability-credential-store.md); nothing in this review
  overturns them.
- **The environment-fallback default and `allowKeys`.** Both are already tracked: the default is
  the product call the capability-credential store deliberately did not make, and unset
  `allowKeys` is on the security model's hardening checklist.
- **MCP resources, prompts, elicitation and progress notifications.** Deferred, not refused:
  host support is uneven and none of them gates the flows above. The natural revisit point is
  after slice 3, when hosted sessions make server-side prompts and progress worth having.
- **A warning on re-registering a tool-server id.** Last-write-wins is the DOCUMENTED repoint
  seam (`custom-agent-roles.md` → Repointing without forking): a deployment overrides an
  installed package's server by registering the same id after it, so a warning would fire on the
  intended pattern. The residual risk is two vendor packages colliding on an id by accident, which
  today resolves silently by import order. The cheap remedy, if that ever bites, is an info-level
  boot line naming each replacement (visible, not a warning), so the intended pattern stays quiet
  in spirit while the accident becomes greppable.
- **A deployment knob for `TOOL_SERVER_BUDGET`.** The constants (12 servers, ~32 KB) are far above
  any observed declaration, both dimensions already warn at boot, and a knob would invite raising
  the cap instead of trimming the kind. Revisit only when a real kind hits the cap for a reason
  trimming cannot fix.

## Gotchas already known

- **Any harness-side change is an image bump** (`@cat-factory/executor-harness` version + the
  three pinned tags + `RECOMMENDED_HARNESS_IMAGE`), and a reused tag does not deploy. Slice 1
  bundled its harness edits into one bump (1.89.0); slice 5's handshake is the second (1.93.0).
- **The kernel/harness copies are pinned by conformity tests.** The id pattern, the tool-name
  pattern and the URL rule exist twice on purpose; a validation addition must extend both sides and
  the pinning test, not just kernel.
- **`registry.all()` walks are in more places than validation.** Slice 1 fixed the two found (boot
  validation, the credential checklist) and introduced
  `AgentKindRegistry.kindsWithCapabilities()`; anything new that enumerates "kinds with
  capabilities" must use it, or the same hole reopens. Slice 4 added its COMPLEMENT,
  `allToolServers()`, for the one question that walk cannot answer: which registrations no kind
  declares at all.
- **Slice 4's harness edits: there were none.** The probe is entirely backend, so no image bump. That
  is not a general property of this initiative; slice 5's handshake was the next one (1.93.0).
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
  the hosted endpoint fall under the ADR 0034 stability contract immediately; there is no
  internal-first soft launch for an endpoint whose whole point is external callers. It carries that
  obligation through `backend/docs/public-api.md` rather than the OpenAPI spec (see slice 3's
  decisions below), so a change to it must be reviewed against that doc, which no drift guard reads.

## Slice 5 (handshake): its four decisions

- **The ack rides the job ACCEPTANCE, not the poll view.** The poll would have cost nothing to
  extend and reaches every transport already. It is the wrong seam twice over: the capability list
  is a static fact about the IMAGE, so repeating it on every poll of an hour-long run is noise,
  and by the first poll the only thing left to do about a blind run is fail a step that has already
  begun. The dispatch site is the one place the body just sent is still in scope. Cost: a return
  type on `RunnerTransport.dispatch`, which every implementation had to be looked at for.
- **`void` stays a first-class return, so the check is THREE-STATE.** The cheap version treats "no
  capabilities reported" as "does not support it" and needs no new vocabulary. It is also a false
  accusation: every image between the capability landing (1.67.0) and the handshake landing (1.93.0)
  parses `mcpServers` perfectly and reports no list, so a boolean would refuse every tool-server run
  on every deployment one image behind, with no evidence and no way for an operator to tell a real
  gap from the tooling. The version could have disambiguated it (the harness has reported one on
  `/health` for a long time), but that buys a semver comparison plus a per-capability minimum-version
  table to keep in step, to answer a question the image can simply be asked. So `unknown` is its own
  disposition: proceed, and report the BLIND SPOT rather than the run. It is expected to decay to
  zero, which is what makes `container.capability_unknown` worth having.
- **The refusal STOPS the job through its own port method, and REPORTS whether that worked.** The
  harness starts work on acceptance, so a throw alone leaves a blind agent running to completion
  (possibly opening a PR) for a step the engine has already failed.

  _WITHDRAWN, first attempt: reusing `release`._ It reads as the reclaim and it is, on the one
  backend the design was checked against. It is not a stop anywhere else: `HttpRunnerPoolProvider.release`
  is a NO-OP when the manifest declares no `release` template, and `LocalContainerRunnerTransport.releasePooled`
  hands the warm-pool member BACK with the job still running in it. All three return the same `void`,
  so the refusal reported an identical confident stop for a job that was destroyed, one that was
  handed to the next run, and one that was never touched. The pooled case was the worse half: the
  member's harness still answers `/health`, so the next run leases a container with a live agent and
  a live checkout in it, which is the collision `acquireMember`'s synchronous claim exists to prevent.

  What replaced it: `RunnerTransport.stopJob`, a harness `DELETE /jobs/{id}` that aborts ONE job
  (never `abortAll`, since a pooled container serves other runs) and waits for it to settle before
  answering, and a returned {`stopped` | `requested` | `unsupported`} outcome plus `failed` for a
  throw. A container-owning backend always reaches `stopped` because a graceful abort that fails
  ESCALATES to destroying the container, which also takes a poisoned pool member off the idle list.
  A pool reaches at most `requested`. The three non-`stopped` outcomes are named in the refusal
  message and counted as `container.blind_job_not_stopped`, per the degrade-loudly rule: the
  environment-disposal flow learned the identical lesson (a teardown call returning is not the
  environment being gone).

- **A pool's ack is MANIFEST-MAPPED (`response.dispatchCapabilitiesPath`), like every other pool
  field.**

  _WITHDRAWN, first attempt: reading `capabilities` off the scheduler's response by name._ The
  argument was that the field is the HARNESS's and not the scheduler's, so a proxying pool would
  need no configuration and a non-proxying one would have nothing to map. It is wrong about what a
  scheduler's response contains: `capabilities` is an ordinary word for a scheduler to use about its
  own runners, and `{"capabilities":["gpu","docker"]}` narrows to `[]`, which resolves to
  `unsupported` and HARD-REFUSES every capability dispatch against a perfectly current image. The
  whole point of the three-state design is that the middle state exists to avoid a false accusation;
  guessing at an arbitrary JSON document manufactures one. Nothing in the response can tell the two
  apart, and the operator can, in one line. Unmapped now means `unknown`, which is the truth about a
  control plane this backend knows nothing about.

## Slice 5 (run record): its four decisions

- **The record lives on the STEP, not on the agent-context snapshot.** The tracker originally said
  "a typed snapshot field", and the snapshot is where the same facts already were (in its untyped
  `extras` bag). It is the wrong home for anything a person is meant to see: the snapshot is
  DOUBLE-GATED (`LLM_RECORD_PROMPTS` plus the per-workspace `storeAgentContext`) and pruned on the
  telemetry retention window, so a chip reading it would be blank on a deployment that simply has
  prompt recording off, and gone from an older run on one that does not. "Which tools did this step
  have" is an ordinary question about a run, not an opt-in debugging artifact. Cost avoided as a
  side effect: no telemetry column, so no D1 migration ⇄ Drizzle pair for a field the run row
  already carries as JSON. The `extras` entries were DELETED rather than left beside it, so there is
  one authority.
- **The reason vocabulary MOVED to `@cat-factory/contracts` and kernel is typed against it.** The
  cheap version leaves kernel's union where it is and hand-copies the members into the SPA, which is
  what every other run-surface vocabulary here was already doing. It is the drift this repo has a
  rule about: the SPA cannot see kernel, and a member added on one side only renders as a blank
  chip. Which member a dispatch PICKS still lives in kernel; only the list moved.
- **Two lists, never one list with a status field.** A filtered read gives the same answer, so this
  is about what an unfiltered one gives: a wired server is a capability the prompt promised the
  agent, and a dropped one is a promise the platform deliberately withheld. Rendering them from one
  array is one forgotten filter away from reporting a withheld tool as a working one, which is the
  precise failure the whole unavailability vocabulary exists to prevent.
- **The conformance seam is a PROBE over the facade's own container, not a fake.** Asserting the
  credential chain by injecting a resolver would assert the injection: what differs between
  deployments is whether a facade composed the per-workspace store IN FRONT of its environment
  resolver and PER KEY, and only the facade's own wiring can answer that. So the probe binds each
  facade's real `container.toolSecretResolver` and `agentKindRegistry` into the SAME
  `resolveToolServers` the executor calls. It closes
  the capability-credential store's last open slice, which had scoped itself as exactly this seam
  ([ADR 0041](../../backend/docs/adr/0041-capability-credential-store.md)).

## Gotchas slice 5 (run record) surfaced

- **Only an ASYNC dispatch produces a handle to fold.** `recordDispatchAttribution` runs at the
  dispatch site, and `ContainerAgentExecutor.runsAsync` is unconditionally true, so the fold is on
  the container path by construction. A conformance test that drives the kind INLINE therefore
  asserts nothing and passes vacuously until it sets `asyncKinds`; that is the shape to copy for
  any future handle field.
- **The fold is guarded on the field's PRESENCE, never on its content.** Both lists empty is a real
  answer (a kind declaring no tool servers), and a re-dispatch by an executor that resolves none
  must not erase what a container round recorded. Same rule the neighbouring fields already follow,
  and the reason `stepToolServerRecord` is called unconditionally at dispatch rather than only when
  something was wired.
- **The environment-fallback leg of the credential chain is deliberately NOT asserted
  cross-runtime.** Seeding a deployment ENVIRONMENT variable is per-runtime (a workerd binding
  versus `process.env`), so a conformance assertion of it would grade the seeding rather than the
  chain. What the suite asserts instead is the property that actually differs between facades and
  needs no seeding: a workspace that stored ONE of two declared keys keeps the server that key
  belongs to and loses only the other. A "first resolver that answers wins" chain fails exactly
  there.
- **`@cat-factory/conformance` is consumed from `dist`, so a suite edit needs a rebuild.** A facade
  test run against a stale build reports the PREVIOUS revision of an assertion, which reads as a
  product bug for as long as it takes to notice. `pnpm exec turbo run build --filter=@cat-factory/conformance`
  before running a facade's spec.

## Gotchas slice 5 (handshake) surfaced

- **The capability NAME is the body FIELD name, deliberately.** That is what lets
  `requiredHarnessCapabilities` be one filter over the union instead of a second map to keep in
  step, and it is why the harness's list is a list of field names too. A member whose name did not
  match its field would compile and check the wrong thing.
- **Check what the BODY carries, never what the kind declares.** A dispatch that dropped every tool
  server for its own reasons (Pi, a missing credential, over budget) promised the agent nothing and
  has nothing to verify. Checking the declaration would refuse a Pi run for lacking an MCP client it
  is documented not to have.
- **An equality test against kernel cannot see the list LYING.** Both sides would agree and both be
  wrong if a member were added ahead of the parser, which is exactly the blind run the handshake
  exists to prevent. So the conformity suite also drives the real `parseAgentJob` with a body
  carrying every declared capability and asserts each survives onto the parsed job.
- **`DeployJobClient` is a STRUCTURAL subset, so widening `dispatch` broke it.** The integrations
  layer declares its own narrow shape of the server's `RunnerJobClient` to stay runtime-neutral, and
  a `Promise<void>` member is not satisfied by one returning an ack. It takes `Promise<unknown>`: a
  deploy job runs no agent, carries no body capability, and has nothing to verify.
- **The 400 path must NOT report capabilities.** A refused body accepted no job, so there is no
  dispatch to hold to a handshake, and answering with one invites a caller to read a parse failure
  as a capability verdict.

## Slice 7 (consuming) — its five decisions

- **A store of its OWN, not another key in the capability-credential checklist.** The obvious
  saving is to seal a refresh token under a credential key and reuse everything. It does not
  survive contact with what a grant IS: it expires, it is REWRITTEN by the dispatch path when it
  refreshes, it belongs to a named person's vendor account, and it is created by a redirect rather
  than typed. The checklist's whole shape (a key, a write-only value, a last-written date) can
  express none of that, and a row per (workspace, server) also keeps two servers' refreshes off
  each other's row — where the credential store's one-blob-per-workspace shape would have made every
  refresh contend with every other. What IS reused is the resolver chain, for the OAuth client
  secret: that one really is a static value a tenant supplies, so it goes through the checklist like
  any other and needs no second mechanism.
- **The in-flight authorization request is SEALED INTO THE STATE, not a pending-row table.** A table
  costs a migration on both runtimes, a repository pair, and a sweeper on both facades to delete the
  rows behind every consent screen anyone ever abandoned. Sealing it (AEAD, under the deployment's
  own key) makes all of that disappear: the value is confidential and authenticated, carries its own
  expiry, and an abandoned request is collected by the operator closing the tab. It is SEALED rather
  than signed with the platform's existing `StateSigner` because it carries the PKCE verifier, and
  an HMAC over a readable payload would publish the verifier into the same browser redirect the
  authorization code travels in. The residual gap, recorded rather than hidden: with no row there is
  no single-use enforcement, so a replayed state re-presents a code the authorization server has
  already spent and refuses.
- **The vendor redirects to the SPA, and the backend has no public callback at all** (review
  follow-up; the original slice shipped one). The redirect is a top-level browser navigation a third
  party triggers, and sessions here are bearer tokens, which such a navigation cannot carry. So a
  backend receiver sees no user on EVERY request (on an authenticated deployment exactly as in
  dev-open), and the user binding and `secrets.manage` re-check written on it were unreachable code
  that read like protection; it also had to be exempted from the default-deny session gate to be
  reachable at all, which the first cut missed, leaving the flow returning 401 to the vendor on any
  deployment with authentication. The page at `/mcp-oauth-callback` re-presents `code` and `state`
  to a session-gated `POST /mcp/oauth/complete` instead. Cost: one SPA page. Gain: both checks
  execute, the route inherits the shared gate rather than an exemption, and the workspace still
  comes out of the sealed state (so access is resolved through the one `loadWorkspaceAccess`, the
  path having no `:workspaceId` for the gate to bind to).
- **The refresh race resolves by ADOPTING the winner's tokens, not by re-applying.** Every other
  rev-guarded path in this repo reloads and re-applies on the winner's snapshot. Here that would be
  actively wrong: an authorization server that rotates refresh tokens has already invalidated the
  loser's, so re-applying replaces a working grant with a dead one. The loser re-reads and uses what
  the winner stored. This is the one place the repo's standard CAS idiom needed inverting, and it
  reads as a bug until the rotation is in view.
  **And the rev guard is only half of it** (review follow-up): against a rotating server the
  LIKELIER loss never reaches the swap at all. Both dispatches POST the same refresh token, the
  winner's exchange rotates it, and the loser's request fails at the token endpoint with
  `invalid_grant`, so the adoption has to hang off the exchange FAILING, not only off the CAS
  returning false. Without that, a dispatch loses its tool while a live token sits in the row, and
  the `lastError` it records lands on the winner's healthy grant. The mirror image is `lastError`
  never being cleared: only an exchange cleared it, and the common dispatch is served from the store
  and mints nothing, so one transient outage left a permanent red banner on a working connection.
- **Discovery is performed, and its results are held to the URL floor.** Requiring both endpoints in
  the declaration would have been half the code, and it makes a vendor server a scavenger hunt
  through a changelog for two strings that change when the vendor re-platforms. The MCP spec
  prescribes the walk, so the walk is what a deployment gets. What discovery may NOT do is relax the
  transport rule: a metadata document is a third party naming where this deployment's client secret
  is sent, so a discovered endpoint is refused on exactly the terms a declared one is.
- **Dynamic client registration (RFC 7591) is deliberately NOT performed.** A client registered at
  runtime is deployment state with no home in a composition-root registration and no
  operator-visible identity at the vendor: nobody could find it, rotate it or revoke it from either
  side. Every vendor server this initiative set out to reach offers a console-registered client, so
  the cost is a server that offers ONLY dynamic registration, which is named in the limits list
  rather than left to be discovered.

## Gotchas slice 7 (consuming) surfaced

- **A grant OUTLIVES the declaration that created it, and disconnect must not be gated on the
  registry.** A deployment retires a server or renames it in a refactor, and the row is then a live
  vendor token nobody can reach: a `DELETE` that 404'd on an unknown id would make the one action
  that removes it unavailable exactly when it is needed. The connect route is the opposite and
  checks everything, because a refusal AFTER the redirect lands on a vendor's error page.
- **"Connected" and "no longer working" are ONE row, not alternatives.** The first draft cleared the
  connection on a failed refresh, which reads as never having connected and sends an operator to
  press Connect on a grant the vendor revoked. The summary carries `lastError` BESIDE `connected`,
  the same "absent and zero must never render the same" rule the drop vocabulary is built on.
- **A refresh token the server did not rotate has to be carried forward.** Both behaviours are
  common, and a `{...tokens}` spread that dropped an absent `refresh_token` turns a working
  non-rotating grant into a single-use one — a failure that appears days later, on the first
  dispatch after the access token expires.
- **The expiry needs SKEW, because a dispatched token is used for the length of a run.** Handing
  over a token with twenty seconds left costs the agent a tool the prompt already promised it, with
  no unavailability reason to state, because the platform believed it was wired.
- **The callback cannot read `workspaceAccess` off the context.** It is mounted at the app root
  (the redirect URI is a string the vendor holds, so it can carry no board id), which means the
  workspace gate never ran and nothing published an access object. It loads one itself — which is
  also the right behaviour rather than a workaround, since `secrets.manage` can be revoked in the
  minutes a human spends at a consent screen.
- **The executor's file was at its size ratchet, and a new optional dep is what pushed it over.**
  The binding of injected deps onto `resolveToolServers` moved out of `ContainerAgentExecutor` and
  next to the resolution itself (`resolveDispatchToolServers`), so the NEXT credential channel lands
  there rather than re-triggering the same split.

## Slice 4's five decisions

- **The MCP client is hand-rolled, not `@modelcontextprotocol/sdk`'s.** The same argument slice 3
  recorded about the serving side, pointed the other way: the backend's HTTP layer is typed against
  the Web platform alone so it cannot break on workerd, and the SDK's client transport carries an
  OAuth provider, a reconnecting SSE stream, resumption tokens and a zod-validated message layer,
  every one of which a probe needs to NOT do. Three POSTs plus a body reader is smaller than the
  adapter that would hold that machinery back, and it keeps the SDK out of a module every facade
  bundles. What it deliberately KEEPS is what makes the answer trustworthy: both body shapes a
  compliant server may answer with (JSON, or one SSE event), the `mcp-session-id` a server may mint
  (and the DELETE that ends it, so a press of Test leaves no session behind), and redirects, each hop
  re-validated against `isAllowedMcpHttpUrl`.
- **A credential stops at the DECLARED ORIGIN, redirect or not.** Hand-rolling the redirect loop means
  hand-rolling what a real client does at a hop, and the first draft of this got it exactly backwards:
  it forwarded the credential headers on the reasoning that the agent's own client would. It would
  not. The Web platform REMOVES `Authorization` when a redirect crosses origins (fetch's CORS
  non-wildcard request-header rule), so an SDK client reaches a cross-origin hop unauthenticated and
  answers 401 — meaning a forwarding probe both reports on a request no run makes and becomes the one
  path that hands a workspace's token to whatever a hijacked or lapsed vendor host redirects to. So a
  cross-origin hop is REFUSED while a credential is riding, naming the origin change, because the fix
  is the declaration naming the final url and a stripped-credential 401 would name the token instead.
  A server with no credential is followed across origins as usual: the rule is about the secret, not
  about redirects. Same-origin hops (a versioned path) are the ordinary case and carry it.
  **When you hand-roll a transport, check each divergence from the platform's own fetch semantics in
  the direction of the SECRET**: the method rewrite is the other one here, and re-POSTing is right
  because a GET to an MCP endpoint means "open the stream", so it is documented at the site rather
  than left to read as an oversight.
- **A `stdio` server and a loopback url are REFUSED BY NAME, never approximated.** The backend is not
  the run container: a `stdio` server is a child of the harness inside it (and the Worker has no
  process model at all), and the backend's `127.0.0.1` is a different machine from the container's. A
  probe that reached for the nearest thing it could talk to would answer about the wrong process, and
  a SUCCESS would be the more misleading of the two outcomes. So `not_probeable` carries its own
  three-member reason vocabulary, because "nothing to fix, verify from a run" and "change the
  declaration" are different instructions.
- **The `allowedTools` verdict is WITHHELD when the tool list is a prefix.** `tools/list` is
  paginated and the probe reads a bounded number of pages, so a name's absence from what came back is
  not evidence of its absence from the server. Reporting it as unmatched would send an operator to
  edit a correct declaration, which is worse than the silence the probe was built to end. Hence
  `checked: false` beside an empty `unmatched`, and `toolCount` stated beside `toolsComplete` so a
  count off a truncated read reads as the floor it is.
- **The credential checklist's READ was not actually gated, and this slice fixed it.** Its
  controller, the SPA's tab gate and the store's 403 branch all documented a `secrets.manage`-gated
  read; the mount was `requireWorkspacePermission`, which passes GET/HEAD through by design, so every
  member's GET was answered in full. The fix is a second, explicitly-named middleware
  (`requireWorkspacePermissionIncludingReads`) rather than an option on the first, so the choice is
  legible at the mount and a controller cannot acquire it by a default changing underneath it. Both
  reads now carry a `defineWorkspaceRbacSuite` case, since the ordinary mount makes this failure
  invisible to every existing assertion.

## Gotchas slice 4 surfaced

- **The probe needed the composed chain on the CONTAINER, which nothing read before.** Every other
  consumer of `ToolSecretResolver` is an executor and is HANDED it; a probe is a read path, and a
  probe resolving off the deployment's environment directly would report one tenant's working server
  as every tenant's. So `ServerContainer.toolSecretResolver` joins `toolSecretEnvironmentFallback`
  (resolver and description together, per the rule that surface already established) and both facade
  coverage guards pin the new link. Absent, the probe answers `credentials_missing`, the same
  disposition the dispatch path gives the same state, rather than succeeding against an endpoint it
  reached unauthenticated.
- **An orphan REGISTRATION is invisible to every other check, and needed a new enumerator.** Boot
  validation reaches a definition THROUGH the kind that declares it, so `registerToolServer` with no
  `assignToolServers` beside it passes every rule while its credentials sit in the operator's
  checklist as keys no dispatch will ever ask for. `AgentKindRegistry.allToolServers()` is the
  complement of `kindsWithCapabilities()`, and the inventory unions the two so such a server is
  reported with an empty `declaredBy` rather than filtered out.
- **A declared TARGET is a place a credential can legitimately be, in both transports.**
  `isAllowedMcpHttpUrl` rules on the scheme and host only, so `https://user:token@mcp.example` is an
  accepted declaration, and the inventory renders that url in a browser: it goes through
  `stripUrlCredentials` first. A `stdio` command line carries `--api-key=…` just as easily and is the
  likelier of the two for a deployment that has not found `secretKeys` yet, so the joined argv goes
  through `redactSecrets`. Stored credential values are WRITE-ONLY, which is what makes this row the
  one place on the surface where a pasted secret could be read back. The same reasoning covers the
  probe's own error prose, scrubbed at the emit site because a fetch failure routinely echoes the
  request url and a 4xx body from an auth proxy echoes tokens as a matter of routine — and PREVIEWED
  there as well as scrubbed, because an auth proxy answers a 4xx with an HTML page and that string is
  both rendered in a browser and logged.
- **One deadline over three round trips also aborts the BODY, and that changes the cause.** The signal
  handed to `fetch` errors the response stream too, so a server that answers 200 and then stalls
  leaves a partial buffer behind — which read as `protocol_error` ("the url names something else") for
  what is the plain slow endpoint `unreachable` is documented to cover. Every "the body yielded no
  frame" path now checks `signal.aborted` FIRST (`bodyFailure`), and the deadline prose is authored
  once so a rejected request and an aborted read cannot describe one expiry two ways. A hand-rolled
  client that reports causes owes this check anywhere a partial read can be mistaken for a bad one.
- **Two halves of one surface must resolve an id the SAME way.** An `McpServerDefinition` reaches the
  surface from two places (a registry entry, a kind's inline declaration) and one id can name both, so
  the list and the probe each having their own lookup meant the row could describe one endpoint while
  the Test button probed another, both labelled with the id the operator recognises. There is now one
  `resolveDeclaredToolServers` and both halves ask it.
- **`isLoopbackMcpHttpUrl` is deliberately a SEPARATE predicate from `isAllowedMcpHttpUrl`.** They
  answer different questions and only the probe wants the second: "may this url be dispatched" is
  about the scheme, "does this server live beside the agent" is about the host, and an `https`
  loopback sidecar is allowed and equally unreachable from here. Folding them would have made the
  probe's refusal read as a policy rejection.
- **The probe's protocol version is a literal, and drift is benign.** Negotiation belongs to the
  SERVER: it answers with the requested version when it speaks it and with one of its own when it
  does not, so a probe advertising something older than the spec's latest still completes a handshake,
  and the version REPORTED is always the one the server chose. That is why it is not pinned against
  the SDK's `LATEST_PROTOCOL_VERSION`: the pin would cost the backend a direct dependency on the SDK
  to protect against a drift with no consequence.
- **A `'*'` middleware mount in a routed Hono sub-app is NOT scoped to that controller, and CI is
  what said so.** `app.route('/workspaces/:workspaceId', sub)` re-registers each of `sub`'s entries
  under the prefix, so `sub.use('*', gate)` becomes `ALL /workspaces/:workspaceId/*` on the shared
  app and matches every SIBLING controller's routes too; Hono then runs whichever matching entry was
  registered first, which makes the blast radius depend on the order in `app.ts`. Every existing
  admin controller mounts that way and it has stayed invisible because the gate lets GET through and
  the siblings it can reach are all admin-tier. Gating READS turned it into an outage on the first
  real run: `GET /workspaces/:ws/github/repos`, which a plain member may read, answered 403, and the
  branch-protection RBAC test caught it. Both `IncludingReads` mounts now name their own patterns
  (`/thing` AND `/thing/*` — Hono's `*` does not match the bare prefix), pinned by a controller test
  that mounts a sibling route in the WORST order and asserts it stays open. **The pre-existing `'*'`
  mounts are left alone deliberately**: they are latent rather than live, and un-leaking ~15
  controllers would loosen authorization across the whole workspace surface, which needs its own
  change and its own conformance work rather than a drive-by in this slice.
- **The tab is earned by EITHER surface now.** A tool server that declares no credential has no
  checklist row, and gating the "Capability credentials" tab on the checklist alone would have left
  exactly the server an operator most wants to test unreachable, while a credential belonging to a
  generative integration has no tool-server row. Two questions, one tab, and neither list is a subset
  of the other.

## Slice 3's three decisions, and the two it did not need

- **The transport is `WebStandardStreamableHTTPServerTransport`, not the `StreamableHTTPServerTransport`
  this tracker originally named.** That one wraps Node's `IncomingMessage`/`ServerResponse`, so a
  Worker facade could not mount it, and "the hosted endpoint exists on one runtime" is the facade
  asymmetry this repo treats as a showstopper. The web-standard sibling is `Request → Response`, which
  is what let the endpoint land in the SHARED controller layer rather than once per facade.
- **Stateless, one server per request, JSON responses.** A session-keyed server holds its state in the
  memory of the process that minted the session id, and neither runtime can promise the next request
  lands there: a Worker request gets whichever isolate the edge picks, and a Node deployment scaled
  past one instance has the same problem without sticky routing. So a stateful endpoint works on a
  developer's single process and fails intermittently in production. Nothing needs the state anyway.
  `GET`/`DELETE` are therefore `405` with `Allow: POST`, in the transport's OWN JSON-RPC error frame
  rather than the deployment's error envelope, because the reader is a protocol client that wants the
  header and the frame. Auth failures go the other way (thrown `DomainError` → the envelope), since
  the MCP spec puts those at the HTTP layer and an operator needs `details.reason`.
- **Scope decides the tool list; the per-host filters do not apply.** A `read` key gets exactly the
  `readOnly` tools, which is EXACT rather than approximate (every `/api/v1` GET requires `read` and
  every write requires more), and the new `readOnlyReason: 'key-scope'` makes the instructions name a
  wider key as the fix rather than a host-config edit. Above `read` the whole table is listed and the
  refusal comes from the ONE authority on the question, the endpoint itself: the tool table carries no
  per-operation scope, so filtering further would mean guessing, and a wrong guess WITHHOLDS a
  capability the key genuinely has. Making it exact would mean emitting the required scope into the
  spec (structured `security` per operation, additive, `info.version` minor) and threading it through
  `emit-mcp.mjs`; deliberately not done here, since it is an `/api/v1` spec change with its own
  regeneration of four clients.
- **It did not need a deployment-wide filter.** The stdio filters exist because a stdio server is
  per-host; a hosted one is per-DEPLOYMENT, so the same knob would narrow what an already-scoped key
  may do for every caller at once, which is a break rather than a convenience. Per-workspace selection
  is slice 6's job and has a tenant to attribute the decision to.
- **It did not need an OpenAPI entry, and must not have one.** A JSON-RPC endpoint has no operation
  shape to describe, and the generator's own rule (an `/api/v1` operation MUST have a
  `scripts/sdk/surface.mjs` entry) would mint an SDK method in four languages plus an MCP tool for the
  protocol none of them speaks. The two hand-documented SSE routes are not a precedent: those ARE
  operations, which is why they need `MCP_OMITTED_OPERATIONS` entries.

## Gotchas slice 3 surfaced

- **`sdk/mcp` is now bundled into a Worker, so its runtime-neutral half may import NO Node built-in.**
  This is invisible to every typecheck: the package opts into `@types/node` (its `bin` genuinely is a
  process), so `import { readFileSync } from 'node:fs'` in `config.ts` compiled perfectly and would
  break a deployment's Worker BUILD, since `node:fs` does not resolve there. `optionsFromEnv` therefore
  takes its file reader as a required dependency, `bin.ts` supplies `readFileSync`, and
  `test/runtime-neutral.test.ts` pins the closed neutral module list AGAINST the import graph, so a new
  module reached from `http.ts` cannot join it unguarded.
- **The loopback is a dispatch through `app.fetch`, not a `fetch` to the deployment's own origin.** A
  network loopback needs an origin to aim at, which a facade behind a proxy, a preview URL or a private
  hostname cannot reliably derive, and spends a connection to reach code already in memory. Forward
  BOTH runtime handles: `env` (without it a Worker's inner request cannot build a container at all) and
  `executionCtx` (without it an inner handler's post-response telemetry write is silently dropped, the
  exact failure `makeWaitUntil` exists to prevent). Hono's `c.executionCtx` THROWS when absent, so
  reading it is a try/catch.
- **And forward the CORRELATION ID, which is the third handle and the easiest to forget.**
  `mountRequestLogging` ADOPTS an inbound `X-Request-Id` rather than always minting one, so a
  loopback that omits it leaves the inner `/api/v1` request logging under an id of its own: both
  lines are present and nothing joins them, which is the one question a log of this endpoint exists
  to answer. An id the inner request already carries wins, so a future loopback caller can still set
  its own.
- **A cross-origin BROWSER host needs `Mcp-Protocol-Version` in `CORS_ALLOWED_HEADERS`.** A
  Streamable HTTP client sends it on every request AFTER `initialize` and on none before, so leaving
  it out fails in the shape that reads as success: the handshake preflight asks only for headers
  already listed and passes, then every real call is dropped by the browser with a CORS message that
  names no route. The session header stays out on purpose — this endpoint is stateless and mints no
  session id, so listing it would advertise a mode that does not exist. Server-side hosts send no
  preflight at all, which is why the whole class was invisible until someone asked about a browser.
- **A JSON-RPC BATCH is the endpoint's one unbounded dimension.** The transport accepts an array of
  calls in one `POST` and each becomes its own loopback `/api/v1` request, so one authenticated
  request fans out in proportion to its length, inside a single Worker invocation. Not a bypass (each
  inner call re-runs the key gate and its own scope rung, and an in-process dispatch is not a
  subrequest), but it is the shape to look at first if this endpoint ever needs a limit.
- **Recursion is prevented by construction rather than by a guard.** The tool table is generated from
  the OpenAPI spec, and the endpoint is deliberately not in it, so no tool can name a path that
  re-enters the endpoint. That argument is what a future composed or hand-authored tool would break.
- **Three test layers, and each sees something the others cannot.** `sdk/mcp`'s `http.test.ts` drives a
  real MCP client whose `fetch` is the handler (protocol negotiation, statelessness, the 405 shape);
  `publicMcp.spec.ts` drives the controller over a real `appLoopback` with a stub `/api/v1` route (the
  refusal shapes, the scope mapping, that the CALLER's key is what reaches the API);
  `integration-public-mcp.ts` drives each facade to a real row. The gap only the last one closes: a
  facade that mounted the endpoint but wired the loopback wrongly answers `initialize` and `tools/list`
  perfectly and returns nothing from every tool, which reads as an empty workspace.
- **The `sdk-smoketest` MCP phases are now two, against ONE backend.** `--only=mcp` spawns the binary,
  `--only=mcp-hosted` connects a real Streamable HTTP client to the running deployment. Running both
  against one seeded board is the only thing in the repo that can see the two access paths answer
  differently.
- **Import `@cat-factory/mcp-server/http`, never the package root, from anything that bundles.** The
  root re-exports the stdio boot, which drags `@modelcontextprotocol/sdk/server/stdio.js` and its
  `node:process` import along: esbuild cannot shake it out, because dropping it would drop an import
  of a package that does not declare itself side-effect-free. The `./http` subpath exists for exactly
  this, and it is the only entry with the runtime-neutrality guarantee.
- **What the Worker bundle pays for it, measured:** about **1.1 MiB unminified** (zod 640 KiB via the
  SDK's `types.js`, ajv + ajv-formats 226 KiB via the eager validator in `server/index.js`, the SDK
  itself 142 KiB, this package 94 KiB, `@cat-factory/sdk` 37 KiB), taking the Worker from 6.8 to
  7.9 MiB raw and **0.96 MiB minified+gzipped**, so comfortably inside the 3 MiB limit. None of it is
  avoidable while using the SDK's `Server`: both heavy imports are static and unconditional. ajv is
  never asked to COMPILE anything on this path (the low-level server uses it only for elicitation,
  which this facade never performs), which matters because `new Function` is unavailable on workerd;
  constructing an `Ajv` does not compile.

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
