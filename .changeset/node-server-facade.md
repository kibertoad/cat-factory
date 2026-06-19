---
'@cat-factory/node-server': minor
---

Add `@cat-factory/node-server` — the Node.js runtime facade. It serves the shared
`@cat-factory/server` Hono app (all controllers + middleware) via `@hono/node-server`,
proving the runtime-neutral HTTP layer runs unchanged on a second runtime. It wires
Node implementations of the runtime ports: a `loadNodeConfig` (the Node analogue of
the Worker's env-driven config), Node gateways (HTTP LLM upstreams; real-time and
async GitHub ingest fall back to the inline/not-enabled paths for now), a
`CompositeModelProvider` (direct vendors + Cloudflare-over-REST + opt-in Bedrock via
`@cat-factory/provider-bedrock`), and a process-local in-memory persistence layer
behind the core kernel repository ports. `start()` boots an HTTP server;
`createServer()`/`buildNodeContainer()` are exposed for embedding and tests.

Persistence is in-memory (non-durable) for now — a Drizzle/Postgres layer and
pg-boss durable execution implement the same ports as follow-ups.
