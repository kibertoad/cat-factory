# ADR 0031: Foundational services — a shared-capability catalog designs consume instead of rebuilding

- **Status:** Accepted (implemented)
- **Date:** 2026-08-01
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/server`,
  `@cat-factory/integrations`, both runtime facades) + the SPA

Supersedes the `foundational-services` initiative tracker, whose committed scope is complete.

## Context

The platform already knew a great deal about the service being built — its repo, its spec, its
standards — and nothing at all about the systems it must talk to. That produced the most expensive
avoidable rework in the loop: an architect proposes an in-house upload endpoint beside a
file-storage service the org has run for years, and nothing downstream can catch it, because
nothing downstream knows the service exists. Worse, when a design DID name a shared service, the
implementer had no contract for it and invented an API that then had to be unwound in review.

## Decision

A **foundational service** is a registered shared capability carrying an id (a lower-kebab slug —
the name an Architect writes in its design), a name, a one-line summary, a general description,
capability tags, and zero or more **API contracts**: an OpenAPI 3.x document, a
`@toad-contracts/core` module or a `@lokalise/api-contract` module.

Registration is **tiered**, exactly like the prompt-fragment library: an `account` row is shared by
every workspace in the account and a `workspace` row of the same id wins over it. A workspace
tombstone SUPPRESSES an inherited account service, which is how a board opts out without an account
admin.

Contracts arrive two ways, and both are served: **direct upload** (the document body on the
request, validated at the write boundary against the format it declares), and **a linked git repo**
— either a FOLDER whose immediate subdirectories are services (each with a `service.md` and its
contract files beside it) or an explicit FILE list attached to one named service. Both are cached
in our own store and auto-refreshed.

### The two agent-facing reads, and why they are separate

This is the feature's load-bearing design decision.

| Read          | Who gets it                                                               | What it carries                                                                                                        |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Catalog**   | kinds carrying the `foundational-catalog` trait — the `architect`         | id, name, summary, description, capability tags, and each contract's format + operation names. **No document bodies.** |
| **Contracts** | kinds carrying the `foundational-contracts` trait — `researcher`, `coder` | the FULL contract documents, for exactly the ids the design declared                                                   |

An OpenAPI document routinely runs to hundreds of kilobytes and there is one per service, so
folding every document into every design dispatch would make a design prompt scale with the size of
the org's specs rather than with the number of its services. Hence:

- **identity and documents are separate tables.** The catalog read joins a manifest (`length(body)`
  as a SQL projection, never `body`); the lazy read is one chunked `IN` over the declared ids. The
  split makes "lazily read api details" a property of the schema rather than a discipline every
  caller has to remember.
- **operations are indexed ONCE at write time** and stored on the contract row, so the catalog can
  show an agent what an interface offers without loading a body.

Both reads are delivered as injected `.cat-context/` files (`foundational-services/catalog.md`,
`foundational-services/index.md`, `foundational-services/<id>.md`) rather than as new prompt
fields — one mechanism that already works for container dispatches, inline calls and consensus
participants, and one stable path the trait guidance can name.

### The declaration is the join between them

The Architect's guidance requires it to end its reply with a fenced ` ```foundational-services `
block naming the ids its design consumes (or `none`). `parseFoundationalDeclaration` reads that
block ONLY — scanning prose for catalog ids would "find" a service the design mentions as a
rejected alternative, and a false positive there hands a coder the wrong API.

The parsed selection is recorded on the settled design step (`PipelineStep.foundationalServices`),
split into `declared` (ids that resolved) and `unknown` (ids the agent invented). Three states are
kept apart on purpose, because each needs a different reaction from a consumer:

- **absent** — no design step declared anything (it was gated off by the task estimate, or the run
  predates the feature). The index file says _nothing was checked_.
- **empty** — a design ran and concluded no shared service applies.
- **`unknown` non-empty** — the design leaned on a service the platform cannot hand anyone the
  contract for. The index names it and tells the consumer not to guess at its API.

### Opting a board out is a suppression, never a delete

Two verbs on one sub-resource (`POST` / `DELETE /foundational-services/:id/suppression`), workspace
scope only. A suppression is a fact the WORKSPACE tier asserts about an id it does not own, so
there is no service row of its own to patch; deleting the board's own registration is the separate,
destructive `DELETE /foundational-services/:id`.

Three rules make the pair usable rather than a trap:

- **Suppressing an id the merged catalog does not carry is refused** (404). A tombstone there would
  shadow NOTHING today and silently swallow whatever the account registers under that id tomorrow —
  a suppression nobody could later explain.
- **Suppressing the board's OWN registration is refused** (409, `foundational_service_not_inherited`).
  It would read as a delete while destroying the board's authored description and contracts.
- **Restoring HARD-deletes the tombstone rather than clearing `deletedAt`.** A suppression row
  carries no name, summary or contracts, so reviving it would leave an EMPTY workspace override
  winning the merge — a worse outcome than the suppression it was meant to undo.

The suppression LIST is its own read for the same reason: a suppressed id is by construction absent
from the merged catalog, so without it the surface offering suppression could offer no way back.
Its `inherited: false` case is kept distinct, because a tombstone that shadows nothing today must
not read as a capability being withheld — and that case is not hypothetical: `remove` at the
workspace tier leaves a tombstone too, so a board that deletes its own registration lands in this
list. The board's delete confirmation says so, since the opt-out is otherwise a silent side effect
of a delete.

The list is mounted as a SIBLING resource (`GET /foundational-service-suppressions`), the way the
repo sources are, rather than as a literal `/foundational-services/suppressions` segment: a service
id is a lower-kebab slug that could legitimately be `suppressions`, and a literal segment sharing a
namespace with `:serviceId` is a collision waiting for the first single-segment by-id route. The
two mutating verbs stay on the sub-resource, where `:serviceId` is a real path parameter.

Both refusals are decided against a FRESH tier merge, not the cached one the agents read. They are
decisions about persisted state, so a TTL'd view can 404 an opt-out for a service the account
registered moments ago, or write a tombstone against an id it has since withdrawn — precisely the
shadows-nothing row the 404 exists to prevent.

### Runtime symmetry

| Concern      | Cloudflare                                                        | Node                                                        |
| ------------ | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Store        | D1 migrations `0073_foundational_services`, `0074_..._repo_index` | Drizzle schema + the two matching migrations                |
| Repositories | `D1FoundationalServiceRepository` (+ contract, source)            | `DrizzleFoundationalServiceRepository` (+ contract, source) |
| Autorefresh  | a `scheduled` cron pass, gated to the staleness window            | a `startSweeper` interval                                   |
| Push refresh | a `foundational-source-resync` message on `GITHUB_SYNC_QUEUE`     | the same kind on the pg-boss `github.sync` queue            |
| Parity       | `defineFoundationalServicesSuite` runs against both real stores   | ditto                                                       |

The refresh PASS itself is one implementation (`sweepFoundationalSources` in
`@cat-factory/server`) that both facades drive — only the trigger differs. Two copies would be two
places for the staleness window to drift, and that drift is invisible until a stale contract
reaches a coder.

**Push freshness** rides the same webhook fan-out the skill library uses: a branch push looks up
every tier that linked the repo (`listByRepo`, one indexed read) and enqueues a targeted resync per
source that TRACKS the pushed branch. It matters more here than for skills — a stale skill costs an
agent a slightly old instruction, while a stale API contract is handed to a coder as the interface
to write against, so the sweep's staleness window is the window in which code is written against a
withdrawn endpoint. The message carries the source id ALONE: `syncById` resolves the owning tier off
the stored row, so a copy of the owner on the queue could only ever contradict it.

**Mothership.** The catalog + contract reads/writes are in the `remote` bucket
(`REMOTE_PERSISTENCE_METHODS`), because what READS them is a run: a mothership-mode architect
resolves the catalog over the RPC and its coder resolves the declared contracts the same way. The
repo-SYNC surface stays off, exactly as the fragment library's does — a sync needs a GitHub client
a mothership node does not have, and none of those methods carries an `(ownerKind, ownerId)` pair
for a scope rule to bind.

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
  positive there hands a coder the wrong API — a failure that reads as confidence.
- **Routing the two reads by agent-kind id.** Rejected in favour of traits, so a deployment's own
  design/implementer kinds opt in by declaring one rather than being added to a list they cannot
  edit.
- **A `suppressed` flag on the catalog read** rather than a separate suppression list. Rejected: the
  catalog read is what an agent's context is built from, and a flag there would put opt-out
  bookkeeping in a prompt.

## Consequences

Gotchas the implementation surfaced, each now pinned by a test:

- **A workspace override that ships no contract of its own must NOT inherit the account's
  documents.** The winning TIER is decided by the catalog merge, and the lazy read takes that
  tier's documents — otherwise an override reads as partially applied.
- **`length()` counts characters on both stores**, which is what makes the manifest's `size`
  comparable to the `body.length` the service works in. A bytes-vs-characters difference would pass
  a naive round-trip and disagree about every non-ASCII document; the conformance suite pins it with
  a multi-byte body.
- **A `files`-mode source anchors its head-commit probe on the linked files' deepest common
  directory**, so a dozen linked files still cost ONE cheap read per freshness check.
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

- **Suppression is workspace-only.** An account has no tier above it, so there is nothing to opt out
  of; an account that wants a service gone deletes it.
- **The repo-sync surface remains off in mothership mode.** Closing it needs a source→owner resolver
  and a GitHub client on the node; both belong to a later mothership slice, and until then a
  mothership-mode board manages sources through the hosted surface.
