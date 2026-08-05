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
- [`capability-credential-store.md`](../../docs/initiatives/capability-credential-store.md): the
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
prompt's tool-server section) and recorded on the run's context snapshot. Silence would let the
agent plan around a tool that was never there and discover the gap mid-run. Each reason below is
its own member of a closed vocabulary, because each needs a DIFFERENT fix, and the prompt renders
them through an exhaustive `Record`, so adding one fails the typecheck rather than rendering blank:

| Reason                  | What happened                                                                                                                    | The fix                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `harness_unsupported`   | This CLI speaks no MCP (Pi), the definition's `harnesses` excludes it, or it is an ambient Codex run with no per-run config home | The run's harness, or the `harnesses` list           |
| `transport_unsupported` | The CLI speaks MCP but its client cannot reach this transport (Codex is stdio-only)                                              | A second declaration for the other transport         |
| `missing_secret`        | A `required` credential did not resolve                                                                                          | Set the variable, or store the workspace value       |
| `reserved_secret`       | The credential's LOOKUP key names a platform variable                                                                            | The DECLARATION (setting the variable must not help) |
| `over_budget`           | Nothing is wrong with the server; the kind declares more than a dispatch carries                                                 | Trim the kind's declarations                         |

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
  [`capability-credential-store.md`](../../docs/initiatives/capability-credential-store.md).
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

| Verdict               | What it means                                                                                                    | The fix                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `ok`                  | The handshake completed and the tool list came back                                                              | Nothing; the row names the server, its version and its tool count |
| `credentials_missing` | A `required` credential did not resolve, so NOTHING was sent                                                     | Store the value for this board, or set the variable               |
| `credential_refused`  | A credential's LOOKUP key names a platform configuration variable                                                | The DECLARATION (setting the variable must not help)              |
| `unreachable`         | No answer at all: DNS, TLS, connection refused, or the 10s deadline (including a body that stalls after its 200) | The endpoint, or the network between here and it                  |
| `http_error`          | Something answered with a status rather than an MCP frame (`401` ⇒ a WRONG token)                                | The credential's value, or the url's path                         |
| `protocol_error`      | It answered, but not as an MCP server (non-JSON, a JSON-RPC error, a bad redirect)                               | The url almost certainly names something else                     |
| `not_probeable`       | The backend has no vantage point (see below)                                                                     | Verify from a run, or change the transport                        |

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
  [`docs/releases.md`](../../docs/releases.md)).
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

- **No OAuth for remote servers** (tracker slice 7). Credentials are static values resolved by
  name, so the OAuth-first vendor remote servers (Figma, Atlassian, Slack and Linear remote MCP,
  and most of the current hosted ecosystem) cannot be connected today. Reachable now: any server
  taking a static token (header or env), and anything you run yourself.
- **Runner-pool images must be current, or the run is BLIND** (slice 5 carries the handshake that
  closes this). A self-hosted runner image older than the backend parses the job body without the
  `mcpServers` field and runs with the prompt still promising the tools; nothing states the gap.
  Until the handshake lands, keeping pool images at the pinned tag is an adopter obligation, not a
  nicety.
- **No per-workspace or per-step server selection** (slice 6). A registered server applies to
  every workspace's runs of the kinds it is declared on; only the credential half is per-workspace
  today. Capability credentials are also SPA-only (absent from the public API) until the same
  slice.
- **What a run actually reached is not yet recorded on a typed surface** (slice 5). Today the
  evidence is the prompt's tool-server section and the agent-context snapshot.
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
