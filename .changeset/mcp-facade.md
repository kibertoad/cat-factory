---
'@cat-factory/mcp-server': minor
---

Add `@cat-factory/mcp-server`: a Model Context Protocol facade over the public API, so an MCP host
can drive a workspace directly (plan work on the board, start and watch runs, answer parked
decisions, read a run's telemetry).

It is a facade rather than a fifth client. The tool table is rendered by `pnpm gen:sdk` from the
same `docs/openapi.json` the four SDKs are generated from, and every tool is one call on
`@cat-factory/sdk` — so it cannot drift from the surface it exposes, and it re-implements none of
the SDK's auth, retry, error, pagination or encoding behaviour. `pnpm check:sdk` covers it.

Every operation is a tool except the two SSE endpoints: a tool call returns one result over no
streaming channel, and a bounded "wait for the run" tool would be a timeout dressed up as an
answer, since a parked run waits for a human indefinitely by design. The server names both
omissions, and their alternatives, in its instructions; generation fails on a new streaming
operation nobody has classified.
