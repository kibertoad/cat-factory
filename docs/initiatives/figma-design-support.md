# Figma design support: fidelity, freshness, pixels, and the designer workflow

**Goal.** Make a linked Figma design a first-class task input: an agent building UI reads a
faithful, current description of the design (structure, styling, tokens, and eventually the
pixels), and a designer can start a task from a Figma link, follow it, and verify the result
without an engineer in the loop.

**Where this stands today.** Figma shipped as a document source (`FigmaProvider` on the shared
documents integration; reference doc
[`figma-claude-design-context.md`](../../backend/docs/figma-claude-design-context.md)): a
per-workspace PAT, paste-a-URL import, and a source-neutral `DesignContext` rendered to text and
materialised into `.cat-context/`. The abstraction is sound (Zeplin rides the same model, which
is what proves it is not Figma-shaped), the connect/import/link plumbing is shared with the prose
sources, and the wiring is conformance-covered on every facade. What this tracker adds is the gap
analysis from a full survey (2026-08-05, main @ ec9638739) of the provider, the linked-context
resolution path, the fragment library, the visual-confirmation handover, the SPA document
surfaces and the RBAC gates, plus the committed slices that close the gaps.

## The gaps, ranked by impact

### 1. The designer persona cannot use the feature at all

**Closed by Track A.** The survey finding is kept below because the entry points and the copy are
only legible against the four-surface detour they replaced.

Every document-source route rode one admin gate: `documentSourceController` mounted
`requireWorkspacePermission('integrations.manage')` on `*`, and `integrations.manage` is held by
`admin` only (kernel `domain/workspace-access.ts`). So import-by-ref, `POST /documents/link`,
plan and spawn were all 403 for a `member`. The Add-task modal's context picker imports-then-links
a pasted ref, so for a member-tier designer the attach flow failed at the first write.
Discoverability compounds it: the import modal is reachable only from the Integrations hub and
the command palette, nothing on the board or the task form says "start from a design", every copy
string is PRD/RFC-framed (`documents.connect.intro`), and no tutorial tour mentions documents.
Connecting the source also requires creating a Figma PAT by hand (`searchable: false`, no OAuth),
which is an unreasonable first step to put in front of a non-engineer.

### 2. A whole-file import is nearly empty, and styling never reaches the agent

**Closed by Track B slices 1 to 4**; the survey finding is kept below because the caps and the
token fallback are only legible against what they replaced.

Two fidelity holes in what the agent reads:

- `FigmaProvider.fetchNodes` fetches a whole-file link at `depth=2`, which returns pages and
  their top-level frames with NO children. `figmaBlocks` renders each frame's layout from
  `root.children`, so the context file degenerates to a list of frame names and sizes: no layout
  tree, no text content. Only a node link (one frame) gets a real subtree.
- The layout tree carries name/type/size only (`figma.logic.ts` `renderLayout`). No fills, no
  typography, no auto-layout facts (direction, padding, gap), no constraints, no component
  variants or properties. Design tokens come only from the variables API, which is
  Enterprise-gated and silently dropped on 403/404, so on most plans the tokens section does not
  exist, while the published-styles data available on every plan (the file response's `styles`
  map plus per-node paint/text style properties) goes unread.

### 3. Context is frozen at import time

**Closed**: on the RUN path by Track C slice 1, on the SPA by slice 2, and on the RECORD by
slice 3, which is what makes the revision a finished run built against answerable afterwards.

`probeVersion` was implemented on every provider and had exactly one caller: the fragment-library
body cache (`FragmentLibraryService.resolveDocumentBody`). Nothing on the run path re-probed or
re-fetched a linked document: no refresh endpoint, no sweep, no staleness signal to the agent or
the SPA (`syncedAt` is stored and never consulted downstream). A frame edited after import fed
every later run the old markdown, silently. For prose documents that is an annoyance; for a
design under active iteration it meant the agent routinely built the previous revision.

### 4. Pixels exist upstream and reach nobody

**Closed on the RETENTION half by Track D slice 1** (an import downloads the frames and keeps them
as `reference` artifacts), on the GATE half by slice 2 (a linked design populates the
actual-vs-reference gallery itself), and on the CHECKOUT half by slice 3 (a capturing run reads the
frames off disk under `.cat-context/reference-screenshots/`). What remains is the pixels the MODEL
sees: multimodal delivery. The survey finding is kept below because it is what those slices are
measured against.

The provider asks Figma for a rendered PNG URL, stores the URL as a `### References` line, and
never downloads the bytes (`fetchPreviewUrl`); the `design.context` fragment then explicitly
tells the agent not to fetch it (headless containers cannot). Downstream, the visual-confirmation
gate compares tester screenshots against reference images a human uploads BY HAND, while
`.cat-context/reference-screenshots/`, which the UI-tester prompt names, is never written
(handover doc [`visual-confirmation.md`](../../backend/docs/visual-confirmation.md), "What's
left" item 3). And no harness can hand an image to a model at all: context files are `utf8`
strings by type (`InjectedContextFile`), and the claude stream adapter discards non-text blocks.
So the one artifact a designer actually cares about, what the screen looks like, is invisible to
the agent, absent from the gate unless hand-fed, and one expired signed URL away from useless.

### 5. The `design.context` guidance is effectively unreachable

**Closed by Track B's last slice.**

The one fragment that tells an agent how to consume design context was auto-selected by nothing:
the `appliesTo` run-path selector was retired (`FragmentLibraryService` calls its remnant "a
management-surface leftover the run path no longer drives"), the fragment is in no seed pin set,
and in basic mode the per-task `FragmentSelector` is hidden. So the standard case, a designer
links a Figma frame and a run starts, executed with a design context file on disk and no
instruction to honour it.

### 6. Live design access over MCP is now possible and unused

mcp-maturation slice 7 landed OAuth for external MCP servers (`authorization_code` + PKCE), which
is exactly the shape of Figma's OAuth-first remote MCP endpoint; kernel's own capability docs
name Figma as the worked example. A coder on a subscription harness could query the live file on
demand (deep node reads past the materialisation caps) instead of relying entirely on the static
snapshot. Two constraints bound the design: Pi has no MCP client (`MCP_HARNESS_TRANSPORTS.pi =
[]`), so the materialised `.cat-context/` path stays the baseline for every kind, and a
capability that cannot be honoured must be STATED to the agent, never silently dropped.

Smaller items the survey surfaced are folded into Track G below: first-claimer-wins ordering in
`makeDocumentUrlResolver` with host-blind Notion registered ahead of host-pinned Figma (closed);
`contracts/src/documents.ts` citing the tracker deleted when ADR 0017 landed (closed); a pasted but
never-imported Figma URL degrading to an info log even though a Figma claim is host-pinned and
high-confidence; zero frontend unit or e2e coverage of any document surface.

## Tracks and checklists

Tracks A, B and C are DONE. D's later slices build on its first; E consumes D's artifact bridge. F
is optional scope, committed only through its first (registration) slice. Ordering inside a track
is the intended slice order.

### Track A: designer access and the start-from-design flow (DONE)

The RBAC split follows the existing controller convention (ADR 0025), and the first slice settled
which shape it takes: the admin permission is mounted on the controller's own PATH PATTERNS and the
member half relies on the auth gate's write floor. Attaching context to a task is board authoring,
not integration management, so it sits at the `member` tier; managing credentials stays admin.

- [x] **Split document RBAC.** ([#1739](https://github.com/kibertoad/cat-factory/pull/1739)) Import,
      search, plan, spawn and `POST /documents/link` are member-tier; connect/disconnect keep
      `integrations.manage`. Two deviations from the plan above, both deliberate. The member half
      mounts NO gate rather than an explicit `board.write` one, because the auth gate's write floor
      already requires `≥ member` for every non-GET, so a `board.write` mount would be a no-op that
      reads as the enforcement (`boardController`'s writes mount nothing for the same reason); and
      the admin half is mounted on the controller's own PATH PATTERNS rather than per-handler, so
      the refusal still lands before body validation. Role-links did NOT move: a per-DocKind
      template tag decides what every doc run in the board writes from, which is the
      fragment-library blast radius that keeps such config admin-tier, and no designer flow needs
      it. `defineWorkspaceRbacSuite` asserts both halves plus the viewer floor.
- [x] **Figma OAuth connect.** `authorization_code` connect beside the PAT field, offered when the
      SOURCE declares an `oauth` half AND the deployment has registered an app (`figmaOAuth`, beside
      the Slack and Linear clients). Four things this had to get right. The provider DECLARES four
      constants and nothing else, so the second OAuth-capable source adds a declaration rather than
      a second copy of the flow; the credential bag is PLATFORM-owned, so a provider's whole share
      of the lifecycle is noticing a token in the bag it was handed (and preferring it over a PAT an
      earlier connect left behind, which would otherwise outlive the rotation it was replaced by).
      Declaring is not offering, so the source listing answers "what this SOURCE supports" and "what
      this DEPLOYMENT can run" as two fields: folded together, a board with no registered app renders
      a button that can only 503. And ONE public callback serves every source, because a deployment
      registers one redirect URL per vendor app, so the source rides the signed `state` and a state
      minted by any other flow under the same secret (which mints no `source`) is REFUSED there.
      Renewal sits on the one seam every read resolves a credential through
      (`resolveConnection`/`resolveConnections`) and answers null rather than throwing, so a grant
      that cannot be renewed costs the reader a source call it reports as an outage, never the read;
      it is unguarded against a lost race, which is only safe while the supported endpoints leave the
      refresh token unrotated.
- [x] **Start-from-design entry on the board.** A frame-header affordance (basic tier, shown once a
      design source is connected) that resolves a pasted design URL and hands it to the add-task
      form as staged context, plus an Add-task description paste that offers the same. Both ask only
      HOST-PINNED sources: a host-blind prose parser claims a SHAPE, so asking Notion about a Figma
      link whose file key carries a UUID-shaped run gets a confident yes and stages the design into
      Notion's key space. The paste is resolved BEFORE anything is created and a WIDENED reference
      is stated separately from a trimmed one, because for a designer the widening from one frame to
      the whole file IS the defect. Nothing is imported here: the form's own pre-create resolve does
      the fetch, so an unreachable page stays a correction the author can still make. An UNCHECKED
      paste (the pre-flight itself failed) stays stageable only where ONE design source is connected,
      which is the only case with nothing to guess. The existing info-log drop stays for unclaimed or
      unconnected URLs.
- [x] **Design-aware, target-aware plan.** `plan(record, target?)` asks two different questions with
      two different ANSWER SHAPES, rather than one prompt with a hint. A targeted response proposing
      `frames` is REFUSED rather than re-read as modules: a model proposing services where one
      already exists has made a mistake, and re-reading it would launder that onto the board. The
      fallback matches the shape of the request (a targeted plan degrades to the targeted heading
      parser, never to a board-wide plan nobody asked for), and under a target the outline shifts up
      a level, h1 being consumed by the frame it names. The plan carries `targetFrameId`, which is
      what makes the preview honest and the `frameId` spawn safe to send: flattening a board-wide
      plan into a frame discarded the titles and types the preview rendered, while a plan authored
      FOR the target has nothing to discard. Design documents REQUIRE a target in the SPA, because a
      design describes screens and the architecture question produces a service per Figma page.
- [x] **Designer-framed surface copy + tour.** Connect copy that names designs rather than only
      requirements/RFCs/PRDs, the `start-from-design` tour (in the LAUNCH arc rather than the
      catalogue-only half, gated on a design source being CONNECTED rather than on permission to
      connect one, which is the admin's job and not the designer's), and locale parity across all
      ten catalogs.

### Track B: context fidelity (DONE)

All rendering changes land in the source-neutral `DesignContext` model (new optional block
sections and token fields), never as Figma-only renderer branches; Zeplin maps what it has,
omits what it lacks, and the conformity of the two is what keeps Penpot cheap later.

- [x] **Real whole-file content.** ([#1745](https://github.com/kibertoad/cat-factory/pull/1745)) The `depth=2` file read became an OUTLINE read, and the frames
      it names are fetched as real subtrees in chunks of 4, capped at `MAX_FILE_FRAMES`. Chunked
      rather than one request because an oversize response must cost its own frames, not every
      frame: a chunk that fails leaves those frames at outline depth and says so (with the HTTP
      status, since a 403, a 429 and a 502 need different fixes), beside the note naming the frames
      the cap dropped and the pages they spread over. The two caps that bound the render moved with
      it: the per-frame node cap now sits under an IMPORT-wide budget, since a per-frame cap alone
      bounds nothing about a whole-file import that fans out over a dozen frames.
      **Each cap owns its own note, and a DEPTH cut does not stop the walk.** Collapsing the caps
      into one "was truncated" boolean is what made a branch nested past the cap drop every later
      sibling of every ancestor (auto-layout nests past six levels routinely, so this hit ordinary
      frames), and what left the TEXT caps stating nothing at all: since the renderer drops an empty
      section, a frame whose text the budget refused was byte-for-byte a frame with no text. The
      requested API `depth=` is now DERIVED from the renderer's own cap, plus one level so a node at
      the cap can still see whether it has children: without that, a tree the FETCH truncated and a
      complete one arrive identical.
- [x] **Styling in the layout tree.** ([#1745](https://github.com/kibertoad/cat-factory/pull/1745)) Fills, strokes, typography, corner radius and the
      auto-layout facts ride the node's own layout line in brackets, rather than a per-frame
      `Styling` section: the facts are per-node, and a second section would make the reader join
      them back up by name. Bounded by the tree's own caps, since they are the same lines.
- [x] **Tokens without Enterprise.** ([#1745](https://github.com/kibertoad/cat-factory/pull/1745)) Published styles (the `styles` map joined to the fills/text
      styles of the nodes referencing them) are the fallback when variables are plan-gated, and
      `DesignContext.tokenOrigin` states which source produced the section. A style whose value no
      node resolves is DROPPED rather than emitted as a bare name: a token an implementer cannot
      apply is noise, and it would inflate the section that decides whether the gate gets stated.
- [x] **Component fidelity.** ([#1745](https://github.com/kibertoad/cat-factory/pull/1745)) An instance is named by its component SET (a variant's own name is
      its property assignment, so it identifies nothing alone), and every variant and property the
      design uses folds onto that one component's `note`. Folded rather than one entry per variant
      because the shared `dedupeComponents` keys on the name, so per-variant entries would collapse
      to whichever one was seen first. The components and tokens lists are CAPPED too, since both
      grow with the design system rather than with the frames imported, so the layout/text budgets
      bound neither; the component cap ranks by instance count so what survives it is what the
      design leans on, and the token cap sorts by the rendered order first so its "N not listed"
      note points at the tail the reader can see is missing.
- [x] **Auto-fold `design.context`.** ([#1754](https://github.com/kibertoad/cat-factory/pull/1754))
      `withDesignContextFragment` appends the id in `AgentContextBuilder.resolveFragments` whenever
      the run's resolved context carries a design-origin document, so it rides the normal fold and
      inherits its rules for free (a workspace override still wins, the two-tier brief/full verbosity
      still applies, a kind that receives no standards still receives none). Whether a document is
      design-origin comes off `isDesignSource` in CONTRACTS rather than a provider lookup: the SPA has
      to label a design source too, and the run path reads it where no provider is reachable. The
      fragment's retired `appliesTo: { blockTypes: ['frontend'] }` selector is DELETED rather than left
      beside the presence rule, or the deterministic selector and the management surface would go on
      driving the old wrong-in-both-directions behaviour. Trap the wiring hit: `resolveLinkedContext`
      and `resolveFragments` are in the SAME `Promise.all` wave, so the flag settles off the
      resolution's CHEAP half (the `onDocumentsResolved` hook, which reports the corpus origins the
      moment the corpus read returns) rather than off the finished context, which is only ready after
      a live probe per source and a possible whole-file re-download that cannot change an origin.
      Binding it to the finished context serialised the fragment fold (an LLM call, when a standard
      needs condensing) behind a Figma round trip on every dispatch. It resolves `false` when the
      corpus never resolves at all, since that rejection is already the wave's own failure and
      answering it twice would surface a run refusal as a fragment error naming the wrong thing.

### Track C: freshness (DONE)

- [x] **Dispatch-time refresh.** ([#1754](https://github.com/kibertoad/cat-factory/pull/1754))
      `LinkedDocumentRefreshService` behind the kernel `LinkedDocumentRefresher` port, on the
      linked-context resolution path of every dispatch: probe → compare → re-import only what moved.
      **The comparison needed somewhere to compare TO**, which the plan above missed: the row recorded
      no version, so a new `documents.source_version` column (D1 0083 ⇄ Drizzle, nullable) holds the
      token the stored body came from, and it is part of the idempotent-reimport comparison even though
      no agent reads it (a Figma file version bumps on any edit in the file, so leaving the old token
      on an unchanged body would re-fetch the whole design on every dispatch, forever). `sourceVersion`
      NULL covers three cases that all mean "cannot be proven current" and all self-heal on one
      re-import: an upload, a source with no version, a row predating the column.
      A new `linkedDocumentVersion` cache entry holds the OUTCOME of the whole ladder, not the body
      and not just the probe. 60s TTL and NO refresh window, because the load already IS the check so
      there is nothing cheaper to re-validate with, and caching the body instead would put a
      whole-file Figma download on the critical path of any dispatch that missed. Covering the ladder
      rather than the probe is what bounds the EXPENSIVE half too: the re-import runs inside the
      loader, so concurrent dispatches of one document dedupe onto a single download and a failure is
      a cached VALUE rather than a thrown loader (a loader that throws caches nothing, so a source
      that is down would be re-asked by every dispatch for as long as the outage lasted). Enabled on
      the isolate-safe profile (an external token, not our own mutable state), and invalidated on
      every write that can move either side of the comparison: connect/disconnect drops the workspace
      GROUP, a manual import drops that document's entry.
      Two things the ladder needs to CONVERGE, both learned the hard way. `reimport` takes the probed
      token as the version to record when the source's own fetch exposes none (GitHub docs resolve
      their commit sha best-effort, so a rate-limited fetch stored `null`, mismatched the probe
      forever, and re-downloaded the document on every dispatch while reporting `unversioned` about a
      source that plainly versions). And the connection is resolved ONCE per pass for the whole
      corpus (`resolveConnections`) rather than per document and again inside each probe, with the
      per-document fan-out bounded, since this runs per step of every run.
      Freshness is a THREE-way verdict rendered by kernel's `freshnessHeaderLines`, not a boolean:
      `confirmed` contributes `Revision: <token>` (so "which revision did this run build against" is
      answerable afterwards), `not-applicable` renders NOTHING (an upload has no source to trail, so a
      warning would invent a problem), and `unconfirmed` names which of FOUR gaps applies, since
      "reconnect the source" / "this deployment cannot read the credentials at all" (mothership mode,
      where the read fails permanently and by design) / "wait out the outage" / "this source has no
      revision" are four different fixes. The same renderer serves BOTH surfaces: the materialised
      `.cat-context/` header and the in-prompt injection an inline kind gets instead of a checkout,
      because an inline judge or reviewer scoring against a stale design is the same failure as a
      container agent building from one. Every gap a DISPATCH found also increments `document.freshness_gap`
      (dimensioned by reason and source), because each of these repeats per dispatch while it lasts,
      so the log line says which run and only the rate says whether it is spreading. A gap a PERSON
      found does not: the counter measures runs handed a copy the source has moved past, and a click
      hands nothing to anyone. Best-effort by
      port contract (it never throws), and the readability refusal now runs on the REFRESHED records,
      because a page emptied since import is the case most worth refusing, including in the
      REQUIREMENTS REVIEW, the first step of the default pipelines and the one a human signs off on,
      which resolves its attachments through the same refresher for the same reason the initiative
      interviewer does.
- [x] **Staleness on the surface.** ([#1782](https://github.com/kibertoad/cat-factory/pull/1782))
      The imported-documents list and the task context panel show `syncedAt` beside a
      member-tier refresh action (`POST /documents/refresh` →
      `LinkedDocumentRefreshService.refreshNow`, the same ladder a dispatch runs). The
      verdict VOCABULARY moved to `@cat-factory/contracts` in the same change, because this
      is the point at which a human reads the conclusion the agent reads and the backend does
      not localize prose; kernel keeps only the agent-facing renderer.
      Four things this had to get right, each of which the obvious shape gets wrong.
      **The manual path DROPS the cached verdict before it asks, and puts back only a SUCCESS**: the
      60s cache exists so a pipeline's dispatches cost one round trip and so an outage is remembered
      rather than re-probed, and both are exactly wrong for a click, whose commonest cause is that
      the last answer said the source was unreachable. Served from the cache, the button would
      report the failure the person is retrying past and no amount of clicking would clear it. The
      asymmetry on the way back out is what keeps that safe: re-caching what one click found would
      let a person retrying past a flaky source install an `unreachable` verdict every dispatch
      reads for the rest of the window, so the manual loader RETHROWS (a loader that throws caches
      nothing) while a dispatch's returns the failure as a value.
      **A moved REVISION is not a changed document.** The confirmed verdict carries a three-member
      `change` rather than a `reimported` boolean, because a whole-file source moves its token on
      any edit anywhere in the file, including frames a given document does not cover:
      `revision_only` is the common case, and calling it `reimported` would tell a person their own
      edit had landed. The token-only write records the token and leaves `syncedAt` where it was,
      for the same reason.
      **`syncedAt` and the verdict stay TWO facts.** `syncedAt` is when the body was last
      WRITTEN, and a refresh that finds nothing changed writes nothing, so folding the check into
      the stamp would either claim a write that never happened or leave a `confirmed` badge on a
      row the source has since moved past. An absent verdict therefore means "nobody has asked",
      never "unknown": listing documents deliberately probes nothing, since confirming costs a
      round trip per page and a board-wide sweep is a rate limit waiting to happen. Both facts
      render WITH their time, and a verdict is scoped to the BOARD it was asked on, since the same
      file can be imported into two of them.
      **The refresh is refused for an `upload` at the SCHEMA**, by taking the narrow
      `DocumentSourceKind` rather than the wide origin: a 200 carrying `not-applicable` would
      leave a caller unable to tell "this document has no source" from "the check ran and found
      nothing to compare", which is the distinction the whole vocabulary exists to keep.
- [x] **Name the revision a run BUILT against.**
      ([#1807](https://github.com/kibertoad/cat-factory/pull/1807))
      `step.contextDocuments` records each linked document a dispatch put in front of its agent
      with the verdict that dispatch reached, written through the `StepObservations` seam that
      already gates `selectedFragmentIds` and `validationConfigUnreadable`. That seam, not a new
      call at each dispatch site, is what made the record correct: `buildContext` has two callers
      that resolve a full context and start NO job (the over-budget exemption probe, and a
      re-attach to a job a replayed dispatch already started), and a source that recovered between
      the shipped dispatch and the replay would otherwise overwrite the revision the agent actually
      read with the one it never saw.
      **A moved revision is derived, not recorded.** The last verdict is what a row carries, since
      that is the state the run ended on, and it alone says the run ended CURRENT while saying
      nothing about the coder step that finished before the designer's edit. So both readers
      compute `movedDuringRun` from the distinct revisions the run's own steps recorded, and state
      it beside the revision rather than folded into it. The PR report's new `Context sources`
      section leads with that call-out for the same reason the requirement table leads with its
      regression count: it changes how every section below it reads.
      Absent and empty are NOT split here, deliberately, against the usual rule: a step that read
      no document and a task that linked none are the same fact ("nothing was read"), and most
      tasks link nothing, so an empty array on every step of every run would be weight that states
      nothing. What absent must not be confused with is a document read with NO verdict, and that
      one is a present entry with no `freshness`: nobody asked, versus asked and could not tell.
      The report shape steps to `PR_VERIFICATION_REPORT_VERSION` 9, the outcome to
      `RUN_OUTCOME_VERSION` 2, and the API to 1.27.0, all additive.
      A row is keyed by the document's SOURCE identity, never by anything it displays: an `upload`
      carries no URL, so a key falling back to the title would fold two same-titled uploads into
      one row and read their differing revisions as a page that moved mid-run.

### Track D: pixels

The bridge is the binary-artifact store that visual confirmation already reads
(`kind:'reference'`), so the first two slices need no harness change and close a documented
visual-confirmation leftover. Multimodal delivery is the long pole and is deliberately LAST.

- [x] **Download renders at import.** The kernel `DocumentSourceProvider.fetchRenders` port, called
      by the import that WRITES a body, storing `kind:'reference'` artifacts keyed to the document
      (`binary_artifacts.document_source` / `document_external_id`, D1 0087 ⇄ Drizzle) and pruning the
      previous set first, so a design's pictures are never a mix of two revisions.
      **A separate port method rather than a field on `fetchDocument`, which is the decision the
      plan above missed.** The freshness ladder re-fetches the TEXT on every dispatch whose probe
      finds a moved version, and a design file's version moves on any edit anywhere in it, so most
      of those re-fetches write nothing but a token; carrying the images on the same call would put
      megabytes of PNGs on the critical path of a dispatch that had no reason to spend them. The
      render pass is therefore gated on the write that actually changes a body, and a token-only
      write carries the previous status forward untouched.
      **The status is `documents.render_status`, a five-member vocabulary plus NULL**, because
      every way of ending up with no images renders as the same absence and each asks for a
      different fix: `storage_unavailable` (configure storage, and the download is not even
      attempted), `failed` / `partial` (retry the source), `none` (the design had no frames),
      `stored`. NULL is the fourth state and the commonest, meaning the question does not apply.
      It is derived from what was RETAINED rather than downloaded, so a store that rejects half the
      bytes reads as `partial` exactly like a source that rendered half the frames: claiming
      `stored` over an artifact that never landed is the one answer that sends a reader to the
      wrong place. The SPA states the three that name a fix and stays silent on the other two.
      **A CAP is retention too**, so `DocumentRenderResult.capped` counts the frames a provider
      declined to rasterise and pushes the row to `partial`; reported as nothing, six pictures of a
      twenty-frame file land as `stored` and the design reads as having six screens. It is kept
      apart from `failed` because a retry fixes one and never the other.
      **`storage_unavailable` is a DEPLOYMENT fact, so an account-settings read that FAILED is
      `failed` instead**: naming an unconfigured capability sends an operator to change a setting
      that is already right, and the status then rides forward untouched through every token-only
      re-import, outliving the outage.
      **The order is prune-then-FETCH**, not prune-then-store: the reverse leaves the new body
      beside the previous revision's pictures, and a `failed` row over a full set of frames reads
      to everyone as a transient blip rather than as a document illustrating a screen that no
      longer exists. A `view` must also name ONE screen (it is the pairing key), so a frame name
      repeated across pages qualifies EVERY occurrence with its id, including the first: leaving
      the first bare hands that view to whichever frame the file lists first, and re-ordering a
      page would silently re-point a stored view at a different screen.
      **The renders are exempt from the age-based artifact retention sweep**
      (`listOlderThan`/`deleteOlderThan` skip a row carrying a document ref, D1 ⇄ Drizzle with a
      conformance assertion). Age fits run debris, produced once and never referenced again; a
      document's renders are a projection of a live row, replaced by the next body-changing import
      and by nothing else. Swept on a clock they would vanish while the row still said `stored`,
      with nothing to re-download them, since an unedited design is never re-imported.
      **The structural read is done ONCE.** `fetchDocument` already learns the frame ids and names
      a render pass needs, so it carries them out as `DocumentContent.renderPlan` and `fetchRenders`
      takes the plan rather than re-issuing the same request against the rate-limited API. The plan
      is a HINT: a provider handed none discovers the frames itself, which is what keeps the two
      port methods independent.
      Two smaller traps. The signed asset URL arrives inside a response BODY, which is the shape an
      SSRF comes in, so the download is host-pinned to Figma's own asset hosts and carries NO
      credential (the signature is the auth, and a bucket host has no business holding the
      workspace's token); the shared host-pinned fetch grew a fixed host SET for it, still a
      constant and still not a per-connection value. And the artifact is keyed by the DOCUMENT's
      source identity rather than by the block: an import runs before the document is attached to
      anything, the attachment can move later, and a hand-uploaded reference on the same block must
      survive a re-import that replaces the design's own frames.
- [x] **Feed the visual-confirmation GATE.** A task's linked designs have their retained frames
      folded into the gate gallery beside the hand-uploaded ones, so a designer linking a Figma
      frame gets screenshot-vs-design comparison with zero manual uploads.
      **Split from the container half below**, which the plan above carried in the same bullet and
      which is a different KIND of change: writing `.cat-context/reference-screenshots/` means real
      PNG bytes in a subdirectory of the job's context, and an `InjectedContextFile` is UTF-8 text
      by type while the harness flattens a context file's path to a bare name. That is an
      image-bumping harness slice; this one is backend-only and ships the designer-visible half now.
      Six things it had to get right. **An EXPLICITLY CHOSEN reference outranks a design frame for
      the same view**: an upload is a deliberate act against this one task and survives every
      re-import, while a design render is a projection the next body-changing import replaces
      wholesale, so the design fold runs first, the uploads assign over it, and a view whose
      reference the CAPTURE named is skipped (the fold cannot tell which choice it would overwrite,
      and the container half will have the tester naming the design files it was handed). **A view
      name TWO designs both claim is
      qualified on both sides**, the same rule Track D slice 1 applied within one file, because
      leaving the first bare hands the plain name to whichever design is listed first and
      re-ordering the links would then silently re-point a reviewed view at a different screen (the
      cost, that neither qualified name pairs with a capture called plain "Checkout", is the honest
      one: nothing knows which design that capture is of). **A pair says WHERE its reference came
      from**, and says nothing when the CAPTURE named its own reference, since a reference the gate
      did not source is one whose provenance it can only guess at. And **`designReferences` is
      present whenever a design is linked**, even when everything worked, because "no design is
      attached" and "one is attached and gave nothing" are different facts and the second needs a
      per-design reason: `partial` / `failed` / `none` / `storage_unavailable` / `not_retained`,
      each naming a different fix, derived from what the store actually HOLDS rather than from
      `render_status` alone (any status CLAIMING retention over an empty shelf, `stored` and
      `partial` alike, is exactly the case a reviewer must not read as a design that is merely
      short). **The 12-view ceiling is SHARED round-robin and what it cuts is named per design**,
      because spending it in read order lets the design linked longest ago fill the gallery while
      one linked this morning contributes nothing, which reads to a reviewer as a design with no
      frames; each short design carries its own `dropped` beside its `reason`, the two being
      independent. And **a gallery ROW is not a captured screenshot**: a reference-only row makes a
      pair too, so every consumer that asks "did this run capture anything" asks
      `countCapturedViews` in contracts rather than reading `pairs.length`, or a run that captured
      nothing loses its warning, reports a verified gallery of blanks in the run outcome, and
      summons reviewers to screenshots that are not there. That warning is `degradedReason`, kept
      apart from `designReferences` because it gates the approve button behind an acknowledgement:
      a design that gave fewer frames than it has is not a degraded review BASIS, since references
      have always been optional.
      The reads are LIVE at gather time (one batched `listByDocuments`, never a read per design),
      so **recapture** picks up a design linked while the gate is parked, exactly as it already
      does for an upload.
- [x] **Write the references INTO the container.** `.cat-context/reference-screenshots/`, which the
      UI-tester prompt has always named and nothing wrote (the handover doc's "What's left" item 3).
      A dispatch of a kind declaring the `ui` image resolves the task's reference set onto
      `AgentRunContext.referenceScreenshots`, the job body carries it, and the harness downloads the
      images into the checkout before the agent's first turn.
      **The bytes do not ride the job body, which is the decision the plan above skipped.** The plan
      called for "a binary context-file channel", and widening `InjectedContextFile` past UTF-8 would
      have put megabytes of PNG into JSON that crosses every transport and is persisted with the
      dispatch. What travels is a MANIFEST of ids and file names, and the harness fetches the bytes
      back through `GET ${proxyBaseUrl}/artifacts/reference/:id` on the SAME container session token
      the run already holds for the LLM proxy: the mirror image of the screenshot ingest route beside
      it, so no new credential and no publicly reachable URL. That route serves `kind:'reference'`
      only, within the token's own workspace, because a route that also served `screenshot` would
      turn one compromised container into a reader of every capture on the board.
      **The reference SET is now read by TWO callers, so it moved into one module.** The gate pairs
      captures against it and a dispatch hands it to the container, and the view name is exactly the
      join the gate performs: derived twice, the two halves would disagree about a name and the
      pairing would come apart with both looking correct on their own. `block-reference-set.ts`
      answers "which artifact is the reference for each view" once, uploads outranking design frames
      as they always did.
      **The file NAME is the engine's answer, not the container's**, because the name is how the
      agent learns the view name: derived in the harness, a sanitiser change in an image a deployment
      has not rolled out yet would silently rename every view a run reports. Two views that slug to
      one name are SUFFIXED rather than deduped, since dropping one hands the agent a directory
      quietly missing a screen it was asked to compare, and the extension follows the stored content
      type rather than assuming PNG.
      **A reference that could not be fetched is NAMED to the agent.** On disk an absent file and a
      screen the design does not have are the same thing, so a miss is listed beside the files with
      its cause and the agent is told to capture that view anyway, under the same name. The whole
      pass is best-effort and time-bounded well under `JOB_INACTIVITY_MS`: downloading is
      activity-silent, and a wedged blob backend must cost the run its references, never the run.
      **An empty set sends no manifest.** "This kind captures nothing" (absent) and "the task has no
      reference" (an empty array) stay different facts on the context, but neither may produce an
      empty directory in the checkout, which reads to the agent as designs that gave nothing.
      Image-bumping slice: `@cat-factory/executor-harness` and the pinned tags move together, and the
      directory joins `HARNESS_SENTINEL_PATHS` so the two independent copies of its name are pinned
      byte-for-byte by the harness contract suite.
- [ ] **Multimodal delivery to agents.** Hand the stored render to image-capable harness/model
      pairs as an image content part (job body + proxy + prompt assembly; the OpenAI-shape
      `image_url` translation already exists on the Workers AI upstream with no producer).
      Requires an executor-harness change, so it is an image-bumping slice; kinds/harnesses that
      cannot take images keep the textual path and the prompt states that the render exists but
      could not be attached.

### Track E: the designer verification loop

- [x] **Live URL on the outcome card.** The run's environments are a section of the outcome
      summary (`environments`, contracts' `run-outcome.ts`), so "click and look" sits next to the
      captured views on the card and on `GET /api/v1/runs/:runId/outcome` (surface 1.38.0, outcome
      `version` 3) rather than in step detail.
      **The section reports a STATE, not a URL**, which is the decision the plan above did not
      make. A deploy row is terminal at provision time and never moves again, so the URL alone
      reads as a working preview for as long as the run is readable, months after the disposer
      reclaimed it: `live` is the only state that offers a link, and every other row still shows
      its URL as text because that is what names the environment and what an operator greps for.
      Several producers know something about the same environment, and they are RECONCILED BY
      IDENTITY before they are ranked: the run's step projections and the `human-test` gate's own
      record are folded into one observation per environment id (the gate destroys the environment
      it sent a person to and stamps its record on the way past, so kept apart it is the deploy
      row's stale `ready` that a reader is offered). Above that observation the DISPOSE record
      wins, being written after the run stops watching; below it the deploy row is the floor. A
      reclaim that FAILED deliberately changes nothing here: the environment is still standing and
      its URL still works, and that it should not be is the verification report's teardown proof,
      not this card's question.
      **A superseded environment is derived, not observed.** A re-deploy of a frame (a fix, or the
      gate rebuilding what a person is testing) supersedes the frame's earlier environment, and
      nothing ever refreshes its projection again: left underived it is the most convincing dead
      link a run can produce, a `ready` snapshot with a URL. Every deploy the run made is folded,
      the frame reports the environment it ended on, and the ones it replaced report `reclaimed`
      unless their own last status already named where they went.
      **`reclaimed` is one word for two facts on purpose** (the disposer tore it down, or went
      looking and found nothing live): nothing records who took it, and the reader's next move is
      the same either way. The three absences are kept apart for the opposite reason, since each
      names a different fix: `no_environment_step`, `not_provisioned` and `infraless`.
      **The in-flight row is reported and LABELLED** (`origin: 'projected'`), because a card that
      goes silent until the deployer settles loses the preview URL for exactly as long as the run
      is live, which is when a designer most wants it. `hasOutcomeToShow` counts it, so the
      affordance appears on a run whose only product so far is something to look at.
      The rules this shares with the verification report (which frames the run's deploys settled,
      what the run observed of each environment, which recorded states mean one is gone, whether
      the deployer declared retention) moved into contracts' `run-evidence.ts` beside the tester
      rules, and the parity test asserts the two documents name the same environments, including
      for a run that deployed twice. The disposer reclaims by the same fold, so the set of
      environments a run stood up has ONE statement.
      **A clock is deliberately not one of the reduction's inputs**: a lapsed TTL is reported as
      the instant it lapses, so the SPA composing the summary live and the endpoint composing it
      server-side cannot disagree about one run. Applying that instant is then the RENDERER's job,
      and the card does it (`OutcomeSummaryWindow.logic.ts`): a `live` row past its expiry reads
      `expired` and offers no link, because the alternative is a green badge and a working-looking
      button beside a date in the past.
- [ ] **Visual pipeline out of the attic.** Once tester-ui auto-capture is wired end to end (the
      deploy-coupled `image: 'ui'` routing + harness passthrough tracked in the
      visual-confirmation handover), drop the `experimental` label on `pl_visual` and revisit the
      `visual-confirmation` kind's `advanced` catalog tier: the everyday delivery loop of a
      design-led team needs it, which is the tier bar.
- [ ] **Designer-fit merge policy preset.** Nothing to build in the engine (ADR 0037/0039 already
      carry role-scoped rules and submission classes): ship a documented preset for
      designer-started runs (e.g. dry-run or frontend-class-limited submission) and name the
      designer persona in the merge-thresholds docs, so an admin can enable designer starts
      without inventing the policy.

### Track F: live Figma MCP (optional scope)

- [ ] **Register Figma's remote MCP server** as an OAuth `authorization_code` tool server and
      assign it to the UI-building kinds via `assignToolServers`. Committed scope ends here; the
      rest is per-deployment configuration. The capability statement rule applies: a Pi-harness
      run says the server exists and cannot be served (no MCP client) rather than dropping it.

### Track G: hygiene

- [x] **Host-pinned claims win.** ([#1754](https://github.com/kibertoad/cat-factory/pull/1754))
      `makeDocumentUrlResolver` two-passes: host-PINNED parsers first, host-blind second, registration
      order still deciding within each pass (two pinned sources cannot claim one host). The
      classification is `isHostPinnedSource` in contracts, off the same exhaustive traits `Record` as
      `isDesignSource`, so a new source cannot ship unclassified.
- [x] **Fix the stale tracker pointer** in `contracts/src/documents.ts`
      ([#1754](https://github.com/kibertoad/cat-factory/pull/1754)): now cites ADR 0017.
- [x] **A pasted ref is judged BEFORE the task is saved.** The attach picker staged whatever text
      sat in its box and only found out by trying to IMPORT it, after the task had been created:
      a Figma share link (title segment + `?p=`/`&t=`, what the Copy link button produces) was
      staged verbatim, and a link the source could not read at all was staged just as readily.
      `POST /document-sources/:source/resolve-ref` is the provider's own `parseRef` with the fetch
      removed, so the picker shows the canonical form the paste is TRIMMED to (`canonicalUrl`,
      rebuilt from the id by the provider) and refuses the rest with a reason naming WHICH
      correction it needs: a different link, or the same link on the source that claims it. The
      claimant search calls the same `orderSourcesByClaimConfidence` as the host-pinned ordering
      above, so the hint cannot point a design link at Notion. A node id the parser CANNOT read
      still falls back to the whole file, which is right and invisible, so the provider reports the
      dropped frame (`droppedScope`) and the picker warns about it separately from the trim: for a
      design source that widening is the defect, not the tracking params. The fetch itself moved
      ahead of the create (`resolvePending`), so an unreachable page is a correction made with the
      form still open rather than a toast over a task that already exists without its context.
      Model: [`document-sources.md`](../../backend/docs/document-sources.md).
- [ ] **Coverage for the designer path.** An e2e spec for attach-document-to-task and one for the
      start-from-design flow (live-push assertions per the e2e rules). The `stores/documents.ts`
      half started with Track C slice 2, which added the store's first specs (the refresh
      reconcile, the verdict map, the in-flight flag); Track A added the OAuth-availability and
      design-source projections. The connect / import / link actions are still unspecced.

## Gotchas the survey surfaced (read before building)

- **`appliesTo` looks live and is not.** `FragmentLibraryService.resolveForRun` honours
  `appliesTo`, and the run path does not call it: runs resolve `block.fragmentIds` /
  `serviceFragmentIds` by id only. Anything that should reach a run automatically needs its own
  deterministic rule at prompt assembly (`withDesignContextFragment` is the worked example), not an
  `appliesTo` edit.
- **`probeVersion` now has TWO cache shapes, and they must stay separate.** The fragment-library
  body cache (`fragmentDocumentBody`) caches the BODY and uses the probe as its self-verification;
  the freshness path (`linkedDocumentVersion`) caches the PROBE itself and re-imports on a change.
  Collapsing them into one entry would put a whole-file Figma download on the critical path of any
  dispatch that missed, which is the cost the freshness path exists to avoid. The freshness path has
  two ENTRY points sharing that one cache, and the second exists because of how it treats it: a
  dispatch reads the cache, a person's click drops the entry first (`refreshNow`), since the click
  is the request for a new answer.
- **`documents.source_version` is what makes "unchanged" provable.** A NULL means "cannot be proven
  current", never "no version" alone, and it is part of the idempotent-reimport comparison even
  though nothing reads it downstream: skip that and a file whose version moved without its Markdown
  changing re-downloads on every dispatch forever.
- **Figma `depth` semantics.** `?depth=2` returns pages and top-level frames with no
  grandchildren; a node fetch (`/nodes?ids=`) returns the full subtree. "Fetch deeper" for a
  whole file means per-frame node fetches, not a bigger depth constant, or one huge file blows
  the response cap.
- **The variables 403 is a plan gate, not an error.** Keep the drop-on-403 behaviour when adding
  the styles fallback; the two sources must not be merged silently (state which one produced the
  tokens section).
- **`image: 'ui'` routing is dispatch-side only today.** `RunnerDispatchOptions.image` is set for
  tester-ui and honoured by the Kubernetes/pool transports, but Cloudflare's container transport
  ignores it and per-step image routing on a shared per-run container is unsolved (noted in
  `kernel/domain/seed.ts` at `pl_visual`). Track E's "out of the attic" item is BLOCKED on that
  deploy-coupled work; do not un-label `pl_visual` before it.
- **Anything the harness writes is per-job state.** Reference renders materialised for a job
  (Track D) go under the job's own context dir, never HOME, and the slice that changes the
  harness is an image bump with the pinned-tag rollout recipe.
- **A render is fetched on the write, not on the probe.** `fetchRenders` is a SEPARATE port method
  from `fetchDocument`, and the split is a cost decision rather than a tidiness one: the freshness
  ladder re-fetches the text whenever a version moves, which for a whole-file source is any edit
  anywhere in the file. Anything new that rides the import path has to answer the same question:
  does it belong to the BODY (refresh it only when the body changed) or to the probe.
- **A refusal already guards this corpus.** Linked-context delivery is load-bearing
  (`context_document_unreadable` / `context_documents_over_budget` refusals): richer Figma
  renders (Track B) enlarge bodies, so watch the ~256 KB corpus budget; the caps must state what
  they dropped, and a design doc that grows past the budget should fail the same honest way, not
  a new one.
