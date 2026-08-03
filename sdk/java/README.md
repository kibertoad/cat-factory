# cat-factory Java (and Kotlin) SDK

Client for the cat-factory **public API** (`/api/v1`). **One artifact serves both Java and
Kotlin**; see [Kotlin](#kotlin) for what that means and what it costs.

```xml
<dependency>
  <groupId>ai.catfactory</groupId>
  <artifactId>cat-factory-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

```kotlin
implementation("ai.catfactory:cat-factory-sdk:0.1.0")
```

Java 21+. One runtime dependency (Jackson) plus JSpecify's annotations; the HTTP stack is
`java.net.http` from the JDK.

## Java

```java
CatFactoryClient client = CatFactoryClient.builder()
        .baseUrl("https://cat-factory.example.com")
        .apiKey(System.getenv("CAT_FACTORY_API_KEY"))
        .build();

PublicService service = client.services().list().services().get(0);
PublicTask task = client.tasks().create(
        service.serviceId(),
        CreatePublicTask.builder()
                .title("Add a health check endpoint")
                .taskType("feature")
                .build());
client.tasks().start(task.taskId(), StartPublicTask.builder().build());
```

## Kotlin

The same artifact, with **real null-safety**: the model and resource packages are JSpecify
`@NullMarked`, so Kotlin infers actual nullable types rather than unchecked platform types:

```kotlin
val client = CatFactoryClient.builder()
    .baseUrl("https://cat-factory.example.com")
    .apiKey(System.getenv("CAT_FACTORY_API_KEY"))
    .build()

val service = client.services().list().services.first()
val task = client.tasks().create(
    service.serviceId,
    CreatePublicTask.builder().title("Add a health check endpoint").build(),
)

val pr: String? = task.pullRequestUrl   // nullable - the compiler knows
val title: String = task.title          // non-null - the compiler knows that too

// The decision union is a SEALED interface, so this is exhaustive with no `else`:
when (val decision = client.decisions().list(runId).decisions.first()) {
    is PublicRequirementsDecision -> handleRequirements(decision)
    is PublicForkDecision -> handleFork(decision)
    is PublicJudgeDecision -> handleJudge(decision)
}
```

**Why there is no separate Kotlin SDK.** Kotlin's own metadata (`@Metadata`) is emitted by the
Kotlin compiler and describes Kotlin declarations; it cannot be synthesised onto a Java jar. But
the metadata Kotlin _reads_ from a Java library can be, and that removes nearly every reason
to maintain a second client:

- **JSpecify `@NullMarked` + `@Nullable`**: the big one. Without it Kotlin's null-checking is
  off across the SDK and an NPE surfaces at the first dereference instead of at the call.
- **Kotlin hard keywords are escaped.** `PublicPipeline.public` is a keyword in both languages;
  the accessor is `isPublic()` and `@JsonProperty("public")` keeps the wire name, so neither
  language needs backticks.
- **Builders rather than telescoping constructors**, since Kotlin cannot see Java default
  arguments (Java has none). They compose with `apply { }`.
- **Unchecked exceptions only**: Kotlin has no checked exceptions.
- **A sealed error hierarchy**, so a `when` over failure classes is exhaustive.
- **Enums tolerate unknown values**, so a newer deployment cannot break decoding.
- **`-parameters` in the bytecode**, so parameter names are meaningful at the call site.

**What Kotlin does not get**, stated plainly: the models are Java records, so no `copy()` and no
destructuring; and named arguments do not work on Java methods (the builders cover that ground).
Both are cosmetic beside null-safety, and neither justifies a second artifact that would have to
be kept in step release for release.

If you declare dependencies transitively-pruned (some Gradle setups do), keep **JSpecify on the
compile classpath**: Kotlin reads the annotations from there, and without it you silently fall
back to platform types.

## Resource clients

`initiatives()`, `services()`, `tasks()`, `pipelines()`, `notifications()`, `usage()`,
`decisions()`, `debug()`: one per tag of the published OpenAPI surface. Every call is scoped to
the key's workspace.

## Watching a run

```java
try (EventStream stream = client.tasks().stream(taskId)) {
    for (StreamEvent event : stream) {
        if (event.event().equals("decision")) {
            // The run PARKED on a human decision and waits indefinitely. Answer it through
            // client.decisions() (needs a `decide`-scope key) or free it with tasks().stop().
        }
        if (event.event().equals("done") || event.event().equals("error")) break;
        // `timeout` means the deployment's connection cap was reached, NOT that the run finished.
    }
}
```

## Paging

```java
Iterator<PublicTask> tasks = client.tasks().listByServiceAll(serviceId);
while (tasks.hasNext()) {
    System.out.println(tasks.next().taskId());
}
```

Pages lazily, following `nextCursor` until the server reports no further page.

## Errors

The exception CLASS comes from the HTTP status; `code()` carries the specific cause and is a plain
`String`, because this surface adds new codes without a major version.

```java
try {
    client.tasks().get(taskId);
} catch (CatFactoryNotFoundException exc) {
    return null;
} catch (CatFactoryForbiddenException exc) {
    if ("insufficient_scope".equals(exc.code())) {
        throw new IllegalStateException("this key needs a higher scope", exc);
    }
    throw exc;
}
```

`CatFactoryApiException` carries `status()`, `code()`, `details()`, `issues()` and the
`requestId()` to quote when reporting a fault. The hierarchy is sealed and every member is
unchecked.

`CatFactoryApiException` is itself a case, not just a base: a status with no subclass of its own
(a 402, a 413, or one this surface gains later) arrives as the base class rather than being
folded into `CatFactoryServerException`. The surface is additive forever, and reporting a refusal
the caller caused as a deployment fault would send them to look at the wrong system. So a Kotlin
`when` over the hierarchy needs a branch for the base type (or an `else`), and that branch is the
right place to read `status()` directly.

## Options

```java
CatFactoryClient.builder()
        .baseUrl(baseUrl)
        .apiKey(apiKey)
        .timeout(Duration.ofSeconds(30))
        .maxRetries(2)              // idempotent requests only - a POST is never auto-retried
        .header("x-tenant", "acme")
        .userAgent("my-integration/1.2.3")
        .httpClient(myHttpClient)   // a proxy, a custom SSL context, a shared pool
        .build();
```

The default `HttpClient` picks its protocol by scheme: HTTP/2 for `https` (negotiated by ALPN)
and HTTP/1.1 for cleartext. That is not incidental: over cleartext, `HttpClient`'s default
HTTP/2 sends an h2c upgrade on every request, and a server that does not speak h2c may answer
with a 404 for a route that exists. Supply your own client to override.

## Local development and mocks

The base URL takes any origin (`http://localhost:8787`, a fixture server, a mock) and no scheme
validation is applied. Each client also accepts a custom transport, so you can intercept in-process
instead. See [the SDK guide](../README.md#pointing-an-sdk-at-localhost-or-a-mock).

## Notes

- Everything under `model/` and `resources/` is generated from `docs/openapi.json`; see
  [`../README.md`](../README.md).
- API reference: [`backend/docs/public-api.md`](../../backend/docs/public-api.md).
