# `sdk/`: the four public-API SDK clients, plus the MCP facade

Official clients for `/api/v1` in TypeScript, Python, Go and Java (which also serves Kotlin;
there is no separate Kotlin SDK), and beside them `mcp/` (`@cat-factory/mcp-server`), which is not a
fifth client but a Model Context Protocol facade projecting the same operations as tools an MCP host
can drive. Product/design notes: [`README.md`](./README.md) and
[`mcp/README.md`](./mcp/README.md); the API itself:
[`backend/docs/public-api.md`](../backend/docs/public-api.md).

One member is not a projection at all: `gatekeeper-worker/` (`@cat-factory/gatekeeper-worker`) is
the hand-written Cloudflare OS Gatekeeper machinery a deployment installs, built on the generated
`gatekeeper/` table and the TypeScript client. Nothing in `scripts/sdk/` emits it, and the rule
below does not apply to it; `deploy/gatekeeper` is the template that installs it.

**The rule that governs everything here: models and operations are GENERATED, transports are
HAND-WRITTEN.** The chain is `contracts → docs/openapi.json → sdk/*`, with no hand-editing at any
link. Never edit a file whose header says GENERATED: change the contracts (or the emitter) and
run `pnpm gen:sdk`. `pnpm check:sdk` fails CI on drift and on version skew.

**Where things live**

| Path                                                       | What                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `typescript/src/*.generated.ts`                            | generated models + resource clients                                                                        |
| `typescript/src/{http,errors,sse,client,index}.ts`         | hand-written transport, error hierarchy, SSE reader, entry point                                           |
| `python/cat_factory/{models,operations}.py`                | generated                                                                                                  |
| `python/cat_factory/{_http,_sse,errors,client}.py`         | hand-written                                                                                               |
| `go/{models,operations}_gen.go`                            | generated                                                                                                  |
| `go/{client,errors,sse}.go`                                | hand-written                                                                                               |
| `java/src/main/java/.../model/`, `.../resources/`          | generated (whole packages, wiped on regeneration)                                                          |
| `java/src/main/java/ai/catfactory/sdk/*.java`              | hand-written (`Transport`, `CatFactoryClient`, the exception hierarchy, `EventStream`, `PageIterator`)     |
| `mcp/src/tools.generated.ts`                               | generated tool table (input + output schemas, hints, one thunk per operation)                              |
| `mcp/src/{server,config,result,instructions,stdio,bin}.ts` | hand-written: the filters, the result rendering, the model-facing prose, the executable                    |
| `gatekeeper/src/bindings.generated.ts`                     | generated policy table; `index.ts` beside it is the hand-written scope-ladder half                         |
| `gatekeeper-worker/src/**`                                 | hand-written throughout: the Worker factory, capability, key broker, webhook receiver, approval inbox      |
| `gatekeeper-worker/src/policy/`                            | the `./policy` entry point: the policy vocabulary, with no Worker runtime, so a policy file loads anywhere |
| `gatekeeper-worker/test/live/`                             | the same Worker against a REAL deployment, run by `@cat-factory/sdk-smoketest` (`--only=gatekeeper`)       |
| `*/smoketest/`                                             | the per-SDK smoketest programs the cross-SDK harness drives                                                |

**The generator** is `scripts/sdk/` (`ir.mjs` → spec-to-IR, `surface.mjs` → the chosen public
shape, `emit-*.mjs` → one per language plus `emit-mcp.mjs`) driven by `scripts/generate-sdks.mjs`.

**Adding an endpoint to `/api/v1` requires an entry in `scripts/sdk/surface.mjs`** naming its
resource group and method; generation FAILS without one, so a new endpoint cannot ship as an
un-callable hole in four clients. The same entry becomes an MCP tool with no second decision, with
two escapes, both in `surface.mjs` and both fail-closed:

- **`MCP_OMITTED_OPERATIONS`** names an operation that CANNOT be a tool (today the two SSE streams)
  with the reason a caller should read. Generation fails on an unclassified streaming operation, and
  on an entry naming an operation the spec no longer has.
- **`MCP_TOOL_HINTS`** names the operations whose consequence is real money or a merged pull request,
  supplying the `destructiveHint` / `idempotentHint` the HTTP method cannot. An operation absent from
  it keeps the protocol's own cautious defaults, which is why the table is deliberately not a blanket
  pass over the writes. Generation fails on a stale entry or one naming a GET.

**An OUTPUT schema is not an input schema with the arrow reversed.** `emit-mcp.mjs` renders responses
permissively on purpose (no `required`, no `enum`, no closed `anyOf`, no bounds, and for a union not
even `type`): a caller's own MCP client VALIDATES a result against the declared schema, and
`/api/v1` is additive forever, so every one of those would be a way for an older copy of the package
to reject a newer deployment's honest answer. That is the same "an unknown value never raises" invariant the four clients hold to, arrived
at from the other side.

**Four cross-cutting invariants** every emitter and runtime honours, each a rule about being
honest with the caller rather than convenient: absent ≠ null; an unknown enum value or field
never raises (the surface is additive forever); the error CLASS comes from the HTTP status while
`code` is exposed verbatim (it carries surface-specific values this SDK deliberately does not
narrow); and only idempotent requests are retried. The reasoning is in `README.md`.

**See also:** `backend/internal/sdk-smoketest` (the cross-SDK parity harness, the only thing in
CI that can see the four clients DISAGREE, and the only thing that spawns the MCP binary against a
real backend), `backend/docs/adr/0030-public-api-surface.md`.
