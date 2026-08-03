# `sdk/`: the four public-API SDK clients

Official clients for `/api/v1` in TypeScript, Python, Go and Java (which also serves Kotlin;
there is no separate Kotlin SDK). Product/design notes: [`README.md`](./README.md); the API
itself: [`backend/docs/public-api.md`](../backend/docs/public-api.md).

**The rule that governs everything here: models and operations are GENERATED, transports are
HAND-WRITTEN.** The chain is `contracts → docs/openapi.json → sdk/*`, with no hand-editing at any
link. Never edit a file whose header says GENERATED: change the contracts (or the emitter) and
run `pnpm gen:sdk`. `pnpm check:sdk` fails CI on drift and on version skew.

**Where things live**

| Path                                               | What                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `typescript/src/*.generated.ts`                    | generated models + resource clients                                                                    |
| `typescript/src/{http,errors,sse,client,index}.ts` | hand-written transport, error hierarchy, SSE reader, entry point                                       |
| `python/cat_factory/{models,operations}.py`        | generated                                                                                              |
| `python/cat_factory/{_http,_sse,errors,client}.py` | hand-written                                                                                           |
| `go/{models,operations}_gen.go`                    | generated                                                                                              |
| `go/{client,errors,sse}.go`                        | hand-written                                                                                           |
| `java/src/main/java/.../model/`, `.../resources/`  | generated (whole packages, wiped on regeneration)                                                      |
| `java/src/main/java/ai/catfactory/sdk/*.java`      | hand-written (`Transport`, `CatFactoryClient`, the exception hierarchy, `EventStream`, `PageIterator`) |
| `*/smoketest/`                                     | the per-SDK smoketest programs the cross-SDK harness drives                                            |

**The generator** is `scripts/sdk/` (`ir.mjs` → spec-to-IR, `surface.mjs` → the chosen public
shape, `emit-*.mjs` → one per language) driven by `scripts/generate-sdks.mjs`.

**Adding an endpoint to `/api/v1` requires an entry in `scripts/sdk/surface.mjs`** naming its
resource group and method; generation FAILS without one, so a new endpoint cannot ship as an
un-callable hole in four clients.

**Four cross-cutting invariants** every emitter and runtime honours, each a rule about being
honest with the caller rather than convenient: absent ≠ null; an unknown enum value or field
never raises (the surface is additive forever); the error CLASS comes from the HTTP status while
`code` is exposed verbatim (it carries surface-specific values this SDK deliberately does not
narrow); and only idempotent requests are retried. The reasoning is in `README.md`.

**See also:** `backend/internal/sdk-smoketest` (the cross-SDK parity harness, the only thing in
CI that can see the four clients DISAGREE), `backend/docs/adr/0030-public-api-surface.md`.
