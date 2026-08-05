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

**The authorization half is closed** (Track A slice 1); the discoverability half below is not.

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

`probeVersion` is implemented on every provider and has exactly one caller: the fragment-library
body cache (`FragmentLibraryService.resolveDocumentBody`). Nothing on the run path re-probes or
re-fetches a linked document: no refresh endpoint, no sweep, no staleness signal to the agent or
the SPA (`syncedAt` is stored and never consulted downstream). A frame edited after import feeds
every later run the old markdown, silently. For prose documents that is an annoyance; for a
design under active iteration it means the agent routinely builds the previous revision.

### 4. Pixels exist upstream and reach nobody

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

The one fragment that tells an agent how to consume design context is auto-selected by nothing:
the `appliesTo` run-path selector was retired (`FragmentLibraryService` calls its remnant "a
management-surface leftover the run path no longer drives"), the fragment is in no seed pin set,
and in basic mode the per-task `FragmentSelector` is hidden. So the standard case, a designer
links a Figma frame and a run starts, executes with a design context file on disk and no
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
`makeDocumentUrlResolver` with host-blind Notion registered ahead of host-pinned Figma; a pasted
but never-imported Figma URL degrades to an info log even though a Figma claim is host-pinned and
high-confidence; `contracts/src/documents.ts` still cites `docs/initiatives/document-task-improvements.md`,
deleted when ADR 0017 landed; zero frontend unit or e2e coverage of any document surface.

## Tracks and checklists

Tracks A, B and C are independent and each is worth landing alone. D's later slices build on its
first; E consumes D's artifact bridge. F is optional scope, committed only through its first
(registration) slice. Ordering inside a track is the intended slice order.

### Track A: designer access and the start-from-design flow

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
- [ ] **Figma OAuth connect.** Add `authorization_code` connect for the Figma document source
      beside the PAT field (the descriptor grows an optional OAuth half; PAT remains for
      deployments that prefer it). This is what makes "connect Figma" a designer-doable step.
      Model: the MCP OAuth grant flow that landed in mcp-maturation slice 7.
- [ ] **Start-from-design entry on the board.** A frame-header affordance (basic tier) that takes
      a pasted Figma/design URL and does import + link + open-task in one step, and an Add-task
      description paste that offers the same when a connected provider claims the URL with a
      host-PINNED `parseRef` (Figma, Zeplin; never the host-blind prose parsers). The existing
      info-log drop stays for unclaimed or unconnected URLs.
- [ ] **Design-aware, target-aware plan.** A second plan prompt for design-origin documents:
      given an existing frontend service frame, propose tasks (one per frame/flow) rather than a
      whole architecture, unblocking the documented `frameId` spawn limitation for the design
      case (`document-sources.md`, "The SPA never sends frameId"). The SPA spawn preview gains
      the target-frame variant for design documents only.
- [ ] **Designer-framed surface copy + tour.** Connect/import/picker copy that names design
      sources and the designer's job to be done (today everything says requirements/RFC/PRD), a
      `start-from-design` tutorial tour, and locale parity for every new key.

### Track B: context fidelity

All rendering changes land in the source-neutral `DesignContext` model (new optional block
sections and token fields), never as Figma-only renderer branches; Zeplin maps what it has,
omits what it lacks, and the conformity of the two is what keeps Penpot cheap later.

- [ ] **Real whole-file content.** Fetch the file shallow first, then the top-level frames as
      node subtrees (bounded: first N frames by the existing node/byte caps, the cap stating what
      it dropped). A whole-file import must produce layout and text for its frames, not a bare
      frame list.
- [ ] **Styling in the layout tree.** Extract per-node fills (solid colours as hex), text style
      (family/size/weight), corner radius, and auto-layout facts (direction, padding, gap) into
      the layout lines or a per-frame `Styling` section. Bounded exactly like the tree itself.
- [ ] **Tokens without Enterprise.** Derive a tokens section from published styles (the file
      `styles` map joined to the styled nodes) when the variables API is gated; keep variables as
      the richer path when available. The render states which source the tokens came from, since
      "absent" and "plan-gated" must read differently.
- [ ] **Component fidelity.** Carry component properties/variant names on `DesignComponent.note`
      so "reuse the existing component" has enough signal to match against repo code.
- [ ] **Auto-fold `design.context`.** Fold the fragment (brief for implementer kinds, full body
      for reviewer/planner kinds, the existing two-tier rule) whenever the run's resolved context
      includes a design-origin document. A deterministic presence rule at prompt assembly, NOT a
      revival of the retired `appliesTo` run-path selector: the trigger is the design doc the run
      actually carries, so it cannot drift from what is on disk.

### Track C: freshness

- [ ] **Dispatch-time refresh.** Before materialising linked context, `probeVersion` each linked
      source-backed document (through the app cache seam with a short TTL, the
      [`caching-layer.md`](./caching-layer.md) pattern; Figma's probe is the cheap `?depth=1`
      read) and re-import through the existing idempotent `DocumentImportService.import` on a
      version change. Best-effort with the outage stated: a probe/refresh failure degrades to the
      stored body plus a staleness note in the materialised header, never a run failure, and the
      degradation is logged through `runBestEffort`.
- [ ] **Staleness on the surface.** The SPA document rows and the task context panel show
      `syncedAt` and a refresh action (member-tier, per Track A); the outcome/report side names
      the design version a run actually built against, so "built from the old rev" is diagnosable
      after the fact.

### Track D: pixels

The bridge is the binary-artifact store that visual confirmation already reads
(`kind:'reference'`), so the first two slices need no harness change and close a documented
visual-confirmation leftover. Multimodal delivery is the long pole and is deliberately LAST.

- [ ] **Download renders at import.** For a node link, fetch the node's PNG bytes server-side
      (size-capped, best-effort); for a whole-file link, the first N top frames. Store through
      the workspace's binary-artifact store as `kind:'reference'` artifacts keyed to the
      document; re-import replaces them. Where no artifact store is wired the import proceeds
      textually and the document row says renders were not retained ("absent" and "zero" must not
      render the same).
- [ ] **Feed the visual-confirmation gate.** Auto-pair a block's design-origin reference
      artifacts into the gate gallery beside the hand-uploaded ones, and write them into
      `.cat-context/reference-screenshots/` via the reference pre-op the handover doc already
      names as unwired (its "What's left" item 3). A designer linking a Figma frame then gets
      screenshot-vs-design comparison with zero manual uploads.
- [ ] **Multimodal delivery to agents.** Hand the stored render to image-capable harness/model
      pairs as an image content part (job body + proxy + prompt assembly; the OpenAI-shape
      `image_url` translation already exists on the Workers AI upstream with no producer).
      Requires an executor-harness change, so it is an image-bumping slice; kinds/harnesses that
      cannot take images keep the textual path and the prompt states that the render exists but
      could not be attached.

### Track E: the designer verification loop

- [ ] **Live URL on the outcome card.** Surface the run's ephemeral-environment / preview URL on
      `OutcomeSummaryWindow` (today it is buried in step detail and the test report), so "click
      and look" is the designer's default verification, next to the captured views.
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

- [ ] **Host-pinned claims win.** Order `makeDocumentUrlResolver` so host-pinned `parseRef`
      implementations (Figma, Zeplin, GitHub, Linear) are consulted before host-blind ones
      (Notion, Confluence), or two-pass it (pinned, then blind). Today first-registered wins and
      Notion claims any UUID-shaped run in any URL.
- [ ] **Fix the stale tracker pointer** in `contracts/src/documents.ts` (points at the deleted
      `document-task-improvements` tracker; ADR 0017 is the surviving record).
- [ ] **Coverage for the designer path.** An e2e spec for attach-document-to-task and one for the
      start-from-design flow once Track A lands (live-push assertions per the e2e rules), plus
      unit specs for `stores/documents.ts`, which currently has none.

## Gotchas the survey surfaced (read before building)

- **`appliesTo` looks live and is not.** `FragmentLibraryService.resolveForRun` honours
  `appliesTo`, and the run path does not call it: runs resolve `block.fragmentIds` /
  `serviceFragmentIds` by id only. Anything that should reach a run automatically needs its own
  deterministic rule at prompt assembly (Track B's last item), not an `appliesTo` edit.
- **`probeVersion` is load-bearing for exactly one feature.** Wiring it into the run path (Track
  C) must not disturb the fragment-library body cache, its only current caller.
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
- **A refusal already guards this corpus.** Linked-context delivery is load-bearing
  (`context_document_unreadable` / `context_documents_over_budget` refusals): richer Figma
  renders (Track B) enlarge bodies, so watch the ~256 KB corpus budget; the caps must state what
  they dropped, and a design doc that grows past the budget should fail the same honest way, not
  a new one.
