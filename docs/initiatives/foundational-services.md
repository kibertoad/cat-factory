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

Both reads are delivered as injected `.cat-context/` files rather than as new prompt fields — one
mechanism that already works for container dispatches, inline calls and consensus participants, and
one stable path the trait guidance can name:

```
.cat-context/foundational-services/
  catalog.md              # the design-time read
  index.md                # what was injected, and what was asked for but could not be
  contracts/<id>.md       # one per declared service
```

The contract files sit one level BELOW the two fixed files deliberately. `index` and `catalog` are
both legal service ids (under the upload schema and under the repo-directory slugging alike), so a
flat layout lets a service called `index` overwrite — or be overwritten by — the file describing what
was injected. Reserving the two ids instead would impose a naming rule on the org's own services to
suit our file layout, and would need enforcing at three write boundaries; a directory enforces it
structurally at none.

The catalog carries a whole-catalog character budget on top of the per-document operation cap.
Without it a design prompt grows without limit in the number of registered services — the very axis
this feature exists to let an organisation grow along. Services that do not fit are still listed by
id, name and summary rather than dropped: an id is all a design needs in order to declare a service
and be handed its full contracts, whereas a silent drop teaches the Architect that a capability the
org runs does not exist.

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
- **`size` is counted in CODE POINTS on every path.** `length()` counts code points on both stores,
  but JS `.length` counts UTF-16 code units — so a create/update response (which derives the size in
  JS from the body it just wrote) and a list response (which derives it in SQL) would report
  different sizes for the same unchanged row as soon as one astral character appeared, e.g. an emoji
  in an OpenAPI `description:`. Kernel's `documentSize` is the single JS-side counter, and the
  conformance suite pins it with a body carrying both a BMP multi-byte character and an astral one,
  so the assertion is not a tautology.
- **A contract document is fenced with a fence sized to the document**, via kernel's `fencedBlock`.
  An OpenAPI `description:` routinely holds a fenced request sample, and a fixed ``` fence closes on
  it — spilling the rest of the spec, the truncation note and the NEXT document into what the agent
  reads as prose. The fence is sized from the text that survives truncation, never the original.
- **A `files`-mode source anchors its head-commit probe on the linked files' deepest common
  directory**, so a dozen linked files still cost ONE cheap read per freshness check.
- **A directory that loses its `service.md` retires the service it described**, but a manifest that
  reads back unparseable this round keeps the prior row alive AND leaves the pinned commit behind,
  so the next pass re-reads it. Retiring a service over a transient read would silently strip a
  capability from every subsequent design.
- **The autorefresh sweep orders on the last ATTEMPT, not the last SYNC.** `syncRepoSource` stamps
  the sync state only once it completes, so a source that THROWS — a revoked installation, a deleted
  repo, a rate limit — would keep its old timestamp, stay permanently the least-recently-synced row,
  and re-occupy the head of every bounded batch. Twenty such sources and no healthy source in the
  deployment ever refreshes again, with nothing to show for it but a warn line per tick. So
  `lastAttemptedAt` is stamped either way and drives `listStale`, while `lastSyncedAt` stays where
  the last real success left it — reporting a failed attempt as a sync would buy fairness by making
  a week-long outage read as "synced a minute ago". The cause is persisted as `lastError` (scrubbed
  through `describeError`) rather than only logged, so a broken source is visibly broken.
- **Re-linking a previously unlinked location REVIVES its row.** A source location
  (`owner × repo × ref × dirPath`) is unique per tier and an unlink only tombstones, so inserting a
  fresh row on re-link is a constraint violation — a 500 on an ordinary unlink/relink. The revival
  resets the pin to zero: `unlink` tombstoned every service the source produced, so a retained pin
  would make the next pass short-circuit on an unchanged head commit and re-create none of them,
  leaving a source that reports itself synced while producing nothing.
- **A repo-sourced contract is titled from the document's own `info.title`** where it has one. Every
  service's file is called `openapi.yaml`, so the filename is the same string for every service in
  the deployment and identifies nothing at exactly the moment the Architect is comparing them.
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
