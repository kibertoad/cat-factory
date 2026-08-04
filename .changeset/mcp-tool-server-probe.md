---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

MCP maturation slice 4: a declared tool server can now be TESTED, and the deployment's tool servers are
finally visible without reading its source.

Until now the only way to learn whether a wired MCP tool server actually works was to start a run and
read the agent's own prompt. Boot validation rules on the DECLARATION and a dispatch reports what it
DROPPED, but a server that survives both — servable harness, allowed transport, credential present —
could still be a dead url, a rotated token or a typo'd tool name, and every one of those surfaced as an
agent quietly doing worse work without the tool it was promised.

Two new `secrets.manage`-gated routes under `/workspaces/:ws`: `GET /tool-servers` lists every
registered server (which agent kinds get it, which harnesses can serve it, which credentials it asks
for by name, whether it can be probed at all), and `POST /tool-servers/:id/test` speaks `initialize` +
`tools/list` to it for real. The Infrastructure window's "Capability credentials" tab renders the
inventory with a Test button per row, above the credential checklist those credentials belong to.

What makes the verdict worth having is that the probe resolves credentials through the SAME composed
chain a dispatch uses: the per-workspace store in front of the deployment environment, per key, with
the reserved-key floor applied before the resolver is asked. So the answer is about THIS board rather
than about whoever set the deployment's variable, and the probe can never be the one path that resolves
a platform configuration variable and ships it to a third party. The result names a CAUSE rather than a
boolean, split by the fix each needs: a missing credential and a rejected one are different rows, and
"no answer at all" is kept apart from "answered with a status" because one is the network and the other
is usually the token or the path.

Three things it deliberately refuses rather than approximating. A `stdio` server runs inside the run
container, a loopback url means "beside the agent in its own container", and the backend is neither of
those places — so those rows say why instead of offering a button, because a probe that reached for the
nearest thing it could talk to would answer about the backend's own machine, and a SUCCESS there would
mislead more than a failure. The third is the `allowedTools` reconciliation: the probe is the first
thing in the platform that can check a declared tool name against reality (every other layer holds it
to a NAME pattern, which a well-formed typo passes), and when the server's tool list came back
paginated past the probe's page bound the check reports itself as unchecked rather than calling a
working tool missing.

Two smaller fixes ride along. `McpSecretRef` gains `usage`, the operator-facing note the credential
checklist has always had a field for and only the generative-integration half ever populated — so a
tool server's row can finally say which token type and scopes a key wants. And the checklist's READ was
documented as `secrets.manage`-gated in three places while its mount let every member's GET through:
`requireWorkspacePermission` passes GET/HEAD by design, so both surfaces now mount the
explicitly-named `requireWorkspacePermissionIncludingReads`, with a cross-runtime RBAC assertion each.

`ServerContainer` gains `toolSecretResolver`, the composed credential chain itself, beside the
`toolSecretEnvironmentFallback` description it already carried; a facade that wires the chain now
surfaces both. `AgentKindRegistry` gains `allToolServers()`, the complement of
`kindsWithCapabilities()` and the only way to see a registration attached to no kind at all — a state
that previously passed every check while its credentials sat in the operator's checklist as keys no
dispatch would ever ask for. Kernel gains `isLoopbackMcpHttpUrl` beside `isAllowedMcpHttpUrl`, a
separate predicate on purpose: one rules on the scheme, the other on where the server lives.

No harness change, so no runner-image bump.
