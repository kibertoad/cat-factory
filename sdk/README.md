# cat-factory SDK clients

Official clients for the cat-factory **public API** (`/api/v1`) in four languages. The API itself
(keys, scopes, conventions, the full endpoint reference) is documented in
[`backend/docs/public-api.md`](../backend/docs/public-api.md); this file is about the clients.

> **Using them is documented on the website**:
> [Official SDKs](https://www.catfactory.ai/extend/sdks.html) owns getting a key, the guarantees
> every client makes to a caller, the Kotlin story, and pointing a client at localhost or a mock.
> This file is the CONTRIBUTOR half: the generation chain, what is generated versus hand-written,
> the cross-client smoketest, and how a release happens. A caller-visible rule changes on the
> website in the same PR.

| Language                   | Package                         | Registry                                 |
| -------------------------- | ------------------------------- | ---------------------------------------- |
| [TypeScript](./typescript) | `@cat-factory/sdk`              | npm                                      |
| [Python](./python)         | `cat-factory-sdk`               | PyPI                                     |
| [Go](./go)                 | `.../cat-factory/sdk/go`        | the module proxy (a `sdk/go/vX.Y.Z` tag) |
| [Java + Kotlin](./java)    | `ai.catfactory:cat-factory-sdk` | Maven Central                            |

Beside them, [`sdk/mcp`](./mcp) is a **Model Context Protocol facade**, not a fifth client: the same
operations projected as MCP tools over the TypeScript client, so an MCP host can drive a workspace
directly. It rides this generator for the same reason the clients do (it must not be able to drift
from the surface it exposes) and re-implements none of their behaviour. It serves BOTH access paths a
host can take: the `cat-factory-mcp` stdio binary, and the deployment's own hosted
`POST /api/v1/mcp`, which the backend mounts from this same package so the two cannot answer
differently. See [its README](./mcp/README.md).

Also beside them, [`sdk/gatekeeper`](./gatekeeper) (`@cat-factory/gatekeeper-bindings`) rides the
same generator as a **policy-annotated operation table** for credential-holding front-ends (the
Cloudflare OS Gatekeeper pattern; tracker:
`docs/initiatives/cloudflare-os-gatekeeper.md`): per-operation key-scope floors (from the spec's
`x-min-scope`, ranked against the ladder it publishes as `x-public-api-scopes`), mutation and
transport metadata, and invoke thunks over the TypeScript client using the MCP facade's argument
convention. It emits a second file beside the table, `session-types.generated.ts`: one TypeScript
method signature per operation, which a front-end composes into the `.d.ts` a granted capability
serves. See [its README](./gatekeeper/README.md).

[`sdk/gatekeeper-worker`](./gatekeeper-worker) (`@cat-factory/gatekeeper-worker`) is the ONE
package in this tree that the generator does not touch: the Gatekeeper Worker machinery itself,
hand-written on top of that table and the TypeScript client. It lives here rather than under
`deploy/` because it is a published library an outside deployment installs, and the split it makes
is the point: `deploy/gatekeeper` keeps the policy and the bindings an operator edits, this keeps
the capability surface, the Cloudflare OS object model in front of it, the key broker, the delivery
receiver and the approval inbox, so upgrading the second is a version bump rather than a re-merge of
the first. See [its README](./gatekeeper-worker/README.md).

There is **no separate Kotlin SDK**, and that is a decision rather than an omission: one artifact
serves both languages, and what it costs a Kotlin caller is stated plainly on the website's
[Kotlin section](https://www.catfactory.ai/extend/sdks.html#kotlin). A second codebase would have
to be kept in step release for release to buy null-safety the Java client already has.

## The one thing to know

**Models and operations are GENERATED. Transports are HAND-WRITTEN.**

```
Valibot route contracts ──► docs/openapi.json ──► sdk/{typescript,python,go,java}/
   (backend/packages/         (pnpm gen:openapi)     (pnpm gen:sdk)   sdk/mcp/  (tool table)
    contracts)
```

Nothing in that chain is hand-edited. A change to the `/api/v1` contracts flows to the spec and
then to all four clients, and `pnpm check:sdk` fails CI if the committed clients do not match what
the generator would produce.

What is generated is deliberately narrow: the wire **models** and the **operation methods**. Each
SDK's transport, error hierarchy, retry policy, pagination helper and SSE reader are hand-written
and live beside the generated files. That split is what keeps a contract change from rewriting
behaviour, and a behaviour fix from having to be re-applied across 66 operations × 4 languages.

Generated files are marked as such in their header and named so it is obvious:
`*.generated.ts`, `models.py` / `operations.py`, `*_gen.go`, and everything under the Java
`model` and `resources` packages.

### Regenerating

```sh
pnpm build           # the contracts package must be built first
pnpm gen:openapi     # contracts  -> docs/openapi.json
pnpm gen:sdk         # spec       -> the four SDKs
pnpm check:sdk       # the CI drift guard, runnable locally
```

The generator lives in [`scripts/sdk/`](../scripts/sdk): `ir.mjs` turns the spec into a
language-neutral intermediate representation, `surface.mjs` is the chosen public shape (which
resource client each operation is mounted on, and what the method is called), and one emitter per
language renders it.

**Adding an endpoint to `/api/v1` requires an entry in `surface.mjs`.** Generation fails without
one, so a new endpoint cannot ship as an un-callable hole in four SDKs. It becomes an MCP tool from
that same entry, with no second decision, except for an endpoint whose response a tool call has no
shape for (a STREAM, or a raw BYTE body), which must be named in `MCP_OMITTED_OPERATIONS` with the
reason a caller should read. Generation fails on an unclassified one.

**A request body with no required field is a parameter the caller may OMIT.** The IR reads that off
the spec (`required: []` on the body schema) rather than from a per-operation list, and each emitter
spells "omittable" in its own idiom: a `= {}` default in TypeScript, `| None = None` in Python, a
`*T` pointer in Go, and a real forwarding OVERLOAD in Java, which has neither defaults nor a way for
Kotlin to synthesise them. What is optional is the CALLER's obligation, never the wire: every client
sends `{}` when the argument is left out, because the route's validator parses a body against the
schema and rejects an absent one. A route that must ALSO tolerate a caller sending nothing (one that
gained its first optional field after shipping body-less, like `POST /notifications/:id/act`) mounts
the backend's `optionalJsonBody` middleware; that is a server-side decision, not something an emitter
can see. Everything after the body is keyword-only in Python for the same reason the rule exists: an
operation that later gains an optional body would otherwise rebind an existing positional `timeout`
onto it and send the timeout as the payload.

**A response body that is not JSON needs a branch in every emitter, not a default.** The IR marks
each operation `stream` (SSE) or `binary` (an artifact download) from the spec's own media type,
and each transport hands the body back in its language's idiom (`Uint8Array`, `bytes`, `[]byte`,
`byte[]`). A media type no emitter knows FAILS generation rather than falling through: the fallback
was a method that silently returned nothing, which compiles, ships, and discards the body a caller
asked for.

## Design rules the four share

The eight invariants each client implements in its own idiom (absent is not null, an unknown value
never raises, error class from the status and cause from `code`, only idempotent requests retried,
no stream auto-reconnect, the deadline bounding the response rather than a stream, pagination
ending on the cursor, no dependencies we do not need) are stated for callers on the website:
[Official SDKs → What every client guarantees](https://www.catfactory.ai/extend/sdks.html#what-every-client-guarantees).

They are listed there rather than here because they are PROMISES to a caller, and a promise
documented only where contributors read it is one nobody can hold us to. What belongs here is the
consequence for a change: each is implemented four times, so relaxing one in a single emitter is a
divergence the smoketest below is built to catch, and the Java client's JSpecify annotations are a
`compile`-scope dependency on purpose, since a consumer without them silently falls back to Kotlin
platform types and loses exactly the thing they exist for.

## Smoketests

[`backend/internal/sdk-smoketest`](../backend/internal/sdk-smoketest) boots a real Node backend
(real Postgres, real pg-boss, only the LLM/agent side faked), mints an `admin` and a `read`
public-API key, and drives the **same scenario** through all four clients, then compares their
observation reports field by field.

The comparison is the point. A per-SDK test can only assert that a client matches what its own
author expected; four reports compared against each other catch one language decoding a field
differently, mapping a refusal to the wrong class, dropping a null, or paginating one page
short, including when nobody had written down what the right answer was.

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cat_factory_test \
  pnpm --filter @cat-factory/sdk-smoketest run smoketest

# while iterating on one client:
DATABASE_URL=... pnpm --filter @cat-factory/sdk-smoketest run smoketest -- --only=go
```

CI runs it whenever either side of the contract moves: the SDKs and their generator, or the
`/api/v1` contracts and controllers they talk to.

### Per-SDK unit tests

Each SDK also has its own tests for the **hand-written** half, above all the four independent SSE
readers, whose framing bugs (a read boundary landing mid-record, a terminal frame arriving as the
socket closes) show up in production as a run that silently appears to stall, and which the
smoketest structurally cannot provoke:

```sh
pnpm --filter @cat-factory/sdk run test:run    # TypeScript
cd sdk/go     && go test ./...
cd sdk/java   && mvn -B test
cd sdk/python && python -m pytest tests -q
```

## Releasing

The TypeScript SDK is an ordinary workspace package: **changesets** versions and publishes it with
everything else.

The other three publish from [`.github/workflows/sdk-release.yml`](../.github/workflows/sdk-release.yml),
gated on a **version change** rather than a file change, so a README edit or a no-op
regeneration ships nothing and a re-run cannot try to republish a version the registry already
has. Bumping the version in `sdk/python/pyproject.toml`, `sdk/java/pom.xml` or
`sdk/typescript/package.json` (which the Go module tracks) and merging to `main` **is** the
release action.

`pnpm check:sdk` also fails on version skew between a manifest and the constant its transport
stamps into `User-Agent`, so a release cannot half-happen.
