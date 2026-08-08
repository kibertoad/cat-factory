# MCP tool servers: external tools for agents, without forking

The authority for the CONSUMING side of MCP on this platform: how a deployment gives its agents
extra tool servers (an issue tracker, an advisory database, a vendor's MCP server, an internal
service) programmatically, without forking the platform and without rebuilding the harness image.

The platform has TWO MCP surfaces, and this doc is one of them:

- **Consuming** (this doc): agent kinds calling MCP servers a deployment registered.
- **Serving**: the public `/api/v1` surface exposed AS an MCP server, both as the published
  `cat-factory-mcp` stdio binary and as the hosted `POST /api/v1/mcp` endpoint. That is
  `sdk/mcp` (`@cat-factory/mcp-server`); see [`sdk/mcp/README.md`](../../sdk/mcp/README.md) and
  [`public-api.md`](./public-api.md).

Neighbouring docs, each with its own job:

- [`custom-agents.md`](./custom-agents.md): the extension MODEL (three stages, registry seams,
  skills, the frontend surface). Tool servers are one capability inside that model; this doc is
  where its detail lives.
- [`custom-agent-roles.md`](./custom-agent-roles.md): the field-by-field authoring reference for
  `McpServerDefinition` and `McpSecretRef`, and how the prompt renders what you declare.
- [ADR 0029](./adr/0029-agent-kind-capabilities.md): the design record.
- [ADR 0041](./adr/0041-capability-credential-store.md): the
  per-workspace sealed credential store the resolver chain reads first.
- [`mcp-maturation.md`](../../docs/initiatives/mcp-maturation.md): the roadmap, including every
  known limit below and its disposition.

## Registering a server: the no-fork path

A tool server is deployment-STATIC data registered in the deployment's own composition root, on
the same app-owned `AgentKindRegistry` the deployment already injects for custom agent kinds. All
three facades are published packages whose entry points take the registry (and the credential
resolver) as options, so a deployment depends on a facade, composes its own entry point, and never
touches this repository:

```ts
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { createWorker } from '@cat-factory/worker'
// Node: `start` from '@cat-factory/node-server'; local: `startLocal` from '@cat-factory/local-server'.
// All three take the same `agentKindRegistry` / `createToolSecretResolver` options.

const registry = defaultAgentKindRegistry()

registry.registerToolServer({
  id: 'org-advisories',
  label: 'Org advisory database',
  guidance: 'Look up a dependency here before judging whether a version bump is risky.',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', '@example-org/advisories-mcp@1.4.2'] },
  allowedTools: ['lookup_advisory'],
  secretKeys: [
    { key: 'MCP_ORG_ADVISORY_TOKEN', usage: 'A read token from the advisory admin page.' },
  ],
})

// Attach it to a BUILT-IN kind without redefining it, or list it in a custom kind's `toolServers`.
registry.assignToolServers('coder', ['org-advisories'])

export default createWorker({ agentKindRegistry: registry })
```

Registration is code-first ON PURPOSE: the deployment declares WHAT exists (URL, command,
transport, credentials by name), and a tenant supplies credential VALUES through the per-workspace
store, so the trust boundary does not move. Per-workspace say over WHERE a server applies is
planned (tracker slice 6) but not built; today a registered server reaches every workspace's runs
of the kinds it is declared on.

`registerToolServer` replaces by id (last write wins), which is the documented seam for repointing
a server an installed third-party package registered: see
[`custom-agent-roles.md` → Repointing without forking](./custom-agent-roles.md#repointing-without-forking)
for the composition-root ordering that makes it deterministic.

## Which harnesses can serve what

Which transports each CLI's MCP client reaches is a fact about the CLI, held once in kernel's
`MCP_HARNESS_TRANSPORTS` (`packages/kernel/src/domain/agent-capabilities.ts`):

| Harness       | `stdio` | `http` | Notes                                                                                           |
| ------------- | ------- | ------ | ----------------------------------------------------------------------------------------------- |
| `claude-code` | yes     | yes    | Config rides a per-run `--mcp-config` file, so ambient (developer-login) runs are served too.   |
| `codex`       | yes     | no     | Stdio-only client. An AMBIENT Codex run has no per-run config home, so it is not served at all. |
| `pi`          | no      | no     | Pi has no MCP client (a standing non-goal, ADR 0029). Tool servers never apply on Pi runs.      |

A definition's `harnesses` field may NARROW this (a server that only makes sense under one CLI)
but never widen it. Narrowing to a combination no harness can serve (an `http` server on
`['codex']`, anything on `['pi']`) is dead configuration a run cannot report, because the server
never applies rather than being dropped for a reason, so boot warns (`tool_server_unservable`).

Tool servers also need a **container surface**: an inline LLM step has no agent CLI to wire them
into, and boot validation warns about that combination (the same warning covers `skills`).

## Which runs actually get the server

**A declared server that is not wired is STATED to the agent, never silently missing** (in the
prompt's tool-server section) and recorded on the step (see below). Silence would let the
agent plan around a tool that was never there and discover the gap mid-run. Each reason below is
its own member of a closed vocabulary, because each needs a DIFFERENT fix, and the prompt renders
them through an exhaustive `Record`, so adding one fails the typecheck rather than rendering blank:

| Reason                  | What happened                                                                                                                    | The fix                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `harness_unsupported`   | This CLI speaks no MCP (Pi), the definition's `harnesses` excludes it, or it is an ambient Codex run with no per-run config home | The run's harness, the `harnesses` list, or (ambient Codex) a leased credential instead of the developer's own CLI login |
| `transport_unsupported` | The CLI speaks MCP but its client cannot reach this transport (Codex is stdio-only)                                              | A second declaration for the other transport                                                                             |
| `missing_secret`        | A `required` credential did not resolve                                                                                          | Set the variable, or store the workspace value                                                                           |
| `reserved_secret`       | The credential's LOOKUP key names a platform variable                                                                            | The DECLARATION (setting the variable must not help)                                                                     |
| `oauth_not_connected`   | The server authenticates with OAuth and this workspace holds no grant (or the deployment has no `ENCRYPTION_KEY` to keep one in) | Press Connect on the board and sign in at the vendor; set `ENCRYPTION_KEY` first if the deployment has no grant store    |
| `oauth_token_failed`    | A grant IS on file and produced no access token: revoked/expired refresh, an authorization server that refused, discovery failed | Reconnect, or wait out the vendor's outage                                                                               |
| `over_budget`           | Nothing is wrong with the server; the kind declares more than a dispatch carries                                                 | Trim the kind's declarations                                                                                             |

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
  resolution: an inline step, a run predating the field, or a step re-armed for a re-run whose next
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
The mapping is written up for pool operators beside its sibling response paths in
[`runner-pool-integration.md`](./runner-pool-integration.md#3-describe-your-scheduler-as-a-manifest-application-team).

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

## What the agent may call (`allowedTools`)

- **Each entry is a single tool NAME.** The harness joins the whole list into one `--allowedTools`
  argument with commas, so `['search_issues,get_issue']` becomes two patterns of which the second
  matches nothing, while the prompt goes on advertising the name verbatim. Refused at registration
  (`invalid_tool_server_tool_name`), and dropped at the DISPATCH (where it would otherwise reach the
  prompt) and again at the job boundary, the same three-layer shape the credential floors have.
- **It is SCOPING, not a security boundary.** It is always stated in the prompt, and additionally
  passed to claude-code's `--allowedTools`, but whether that CLI list gates depends on the run's
  permission mode, and Codex cannot express a per-tool restriction at all. If an agent kind must
  never reach a server's other tools, do not wire that server for that kind.

## Credentials

- **An `http` server must be `https`, or loopback.** Its credential rides the request as a header,
  so a cleartext off-box endpoint is refused at registration (`insecure_tool_server_url`) and again
  at the harness boundary. A sidecar on `http://127.0.0.1:…` is fine.
  - **"Loopback" is decided by the URL parser that resolves the request**, not by how the host
    reads. So `http://127.1` and `http://0177.0.0.1` are loopback (they dial `127.0.0.1`), while
    `http://evil.example\@127.0.0.1` is not: the backslash ends the authority, and everything after
    it is path. The one thing the rule will not do is canonicalise for you, because the url is
    stored and written verbatim into the CLI's config: a url carrying an ASCII control character or
    a space is refused rather than trimmed, so what was admitted and what is started cannot differ.
- **`required` defaults to true**, because a tool whose first call 401s is worse than one the agent
  was told it does not have.
- **Give each credential a `usage` line.** It is rendered beside the key in the operator's checklist,
  and the checklist can only ever say what the declaration says: a bare `SLACK_MCP_TOKEN` names
  neither the token TYPE nor the scopes it needs, so without it the operator goes back to your
  source, the one trip the checklist exists to remove. One sentence, naming where to get the value.
  It is operator-facing and non-secret, so it must name no value.
- **A credential may NOT be LOOKED UP BY a platform configuration variable.** A definition names
  both the key it wants and the endpoint that key is sent to, so
  `{ key: 'ENCRYPTION_KEY', header: 'Authorization' }` would boot clean and ship the deployment's
  master sealing key to a third party. Every variable in `docs/environment-variables.md` is
  reserved (`isReservedPlatformEnvKey`, case-insensitively, because `process.env` lookup is
  case-insensitive on Windows). The declaration is refused at boot (`reserved_credential_key`), and
  refused again at dispatch, where the server is reported unavailable under its own
  `reserved_secret` reason rather than `missing_secret`: the two need opposite fixes, and setting
  the variable is precisely what must not help. This floor needs no configuration and cannot be
  widened.
- **Use `envName` when the server's own client requires a specific variable.** The floor binds the
  LOOKUP key, not the variable the value is injected under in the server's process, which reads
  nothing. That distinction is what keeps the floor affordable: the GitHub MCP server reads
  `GITHUB_PERSONAL_ACCESS_TOKEN`, the Slack one `SLACK_BOT_TOKEN`, and the platform reads neither
  while owning both families. Declare
  `{ key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }` and the value is looked
  up under a name of your own and injected under the one the SDK wants. `envName` has its own,
  narrower rule (`isToolchainEnvName`): not `PATH`, `NODE_OPTIONS`, `npm_config_*` or anything else
  that would reconfigure the process instead of authenticating a call. It applies to `stdio`
  servers; an `http` server's value goes to its `header`, so an `envName` there is warned about as
  inert.
- **A workspace's OWN value wins over the deployment's.** Every facade composes the per-workspace
  capability-credential store (sealed, `secrets.manage`-gated, edited over
  `/workspaces/:ws/capability-credentials`) in FRONT of the environment resolver, PER KEY, so a
  tenant supplies its own vendor account and a workspace that has stored nothing resolves exactly
  as it did before the store existed. The surface is a CHECKLIST, not a blank form: the
  Infrastructure window's "Capability credentials" tab projects the credentials this deployment's
  registered capabilities declare, so an operator never has to read the deployment's source to
  learn what to fill in. It appears only for a caller holding `secrets.manage` and only when
  something is declared, stored or unreadable, and it saves ONE key at a time
  (`PUT /workspaces/:ws/capability-credentials/:key`) because it holds no values to re-send. See
  [ADR 0041](./adr/0041-capability-credential-store.md).
- **Mind what `secretKeys` can reach BEYOND that floor.** Everything outside the platform's own
  configuration is a developer's own tooling, and only the deployment knows which of it an
  integration may see. If a deployment installs agent packages it did not author, wire
  `createToolSecretResolver: (env) => createEnvToolSecretResolver(env, { allowKeys: [...] })` and
  keep the credentials behind a dedicated prefix (`MCP_…` by convention). Note that a deployment
  resolver REPLACES the chain above rather than being wrapped by it. See ADR 0029 → Consequences.

  **The list gates every SUBJECT that resolver serves**, not only tool servers: a generative binary
  integration's credential (`BinaryGeneratorRegistry`) goes through the same port. So an
  allow-list holding only `MCP_…` keys silently resolves nothing for a registered image or music
  generator: the run continues and the agent reports the integration as unavailable, with nothing
  naming the allow-list as the cause. Cover both families, or list the exact keys.

## OAuth: connecting an OAuth-protected remote server

Most of the hosted MCP ecosystem (Linear, Atlassian, Figma, Slack's remote server) authenticates
with OAuth rather than a static token, so a declaration that can only name a key reaches none of
it. A remote (`http`) server may therefore declare `oauth` instead of, or beside, its
`secretKeys`:

```ts
registry.registerToolServer({
  id: 'linear',
  label: 'Linear',
  guidance: 'Read the issue behind a task before guessing at its intent. Never file or edit.',
  transport: { kind: 'http', url: 'https://mcp.linear.app/mcp' },
  oauth: {
    grant: 'authorization_code',
    clientId: 'the client id you registered at the vendor',
    // Public client (PKCE only) when omitted, which is what most remote MCP servers expect.
    clientSecretKey: 'MCP_LINEAR_CLIENT_SECRET',
    scopes: ['read'],
    // authorizationUrl / tokenUrl omitted ⇒ DISCOVERED from the server url (see below).
  },
})
registry.assignToolServers('coder', ['linear'])
```

**The split is the same one the static path has, one level up.** A `secretKeys` declaration names
a credential and the tenant supplies its VALUE; an `oauth` declaration names a CLIENT and the
tenant supplies its GRANT. Registration stays deployment code either way, so the trust boundary
does not move: a workspace can authorise its own vendor account, and cannot point the deployment
at a different endpoint.

**Two grants, and only one of them involves a person.**

| Grant                | Who authorises                                        | What a board does                                 |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `authorization_code` | A human with `secrets.manage`, in the vendor's own UI | Presses Connect once; the grant is then refreshed |
| `client_credentials` | Nobody: the deployment's own client authenticates     | Nothing; the token is minted on first dispatch    |

`client_credentials` is what makes an OAuth-protected INTERNAL or partner server reachable on a
deployment with no one to press a button (a cron-driven install, a CI environment). It needs no
redirect URL and shows no Connect button.

### Endpoints: discovered, or declared

Omit `authorizationUrl` / `tokenUrl` and the platform discovers them the way the MCP authorization
spec prescribes: the server's protected-resource metadata (RFC 9728, tried at the path-aware
well-known location first) names its authorization server, and that server's metadata (RFC 8414,
falling back to OpenID Connect discovery) names the endpoints. A server that publishes no
protected-resource document is treated as its own issuer, which is what makes the pre-RFC-9728
generation of servers reachable.

**Declaring an endpoint WINS over discovery**, half a pair included: pinning one and discovering
the other is a legitimate declaration for a vendor whose metadata is right about one and stale
about the other. Pin both when you do not want a third party's metadata document deciding where
your client secret is sent.

**A discovered endpoint is held to the same URL floor a declared one is** (https, or plain http on
loopback; never a cloud instance-metadata address). A metadata document is a third party telling
this deployment where to send its client secret and receive its tokens, so that is the one rule
discovery may not relax. The floor runs on EVERY url the walk touches, each candidate and each
redirect hop, because checking the first one and following whatever it points at is not checking.

**The token endpoint's redirects are refused rather than followed.** That request body carries the
client secret and the grant, and while `fetch` strips an `Authorization` header across origins it
never strips a form body, so following a 30x there would hand the client secret to wherever it
pointed. A metadata GET carries no credential and does follow, up to three re-validated hops.

### What a deployment has to configure

- **`ENCRYPTION_KEY`**, because a grant is sealed at rest like every other credential in the
  platform. Without it there is nowhere to keep one, and every OAuth server is stated to its agent
  as `oauth_not_connected` rather than dispatched without a token.
- **`MCP_OAUTH_REDIRECT_URL`**, for the interactive grant only: this deployment's public app URL
  followed by `/mcp-oauth-callback`, and the SAME string registered as the client's redirect URI at
  the vendor. It points at the SPA, not at the backend, for the reason the security notes below
  give. Operator-set rather than derived from the request, because a `Host`-derived value differs
  behind every proxy and preview URL a deployment sits behind, and the vendor then refuses the
  exchange with `redirect_uri_mismatch`, which names nothing on this side. Unset ⇒ Connect refuses
  with a 503 naming the variable, before the browser leaves the app.
- **The client secret**, when the client has one. It is looked up through the SAME
  capability-credential chain a `secretKeys` entry uses (the workspace store in front of the
  environment, per key), so a tenant can bring its own OAuth client through the credential
  checklist rather than through a second mechanism. It is held to the same reserved-key floor.

### What a board sees, and what a run gets

The tool-server row in Infrastructure → Capability credentials carries the connection: Connect /
Reconnect / Disconnect, who granted it, the scopes the vendor actually granted, and — beside
`connected` rather than instead of it — the last token renewal that failed. That pairing is the
point: a grant that is on file and no longer producing tokens is precisely the state that reads as
working and is not.

At dispatch the access token is refreshed if it is close to spent and folded into the header the
declaration names (`Authorization: Bearer …` by default). It rides the job body only, exactly like
a resolved `secretKeys` value: never a prompt, never the agent-context snapshot.

Three things worth knowing before you wire one:

- **A refresh token the vendor did not rotate is carried forward.** Servers differ, and dropping
  the old one on a non-rotating server would turn a working grant into a single-use one.
- **A grant with NO refresh token is reported as such** (`refreshable: false`), before its access
  token expires rather than after. It has to be granted again by hand when it does.
- **Disconnect is not gated on the declaration still existing.** A grant outlives the registration
  that created it (a retired server, a rename in a refactor), and the row is then a live vendor
  token nobody can reach, so the one action that removes it always works.

### Security notes specific to OAuth

- **The vendor's redirect lands on the SPA, and the backend never receives one.** This is the
  load-bearing choice of the whole flow. A redirect target is reached by a top-level browser
  navigation a third party triggers, and sessions here are BEARER TOKENS, which such a navigation
  cannot carry, so a backend route receiving the redirect directly sees no user on every request,
  on an authenticated deployment exactly as in dev-open, and any "same user" or "still permitted"
  check written there is unreachable code that reads like protection. The page at
  `/mcp-oauth-callback` re-presents the `code` and `state` to `POST /mcp/oauth/complete`, which is
  ordinary session-gated API, so the two checks below actually run. (It also means the completion
  route is behind the shared default-deny gate rather than exempted from it.)
- **The `state` is SEALED, not signed.** It carries the PKCE verifier, so it is encrypted under the
  deployment's own key rather than merely authenticated: the state travels through the same browser
  redirect the authorization code does. It also carries the user who STARTED the flow, and the
  completion refuses anyone else. Without that binding, getting an admin to open an attacker's
  authorization link plants the attacker's vendor account as the board's connection.
- **`secrets.manage` is re-resolved when the token is stored**, not assumed from the Connect press.
  A grant takes minutes of human time and the permission can be revoked inside that window. It goes
  through the same single `loadWorkspaceAccess` the workspace gate uses; that gate cannot do it
  itself, because the board is sealed into the state rather than named in the path.
- **A grant row is reclaimed with the board.** `mcp_oauth_grants` is in the workspace-delete
  cascade, so deleting a workspace does not leave live vendor tokens behind. Neither disconnect nor
  delete REVOKES at the vendor (no RFC 7009 call is made), so revoke there too when that matters.
- **The `resource` indicator (RFC 8707) is always sent**, defaulting to the server's own url, so a
  token minted for one MCP server is not replayable against another behind the same authorization
  server.
- **Everything the security posture section says about a wired server still applies.** OAuth
  changes who the run authenticates AS; it does not make the server's results trusted input, and
  the granted scopes are the boundary you actually control. Grant read-only scopes at the vendor.

## Testing one for real (the probe)

Boot validation rules on the DECLARATION and a dispatch reports what it DROPPED. Neither can tell you
whether a server that survives both actually answers, so a dead url, a rotated token or a typo'd tool
name used to surface only as an agent quietly working without a tool it was promised.

The Infrastructure window's "Capability credentials" tab lists every registered server with a **Test**
button (`POST /workspaces/:ws/tool-servers/:id/test`, `secrets.manage`, read included). A test resolves
the credentials through the SAME composed chain a dispatch uses (the workspace store in front of the
environment, per key, with the reserved-key floor applied before the resolver is asked), then speaks
`initialize` + `tools/list` to the server. So the verdict is about THIS board rather than about
whoever set the deployment's variable.

| Verdict               | What it means                                                                                                      | The fix                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `ok`                  | The handshake completed and the tool list came back                                                                | Nothing; the row names the server, its version and its tool count |
| `credentials_missing` | A `required` credential did not resolve, so NOTHING was sent                                                       | Store the value for this board, or set the variable               |
| `credential_refused`  | A credential's LOOKUP key names a platform configuration variable                                                  | The DECLARATION (setting the variable must not help)              |
| `oauth_not_connected` | The server authenticates with OAuth and this board has not granted it, so NOTHING was sent                         | Press Connect and sign in at the vendor                           |
| `oauth_token_failed`  | A grant is on file and produced no token (revoked refresh, an authorization server that refused, failed discovery) | Reconnect; the row's detail carries the cause                     |
| `unreachable`         | No answer at all: DNS, TLS, connection refused, or the 10s deadline (including a body that stalls after its 200)   | The endpoint, or the network between here and it                  |
| `http_error`          | Something answered with a status rather than an MCP frame (`401` ⇒ a WRONG token)                                  | The credential's value, or the url's path                         |
| `protocol_error`      | It answered, but not as an MCP server (non-JSON, a JSON-RPC error, a bad redirect)                                 | The url almost certainly names something else                     |
| `not_probeable`       | The backend has no vantage point (see below)                                                                       | Verify from a run, or change the transport                        |

Three declarations are refused BY NAME instead of being probed, because a probe from the backend would
answer about the wrong process: a `stdio` server is a child of the harness inside the run container; a
loopback url means "beside the agent, in its own container", and the backend's `127.0.0.1` is a
different machine (a SUCCESS there would be the more misleading of the two outcomes); and a url that
fails the transport rule is held to the same floor the dispatch holds it to.

**A REDIRECT is followed, but a credential stops at its own origin.** Each hop is re-checked against
the transport rule, so an https endpoint cannot redirect a credential-bearing request onto cleartext.
A hop that leaves the DECLARED ORIGIN is refused outright while a credential is riding, and that is
what a run does too rather than extra caution: the Web platform removes `Authorization` when a
redirect crosses origins, so an agent's own MCP client reaches such a hop unauthenticated and would
report a 401. Naming the origin change instead points at the fix, which is the declaration naming the
final url. A server that needs no credential is followed across origins as usual.

**The probe is also the only thing that can check `allowedTools` against reality.** Every other layer
holds an entry to a NAME pattern and none can tell a well-formed name from a real one. When the tool
list came back COMPLETE, the result names any declared tool the server does not expose. When it did
not (a paginated list past the probe's page bound), the check reports itself as unchecked rather than
calling a working tool missing: absence from a prefix is not absence from the server.

## Operating `stdio` servers

A `stdio` server is a child process the agent CLI spawns INSIDE the run container, which shapes
everything about operating one:

- **It cannot be probed.** The Test button refuses it by name (`not_probeable`): the backend is a
  different machine from the run container, so there is no vantage point that would answer about
  the right process. The verification path is a run: read the prompt's tool-server section, or the
  run's agent-context snapshot.
- **An `npx`-launched server resolves and installs its package at CLI startup, per run.** That
  spends the run container's network and the registry's availability on every dispatch, and a
  resolution failure surfaces from the CLI mid-run (the CLI simply fails to connect to the server)
  rather than through the platform's unavailability vocabulary, which has already said the server
  was wired. **Pin the package version in `args`** (`@example-org/advisories-mcp@1.4.2`, never a
  bare name or a dist-tag) so every run executes the same code and a vendor's bad publish cannot
  change agent behaviour mid-week.
- **Pre-installing the package into the runner image** removes the cold start and the registry
  dependence, and is an image-affecting change with everything that implies (an
  `@cat-factory/executor-harness` version bump and a fresh immutable tag; see
  [`docs/internal/releases.md`](../../docs/internal/releases.md)).
- **Non-secret process config rides `transport.env`; anything secret rides `secretKeys`.** The
  harness redacts exactly the resolved credential values from its logs, by name, so putting a token
  into `transport.env` (or a `--api-key=…` argv entry) bypasses both the credential chain and the
  redaction.

## Security posture

The threat model for everything below is
[`security-model.md`](./security-model.md): assume an agent whose instructions have been subverted
by text it read. Three facts follow for tool servers specifically:

- **A wired server's RESULTS are untrusted input**, exactly like repository contents and issue
  text. A third-party or vendor server (or anything it proxies) can inject instructions through a
  tool result, so wiring a server extends the set of parties who can attempt injection to that
  server's operator and its own upstreams.
- **`allowedTools` does not contain a subverted agent** (scoping, above), and the run container
  applies no egress bound on which wired servers such an agent may call with what it has read. A
  wired server is therefore also a potential exfiltration channel for anything else in the agent's
  context.
- **The credential is the boundary you actually control.** Wire third-party servers with read-only,
  minimally-scoped tokens (the Slack runbook below omits `chat:write` at the Slack app, not just in
  `allowedTools`), prefer the per-workspace store over deployment env vars, and set `allowKeys`
  when the deployment runs agent packages it did not author.

## Current limits, and where each is tracked

Every entry here has a disposition in [`mcp-maturation.md`](../../docs/initiatives/mcp-maturation.md);
this list exists so an adopting deployment learns the ceiling from the docs rather than from a run.

- **No dynamic client registration** (RFC 7591). OAuth works from a client the deployment
  registered at the vendor and named in code; a server that offers ONLY dynamic registration
  cannot be connected. Registering a client at runtime would be deployment state with no home in a
  composition-root registration and no operator-visible identity at the vendor, which is why it is
  deferred rather than absent by accident.
- **A runner pool that maps no `dispatchCapabilitiesPath` gets no capability handshake** (see
  above). Its dispatches are then counted as UNVERIFIABLE rather than confirmed, which is honest
  but is not the same as safe: keeping pool images at the pinned tag remains an adopter obligation.
- **A runner pool cannot PROVE it stopped a refused job**, and one with no `release` template
  cannot stop it at all. Both are stated on the failure rather than hidden, but on that backend a
  refused blind run really can keep working against the repository until someone kills it.
- **No per-workspace or per-step server selection** (slice 6). A registered server applies to
  every workspace's runs of the kinds it is declared on; only the credential half is per-workspace
  today. Capability credentials are also SPA-only (absent from the public API) until the same
  slice.
- **Only the claude-code harness reports what it reached.** `step.toolServers.observed` carries
  the agent CLI's own startup report (see above), and codex's CLI publishes none, so a codex run
  records the platform's half alone. That is stated as ABSENT rather than as a healthy or failed
  server, and on that harness a wired-but-broken server is still diagnosed with the probe. The same
  holds for a runner pool that leaves `response.toolServersPath` unmapped, and for any image older
  than 1.95.0.
- **Pi has no MCP client** (standing non-goal, ADR 0029). A deployment whose model provisioning
  resolves to Pi runs gets no tool servers there, stated per run as `harness_unsupported`.
- **`http` means streamable HTTP.** The legacy HTTP+SSE transport is deliberately not a vocabulary
  member; an SSE-only server is unreachable (revisit recorded in the tracker).
- **Tools only.** MCP resources, prompts, elicitation and progress notifications are not consumed
  (deferred, not refused).

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

## Runbook: give `coder` the Slack MCP server

A real vendor server, end to end, because the worked example
(`backend/internal/example-custom-agent`) is a house server on a house endpoint and every
interesting rule shows up when a VENDOR fixes the names. Slack's MCP server is `stdio` (an npm
package) and its client reads `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID`, both of which fall inside a
prefix family the platform reserves and neither of which the platform reads.

1. **Register the server and attach it to a built-in**, in the deployment's composition root, beside
   its other `register*` calls:

   ```ts
   registry.registerToolServer({
     id: 'slack',
     label: 'Slack',
     guidance:
       'Read Slack history to find the discussion behind a task. Prefer it over guessing at ' +
       'intent from the ticket alone. Never post.',
     transport: {
       kind: 'stdio',
       command: 'npx',
       args: ['-y', '@modelcontextprotocol/server-slack'],
     },
     allowedTools: ['slack_list_channels', 'slack_get_channel_history', 'slack_get_thread_replies'],
     secretKeys: [
       {
         key: 'ORG_SLACK_BOT_TOKEN',
         envName: 'SLACK_BOT_TOKEN',
         usage: 'A Slack bot token (xoxb-…) with channels:history and channels:read.',
       },
       {
         key: 'ORG_SLACK_TEAM_ID',
         envName: 'SLACK_TEAM_ID',
         required: false,
         usage: 'The workspace id (T…), from Slack’s About this workspace page.',
       },
     ],
   })
   registry.assignToolServers('coder', ['slack'])
   ```

   Three things in there are the rules above rather than taste. The LOOKUP keys are prefixed
   `ORG_` because `SLACK_` is a reserved family, and `envName` carries the names Slack's own client
   insists on: the floor binds what may be READ off the deployment's environment, and an injection
   name reads nothing. `allowedTools` lists the three READ tools and omits `slack_post_message`,
   which is scoping rather than a security boundary: if `coder` must never post, the right answer is
   a Slack app without `chat:write`.

2. **Fill in the values.** Infrastructure → Capability credentials shows both keys as a checklist
   with the `usage` lines beside them. Store them for the board (sealed, per workspace) or set the
   variables on the deployment; the store wins per key.

3. **Check the row.** The tool-server list above the checklist should say `Given to: coder` and
   `Works on: claude-code, codex`. `Given to:` empty means the `assignToolServers` call did not run.

4. **Verify from a run, not from the Test button.** A `stdio` server is a child process of the
   harness INSIDE the run container, so the button is absent and the row says why: there is no
   vantage point here, and a probe that reached for the nearest thing it could talk to would answer
   about the backend. Start a `coder` run and read the prompt's tool-server section, or the run's
   context snapshot. A remote (`http`) vendor server is the case the Test button exists for.

5. **If the run says the server is unavailable**, the reason names the fix: `missing_secret` is a
   value to supply, `reserved_secret` is a declaration to change, `harness_unsupported` means the run
   used Pi (no MCP client), and `over_budget` means `coder` has accreted more servers than one
   dispatch carries.

## Adoption checklist

1. Register the server (and `assignToolServers` it onto the kinds that should reach it) in the
   composition root; read the boot log, which is where a bad id, an insecure url, a reserved key or
   an unservable harness/transport combination is named.
2. Supply credential values: the per-workspace store (preferred on anything multi-tenant) or the
   deployment environment; `allowKeys` if the deployment runs third-party agent packages.
3. Check the Infrastructure window's inventory row (`Given to:` / `Works on:`), then verify: the
   Test button for an `http` server, a real run's prompt section or context snapshot for `stdio`.
4. Keep self-hosted runner pools on the current pinned image (the blind-run limit above).
5. For third-party servers, read the Security posture section before wiring: minimal scopes,
   read-only tokens, and the store over the environment.
