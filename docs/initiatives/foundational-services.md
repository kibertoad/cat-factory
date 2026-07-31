# Foundational services

**Goal.** Let a deployment declare the shared capabilities its organisation already runs — file
storage, notifications, audit, feature flags — so an agent-designed system CONSUMES them instead
of rebuilding them, and so the agents that implement the design work against the real API rather
than an invented one.

**Why now.** The platform already knows a great deal about the service being built (its repo, its
spec, its standards) and nothing at all about the systems it must talk to. The result is the most
expensive avoidable rework in the loop: an architect proposes an in-house upload endpoint beside a
file-storage service the org has run for years, and nothing downstream can catch it, because
nothing downstream knows the service exists.

## Model

A **foundational service** is a registered shared capability carrying:

- an id (a lower-kebab slug — the name an Architect writes in its design),
- a name, a one-line summary, a general description and capability tags,
- zero or more **API contracts**: an OpenAPI 3.x document, a `@toad-contracts/core` module or a
  `@lokalise/api-contract` module.

Registration is **tiered**, exactly like the prompt-fragment library: an `account` row is shared by
every workspace in the account and a `workspace` row of the same id wins over it. A workspace
tombstone SUPPRESSES an inherited account service, which is how a board opts out without an account
admin.

Contracts arrive two ways, and the ask is served by both:

- **direct upload** — the document body on the request; validated at the write boundary against the
  format it declares;
- **a linked git repo** — either a FOLDER whose immediate subdirectories are services (each with a
  `service.md` and its contract files beside it) or an explicit FILE list attached to one named
  service. Both are cached in our own store and auto-refreshed.

## The two agent-facing reads, and why they are separate

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

## The declaration is the join between them

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

## Runtime symmetry

| Concern      | Cloudflare                                                      | Node                                                        |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Store        | D1 migration `0073_foundational_services.sql`                   | Drizzle schema + `20260731183716_foundational_services`     |
| Repositories | `D1FoundationalServiceRepository` (+ contract, source)          | `DrizzleFoundationalServiceRepository` (+ contract, source) |
| Autorefresh  | a `scheduled` cron pass, gated to the staleness window          | a `startSweeper` interval                                   |
| Parity       | `defineFoundationalServicesSuite` runs against both real stores | ditto                                                       |

The refresh PASS itself is one implementation (`sweepFoundationalSources` in
`@cat-factory/server`) that both facades drive — only the trigger differs. Two copies would be two
places for the staleness window to drift, and that drift is invisible until a stale contract
reaches a coder.

**Mothership.** The catalog + contract reads/writes are in the `remote` bucket
(`REMOTE_PERSISTENCE_METHODS`), because what READS them is a run: a mothership-mode architect
resolves the catalog over the RPC and its coder resolves the declared contracts the same way. The
repo-SYNC surface stays off, exactly as the fragment library's does — a sync needs a GitHub client
a mothership node does not have, and none of those methods carries an `(ownerKind, ownerId)` pair
for a scope rule to bind.

## Gotchas this slice surfaced

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
- **The traits are the dispatch key, never a kind id list.** A deployment's own design kind gets the
  catalog by declaring `foundational-catalog`; its own implementer kinds get the contracts by
  declaring `foundational-contracts`.

## Remaining work

- [ ] **SPA management surface.** The REST API is complete and mounted at both scopes; there is no
      Vue surface yet. It belongs beside the prompt-fragment library's, is `advanced`-tier by the
      nav rule (registering org-wide capabilities is not the everyday delivery loop), and needs the
      i18n catalog entries plus the locale-parity change in every shipped locale.
- [ ] **Push-webhook freshness fan-out.** Repo sources refresh on the periodic sweep; the skill
      library additionally resyncs on a GitHub push webhook (`listByRepo` + a queued job). The same
      fan-out applies here and would cut the worst-case staleness from the sweep window to seconds.
- [ ] **Suppress-an-inherited-service endpoint.** `suppressForWorkspace` exists on the service (it
      writes the workspace tombstone the merge already honours) but is not yet routed; today a
      workspace suppresses by registering its own row.
- [ ] **A GitLab-sourced repo link.** Sources read through `GitHubClient`, so a GitLab deployment
      reaches them through `vcsBackedGitHubClient` like every other repo read — worth an explicit
      test before it is claimed.

When the committed scope completes, convert this tracker into a numbered ADR under
`backend/docs/adr/` and `git rm` it in the same PR.
