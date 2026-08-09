# MCP tool servers: the consuming side, engine design

> **Wiring one is on the website**:
> [Give Agents External Tools (MCP)](https://www.catfactory.ai/extend/tool-servers.html) owns registering a
> server, the harness support matrix, the credential rules, OAuth, the Test button, operating a
> `stdio` server, the security posture and a worked vendor runbook. Not to be confused with the
> platform's OWN API served as MCP ([MCP Server](https://www.catfactory.ai/extend/mcp-server.html)),
> which is the serving side.
>
> This page is what a change in THIS repository has to keep true.

Where each decision is made, because the layering is the thing a change here breaks:

| Decision                              | Resolved in                                                                        | Why there                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Which transports a CLI can reach      | kernel `MCP_HARNESS_TRANSPORTS` (`domain/agent-capabilities.ts`)                   | A fact about the CLI, held once so boot validation and dispatch cannot disagree                                |
| Whether a server applies to THIS run  | the container EXECUTOR, at dispatch                                                | It depends on the resolved harness and the facade-wired credential resolver, neither of which the engine knows |
| Whether a credential may be looked up | kernel `isReservedPlatformEnvKey`, at boot AND at dispatch AND at the job boundary | Three layers, because each is reachable without the others                                                     |
| What the agent is TOLD it has         | the prompt's tool-server section, from `step.toolServers`                          | The same record a person reads, so the two cannot drift                                                        |

Design records: [ADR 0029](./adr/0029-agent-kind-capabilities.md) (the capability model) and
[ADR 0041](./adr/0041-capability-credential-store.md) (the per-workspace sealed store the resolver
chain reads first). The roadmap, including every limit the website page lists, is
[`mcp-maturation.md`](../../docs/initiatives/mcp-maturation.md). Field-by-field authoring of
`McpServerDefinition` is [`custom-agent-roles.md`](./custom-agent-roles.md).

## Which runs actually get the server

**A declared server that is not wired is STATED to the agent, never silently missing**, and every
reason plus its fix is on the site's
[Why a run did not get the server](https://www.catfactory.ai/extend/tool-servers.html#why-a-run-did-not-get-the-server).
Silence would let the agent plan around a tool that was never there and discover the gap mid-run.

The rule a change here must hold: each reason is its own member of a CLOSED vocabulary, rendered
through an exhaustive `Record`, so adding one fails the typecheck rather than rendering blank. They
are not collapsible into "unavailable", because each names a different party's fix, and the reason
is what the prompt and the step chip both carry.

### The one reason no container dispatch decides: a consensus panel

Every other member is chosen by the container executor while it resolves a dispatch. `consensus_panel`
is chosen by `@cat-factory/consensus` instead, because a diverted step never reaches a container: the
participants are inline model calls with no CLI to wire a server into. That matters for a change here
in three ways.

- **Boot cannot catch it.** `tool_servers_without_container` keys on the kind's declared surface, and
  the default-eligible set (architect, analysis, the reviewers, the companions) is almost entirely
  container kinds, which is exactly the set a deployment attaches a read-only research server to. The
  same step with consensus off gets the server; there is no registration to warn about.
- **The record arrives from the INLINE path.** `AgentRunResult.toolServers` is the counterpart of
  `AgentJobHandle.toolServers`, folded by `recordInlineToolServers` at the two inline dispatch sites
  and stamped with the dispatched kind by the ENGINE, exactly as the container fold is. Both go
  through one `stampToolServers`, so there is one place an executor-supplied kind could creep back in.
- **Nothing declared means no record.** A panel wires nothing by construction, so an all-empty
  resolution from it would say a dispatch resolved tool servers where none could ever have been
  wired, which is not what both-empty means below. The panel reports only what it withheld.

### What the RUN records, and where a person sees it

A dispatch's decision lands on the step itself (`step.toolServers`), as two lists: the servers it
WIRED (id, label, transport, and the narrowed `allowedTools` when the definition set one) and the
ones it DROPPED, each with the reason from the table above. The step detail renders them as chips,
so a run that quietly went without its issue tracker says so where a person is already looking. The
SPA maps each reason through TWO exhaustive `Record`s over `@cat-factory/contracts`'s
`toolServerUnavailableReasonSchema`, one for the reason line and one for the REMEDY beneath it
(the same pairing as the table above: what happened, and what to change). A member it does not
recognise renders as unknown NAMING the raw code, with no remedy, because a build that knows only
that the code was recorded cannot pick a surface to send anyone to.

Four properties of that record are load-bearing:

- **It is recorded at DISPATCH and never re-derived.** The poll site rebuilds the job handle from
  the step alone, and whether a server was servable depended on the resolved harness plus the
  facade's secret and OAuth resolvers AT THAT MOMENT. A workspace that fills in a missing
  credential an hour later must not make a step that ran without the tool read as one that had it.
- **It names the kind that was DISPATCHED**, which is routinely not the kind the step is named
  for: a `ci` gate escalates to `ci-fixer`, a tester hands off to `fixer`, a two-phase coder
  dispatches twice. Each of those resolves its OWN declarations and overwrites the record, so
  `recordDispatchAttribution` stamps `agentKind` on it from the same parameter that feeds
  `step.dispatches`. Without it the lists would be read under the step's kind and credit one
  agent's capabilities to another. The step detail says whose they are whenever the two differ.
- **Absent and both-empty are different states.** Absent means the step's CURRENT attempt holds no
  resolution: an inline step that resolved none (every one but a consensus panel withholding what its
  kind declared), a run predating the field, or a step re-armed for a re-run whose next
  dispatch has not answered yet (`resetStepForRerun` clears the record, because it describes one
  resolution against one harness, one secret resolver and one set of grants, and a re-run resolves
  afresh). `{ wired: [], unavailable: [] }` means a dispatch ran and its kind declared no tool
  servers at all. So absent never says the step did not RUN: `attempts` and `dispatches` outlive the
  reset and are what answer that. The step detail hides itself on the empty record, since that is
  every step on a deployment that registers no tool servers and it is a fact about the DECLARATION
  rather than about the run; the distinction survives on the wire and the debug API answers it.
- **It carries no credential**, by construction rather than by field-skipping: the projection is
  built from the prompt-facing half of the resolution and `mcpServers` (where every resolved value
  lives) has no projection into it. The step is persisted and rendered in a browser.

### What the CLI itself reported (the observed half)

The record above is the PLATFORM's account, decided before the container started. It structurally
cannot answer the other question a person asks about a run: a server that passed every check and
then failed to come up anyway. A vendor endpoint that 500s, a pinned `npx` package that no longer
resolves, a token the vendor revoked between dispatch and launch — each leaves the server in
`wired`, the prompt promising a tool nothing can call, and no evidence anywhere.

The claude-code CLI announces its resolved session before its first model call: the MCP servers it
loaded, a status each, and the flat list of tools it will expose. The harness reads that one event
into `step.toolServers.observed` (per server: `id`, a normalised `status`, and how many of the
CLI's tools were namespaced to it), the engine folds it onto the record the dispatch already wrote,
and the step detail renders it on the same chips. Three distinctions carry the whole value, and
each of them reads as a healthy server if it collapses:

- **Absent is NOT "the CLI loaded nothing."** It means no observation was made. Codex's CLI
  publishes no such report, nor does an image older than 1.95.0, nor a runner pool whose manifest
  leaves `response.toolServersPath` unset. All of them leave the field absent and the surface then
  says nothing at all, because the alternative is accusing every wired server on every deployment
  one release behind. A `wired` id missing from a report that IS present is the opposite: positive
  evidence the CLI never loaded it.
- **`toolCount: 0` is NOT an uncounted server.** A server that connected and exposes nothing
  reaches the agent exactly like one that was never wired, while every other signal about it says
  healthy — the likeliest causes being an `allowedTools` list that matches nothing and a vendor
  that authenticated and served an empty catalog. So zero is recorded and rendered as its own
  sentence, and a CLI that listed no tools leaves the count absent instead of defaulting to it. The
  count is attributed by matching each tool name against the ids the SAME report declared, never by
  splitting `mcp__<id>__<tool>` on its first separator: a server id may itself contain `__`, so the
  split files `code__search`'s tools under a server called `code` and leaves the real one reporting
  the one value that reads as a fault. Where two declared ids could both own a name (`code` and
  `code__search` both could own `mcp__code__search__query`), nothing in the report says which, so
  both counts stay absent rather than one being guessed.
- **`unknown` is a fact about this BUILD, not about the server.** The CLI's status words belong to
  a third party that may add to them; an unmappable one records as `unknown` and renders neutrally
  rather than as a fault, or a CLI upgrade would send operators to debug working integrations. The
  statuses this platform maps are `ready`, `failed` (the CLI could not start it) and `needs_auth`
  (it answered and refused the credential, which is a different fix from `failed`). A server the CLI
  reported as still handshaking (`pending`) also records as `unknown`: it has no resolved state to
  report, and calling that `needs_auth` would send an operator to re-issue a working credential for
  a server that simply came up a moment later.

Nothing in the engine branches on an observation: it is evidence for a person, never a control
signal, and a failed server does not fail a step. It rides all three poll dispositions — a job
short enough to settle between two polls is never observed `running`, and a job that FAILED is the
one whose post-mortem needs this most.

A self-hosted runner pool that proxies the executor-harness verbatim should set
`response.toolServersPath` to `toolServers` in its manifest. Leaving it unset costs the diagnostic
and never manufactures a false one, which is exactly the trade the absent-vs-empty rule above buys.
The mapping is written up for pool operators beside its sibling response paths on the website's
[Integration Manifests](https://www.catfactory.ai/extend/manifests.html#response-mapping-notes).

This is deliberately not the agent-context telemetry snapshot, which carried the same facts in its
untyped `extras` bag. That snapshot is double-gated (`LLM_RECORD_PROMPTS` plus the per-workspace
`storeAgentContext`) and pruned on the telemetry retention window, so a surface reading it would be
blank on a deployment that simply has prompt recording off, while "which tools did this step have"
is an ordinary question about a run rather than an opt-in debugging artifact. Its copy is
DEPRECATED and still served, projected from the step's own record so the two cannot disagree; the
removal window is in [`public-api.md`](./public-api.md).

**A dispatch carries at most `TOOL_SERVER_BUDGET.maxServers` servers**, plus a total byte cap on
the job-body field. Past either the excess is dropped under `over_budget`, and **both dimensions
warn at boot** (`too_many_tool_servers`, `tool_servers_over_byte_budget`) so the deployment learns
from its own startup rather than off a run's prompt. The realistic cause is accretion: several
packages each calling `assignToolServers` on one kind, none of them individually wrong. Unlike the
linked-context corpus (which REFUSES the dispatch), the excess is dropped rather than fatal,
because tool servers are deployment CODE: taking a deployment down for a registration fault boot
already warned about is worse than running with fewer tools. Two asymmetries are deliberate. The
byte warning measures the DECLARATION (`toolServerDeclaredBytes`), a floor on what a dispatch
measures on the resolved spec, so it never fires falsely but also cannot name WHICH servers a run
will lose: the dispatch keeps every server that still fits, so once bytes are what bind the
survivors are not a prefix of the declaration. And the drop list itself has no budget, so past
`maxStatedUnavailable` the prompt folds the remainder into a count instead of one line each, while
the run context keeps them all.

## Does the runner image serve them at all (the capability handshake)

A runner image older than the `mcpServers` field does not REJECT it, it ignores it. The prompt
this backend composed has already told the agent it has the tools, so the run is misinformed
rather than merely unequipped: a blind run, not a failed one. It is the failure an adopting
deployment is likeliest to hit, because self-hosted runner pools lag the backend by design.

So the harness reports the body-capability field names it parses, on `GET /health` and on the
`POST /jobs` ACCEPTANCE. The acceptance is the load-bearing one: the dispatch site is the only
place the body it just sent is still in scope, and the last moment before the agent starts.

There are THREE answers, not two, and which one a dispatch got decides what happens:

| Answer                     | What it means                                                    | What the dispatch does                                                               |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Named the capability       | The image parses the field                                       | Nothing. The run proceeds.                                                           |
| Reported a list WITHOUT it | The image said it cannot serve it                                | REFUSED: the started job is STOPPED and the step fails as a `preflight` fault.       |
| Reported no list at all    | An image older than the handshake, or a pool that did not map it | Proceeds, and the blind spot is logged and counted (`container.capability_unknown`). |

The third row is why this is not a boolean. Every image between "tool servers landed" and "the
handshake landed" serves them perfectly and reports nothing, so treating silence as a refusal
would take those runs out on no evidence at all.

### Refusing means STOPPING the job, and saying whether that worked

The harness begins work on ACCEPTANCE, so a refusal that only fails the step leaves a full agent
pass running against the repository, free to push a branch and open a pull request for a step the
engine has already failed. The refusal therefore stops it, through the transport port's `stopJob`
(`DELETE /jobs/{id}` on the harness) and never through `release`, which is a reclaim and means
something different on every backend: on a per-run container it happens to kill the job, on a
pooled one it hands the container BACK with the agent still working in it, and on a pool with no
`release` template it does nothing at all.

Not every backend can prove the job died, so the outcome is REPORTED rather than assumed, and the
failure message says which:

| Outcome       | Where it comes from                                                                                    | What the message says    |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| `stopped`     | Cloudflare / local / Kubernetes: the harness confirmed the job settled, or the container was destroyed | Nothing is still running |
| `requested`   | A self-hosted pool: its `release` template was called and accepted                                     | Check the pool           |
| `unsupported` | A pool with no `release` template, or a transport with no stop at all                                  | Stop it on the runner    |
| `failed`      | The stop was attempted and errored                                                                     | Stop it on the runner    |

A container-owning backend always reaches `stopped`, because a graceful abort that fails ESCALATES
to destroying the container. That escalation is right only here: the run is being failed anyway, so
there is no sibling step left to protect, and on the local warm pool it is also what keeps a member
whose job could not be aborted off the idle list (a busy member still answers `/health`, so
re-pooling it would hand the next run a container with a live agent and a live checkout in it).

Anything other than `stopped` also increments `container.blind_job_not_stopped`, dimensioned by the
outcome, because each one is a different operator fix.

**For a self-hosted pool, map the acceptance body and declare a `release` template.** Two lines,
each buying a different half:

- `response.dispatchCapabilitiesPath: "capabilities"` for a pool that proxies `POST /jobs`
  verbatim. Without it the dispatch lands in the third row above. It is deliberately not read by
  name: `capabilities` is an ordinary word for a scheduler to use about its own runners
  (`["gpu","docker"]`), and reading one of those as the harness's answer would narrow to an empty
  list and hard-refuse every capability dispatch against a perfectly current image.
- A `release` template, so a refused run can be cancelled at all. Without one the pool reports
  `unsupported` and the blind agent runs to completion.

The refused case names the capability, the fix and whose fix it is, and it is a configuration
fault rather than a container failure: an operator updates the pool, or removes the capability
from the agent kind. The counters are `container.capability_unsupported` and
`container.capability_unknown`, both dimensioned by the capability alone; the run and workspace ids
ride the log line, since a metric dimension has to be bounded.

## `allowedTools` and credentials: where the floors are enforced

What to declare, and why, is the site's
[What the agent may call](https://www.catfactory.ai/extend/tool-servers.html#what-the-agent-may-call) and
[Credentials](https://www.catfactory.ai/extend/tool-servers.html#credentials). Three enforcement
facts belong here, each because it is a place a change could quietly remove a floor:

- **Every floor is applied at THREE layers**: registration (boot), the dispatch (where the value
  would otherwise reach the prompt), and the harness job boundary. Not defence in depth for its own
  sake: a deployment can register at boot, a workflow can replay a dispatch, and a runner pool can
  be handed a job body directly, so each layer is reachable without the others.
- **A credential has TWO names and only ONE of them is a boundary.** `isReservedPlatformEnvKey`
  binds the LOOKUP key (case-insensitively, because `process.env` lookup is case-insensitive on
  Windows). `envName` is only the name the value is injected under in the server's own process,
  which reads nothing of ours, so it carries the narrower `isToolchainEnvName` rule instead. Merging
  the two rules in either direction breaks something real: the strict one makes the GitHub and Slack
  servers unwireable, the loose one lets `ENCRYPTION_KEY` be read.
- **The transport fixes a credential's CHANNEL; the declaration only states one.**
  `mcpTransportCarriesCredential` (kernel) is the whole rule: a `stdio` server is a child process
  with an environment and no request, an `http` server is a url with headers and no process, so a
  header on the first and a header-less credential on the second each reach NOTHING. Both are boot
  ERRORS, refused again at dispatch and at the probe for the mothership case, and the dispatch
  states the drop as `unusable_secret`. That reason is deliberately neither `missing_secret` (the
  value resolved) nor `reserved_secret` (nothing was withheld): only its own member points at the
  declaration, which is the one thing that changes. The mismatch is silent by construction if
  unrefused, because each projection SELECTS by channel and finds nothing to fold in, so the server
  is wired, advertised in the prompt, and started unauthenticated.
- **A deployment resolver REPLACES the chain, and gates every SUBJECT the port serves.** A
  `createToolSecretResolver` allow-list holding only `MCP_…` keys silently resolves nothing for a
  registered binary generator, which goes through the same `ToolSecretResolver` port. Anything new
  that resolves a capability credential joins that port rather than reading the environment.

## OAuth: the four decisions that are not obvious

Declaring an OAuth server, the two grants, endpoint discovery, what a deployment configures and what
a board sees are on the site's
[OAuth-protected servers](https://www.catfactory.ai/extend/tool-servers.html#oauth-protected-servers). Four
choices in the implementation are load-bearing and would each be got wrong by the obvious version:

- **The vendor's redirect lands on the SPA, and the backend never receives one.** A redirect target
  is reached by a top-level browser navigation a third party triggers, and sessions here are BEARER
  tokens, which such a navigation cannot carry. A backend route receiving the redirect directly
  would see no user on every request, on an authenticated deployment exactly as in dev-open, and any
  "same user" or "still permitted" check written there is unreachable code that reads like
  protection. The page at `/mcp-oauth-callback` re-presents `code` and `state` to
  `POST /mcp/oauth/complete`, which is ordinary session-gated API, so the two checks below actually
  run.
- **The `state` is SEALED, not signed.** It carries the PKCE verifier, so it is encrypted under the
  deployment's own key rather than merely authenticated. It also carries the user who STARTED the
  flow, and completion refuses anyone else: without that binding, getting an admin to open an
  attacker's authorization link plants the attacker's vendor account as the board's connection.
- **`secrets.manage` is re-resolved when the token is STORED**, not assumed from the Connect press.
  A grant takes minutes of human time and the permission can be revoked inside that window. The
  workspace gate cannot do it, because the board is sealed into the state rather than named in the
  path.
- **The token endpoint's redirects are REFUSED rather than followed.** That request body carries the
  client secret and the grant, and while `fetch` strips an `Authorization` header across origins it
  never strips a form body. A metadata GET carries no credential and does follow, up to three
  re-validated hops, with the URL floor applied to every candidate and every hop: checking the first
  and following whatever it points at is not checking.

Two more that shape the data rather than the flow: a refresh token the vendor did not rotate is
carried forward (dropping it turns a working grant into a single-use one on a non-rotating server),
and disconnect is deliberately not gated on the declaration still existing, or a retired
registration would strand a live vendor token nobody can reach. `mcp_oauth_grants` is in the
workspace-delete cascade; neither path revokes at the vendor.

## The probe: what it can and cannot answer

The Test button, its nine verdicts and their fixes are on the site's
[Test a server for real](https://www.catfactory.ai/extend/tool-servers.html#test-a-server-for-real). Two
properties of it are design rather than usage:

- **It resolves through the SAME composed chain a dispatch uses**, so the verdict is about this
  board rather than about whoever set the deployment's variable. A probe with its own resolution
  path would answer a question nobody asked.
- **A redirect is followed, but a credential stops at its own origin.** A hop leaving the declared
  origin is refused outright while a credential is riding, which is what a run does too rather than
  extra caution: the Web platform removes `Authorization` across origins, so the agent's own MCP
  client would reach that hop unauthenticated and report a 401. Naming the origin change points at
  the fix instead.
- **`not_probeable` is a refusal by NAME, not a failed attempt.** For a `stdio` server or a loopback
  URL the backend is a different machine from the run container, and a SUCCESS there would be the
  more misleading of the two outcomes.

## Operating `stdio` servers, and the security posture

Both are on the site
([stdio](https://www.catfactory.ai/extend/tool-servers.html#operating-a-stdio-server),
[security](https://www.catfactory.ai/extend/tool-servers.html#security-posture)). The repo-side halves:

- **The harness redacts exactly the RESOLVED credential values, by name.** That is why a token
  placed in `transport.env` or in an argv entry bypasses redaction as well as the credential chain:
  the redactor knows values it resolved, not values it was handed.
- **Pre-installing a server's package into the runner image is an image-affecting change**, with
  everything that implies (an `@cat-factory/executor-harness` bump and a fresh immutable tag; see
  [`docs/internal/releases.md`](../../docs/internal/releases.md)).
- **The threat model is [`security-model.md`](./security-model.md)'s**, and wiring a server extends
  the set of parties who can attempt an injection to that server's operator and its own upstreams. A
  change that widens what a wired server may reach updates that doc in the same PR.

## Current limits

Listed for an adopting deployment on the site's
[Current limits](https://www.catfactory.ai/extend/tool-servers.html#current-limits); every entry's
disposition, and the slice that would close it, is in
[`mcp-maturation.md`](../../docs/initiatives/mcp-maturation.md). Two of them are obligations on code
here rather than on an adopter:

- **A runner pool that maps no `dispatchCapabilitiesPath` gets no capability handshake**, so its
  dispatches count as UNVERIFIABLE rather than confirmed. Honest, and not the same as safe.
- **A runner pool cannot PROVE it stopped a refused job**, and one with no `release` template cannot
  stop it at all. Stated on the failure rather than hidden, but on that backend a refused blind run
  really can keep working against the repository until someone kills it.

## Two things that hold WHEREVER the server was declared

- **A server ASSIGNED to a built-in is checked exactly like a registered kind's own.** Boot
  validation and the credential checklist enumerate `AgentKindRegistry.kindsWithCapabilities()`:
  every kind that declares a skill or tool server on its own registration, PLUS every kind named by
  `assignSkills` / `assignToolServers`. No built-in is a registry entry, and
  `assignToolServers('coder', …)` is the recommended attachment path, so an `all()` walk skipped the
  commonest case entirely. Anything new that enumerates "kinds with capabilities" uses that helper,
  or the hole reopens.
- **A tool-server call does not count against the agent's no-edit progress bound.** An `mcp__*`
  call is exempt like a read, because reaching a wired server is what this doc's own prompt section
  tells the agent to do. It is bounded by its own consecutive-call cap instead
  (`JOB_MAX_CONSECUTIVE_MCP_CALLS`, raisable per kind through `tuning.guardLimits`), and by the
  backstop every exempt family shares (`JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS`): a per-family cap
  resets on any call outside its family, so raising one is safe while interleaving several would
  otherwise have been bounded by nothing but the job's wall-clock ceiling.

## Adopting one: the checklist is the website's

Registering, supplying credentials, checking the inventory row, verifying, and the worked Slack
runbook are all on the site's
[Adoption checklist](https://www.catfactory.ai/extend/tool-servers.html#adoption-checklist) and
[Worked example](https://www.catfactory.ai/extend/tool-servers.html#worked-example-give-coder-the-slack-mcp-server).
