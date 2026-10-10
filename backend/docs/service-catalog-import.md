# Service-catalog import: a developer portal as a third supply route

How a workspace points the platform at the developer portal its organisation already runs
(Backstage today) and gets that portal's services in front of agents.

The internal design; what an operator has to do is
[catfactory.ai](https://www.catfactory.ai)'s to describe. The catalog these services land in is
[ADR 0031](./adr/0031-foundational-services.md), which this document assumes.

## The decision: it feeds the EXISTING catalog

A Backstage import writes ordinary `workspace`-tier **foundational services**. It is a third
supply route beside a direct upload and a linked git repo, not a second agent-facing catalog.

That is the whole design, and the alternative is what makes it worth stating. A parallel
mechanism would have meant a second `.cat-context/` directory, a second set of trait guidance, a
second tiered merge and a second suppression surface, all describing the same organisation's
services to the same agents. An agent told about a service twice, once per mechanism, is the
accretion this reuse avoids. So everything downstream is untouched:

| What                       | Where it comes from                                                            |
| -------------------------- | ------------------------------------------------------------------------------ |
| the design-time catalog    | `foundational-catalog` trait → `.cat-context/foundational-services/catalog.md` |
| the full API documents     | `foundational-contracts` trait, for the ids a design declared                  |
| the orientation read       | `service-estate` trait → `.cat-context/foundational-services/estate.md`        |
| the tiered merge, opt-out  | unchanged: an imported row is a `workspace`-tier row                           |
| the SPA management surface | unchanged: the catalog list shows imported services beside uploaded ones       |

Imported services carry `sourceId: 'service-catalog'`, which is what separates them from a
workspace's hand-registered and repo-sourced entries. The reconcile diffs against that alone, so
an import never tombstones a service it did not produce.

## Who reads it, and the trait that is NOT the design one

The ask this feature answers is a triage agent working out which service a report belongs to. That
is a different job from an Architect choosing a shared capability, and it gets a different trait.

`service-estate` (`@cat-factory/agents`) delivers the same rows under an orientation framing:
ownership first, the interface surface after it, and nothing to declare back. It is not a reuse of
`foundational-catalog` because that trait's guidance asks the kind to prefer consuming a shared
service and to END its reply with a machine-read declaration block. Both are wrong for a triager,
and the second is actively harmful: `bug-investigator` and its peers are structured-output kinds
whose reply IS a JSON object, so appending "end your reply with a fenced block" would put their
own contract in conflict with itself.

The built-ins carrying it are `bug-investigator` and `on-call`. A deployment's own kind opts in
through `registerAgentKind({ traits })`.

**The estate read deliberately carries no contract DOCUMENTS.** It states each service's identity,
ownership, capability tags and the operation index of every interface it publishes; the full
documents stay behind a design's declaration. That is the catalog/contracts split ADR 0031 exists
for, applied to a read that happens on every triage dispatch: folding every service's OpenAPI
document into one would make the prompt scale with the size of the organisation's specs rather than
with the number of its services. A kind that genuinely needs a document carries
`foundational-contracts` and reads the ids a prior design declared.

## Authentication: the shapes a self-hosted portal actually runs behind

A closed vocabulary (`ServiceCatalogAuthMode`), because each member needs a different request
built. Free-form headers alone would have covered the mechanics and lost every remedy an operator
needs when one fails.

| Mode                        | What the platform sends                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `static-token`              | `Authorization: Bearer <token>`, from Backstage's `backend.auth.externalAccess`     |
| `legacy-shared-secret`      | a short-lived HS256 JWT the platform MINTS per pass, signed with the decoded secret |
| `oauth2-client-credentials` | a token fetched from the IdP, then sent as a bearer                                 |
| `basic`                     | `Authorization: Basic …`, for a reverse proxy in front of the portal                |
| `headers`                   | up to five named headers, for a gateway that authenticates on its own               |
| `none`                      | nothing, for an instance reachable only inside a VPN                                |

Four things about this are load-bearing:

- **The legacy secret is base64-DECODED into key bytes.** That is how the vendor derives its own
  key and how its documentation has operators generate the value. Signing with the raw characters
  of a base64 secret produces a different key, so the choice decides whether the token verifies at
  all. A secret that is not base64 is REFUSED rather than falling back to its raw bytes: the two
  readings of one string are indistinguishable, so a fallback would sign with the wrong key and
  surface as a 401 blaming the credential.
- **`headers` takes a LIST.** The common case needs two: a Cloudflare Access service token is
  `CF-Access-Client-Id` plus `CF-Access-Client-Secret`, and a single-pair shape would have sent
  half a credential.
- **The bearer modes resolve ONCE per import pass**, not per page. There is deliberately no token
  cache: the only places one could live are a module global (banned) and a per-isolate map workerd
  may discard between invocations, and a pass is exactly the scope over which one token is both
  sufficient and safe.
- **`none` seals nothing**, and stores the empty string. An unauthenticated portal has no secret,
  so a deployment whose `ENCRYPTION_KEY` drifted must keep working against it; sealing a
  placeholder would make the one mode with no credential the one that fails on a key problem.

## The URL guard: widening it is the ORDINARY case

The portal base URL and any OAuth token endpoint go through the shared SSRF guard against the
deployment's own `UrlSafetyPolicy` (`SERVICE_CATALOG_ALLOW_URL_HOSTS` /
`SERVICE_CATALOG_ALLOW_HTTP_URLS`), scoped to this integration alone. A self-hosted portal usually
lives on an internal host, so with the strict default the connection is refused at the write
boundary rather than failing later at fetch time.

Redirects are followed BY HAND and re-checked on every hop, and a cross-origin hop drops the body
and the `Authorization` header. The base URL is operator-supplied, so a permitted first host could
otherwise 302 a credential-bearing request at a link-local metadata address.

## Two requests per import, never one per service

The listing runs against `/api/catalog/entities/by-query` with a `fields` projection that leaves
out `spec.definition`; the definitions come back from ONE batched
`POST /api/catalog/entities/by-refs` per chunk of references. A per-service definition fetch would
be a textbook N+1 against someone else's server, and an API entity's definition is the large half
of the payload.

The by-refs answer is positional against the refs asked for, and is read by index: the vendor
answers null for an entity that does not exist or that this credential may not read, and reading by
index is what keeps a null attributed to the reference that produced it.

## Mapping: composed prose, not a column per portal attribute

A portal carries a dozen useful attributes (owner, system, domain, lifecycle, type, links,
TechDocs, source location). They are composed into the service's `description` as labelled lines
with the entity's own prose after them, rather than each becoming a column.

The ORDER is the load-bearing part: ownership is what a triage reader needs first and what a cap
must never drop, so the facts come before the free text and the truncation falls on the prose.

Two rules the mapping enforces:

- **The service id prefixes a non-default namespace.** Backstage namespaces exist precisely so two
  teams can both own an `api` component, and slugging on the name alone would collapse them onto
  one catalog entry, silently, in favour of whichever the portal paged first. A collision that
  survives anyway is counted as a skipped entity, with the FIRST occurrence winning, because an
  import has to be stable across passes.
- **A RESERVED platform capability tag is dropped.** `asset-storage` makes a service selectable as
  a binary-output step's storage target, so accepting it from an external portal would enrol a
  component into a platform capability nobody at this deployment chose. A near-miss of a reserved
  tag goes the same way, since importing it would put a tag in the catalog that reads as the
  reserved one and behaves as nothing.

### Interface formats

The contract-format vocabulary gained `asyncapi`, `graphql` and `grpc` for this import, because an
organisation's catalog routinely describes a queue consumer beside its HTTP services. Only
AsyncAPI is INDEXED (it is JSON/YAML, so its channels or operations are a parse rather than a
guess); GraphQL SDL and protobuf answer through `operationsAreIndexable` as formats nobody reads,
which is a different statement from "declares nothing" and is rendered as such.

A portal type the platform serves no format for (`trpc`, `sql`, anything an organisation invents)
is reported as a SKIPPED interface rather than stored as OpenAPI. Storing it under a format it is
not would produce a contract that fails the parse and lists zero operations, which reads to an
Architect as a fully-specified service that publishes nothing.

The two new formats also changed what a SCAN of a linked repository picks up, and there the
extension alone is not enough to conclude anything. A `.gql` file is far more often a client's
`query` text than a schema, and a `.proto` is routinely a vendored or generated file of message
shapes with no RPCs at all; neither is an interface the owning service publishes. So
`detectContractFormat` requires a type-system definition of a GraphQL document and a `service`
block of a protobuf one (`isGraphqlSchemaDocument` / `isGrpcServiceDocument`), and the candidate
test stays by extension because a file has to be READ before its content can refuse it. Upload
validation asks a different question and is unchanged: there a human declared the format.

## Degrading loudly

An import's verdict is stamped on the connection, and three values are kept apart:

- **`ok`**: everything the filter matched arrived, with nothing dropped.
- **`partial`**: the catalog holds real services and not all of them. Truncated by the cap,
  entities that yielded no usable identity, interfaces with no storable definition, or services the
  import REFUSED to write (below). An `empty` filter match lands here too rather than in `ok`,
  because a filter that matched nothing is a configuration problem with a remedy and reporting it as
  a healthy import of zero services is exactly how a workspace comes to believe its estate is empty.
- **`failed`**: the import could not complete. Stamped BEFORE the error propagates, so a workspace
  whose portal has been unreachable for a week does not show the last pass that worked. Nothing is
  tombstoned: an unreachable portal and an empty one are opposite facts.

`lastSyncMessage` carries the sentence a human has to act on, and is NULL for a clean pass. Filling
it on every success is how the one pass that needs reading stops standing out.

**Every failure past the connection lookup is stamped, not only a transport one.** `lastSyncedAt` is
what the autorefresh sweep orders on and it sorts nulls first, so a fault that fires BEFORE the
portal is contacted (a credential bag that will not open) would otherwise pin that connection to the
head of the stale queue forever and occupy the whole bounded batch on every pass, starving every
other workspace with nothing failing anywhere. The stamp is best-effort, so a failing stamp cannot
replace the fault it is recording.

**Three counts, because they have three different remedies.** `skippedServices` is an entity the
PORTAL describes in a way this platform cannot use. `skippedApis` is a declared interface that was
not stored, counted per DISTINCT interface (an interface three components provide and this pass
could not resolve is one loss, not three) and including one dropped because another interface of the
same service already claimed its id. `skippedConflicts` is a portal service whose id the workspace
already registers by another route: the import YIELDS, because an upsert would replace a
hand-authored row, delete its uploaded contracts, strip any platform capability it was granted, and
then hand it to the disconnect path to tombstone.

**An over-large answer is OUR limit, and says so.** A batched by-refs request carrying fifty large
definitions can legitimately exceed what the platform will buffer. Read with a truncating cap that
arrives as a JSON document cut mid-token and is then reported as "the portal answered with a body
that is not JSON", blaming someone else's server; the success path therefore throws
`service_catalog_response_too_large`, whose copy names the two settings that shrink the response.
The error path still truncates, because there the body is quoted as an excerpt and never parsed.

## Deployment shape

- **One connection per workspace**, like every other sealed vendor connection. That is also what
  makes it work in mothership mode: the credential bag travels as ciphertext over the persistence
  RPC and is opened by NAMING the row through `service_catalog_connection`, which is workspace-keyed
  by construction.
- **`updateSyncState` is its own narrow write.** An import must be able to record its verdict
  without rewriting the credential envelope it just read through, which on a mothership-mode node
  it holds no key to re-seal.
- **Autorefresh** holds a connection's import to a six-hour staleness window
  (`sweepServiceCatalogs`), longer than the repo-source sweep's hour: a repo source's refresh is one
  conditional head-commit read, and a portal import has no equivalent cheap probe, so every pass
  pages the matching estate. **The window is not the pass's period.** Firing once per window caps a
  whole deployment at one bounded batch per six hours, so any deployment with more connected
  workspaces than the batch could never keep them fresh however long it ran, and each extra
  workspace pushed the others further behind. `SERVICE_CATALOG_SWEEP_PERIOD_MS` is the cadence
  (four batches an hour, matching the repo-source sweep's throughput) and a pass with nothing stale
  costs one indexed query.
- **A whole-estate write is BATCHED.** `upsertMany` / `replaceForServices` /
  `softDeleteByIds` / `deleteForServices` exist because reconciling a thousand-service estate one
  row at a time is two thousand sequential round trips inside one request: a D1 subrequest budget on
  the Worker and a write storm on Node. Each service's contract delete and inserts still land
  together, so a reader never sees a service whose interfaces have vanished.
- **Disconnecting TOMBSTONES what the portal produced.** Leaving the rows would keep handing agents
  an estate nothing refreshes and nothing can explain the provenance of, which is worse than an
  empty catalog because it still reads as current.

## Where the code is

| Layer                       | Files                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- |
| wire contracts              | `contracts/src/service-catalog.ts`, `contracts/src/routes/service-catalog.ts`   |
| ports (vendor-NEUTRAL)      | `kernel/src/ports/service-catalog.ts`, `…/service-catalog-repositories.ts`      |
| the Backstage adapter       | `integrations/src/modules/serviceCatalog/`                                      |
| the importer (neutral)      | `agents/src/foundationalServices/ServiceCatalogSyncService.ts`                  |
| the estate render + formats | `kernel/src/domain/foundational-services.ts`                                    |
| HTTP + the sweep            | `server/src/modules/serviceCatalog/`                                            |
| stores                      | D1 migration `0097`, `runtimes/node/src/repositories/drizzle/serviceCatalog.ts` |

The neutral/vendor split is the same one `ReleaseHealthProvider` draws around Datadog: everything
that knows what Backstage calls a service, an owner or an API definition lives in the adapter, so a
second portal product is a second adapter rather than a branch inside the import.
