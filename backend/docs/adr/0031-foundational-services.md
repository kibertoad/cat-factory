# ADR 0031: Foundational services; a shared-capability catalog designs consume instead of rebuilding

- **Status:** Accepted (implemented)
- **Date:** 2026-08-01
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/server`,
  `@cat-factory/integrations`, both runtime facades) + the SPA

Supersedes the `foundational-services` initiative tracker, whose committed scope is complete.

## Context

The platform already knew a great deal about the service being built (its repo, its spec, its
standards) and nothing at all about the systems it must talk to. That produced the most expensive
avoidable rework in the loop: an architect proposes an in-house upload endpoint beside a
file-storage service the org has run for years, and nothing downstream can catch it, because
nothing downstream knows the service exists. Worse, when a design DID name a shared service, the
implementer had no contract for it and invented an API that then had to be unwound in review.

## Decision

A **foundational service** is a registered shared capability carrying an id (a lower-kebab slug:
the name an Architect writes in its design), a name, a one-line summary, a general description,
capability tags, and zero or more **API contracts**: an OpenAPI 3.x document, a
`@toad-contracts/core` module or a `@lokalise/api-contract` module.

Registration is **tiered**, exactly like the prompt-fragment library: a `builtin` definition the
DEPLOYMENT registers in code is shared by every account, an `account` row wins over it for every
workspace in that account, and a `workspace` row of the same id wins over both. A tombstone at
either stored tier SUPPRESSES what that tier inherits, which is how a board opts out without an
account admin and how an account opts out without a code change.

The `builtin` tier is the app-owned `FoundationalServiceRegistry`
(`kernel/src/domain/foundational-service-registry.ts`), newed at the composition root and injected
through `CoreDependencies.foundationalServiceRegistry` exactly like `PipelineRegistry` /
`TaskTypeRegistry`. It holds no rows: `resolve` reads it on every merge, so a deployment's estate
is present from a workspace's FIRST request and cannot drift from the definitions that declare it.

Registering in code rather than provisioning over REST is what buys the boot check: a stored row
was refused at the moment someone wrote it, while a code definition has no such moment, so
`validateRegistrations` holds each one to the SAME `createFoundationalServiceSchema` and the same
document checks the write boundary applies (`foundationalServiceDefinitionIssues` +
`validateFoundationalDefinition`). A deployment cannot register what it could not have uploaded.

Contracts arrive two ways, and both are served: **direct upload** (the document body on the
request, validated at the write boundary against the format it declares), and **a linked git
repo**, in one of three shapes. All are cached in our own store and auto-refreshed. A `builtin`
service's documents live in the definition, which is a third supply route in the trivial sense and
no new plumbing: the registry projects them through the same `summarizeContract` and hands them to
the same lazy read.

**A contract set is validated as a SET, not document by document.** A `@toad-contracts/core`
contract is a module GRAPH (the `defineApiContract` module plus the schema modules it imports)
and only the first names the library. The rule is therefore that a set declared as a format must
contain at least one document referencing that library, per format; the modules it imports register
as what they are. Validating per document refused exactly the halves of one contract that are not
its entry point, which left a registrant concatenating source files to get past the boundary.

The repo path gets the same treatment in `files` mode ONLY, where the link is an explicit list a
human wrote and therefore plays the role the `format` field plays on an upload: a linked module
that references no library rides under the format the rest of the set resolved to. It is decided
over every readable file rather than left to right, since a link may list the schemas first, and it
declines to guess when the set mixes two libraries. `folder` and `directory` scans keep the
content-led rule unchanged: they walk paths nobody named, and one recursive link would otherwise
sweep a repo's TypeScript into an agent's context as "contracts".

| Source mode | What it maps to                                                                                        | Where identity comes from        |
| ----------- | ------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `directory` | every immediate SUBDIRECTORY of the path is a service, with a `service.md` and its contracts beside it | the subdirectory name + manifest |
| `folder`    | the WHOLE path (optionally its subfolders) is ONE service's contract set                               | the link                         |
| `files`     | an explicit FILE list attached to ONE service                                                          | the link                         |

`folder` and `files` differ in WHEN the file set is decided, and that is the whole reason both
exist: a `files` link pins the paths, so a contract added upstream stays invisible until somebody
edits the link, while a `folder` link re-discovers the set on every sync. Pointing at a folder is
therefore the right shape for a spec directory that grows, and naming files is the right shape for
picking two documents out of a repo that is mostly something else.

A `folder` source's walk is BOUNDED (depth, directories listed, contract files taken, and the size
of any one file) and breadth-first over name-sorted listings, which buys two properties at once: the
result is deterministic across syncs, so a truncated scan keeps the same contracts rather than
flapping, and the cap falls on the deepest, least-specific files rather than on a root-level
`openapi.yaml`.

How much of the folder the walk covered is REPORTED on the sync result as `folderScan`, one of
`complete` / `truncated` / `missing` (null for the modes that walk nothing: a `files` source did
not scan a folder completely, it never scanned one). It is a discriminated value rather than a pair
of booleans because the three states are mutually exclusive, each needs a different fix from
whoever linked the source, and each carries a different disposition inside the sync (below).
Beside it, `skippedFiles` counts documents that LOOKED like contracts and were not usable; a file
that could never be one, no contract extension, or a package/lockfile/compiler manifest whose name
is fixed by a tool, is never read and never counted, so the number explains a thin catalog entry
instead of restating the folder's contents. Contract ids inside a `folder` source are derived from
the path RELATIVE to the folder root (`v1/users.yaml` → `v1-users`), because a recursive scan is
exactly where the basename rule collapses `v1/users.yaml` and `v2/users.yaml` onto one id and
silently drops one of them.

A `folder` source may also carry an OPTIONAL `service.md` at its root. It supplies the description
and capability tags only, never the id or name, which the link already gave, so identity keeps
exactly one source while a folder that happens to follow the `directory` convention is not left
with a blank catalog entry.

### The two agent-facing reads, and why they are separate

This is the feature's load-bearing design decision.

| Read          | Who gets it                                                              | What it carries                                                                                                        |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Catalog**   | kinds carrying the `foundational-catalog` trait: the `architect`         | id, name, summary, description, capability tags, and each contract's format + operation names. **No document bodies.** |
| **Contracts** | kinds carrying the `foundational-contracts` trait: `researcher`, `coder` | the FULL contract documents, for exactly the ids the design declared                                                   |

An OpenAPI document routinely runs to hundreds of kilobytes and there is one per service, so
folding every document into every design dispatch would make a design prompt scale with the size of
the org's specs rather than with the number of its services. Hence:

- **identity and documents are separate tables.** The catalog read joins a manifest (`length(body)`
  as a SQL projection, never `body`); the lazy read is one chunked `IN` over the declared ids. The
  split makes "lazily read api details" a property of the schema rather than a discipline every
  caller has to remember.
- **operations are indexed ONCE at write time** and stored on the contract row, so the catalog can
  show an agent what an interface offers without loading a body.

**What "indexed" means is per FORMAT, and the catalog says which.** OpenAPI is parsed. A
`@toad-contracts/core` module is read STATICALLY (`indexToadContractOperations`): the library
declares each operation with a `defineApiContract({ method, pathResolver })` call, so a `method`
literal plus a resolver returning a string or template literal yields `GET /files/{fileId}` without
evaluating anything, and what makes a partial parse honest is that the `defineApiContract(` ANCHOR
count is the declaration count, so whatever could not be read is reported through the same
`omittedOperations` channel the cap uses. Nothing uncertain is emitted: an invented operation name
is worse than a missing one, because a coder writes against it.

`@lokalise/api-contract` is not read at all, and `operationsAreIndexable` (contracts) is the single
place that fact lives, because the alternative is the failure this rule exists to prevent: an empty
`operations` list means "declares nothing" for one format and "nobody looked" for another, the two
need opposite reactions, and rendering them identically tells an Architect that a fully-specified
service offers no endpoints. Every surface branches on it: the agent-facing catalog and the SPA's
manifest row alike.

Both reads are delivered as injected `.cat-context/` files (`foundational-services/catalog.md`,
`foundational-services/index.md`, `foundational-services/<id>.md`) rather than as new prompt
fields: one mechanism that already works for container dispatches, inline calls and consensus
participants, and one stable path the trait guidance can name.

A THIRD read rides the same resolver: a BINARY-OUTPUT step (`binary-output` trait, e.g. a
deployment's image generator) gets a brief plus the contracts for the storage and context
services its own step options selected from this catalog. Its join is the step's config rather
than a design's declaration, so admission can validate the whole selection before anything
dispatches: see
[`binary-output-foundational-storage.md`](../../../docs/initiatives/binary-output-foundational-storage.md).

### The declaration is the join between them

The Architect's guidance requires it to end its reply with a fenced ` ```foundational-services `
block naming the ids its design consumes (or `none`). `parseFoundationalDeclaration` reads that
block ONLY, because scanning prose for catalog ids would "find" a service the design mentions as a
rejected alternative, and a false positive there hands a coder the wrong API.

The parsed selection is recorded on the settled design step (`PipelineStep.foundationalServices`),
split into `declared` (ids that resolved) and `unknown` (ids the agent invented). Three states are
kept apart on purpose, because each needs a different reaction from a consumer:

- **absent**, no design step declared anything (it was gated off by the task estimate, or the run
  predates the feature). The index file says _nothing was checked_.
- **empty**: a design ran and concluded no shared service applies.
- **`unknown` non-empty**: the design leaned on a service the platform cannot hand anyone the
  contract for. The index names it and tells the consumer not to guess at its API.

### Opting out is a suppression, never a delete

Two verbs on one sub-resource (`POST` / `DELETE /foundational-services/:id/suppression`), mounted
at BOTH scopes because both tiers inherit: a board from its account, and either from the
deployment's `builtin` tier. A suppression is a fact a tier asserts about an id it does not own, so
there is no service row of its own to patch; deleting the tier's own registration is the separate,
destructive `DELETE /foundational-services/:id`.

It was workspace-only while an account had nothing below it. Leaving it that way once the
deployment tier existed would have made a code-registered service un-declinable for a whole
account: remediable only board by board, forever, including on boards created later.

Three rules make the pair usable rather than a trap:

- **Suppressing an id the merged catalog does not carry is refused** (404). A tombstone there would
  shadow NOTHING today and silently swallow whatever a lower tier registers under that id tomorrow:
  a suppression nobody could later explain.
- **Suppressing the tier's OWN registration is refused** (409, `foundational_service_not_inherited`).
  It would read as a delete while destroying that tier's authored description and contracts.
- **Restoring HARD-deletes the tombstone rather than clearing `deletedAt`.** A suppression row
  carries no name, summary or contracts, so reviving it would leave an EMPTY override winning the
  merge: a worse outcome than the suppression it was meant to undo.

The suppression LIST is its own read for the same reason: a suppressed id is by construction absent
from the merged catalog, so without it the surface offering suppression could offer no way back.
Its `inherited: false` case is kept distinct, because a tombstone that shadows nothing today must
not read as a capability being withheld, and that case is not hypothetical: `remove` leaves a
tombstone too, so a tier that deletes its own registration lands in this list. The delete
confirmation says so, since the opt-out is otherwise a silent side effect of a delete.

The list is mounted as a SIBLING resource (`GET /foundational-service-suppressions`), the way the
repo sources are, rather than as a literal `/foundational-services/suppressions` segment: a service
id is a lower-kebab slug that could legitimately be `suppressions`, and a literal segment sharing a
namespace with `:serviceId` is a collision waiting for the first single-segment by-id route. The
two mutating verbs stay on the sub-resource, where `:serviceId` is a real path parameter.

That sibling path has a cost paid at the ACCOUNT scope, and it is worth writing down because it
cost us once. Account-tier authorization is `accountGuard` mounted per top-level resource, not a
`use('*')`, which Hono would register as `/accounts/:accountId/*` and run against every SIBLING
controller mounted at the same prefix. So a route whose path does not hang off an already-guarded
resource inherits nothing, silently: the suppression list, being a sibling rather than a
`/foundational-services/…` child, was reachable by any signed-in caller for any account id until
`ACCOUNT_GUARDED_RESOURCES` named it. The enforcement is `foundationalServiceAccountGuard.spec.ts`,
which drives every route the controller registers and requires each to refuse a non-member: a new
account resource therefore cannot repeat it without failing a test.

Both refusals are decided against a FRESH tier merge, not the cached one the agents read. They are
decisions about persisted state, so a TTL'd view can 404 an opt-out for a service the account
registered moments ago, or write a tombstone against an id it has since withdrawn: precisely the
shadows-nothing row the 404 exists to prevent. An ACCOUNT's merge for this purpose is the builtin
tier under its own rows: it has one tier below it and no workspace above it to consult.

### Runtime symmetry

| Concern                         | Cloudflare                                                                                                                                 | Node                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Store                           | D1 migrations `0073_foundational_services`, `0074_..._repo_index`, `0075_..._folder_mode`                                                  | Drizzle schema + the three matching migrations                                               |
| Repositories                    | `D1FoundationalServiceRepository` (+ contract, source)                                                                                     | `DrizzleFoundationalServiceRepository` (+ contract, source)                                  |
| Autorefresh                     | a `scheduled` cron pass, gated to the staleness window                                                                                     | a `startSweeper` interval                                                                    |
| Push refresh                    | a `foundational-source-resync` message on `GITHUB_SYNC_QUEUE`                                                                              | the same kind on the pg-boss `github.sync` queue                                             |
| Parity                          | `defineFoundationalServicesSuite` runs against both real stores                                                                            | ditto                                                                                        |
| `builtin` tier                  | the instance passed to `createWorker({ overrides: { foundationalServiceRegistry } })`, defaulted to `defaultFoundationalServiceRegistry()` | the same instance via `start({ foundationalServiceRegistry })` (local rides the Node option) |
| `builtin` tier, mothership mode | serves it at `GET /internal/foundational-services`                                                                                         | ditto; a mothership-mode NODE reads that endpoint instead of its own registry                |

The refresh PASS itself is one implementation (`sweepFoundationalSources` in
`@cat-factory/server`) that both facades drive: only the trigger differs. Two copies would be two
places for the staleness window to drift, and that drift is invisible until a stale contract
reaches a coder.

**Push freshness** rides the same webhook fan-out the skill library uses: a branch push looks up
every tier that linked the repo (`listByRepo`, one indexed read) and enqueues a targeted resync per
source that TRACKS the pushed branch. It matters more here than for skills: a stale skill costs an
agent a slightly old instruction, while a stale API contract is handed to a coder as the interface
to write against, so the sweep's staleness window is the window in which code is written against a
withdrawn endpoint. The message carries the source id ALONE: `syncById` resolves the owning tier off
the stored row, so a copy of the owner on the queue could only ever contradict it.

**Mothership.** The catalog + contract reads/writes are in the `remote` bucket
(`REMOTE_PERSISTENCE_METHODS`), because what READS them is a run: a mothership-mode architect
resolves the catalog over the RPC and its coder resolves the declared contracts the same way. The
repo-SYNC surface stays off, exactly as the fragment library's does: a sync needs a GitHub client
a mothership node does not have, and none of those methods carries an `(ownerKind, ownerId)` pair
for a scope rule to bind.

**The `builtin` tier crosses the machine API too**, and the first cut of this ADR got that wrong:
it reasoned that the tier is code rather than a repo read, so a mothership node resolves it "like
any other". A mothership deployment is TWO processes (the hosted mothership answers the SPA's
catalog reads, the node resolves the catalog for the runs it dispatches) so what that actually
meant was that the estate had to be registered on BOTH entry points, and the two copies were equal
only for as long as both imported the same package at the same commit. Nothing detected a skew,
and a local node one build behind is the NORMAL state of a mothership deployment. The failure was
silent in the worst direction: a run whose catalog is missing a service simply does not consider
it, which is indistinguishable from an Architect deciding the service was not relevant.

A deployment's estate is org state, so the mothership owns it like every other org fact a node
reads remotely. The tier is read through the kernel `FoundationalBuiltinSource` port: the
in-process registry by default, `GET /internal/foundational-services` (+ the batched
`POST .../contracts`) on a mothership-mode node, and the node's own registry is then not consulted at all, with a boot
warning naming the ids it is ignoring, because that is precisely the double registration the old
shape forced. Three things about it are deliberate:

- **It is a DEDICATED `/internal/*` endpoint, not an entry in the persistence allow-list.** The
  registry is not a repository and holds no rows, and every method in that table binds to an
  account through a scope rule this read has no argument to offer one from. The tier is one
  deployment-wide set with no owner, which every workspace of every account already resolves in
  full, so the machine-token audience pin is the whole of its authorization, and there is nothing
  account-shaped to check beyond it.
- **The remote read THROWS; it never degrades to an empty tier.** "The mothership is unreachable"
  and "this deployment registers no shared services" are the same value and opposite facts, and an
  empty catalog reaching an Architect produces a design that reinvents a service the org already
  runs: the failure this whole feature exists to prevent. The case that makes this load-bearing
  rather than pedantic is a mothership one release BEHIND the node, which answers 404 for a route
  it does not serve. A reply the client cannot READ (a 200 whose payload is not the expected
  shape) is refused the same way and for the same reason.
- **…and the throw is STATED to the agent, not swallowed into an omitted file.** Throwing only
  moves the problem if the injection seam then drops it: `resolveFoundationalContext` is
  best-effort by design (an outage must not fail a run that would otherwise proceed), and a
  best-effort `catch` returning no file would have restored the exact substitution the throw
  exists to prevent; an Architect whose prompt has no catalog reads that as an empty estate,
  and the trait guidance is left pointing at a `.cat-context/` path that does not exist. So both
  injected files carry an explicit `unavailable` rendering, discriminated in the renderer
  (`FoundationalCatalogRead` / `FoundationalIndexRead`) rather than expressed as an empty list,
  so a future call site cannot spell the outage as emptiness by accident. The run still
  proceeds; what changes is that the agent is told, and told what to do about it.
- **The two are alternatives, never a merge.** Layering a node's own registrations over the
  mothership's would reinstate the drift, since a stale local copy of a service would win by id
  over the authoritative one, i.e. exactly the skew, now with a mechanism that looks deliberate.
  A deployment that genuinely wants to try a new service before it ships registers it on a
  STANDALONE local deployment, which keeps the in-process registry, or at the account/workspace
  tier, which is what those tiers are for.

A skew is therefore structurally impossible rather than merely observable, which is why no
fingerprint of the resolved tier is exposed on either facade's health read: it would report on a
disagreement that can no longer occur.

### Authenticating to a service: declared credentials, and only from code

A catalog service is an HTTP API the agent is told to call, and most org APIs are authenticated.
Until this landed the platform had a credential seam applied to what MAKES an artifact (a
generative integration declares `credentials` by key name, resolved per dispatch through
`ToolSecretResolver` and injected into the job as named environment variables) and none applied to
where the artifact GOES: a step could authenticate to eight vendors and then not to the service it
had to store the result in. A service's own description had to carry that as a caveat.

A definition may now declare `credentials`, the same `capabilityCredentialSchema` a generative
integration and an MCP tool server declare, and the same resolution path carries it:

- the ENGINE projects the declarations of the services THIS dispatch was briefed on
  (`dispatchFoundationalCredentialsFor` → `AgentRunContext.foundationalCredentials`), key names
  only, never values;
- `@cat-factory/server` resolves the values through the facade-wired resolver and writes them to
  the job body's `capabilitySecrets`, which the harness turns into variables of that one job's
  agent process;
- the BRIEF names the variable to the agent, from the same helper the resolver keys the body with
  (`renderServiceCredentials`), so the two cannot name different variables.

**Only the code-registered `builtin` tier may declare one**, and the stored write boundary refuses
it (`storedTierMayNotDeclareCredentials`). The reason is the resolver's shipped default: it reads
the declared key off the DEPLOYMENT'S OWN ENVIRONMENT, so a declaration is a request to read
deployment-level secret state into an agent process. Every other declarer on the platform is
deployment code, where that is the same trust boundary as the process itself; a foundational
service is the first one a workspace ADMIN can also create over REST, and there the two are not the
same at all. `isReservedPlatformEnvKey` bounds the damage to non-platform variables, which is a
floor rather than a licence. Per-workspace VALUES are unaffected and are the point of the sealed
capability-credential store: the deployment declares the key in code, each board stores its own
value under it.

An account or workspace row that OVERRIDES a builtin id therefore loses its credentials, which is
deliberate rather than a gap: an override supplies its own contract document, and inheriting the
code tier's token would let a stored row repoint the endpoint while keeping the deployment's
credential.

Two capabilities from different registries can claim one environment variable for different lookup
keys, which no single registry's own validation can see. Boot names it
(`capability_injection_name_collision`) and a dispatch that meets the pair anyway withholds the
variable from BOTH, which is the one disposition every brief already describes truthfully.

### The management surface

The REST API is mounted at both scopes from one controller factory, and the SPA mirrors it: an
account tab in Account settings and a board panel reached from the nav / command palette. The board
panel is the only one with a Catalog tab, since an account has no tier above it to merge with.

The nav entry is `advanced`-tier and classified `out-of-tier` in the nav spec's reason table:
registering an org's estate is not the everyday delivery loop, and a board delivers its whole
backlog with an empty catalog.

## Rationale

Alternatives considered and rejected:

- **One table with the bodies on the service row.** Rejected: it makes the catalog read's cost a
  discipline every caller has to remember rather than a property of the schema, and the first
  caller to forget makes every design prompt scale with the size of the org's specs.
- **Scanning the design's prose for catalog ids** instead of requiring a fenced declaration block.
  Rejected: it "finds" a service the design mentions as a REJECTED alternative, and a false
  positive there hands a coder the wrong API; a failure that reads as confidence.
- **Routing the two reads by agent-kind id.** Rejected in favour of traits, so a deployment's own
  design/implementer kinds opt in by declaring one rather than being added to a list they cannot
  edit.
- **A `suppressed` flag on the catalog read** rather than a separate suppression list. Rejected: the
  catalog read is what an agent's context is built from, and a flag there would put opt-out
  bookkeeping in a prompt.
- **SEEDING a deployment's services into every workspace at creation** (the pipeline-registry
  shape) rather than reading them as a tier. Rejected: a foundational service is a standing fact
  about the org's estate, not a starting point someone edits, so copied rows would drift from the
  code the moment a contract changed and would need a reseed/version protocol to un-drift; for
  documents that routinely run to hundreds of kilobytes each. As a tier they cannot drift at all,
  and override/suppression still give a tenant everything a seeded row would have.
- **Widening the resolved catalog entry to carry `ownerKind` and row timestamps** for a `builtin`.
  Rejected: it has no owning scope and no row, so the fields would be placeholders that read as
  facts. The merged read was NARROWED to what every tier can honestly fill instead; provenance
  stays on the per-tier management read, where a stored row's provenance belongs.
- **Accepting an `operations: string[]` on upload** so a registrant can supply what the parser
  cannot derive from a contract module. Rejected: that is the hand-maintained duplicate of the
  contract that this catalog exists to eliminate, and nothing would keep it true. A static
  extraction that reports its own coverage answers the same need without a second source of truth.
- **A `package` source mode** resolving a contract module from a published npm package. Rejected
  for now: it needs a registry client, private-registry auth and tarball extraction inside a Worker
  isolate (a substantial new trust boundary) to serve a case a repo source already serves, since
  the package's source lives in a repo this platform can read. Revisit when a consumer's contracts
  genuinely have no readable repo.

## Consequences

Gotchas the implementation surfaced, each now pinned by a test:

- **A workspace override that ships no contract of its own must NOT inherit the account's
  documents.** The winning TIER is decided by the catalog merge, and the lazy read takes that
  tier's documents: otherwise an override reads as partially applied.
- **`length()` counts characters on both stores**, which is what makes the manifest's `size`
  comparable to the `body.length` the service works in. A bytes-vs-characters difference would pass
  a naive round-trip and disagree about every non-ASCII document; the conformance suite pins it with
  a multi-byte body.
- **A `files`-mode source anchors its head-commit probe on the linked files' deepest common
  directory**, so a dozen linked files still cost ONE cheap read per freshness check. A `folder`
  source anchors on the folder itself, so a whole recursive subtree costs the same single read:
  and the walk only runs at all once that read says the commit moved.
- **A `folder` source's zero-contract pass splits on whether it has EVIDENCE about the folder**,
  never on the empty result the states share. Three reach that point and the disposition is not the
  same for all of them.
  - The walk saw the whole folder (`complete`) or the folder is not there (`missing`), and nothing
    under it even looked like a contract ⇒ STABLE: pin normally and let the sweep retire the
    service, exactly as a directory that lost its `service.md` is retired. Treating this as a
    failure is not a cosmetic error: an ordinary empty spec folder would never pin, so every
    sweep would re-walk the whole subtree to reach the same answer while the source reported
    changes upstream forever.
  - Candidates were found and none was usable ⇒ TRANSIENT: keep the prior row alive and leave the
    pinned commit behind so the next pass re-reads, the same disposition `files` mode takes and
    for the same reason.
  - A cap stopped the walk BEFORE it reached any candidate (`truncated` with nothing found) ⇒
    TRANSIENT as well, and this is the one the obvious rule gets wrong. "Found no candidates" is
    then a statement about the WALK, not about the folder: a recursive link over a wide tree whose
    specs sit below the visited prefix would otherwise retire a live service on the strength of
    directories we declined to list, and pin the commit so it stayed retired.

  So the test is whether the walk had the COVERAGE to conclude anything, not merely whether it
  produced contracts. `files` mode can reuse the simpler rule only because its link is validated to
  carry at least one path.

- **A TRUNCATION that produced contracts pins normally**: it is stable rather than transient, so
  holding the commit back would make the next pass truncate identically while the source looked
  permanently behind. Only the ABSENCE of evidence (above) is transient.
- **`missing` is observable only because git cannot store an empty directory.** A host answers a
  listing of a path that is not there with an empty listing rather than an error, so an empty ROOT
  listing means the folder is gone (renamed, deleted, or mistyped at link time) while an empty
  folder is not a state a repository can even be in. Reported apart from `complete` because the two
  read identically (zero contracts) and need opposite reactions from a human: add specs, or fix the
  link. The same claim is made one step earlier for a link that has NEVER synced, where the
  head-commit probe finds no commit for the path at all and the walk never runs: without that,
  a mistyped folder syncs "successfully" forever.
- **A folder scan's coverage is the only standing signal an autorefresh leaves**, since the sweep
  discards the sync result. Both non-`complete` outcomes are therefore logged with the fix they
  need; a manual resync also surfaces them on the SPA's toast.
- **A directory that loses its `service.md` retires the service it described**, but a manifest that
  reads back unparseable this round keeps the prior row alive AND leaves the pinned commit behind,
  so the next pass re-reads it. Retiring a service over a transient read would silently strip a
  capability from every subsequent design.
- **The traits are the dispatch key, never a kind id list.**
- **A GitLab deployment reaches repo sources through `vcsBackedGitHubClient`** like every other repo
  read. The sync touches only `latestCommitSha` / `listDirectory` / `getFileContent`, and each of
  those is one the GitLab adapter REWRITES rather than passes through (blob/tree vs file/dir,
  base64 bodies, a `ref_name` query), so the claim is pinned by a test that drives the real source
  service over a real `FetchGitLabClient`.

Deliberately not done, and why:

- **The repo-sync surface remains off in mothership mode.** Closing it needs a source→owner resolver
  and a GitHub client on the node; both belong to a later mothership slice, and until then a
  mothership-mode board manages sources through the hosted surface. (The `builtin` tier was
  originally listed here as unaffected. It was not: see the Mothership section above, which
  supersedes that claim.)
- **The catalog CRUD is not mounted on the public (API-key) surface.** The ask behind it was
  provisioning a deployment's catalog from CI, which code registration answers without a
  credential: the definitions live in the deployment's own repo, ship with its build, and are
  validated at boot rather than by a job someone must remember to run. What remains is provisioning
  a per-TENANT catalog from outside, which needs an account-scoped machine credential the public
  API does not have: a question about the key model, not about this feature.
- **No idempotent `PUT` on a service.** A provisioning client still lists, then creates or patches.
  Left out for the same reason: with a deployment's own estate registered in code, what remains is
  a human-driven tenant surface where the read-modify-write is not the bottleneck, and a
  full-replace `PUT` on this entity is a trap, since `contracts` means "replace the whole set", so
  omitting it under `PUT` semantics would silently delete every document while the same omission
  under `PATCH` leaves them alone.
- **No content DIGEST on the contract manifest**, so an external reconciler comparing against
  `size` cannot see an edit that preserved a document's length. The two identities that matter
  internally already exist (a repo source pins the commit it synced, and a code definition is
  checked at boot) and the manifest's job is to keep BODIES off the catalog read, not to make
  re-uploading cheap. A registrant with no other identity re-uploads; the documents are kilobytes.
