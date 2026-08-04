# cat-factory SDK clients

Official clients for the cat-factory **public API** (`/api/v1`) in four languages. The API itself
(keys, scopes, conventions, the full endpoint reference) is documented in
[`backend/docs/public-api.md`](../backend/docs/public-api.md); this file is about the clients.

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

There is **no separate Kotlin SDK**, and that is a decision rather than an omission; see
[Java and Kotlin](#java-and-kotlin) below.

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
that same entry, with no second decision — except for a STREAMING endpoint, which a tool call has
no channel for and which must therefore be named in `MCP_OMITTED_OPERATIONS` with the reason a
caller should read. Generation fails on an unclassified one.

## Design rules the four share

These are the invariants each SDK implements in its own idiom. Every one of them is a rule about
being HONEST with the caller rather than convenient:

- **Absent ≠ null.** A field that may not be sent and a field that is always sent but may hold
  null are different facts, kept apart everywhere: `?` vs `| null` in TypeScript, the docstring
  and encoder in Python, a pointer plus `omitempty` (or its absence) in Go, `@Nullable` plus a
  per-component `@JsonInclude` in Java. Collapsing them turns "leave this alone" into "clear it"
  on a request, and "the server had no value" into "the server said nothing" on a response.
- **An unknown value never raises.** `/api/v1` is additive forever, so a deployment will send
  enum values and object fields an older SDK has never heard of. Every client decodes them
  rather than failing; otherwise every additive server release is an outage for anyone who has
  not upgraded. Unknown fields are even retained where the language allows it (Python's `extra`,
  Go's raw union body).
- **Error CLASS comes from the HTTP status; the CAUSE comes from `code`.** `code` carries two
  families of value on this surface (status-class codes and surface-specific ones like
  `insufficient_scope` or `too_many_active_runs`), and new ones appear without a major version.
  So the status picks the exception type and `code` is exposed verbatim as a plain string. No SDK
  narrows it to a closed enum, and none of them keeps a copy of the vocabulary; the authoritative
  list is in [the API guide](../backend/docs/public-api.md#the-error-envelope).
- **Only idempotent requests are retried.** `POST /jobs` and `POST /tasks/:id/start` cost
  real LLM work, and a duplicate is not something an SDK may risk on the caller's behalf. A
  transport failure with no response says nothing about whether the server acted.
- **Streams are never auto-reconnected.** A reconnect replays the SSE stream from its start, and
  only the caller knows which events it has already acted on.
- **The client deadline bounds the RESPONSE, never a stream.** On an ordinary request it covers
  the whole exchange, body included. On an SSE stream it stops once the response headers arrive,
  because there the body IS the stream: the deployment writes a frame only when a run's projection
  changes and sends no heartbeat, and a run parked on a human decision waits indefinitely by
  design. A quiet stream is therefore the normal state of a healthy one, and a deadline running
  over it aborts exactly the runs a caller most wants to watch. A stream is bounded by the caller closing
  it (or their own context/signal), and above that by the deployment's connection cap.
- **Pagination ends on the CURSOR, not on an empty page.** A keyset page may legitimately arrive
  empty with a cursor still set. A server that answers with the cursor it was just given is a
  server fault: every SDK raises rather than following it, because looping forever and stopping
  silently are both worse than saying so.
- **No dependencies we do not need.** Python has none at all (`urllib`), Go none (`net/http`),
  TypeScript none (`fetch`), Java exactly one (Jackson) plus compile-time annotations. A client
  library's dependencies become every consumer's dependencies.

## Java and Kotlin

**One artifact serves both languages.** A Kotlin-specific SDK would have to be a second codebase
kept in step release for release, and the thing it would actually buy (real null-safety instead
of Kotlin's unchecked platform types) can be bought outright by annotating the Java one.

To be precise about what is and is not possible here: Kotlin's own metadata
(`@Metadata`) is emitted by the Kotlin compiler and describes Kotlin declarations; it cannot be
synthesised onto Java sources, and forging it produces a jar the Kotlin compiler mis-reads rather
than one it understands. What _can_ be added is the metadata Kotlin actually **reads** from a
Java library, and that is what the Java SDK does:

| Choice                                                         | The Kotlin failure it removes                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JSpecify `@NullMarked` package + `@Nullable` per component** | Without it every reference is a PLATFORM type (`String!`) and Kotlin's null-checking is simply off; an NPE surfaces at the first dereference instead of at the call. With it, `task.pullRequestUrl` is `String?` and `task.title` is `String`. |
| **Kotlin hard keywords escaped** (`public` → `isPublic()`)     | `PublicPipeline.public` is a keyword in both languages. The accessor is renamed and `@JsonProperty("public")` keeps the wire name, so neither language needs backticks.                                                                        |
| **Builders, not telescoping constructors**                     | Kotlin cannot see Java default arguments (Java has none). A builder reads naturally from both, and composes with Kotlin's `apply { }`.                                                                                                         |
| **Unchecked exceptions only**                                  | Kotlin has no checked exceptions, so a `throws` clause would be invisible to Kotlin and pure ceremony for Java.                                                                                                                                |
| **Sealed error hierarchy**                                     | A Kotlin `when` over failure classes is exhaustive with no `else`; the same for a Java 21 `switch` pattern.                                                                                                                                    |
| **Enums tolerate unknown values**                              | A strict enum would throw on a value a newer deployment legitimately sends.                                                                                                                                                                    |
| **`-parameters` in the bytecode**                              | Parameter names are meaningful at the call site rather than `p0`, `p1`.                                                                                                                                                                        |

```kotlin
val client = CatFactoryClient.builder()
    .baseUrl("https://cat-factory.example.com")
    .apiKey(System.getenv("CAT_FACTORY_API_KEY"))
    .build()

val service = client.services().list().services.first()
val task = client.tasks().create(
    service.serviceId,
    CreatePublicTask.builder().title("Add a health check").build(),
)
val pr: String? = task.pullRequestUrl   // nullable, and the compiler knows it

when (val decision = client.decisions().list(runId).decisions.first()) {
    is PublicRequirementsDecision -> handleRequirements(decision)
    is PublicForkDecision -> handleFork(decision)
    is PublicJudgeDecision -> handleJudge(decision)
    is PublicInputGateDecision -> handleInputGate(decision)
}                                        // exhaustive: the interface is sealed
```

**What a Kotlin caller does not get**, stated plainly rather than papered over: the models are
Java records, so there is no `copy()` and no destructuring, and named arguments do not work on
Java methods (the builders cover the same ground). Both are cosmetic beside null-safety, and
neither justifies a second artifact.

JSpecify is a `compile`-scope dependency on purpose, not `provided`: Kotlin reads the annotations
off the classpath, so a consumer without it would silently fall back to platform types and lose
exactly the thing this design exists for.

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

## Pointing an SDK at localhost or a mock

**Yes: `baseUrl` takes any origin, and no SDK validates the scheme.** `http://localhost:8787`, a
recorded-fixture server, a WireMock/MSW/`responses` double, a preview deployment: all fine. The
cross-SDK smoketest is itself the proof, driving all four against `http://127.0.0.1:<port>`.

| Language   | Base URL                                    | Inject your own transport         |
| ---------- | ------------------------------------------- | --------------------------------- |
| TypeScript | `new CatFactoryClient({ baseUrl, apiKey })` | `fetch:` (an MSW handler, a stub) |
| Python     | `CatFactoryClient(base_url=…, api_key=…)`   | `opener=` (a `urllib` opener)     |
| Go         | `catfactory.New(Options{BaseURL: …})`       | `HTTPClient:` (an `*http.Client`) |
| Java       | `CatFactoryClient.builder().baseUrl(…)`     | `.httpClient(…)`                  |

Two things to know when the target is a local mock:

- **The Java client drops to HTTP/1.1 for cleartext origins on purpose.** `java.net.http`'s default
  is HTTP/2, which over `http://` sends an h2c upgrade header on every request; a mock server that
  does not speak h2c is entitled to reject it, and the real Node facade answers such a request with
  a **404 for a route that exists**. Over `https://` the negotiation is ALPN, so HTTP/2 is kept.
- **The key is never inspected client-side**, so a mock needs no real key: any non-empty string
  works. Only `baseUrl` and `apiKey` being non-empty are validated, and only to fail early rather
  than send an unauthenticated request.

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
