# Document sources

Link requirements, RFCs and PRDs from external document sources to a workspace's
board: import a page, expand it into board structure (services → modules →
tasks), or attach it to a task as extra context the agents read during
execution.

The integration is **source-agnostic**. A `DocumentSourceProvider` encapsulates
everything specific to one source (credential validation, page-id parsing,
fetching, body → Markdown), and the rest of the stack (connection/import/plan/
spawn/link services, the D1 tables, the HTTP surface and the frontend) is
shared. Two providers ship today:

- **Confluence Cloud**: HTTP Basic (account email + API token), storage-format
  XHTML bodies.
- **Notion**: a single internal-integration token (Bearer), block-based bodies.

Adding a third source is just another provider: implement
`DocumentSourceProvider` (a `kind`, a `descriptor`, `normalizeConnection`,
`parseRef`, `fetchDocument`) and register it in `selectDocumentsDeps`.

## A stored document need not come from a source

Two vocabularies, and which one a surface takes says what it can do with the row:

- **`DocumentSourceKind`** is what can be CONNECTED (the providers listed above). Connect, search,
  import a ref and `probeVersion` are defined only for these, because each is a call to a provider.
- **`DocumentOrigin`** is what a stored row may CARRY: any of the above, plus **`upload`**, a body
  handed to the platform directly rather than fetched. `POST /api/v1/services/:id/tasks` mints these
  when a headless caller attaches a spec it is holding (see
  [`public-api.md`](./public-api.md#attaching-requirements-documents)). Downstream it is an
  ordinary document: it lists with the rest, links to a block, can be tagged as a doc-kind
  template, and is read by the same context path. The app has no upload UI, and the context
  picker is keyed by source, so the SPA can detach one but not re-attach it elsewhere; that is a
  UI gap, not a model one, and the `POST /documents/link` route already serves it.

Keeping the narrow union on the provider surfaces is what makes the missing `upload` provider a
COMPILE error (an exhaustive `Record<DocumentSourceKind, DocumentSourceDescriptor>` still has to
name every member) rather than an `undefined` at whichever call site reaches for it first. Narrow a
wide origin with `isConnectableSource` (`@cat-factory/contracts`), the predicate derived from the
source picklist, never with an optional lookup.

**A source's TRAITS live beside those unions, not on the provider.** `isDesignSource` (does this
source describe a design rather than prose) and `isHostPinnedSource` (does its `parseRef` refuse a
foreign host) are facts the backend AND the SPA have to agree about, and both are read where no
provider is reachable: the engine folds design guidance from the first, the URL canonicaliser orders
itself by the second, and a document surface has to label a design source without asking a provider
it cannot see. They come off ONE exhaustive `Record<DocumentSourceKind, DocumentSourceTraits>`, so a
new source fails to compile until it is classified.

## A document is attached to at most ONE block

`linkedBlockId` is a single column, so attaching a document that another block already holds would
MOVE the link, not copy it: the earlier task silently loses a document it was created with, and
nothing in its next run reports the absence. `DocumentLinkService.linkToBlock` therefore refuses
with a `ConflictError` carrying `document_already_linked` and the holder's id, the same rule and the
same shape as one-task-per-ticket. To put the same text on two tasks, attach two documents (import
the page twice under different refs, or upload the body again).

Two things keep that refusal from wedging anything:

- **A link naming a block that no longer exists is not a holder.** The guard checks whether the
  holder is still live, so a document whose task was deleted re-attaches on first use. That also
  heals rows left by deletes made before the cascade below existed.
- **Deleting a block detaches its documents.** `BoardService.removeBlock` runs
  `documentRepository.detachBlocks` through the removal cascade (`removal-cascade.ts`). Nothing is
  deleted, only unlinked: the document outlives the task it was attached to.

Attaching a LIST of documents goes through `linkManyToBlock`, which asserts the block once, resolves
the whole list in one `listByRefs` read and writes the links in one batched statement. Reach for it
rather than looping the point method (the repo's no-N+1 rule).

An `upload` has **no origin URL**, and empty is how it says so. Every renderer goes through kernel's
`originSuffix` / `originHeaderLine`, so the prompt index, the inline injection and the materialised
`.cat-context/` file omit the origin entirely rather than emitting `Title ()` or a bare `Source:`
line, which read as a link that broke rather than as a document that never had one. The SPA does the
same by rendering a non-anchor row.

This integration is **always on**: tenants connect their own sources
interactively through the app, so there is no enable flag to forget. The one
thing it requires is a master key to encrypt the per-workspace credentials at
rest, and to make a misconfiguration impossible to miss, the worker **fails to
boot** (a loud config error) when the key is unset rather than silently dropping
the feature from the UI.

## Configuring it

Per-workspace credentials are entered in the app and stored (encrypted) in D1;
there are no source secrets in `wrangler.toml`. A couple of knobs are global,
plus the one required secret: the master key used to encrypt the per-workspace
source credentials at rest:

```toml
# wrangler.toml [vars]
# Optional allow-list of sources to register (default: all known sources).
DOCUMENT_SOURCES = "confluence,notion"
# Doc → board planner: "llm" (default) uses the configured agent model; "headings"
# forces the deterministic heading parser.
DOCUMENT_PLANNER = "llm"
```

```sh
# Shared master key for credential encryption at rest (REQUIRED - config load throws
# without it; set as a secret, never commit it). One key backs every integration; the
# cipher domain-separates per integration via its HKDF `info` tag:
openssl rand -base64 32 | wrangler secret put ENCRYPTION_KEY
```

In `llm` mode the planner reuses the agents' default model
(`AGENT_DEFAULT_PROVIDER` / `AGENT_DEFAULT_MODEL`) via the provider-agnostic
`ModelProvider` port. If no provider credential is usable, or a response can't be
parsed, it degrades to the deterministic heading parser, so import/plan/spawn
always work.

Credentials are stored encrypted at rest in D1: the per-source JSON bag is
sealed with AES-256-GCM (the same `WebCryptoSecretCipher` envelope the
environments integration uses, under a documents-scoped HKDF `info`) before it
is written, and decrypted only on the import path. They are never returned on the
wire. Rows written before encryption was introduced are read back as legacy
plaintext and re-encrypted on the next write.

- **Confluence**: each workspace owner connects their own site with an Atlassian
  **API token** (`id.atlassian.com → Security → API tokens`); the backend
  authenticates with HTTP Basic (`email:token`). The stored base URL is
  SSRF-guarded (https, public host).
- **Notion**: create an **internal integration**
  (`notion.so/my-integrations`), share each page with it, and paste the token.
  The API host is fixed (`api.notion.com`), so there is no SSRF surface.
- **GitHub** (repo docs: READMEs / RFCs / notes under `docs/`): rides the
  workspace's installed GitHub App (or PAT in local mode), so it stores **no
  per-workspace credential and needs no separate connect step**. It is reported as a
  live connection as soon as the App is installed: the provider's
  `resolveImplicitConnection` resolves the workspace's installation, and
  `DocumentConnectionService` surfaces it in `listConnections` / `requireConnection`
  without a stored marker row (an explicit stored connection, if one exists, still
  wins). This mirrors the GitHub-issues **task** source's App-presence availability.
  Reads are **tenant-scoped**: `fetchDocument` / `probeVersion` resolve the installation
  via `getByWorkspace` and require the doc's `owner` to match the workspace's own
  installation account, so a crafted `owner/repo:path` id can't reach another tenant's
  repo through a different workspace's installation token (the same scoping `search` uses).
  In the UI the GitHub (and, via the VCS adapter, GitLab) source doesn't use the generic
  free-text search box: instead the context-document picker offers a **repository
  picker**: search for a repo (reusing the shared server-side repo search), then pick one
  or more **files** from it by searching the whole tree by path or browsing it with the
  same tree browser the monorepo add-service flow uses (now multi-pick in file mode). The
  file search is backed by a single recursive tree read per repo: `listRepoFiles`
  (`GET /github/repos/:repoGithubId/files`) over the `listTree` client port, so the
  picker filters files client-side without walking the contents API level-by-level.

## HTTP API

All endpoints are workspace-scoped under `/workspaces/:workspaceId` and return
`503` when the integration is unconfigured. `:source` is `confluence` | `notion`.

| Method & path                                 | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `GET /document-sources`                       | Configured sources + their connect/import descriptors      |
| `GET /document-sources/connections`           | The workspace's live connections (no credentials)          |
| `POST /document-sources/:source/connect`      | Connect: `{ credentials: { … } }`                          |
| `DELETE /document-sources/:source/connection` | Disconnect a source                                        |
| `GET /documents`                              | List imported documents (all sources)                      |
| `POST /document-sources/:source/resolve-ref`  | Canonicalise `{ ref }`: id, canonical URL, dropped scope   |
| `POST /document-sources/:source/import`       | Fetch + persist a page: `{ ref }` (id or URL)              |
| `POST /document-sources/:source/plan`         | Preview the board plan for `{ externalId }` (no writes)    |
| `POST /document-sources/:source/spawn`        | Apply structure: `{ externalId, frameId? }`                |
| `POST /documents/link`                        | Attach a doc to a block: `{ source, externalId, blockId }` |

### Who may call what: the tier split

This controller is one of the few that MIXES permission tiers, and the line is what a call
touches rather than which controller serves it:

| Routes                                                                                                   | Permission            | Why                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /document-sources/:source/connect`, `DELETE …/connection`                                          | `integrations.manage` | Writes and clears the per-workspace source CREDENTIAL.                                                                                      |
| `POST /document-role-links`, `POST /document-role-links/remove`                                          | `integrations.manage` | A per-DocKind template/exemplar tag decides what EVERY doc run in the board writes from: the fragment-library blast radius, not one task's. |
| `resolve-ref`, `import`, `search`, `plan`, `spawn`, `POST /documents/link`                               | member tier           | Reaching for a page and putting it on a task is board authoring.                                                                            |
| every `GET` (`/document-sources`, `/document-sources/connections`, `/documents`, `/document-role-links`) | `workspace.read`      | Reads pass the admin gate by design.                                                                                                        |

The member tier is enforced by the auth gate's own write floor (any non-GET requires `≥ member`),
so those routes mount no permission gate at all, exactly like `boardController`'s writes. The
admin gates are mounted on the controller's OWN path patterns, never `'*'`: a `'*'` mount becomes
`ALL /workspaces/:workspaceId/*` on the shared app and reaches sibling controllers' routes.

Holding the whole controller at `integrations.manage` is what this replaced, and it made the
feature unusable by the persona it exists for. Someone who links the spec or the design their task
is about is usually not the operator who connected the source, and the Add-task context picker
imports the pasted ref and then links it, so for a `member` the attach flow failed on its first
write. Cross-runtime coverage is in `defineWorkspaceRbacSuite`, which asserts both halves: a member
is allowed the authoring writes, a viewer is still refused every one of them (the floor), and
connect/disconnect stay admin-only.

Those writes are ALSO named in `permissionMounts.test.ts`'s `MEMBER_TIER_WRITES`, the one escape
hatch from that test's rule that a gated controller covers every route it serves. They are listed
as routes rather than waived by a flag on the controller so the split reads as named decisions and
adding one more costs a reviewer's attention: this table is the rationale that list points at. The
same test fails on a row that matches no route, so the hatch cannot rot into a standing
pre-approval for whatever later takes the name.

`spawn` without `frameId` creates new top-level frames; with it, the plan's
modules and tasks are added inside that existing service frame. A document linked
to a block is resolved at execution time and injected into the agent prompt
(`resolveLinkedContext` in `packages/orchestration/src/modules/execution/linked-context.ts`
→ `renderLinkedContext` in `packages/agents`), under the delivery rule below.

### A pasted reference is judged BEFORE anything is written

`resolve-ref` is `import` with the fetch removed: `DocumentImportService.resolveRef` runs the
provider's own `parseRef` and answers `{ externalId, canonicalUrl }`, and `import` now goes
through it rather than re-parsing, so the pre-flight and the import cannot disagree about which
refs are usable. It spends no upstream call and needs no connection, which is what lets the
attach picker call it as the user types.

Two things ride on it, and both were real defects in the attach flow:

- **The paste is TRIMMED to the canonical form and that form is what gets staged.** A share link
  carries a title segment and tracking params (`?p=` / `&t=` on Figma's own Copy link output);
  accepting it verbatim hid whether the frame the URL named had survived the parse at all.
  `canonicalUrl` is the provider rebuilding the link from the id, so what the picker shows is what
  the import will do. It is `null` where the id genuinely cannot rebuild one: Confluence needs the
  connection's site base URL and Linear the workspace slug, and GitHub docs needs the deployment's
  VCS HOST (a GitLab-backed deployment reaches that source through the adapter, so a `github.com`
  link would be wrong for it and `ResolveRepoOrigin`, which resolves a host, needs a workspace a
  pure method does not get). The id itself is the canonical form in those cases, NOT a weaker
  answer, and callers render it rather than reading the null as a failed resolution.
- **A reference that had to be WIDENED says so, separately from the trim.** A node/screen id the
  parser cannot read (Figma's Copy link emits a complex instance id for any component instance)
  makes `parseRef` fall back to the whole file or project rather than guess which frame was meant.
  That is the right fallback and an invisible one: the result is a valid id with a valid canonical
  URL, so "I attached this frame" and "I attached the entire design" render identically under a
  bare "trimmed to the supported form" note. `droppedScope` (optional
  `DocumentSourceProvider.droppedScope`, implemented by the design sources) carries the discarded
  qualifier AS PASTED, and the picker states it in its own amber line. Never normalised onto a
  supported form: nothing knows which frame it meant, which is why the parser refused it.
- **A refusal names WHICH correction it needs**, as `details.reason` (the closed
  `documentRefReasonSchema`). `document_ref_unrecognized` means no link of this shape will ever
  work here, and carries the `expected` format; `document_ref_claimed_by_other_source` means the
  link is fine and pointed at the wrong source, and names the claimant so the surface can offer
  to switch with the text unchanged. Claimants are searched host-PINNED first, through the SAME
  `orderSourcesByClaimConfidence` that `makeDocumentUrlResolver` reads rather than a second copy of
  its two passes: a blind parser claims a shape, so registration order deciding would point a Figma
  paste at Notion, and a rule living in two places would be refined in one of them.

The SPA half is the other side of the same rule: `ContextDocumentPicker` stages the RESOLVED
reference rather than the pasted text, and `useContextLinking().resolvePending` fetches every staged
attachment BEFORE the task or initiative is created, so an unreachable page is a correction the
author can still make instead of a toast over a task that already exists without its context.

Two consequences of running the fetch first, both about not overstating what the pre-flight knows:

- **A refusal blocks a paste; a failed CALL does not.** `unchecked` (offline, 5xx, a proxy's own
  error page, a reason value this build does not know) leaves the reference unjudged and still
  stageable, with the import as the backstop it always was. Treating the two alike would make a
  transient outage as final as a refusal, so a perfectly good link could not be attached at all.
- **A staged item that could not be fetched is MARKED on the form** (`PendingContext.unreadable`),
  not only named in the toast. The create is refused while any attachment is unresolved, so the
  chip that caused it has to be identifiable where the author is still working. A tracker ISSUE has
  no `parseRef` to pre-flight, so the add-task form's body pre-fetch is its warning: it records the
  cause instead of swallowing it.

## A referenced context document reaches the agent, or the run breaks

A document attached to a block (and any imported document its description names outright)
is _the intent the agent builds against_, so the resolution path treats it as load-bearing
rather than best-effort. The rule, owned by kernel's `domain/context-references.ts` and
asserted at every point where such a reference could go missing:

**a referenced context document either reaches the agent whole, or the run fails loudly
naming the ones that could not be delivered.** Two causes, two `error.details.reason`
codes, both surfaced on the run's failure record (so the SPA shows the cause, not just the
prose) and both remedied by the human:

| Cause                                                                                  | Reason code                     | Refused by                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| The reference resolves to a page with **no readable content** (blank body AND excerpt) | `context_document_unreadable`   | `resolveLinkedContext`, plus `RequirementReviewService.gatherContext` |
| The corpus **overflows** the ~256 KB materialised-context budget                       | `context_documents_over_budget` | `buildContextFiles`                                                   |

Both land on the run as a **`preflight`** failure (the honest kind, since no agent ran)
but they refuse at different depths, so different seams classify them:
`buildContextFiles` throws inside `startJob`, where `classifyDispatchFailure` sees it;
`resolveLinkedContext` throws earlier, inside the context builder, so the throw leaves
`advanceInstance` and the driver's `failureFromAdvanceError` sees it. Both map a
`DomainError` to `preflight` plus its `details.reason`, and `runFailure.test.ts` pins that
they agree: otherwise which seam happens to catch a refusal would decide how the board
describes it.

**Where in the run each one bites** is worth knowing, because they differ: the unreadable
refusal fires on the first step that resolves context, which on the default pipelines is
`requirements-review` (step 1); the over-budget refusal fires on the first CONTAINER
dispatch, which can be after a human has already answered a requirements round. Catching
the latter at run start would mean wiring the documents/tasks repositories into
`ExecutionService` for a check the first dispatch performs anyway, and the reworked
description path re-resolves per dispatch, so the resolver-level check would still be
needed underneath it.

Neither is hypothetical: `import` persists whatever the provider returned, so a
permission-limited Confluence page, an empty Notion page or a design node whose extraction
yielded nothing all project to a blank body. Before this rule, both cases were dropped on
the floor: the run looked completely healthy while the agent worked from a spec nobody
noticed it never read. The remedy is always named in the message: re-import the page, or
detach it from the task (a task may proceed without a document; it may never do so
silently). The over-budget message says "detach the linked context this task does not
need" rather than naming a page, because linked **tracker issues** are sized into the same
budget and can be what overflows it.

**A refusal is asserted over the content its caller actually renders.**
`hasReadableContent` (body OR excerpt) is right where the RAW body is delivered: a
container agent opens the materialised markdown source and can at least see what is in it.
An inline caller with no checkout renders only a short excerpt, so it asserts over
`contextExcerptFor`, which can be empty for a body that is not: `import` stores
`buildExcerpt(body)`, i.e. `markdownToText`, and a body that is pure markup (the empty
fenced block an extractor emits for an embed it cannot render) collapses to nothing.
Testing the body and rendering the excerpt would re-open this very hole one field narrower.

Two deliberate NON-refusals:

- **A URL that matches nothing imported is logged, not refused.** SOME providers' `parseRef`
  implementations are host-blind (`parseNotionRef` claims any string carrying a UUID-shaped
  run; `parseConfluenceRef` any URL with a `/pages/<digits>` segment), so such a claim is
  evidence of a shape, not of a reference: failing runs on it would block a task whose
  description happens to link a dashboard. The drop stays; an `info` line naming the URL and
  the source is what keeps it from being silent (importing the page turns it into real
  context). It is `info` rather than `warn` for the same reason it is not a refusal: a
  description that links a dashboard is a normal, permanent state of a healthy task, and
  this re-resolves on every dispatch; a warning would repeat forever with no remedy anyone
  intends to apply, which is how a channel gets tuned out.

  **That difference in confidence is also what orders the canonicaliser.**
  `makeDocumentUrlResolver` consults host-PINNED parsers first (`isHostPinnedSource` in
  contracts: Figma, Zeplin, GitHub, Linear all refuse a foreign host) and host-blind ones
  second, rather than in registration order. First-registered-wins let Notion claim a Figma
  URL whose file key happened to carry a UUID-shaped run; the point lookup then searched
  Notion's key space, found nothing, and the linked design reached the agent as no context at
  all with only the `info` line above to show for it. Within each pass registration order
  still decides, since two pinned sources cannot claim one host.

- **A budget that omits an item from a PROMPT states the omission instead.** The
  materialised index is capped at `CONTEXT_BUDGET.maxItems`, and an inline (no-checkout)
  kind's injection at `CONTEXT_BUDGET.inlineBodyTokens`; `renderLinkedContext` says how many
  items are unlisted (they are all on disk) and names the documents an inline prompt had no
  budget left for, because an unmentioned omission reads as "this is the complete set". Both
  notices are themselves BOUNDED (the inline one names a handful and counts the rest) since
  a notice that reports a budget overrun must not be able to cause one.

**The SPA never sends `frameId`.** Planning is target-blind: `plan(record)` takes
only the document, and its prompt asks for a whole architecture (top-level frames →
modules → tasks), so the `frameId` path can only flatten the planned frames into
the target, discarding the frame titles, types and descriptions the preview renders.
That makes the spawn produce something other than what the user approved, so the
affordance is board-level only. Scoping a spawn to one service is a target-aware
PLAN (a second prompt yielding modules and tasks for an existing service), not a
target-aware write; until that exists, `frameId` is an API-only capability.

The `credentials` bag a source expects is described by its descriptor
(`GET /document-sources` → `credentialFields`), so the connect UI renders
generically, no per-source form is hard-coded in the frontend.

## Layout

- Wire contracts: `packages/contracts/src/documents.ts`
- Core module: `packages/core/src/modules/documents/` (connection, import,
  planner, link services + the shared `documents.logic.ts`; provider-specific
  pure logic in `confluence.logic.ts` / `notion.logic.ts`) + ports
  `document-source.ts` / `document-repositories.ts`, assembled by
  `createDocumentsModule` in `core/src/container.ts`
- Worker infra: the providers `documents/ConfluenceProvider.ts` /
  `documents/NotionProvider.ts`, the two `D1Document*Repository` classes,
  `selectDocumentsDeps` in `infrastructure/container.ts`, and
  `DocumentSourceController.ts`
- Schema: migration `0012_document_sources.sql` (supersedes the Confluence-only
  `0005_confluence.sql`, migrating any live rows across before dropping them)
- Tests: `test/integration/documents-*.spec.ts` with `FakeDocumentSourceProvider`
  and the `documentsDeps()` helper
