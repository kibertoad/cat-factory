---
'@cat-factory/mcp-server': minor
'@cat-factory/server': minor
---

MCP maturation slice 3: the public API is now served over MCP from the deployment itself.

`POST /api/v1/mcp` speaks Model Context Protocol behind the same public-API key auth as every other
`/api/v1` route, so an MCP host reaches a deployment with a URL and a key and nothing installed. That
is the point of the slice: until now "drive cat-factory from a model" meant an npm dependency, a local
process per host and a long-lived key in the host's plaintext config, which rules out claude.ai, hosted
agents and anything that cannot spawn a subprocess. The stdio binary stays, for hosts with no HTTP MCP
support and for use against a deployment you do not run.

It is the SAME server behind both paths: the endpoint mounts `@cat-factory/mcp-server`'s
`handleMcpHttpRequest`, so the generated tool table, the instructions and the result rendering are the
same bytes, and every tool call is one `/api/v1` request under the CALLER's own forwarded key. Nothing
is reachable over MCP that the same key could not reach with `curl`. Behaviour worth knowing about:
the key's SCOPE decides the tool list (a `read`-scoped key is served only the tools that change
nothing, and the instructions say a wider key would expose the rest, so a model asks for one instead of
reporting the platform as unable to write); above `read` the whole table is listed and each tool's own
rung is enforced by the endpoint it calls, arriving as tool content the model can act on; and the
endpoint is stateless with JSON responses, so `GET` and `DELETE` are answered `405`.

The endpoint joins the PUBLIC surface under the stability contract from this release. It is
deliberately absent from `docs/openapi.json`: a JSON-RPC endpoint has no operation shape to describe,
and describing it would mint an SDK method in four languages for a protocol none of those clients
speaks. `backend/docs/public-api.md` carries the obligation instead.

`@cat-factory/mcp-server` gains `handleMcpHttpRequest` / `refuseMcpMethod`, so any deployment of this
API can mount the endpoint, plus a `readOnlyReason` option that lets the instructions name the right
fix for a narrowed tool list.

INTERNAL BREAK in `@cat-factory/mcp-server`: `optionsFromEnv(env, deps)` now REQUIRES
`deps.readSecretFile` rather than defaulting to `readFileSync`, and `ToolSelection.writeToolsHidden` is
a `ReadOnlyReason | null` rather than a boolean. The first is what keeps every module the hosted
endpoint reaches free of Node built-ins: those modules are bundled into deployments' Workers, where
`node:fs` does not resolve at build time, so the default was a Worker that fails to BUILD for the sake
of a code path it can never take. `bin.ts` supplies the reader.
