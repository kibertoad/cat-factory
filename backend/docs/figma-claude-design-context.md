# Design-context sources (Figma, Zeplin), and the Claude Design workflow

> How **design context** (component structure, layout, design tokens, visual intent) is fed
> into the UI/frontend coding agents.
>
> **Supported backend sources:** **Figma** (`FigmaProvider`, a per-workspace OAuth grant or PAT)
> and **Zeplin** (`ZeplinProvider`, per-workspace PAT). Both are real, server-fetchable REST integrations that
> ride the shared, **source-neutral** `DesignContext` model + `renderDesignContext` renderer, so
> the abstraction is not Figma-shaped.
>
> **Claude Design is NOT a backend source**: see "Claude Design: via Claude Code, not a backend
> connector" below.

## The problem

The UI agents (`coder`, `spec-writer`, `architect`, `playwright`) get task context today only from
**prose**: Notion / Confluence / GitHub docs and tracker issues (see
[`document-sources.md`](./document-sources.md)). They have no view of the **design**: the actual
frames/screens, the component tree, the spacing/colour tokens, or which design-system component a
screen is built from. So an agent implementing a frontend task guesses at layout, reinvents
components that already exist, and ignores the team's tokens.

## The hard constraint: agents are headless

Agent jobs run inside containers with **no live external access** beyond the LLM proxy and the
optional web-search tools. The platform's one mechanism for getting external content to an agent is
the **`.cat-context/` materialization** pattern:

> backend fetches the content over HTTP → renders it to Markdown → writes `.cat-context/<slug>.md`
> into the checkout → the agent reads it on demand.

See `backend/internal/executor-harness/src/pi.ts` (`materializeContextFiles`) and `buildContextFiles`
in `ContainerAgentExecutor.ts`. A design source therefore has to be **fetchable server-side with a
storable credential** and **renderable to text**. This is the gate that decides which design tools
can be backend sources at all.

## One design serves every source (the documents integration)

Both Figma and Zeplin are **`DocumentSourceProvider`s** (`source='figma'`, `source='zeplin'`),
reusing the entire documents integration: the `document_connections` / `documents` tables, the
generic `DocumentConnectionService` / `DocumentImportService` / link plumbing, the controller, and
the `.cat-context/` materialization. The only per-source code is `normalizeConnection` +
`parseRef` + `fetchDocument`, and the fetched data is mapped into a **shared, source-neutral
model** before rendering:

- `documents/design.logic.ts`: `DesignContext` (`blocks` = frames/screens, `components`, `tokens`,
  `tokenOrigin`, `references`, `notes`) + `renderDesignContext`, which emits the coverage `### Notes`
  first, then `## <block>` sections, a global `### Components`, `### Design tokens` and optional
  `### References`. Each provider only maps its own API into this shape; the renderer is shared, so
  the output isn't Figma-shaped.
  - **`notes` lead the body** because each one qualifies what follows (frames an import cap dropped,
    a subtree read that failed), and a body that gets truncated loses its tail.
  - **`tokenOrigin` names which token path produced the section.** A source with more than one
    (Figma: variables, else published styles) must say which, and a plan gate, a failed read and a
    design that defines no tokens are three facts a bare omission collapses into one.
  - **`capped` + `sortDesignTokens` are how a source bounds a list honestly.** `capped` returns the
    dropped count so the caller must state it, and a source that caps must sort by the RENDERED
    order first (`sortDesignTokens`) or its "N not listed" note points at the wrong tail: a reader
    who assumes a cap is a plain prefix of what they see would conclude the rest was never
    considered.
- `documents/http.ts`: the shared host-pinned fetch + SSRF guard + capped read every fixed-host
  provider reuses (`createHostPinnedFetch` / `assertHostPinned` / `readCappedText`).

### One cap, one note: the caps are not interchangeable

A single "was truncated" flag was the original bug here, in both directions. Each cap gets its OWN
note because each asks the reader for something different, and one of them must not stop the walk:

| Cap                | Blast radius                      | The walk         | What the reader does      |
| ------------------ | --------------------------------- | ---------------- | ------------------------- |
| Tree depth         | one BRANCH                        | carries on       | link that sub-frame's URL |
| Per-frame nodes    | the rest of that frame            | stops that frame | the frame is too big      |
| Import-wide nodes  | that frame and every one after    | stops everything | import fewer frames       |
| Per-frame text     | the rest of that frame's text     | stops that frame | the frame is too wordy    |
| Import-wide text   | that frame's text and all after   | stops everything | import fewer frames       |
| Components, tokens | the design SYSTEM, not the frames | n/a              | open the library file     |

Two traps this shape exists to prevent:

- **A depth cut is LOCAL.** Treating it as exhaustion (propagating it up and breaking the sibling
  loop) meant one branch nested past the cap dropped every later sibling of every ancestor, so a
  frame whose first branch was deep rendered as that branch alone. Auto-layout nests past six
  levels routinely, so this hit ordinary frames.
- **An empty section is DROPPED by the renderer**, so a frame whose text the import budget refused
  was byte-for-byte a frame that contains no text. Every text cut therefore leaves a
  `(text truncated)` line IN the section, not only a note.

### The guidance is folded by PRESENCE, not by selection

One **best-practice prompt fragment** serves all design sources: `design.context`
(`prompt-fragments/src/collections/design.ts`, category `Design`). It tells a `code-aware` agent to
read the materialised structure, match `### Components` against existing repo components, and honour
`### Design tokens` instead of ad-hoc values.

**The engine adds it whenever the run's resolved linked context carries a design-origin document**
(`withDesignContextFragment`, applied in `AgentContextBuilder.resolveFragments`), on top of whatever
the block pins. Selection alone reached almost nobody: the fragment's `appliesTo` selector is a
management-surface hint the run path never drove, it is in no seed pin set, and basic mode hides the
per-task fragment picker, so the standard case (a designer links a Figma frame and starts a run)
executed with a design context file on disk and no instruction anywhere to honour it.

Two properties to preserve when touching this:

- **The trigger is the document, not the block type.** A deterministic presence rule at prompt
  assembly cannot drift from what is on disk, whereas `blockTypes: ['frontend']` was wrong in both
  directions: it missed a design linked to an unlabelled task and fired on a frontend task with no
  design at all. It is deliberately NOT a revival of the retired `appliesTo` run-path selector.
- **It rides the normal fold, so it inherits the normal rules.** Ids go through the same resolver, so
  a workspace override of `design.context` wins, the two-tier `brief`/full verbosity applies (an
  implementer folds the condensed variant), and a kind that receives no standards at all still
  receives none.

### Freshness: the body is re-confirmed at dispatch, not frozen at import

Import writes a projection of a page someone else keeps editing. Nothing used to look at the source
again, so a run started after a frame moved fed its agent the old markdown with the run reading as
perfectly healthy. For a requirements page that is an annoyance; for a design under active iteration
it means the agent routinely builds the previous revision.

`LinkedDocumentRefreshService` (the kernel `LinkedDocumentRefresher` port) runs on the linked-context
resolution path of every dispatch. **The cost model is the design**, because that path runs per STEP:

1. `probeVersion` the source (Figma's `?depth=1` file read).
2. Compare the probed token against `DocumentRecord.sourceVersion`, the token the stored body was
   imported at. This column is why "unchanged" is provable at all; without it every dispatch would
   pay a full re-download, and a whole-file Figma import fans out into chunked per-frame node reads.
3. Re-import (`DocumentImportService.reimport`, idempotent, preserves the block link and role tag)
   only when they differ. A row recording no version cannot be proven current, so it re-imports once
   and self-heals.

Three things bound what that costs, and each bounds a different half:

- **The `linkedDocumentVersion` app cache holds the OUTCOME of the whole ladder**, re-import included,
  on a short TTL. So a burst of step dispatches costs ONE round trip per document, two concurrent
  dispatches of the same document dedupe onto a single download, and a source that is DOWN is
  remembered as down rather than re-asked by every dispatch until it recovers (a cache loader that
  throws caches nothing, which is why an unreachable source is a cached VALUE). Its coherence is that
  TTL plus invalidation on every write that can move either side of the comparison: a
  connect/disconnect drops the workspace group, a manual re-import drops the document's entry.
- **The workspace's connection is resolved ONCE for the whole corpus** (`resolveConnections`, one
  stored-row read), not per document and again inside each probe. It is invariant per
  `(workspace, source)` for the entire pass.
- **The per-document fan-out is bounded.** A task can attach a corpus budget's worth of frames, and
  unbounded, one dispatch becomes that many concurrent whole-file imports at a source that answers
  429 well before finishing them.

**The ladder must CONVERGE**, which is why `reimport` records the caller's PROBED token when the
source's own fetch exposes none. A provider may resolve its version best-effort inside `fetchDocument`
(GitHub docs' commit sha degrades to `null` on a rate-limited request) while the cheap probe still
answers: the row then holds `null`, mismatches the probe on every future dispatch, and re-downloads
the whole document forever while reporting `unversioned` about a source that plainly versions.
Recording the probed token is also the conservative direction, since the body is at least as new as
that token, so a later edit still moves the probe past it.

The verdict rides each context doc as `DocumentFreshness` and is rendered by `freshnessHeaderLines`
into BOTH surfaces a document reaches: the materialised `.cat-context/` file's header, and the
in-prompt injection an INLINE kind gets instead of a checkout. One renderer, because an inline judge,
estimator or requirements reviewer scoring against a stale design is the same failure as a container
agent building from one, and it has no file to read the warning from. Three dispositions, deliberately
not one:

- **`confirmed`** contributes `Revision: <token>`, so "which revision did this run build against" is
  answerable from the checkout afterwards. Whether the check had to re-import does not change the
  rendered claim (both mean the agent is reading the live revision); the distinction is for logs.
- **`not-applicable`** renders NOTHING. An `upload` has no source to trail, and neither does a source
  this deployment wired no provider for, so a freshness warning would invent a problem.
- **`unconfirmed`** renders a warning naming the gap, because an agent handed a design has no other
  way to know the copy might trail the live file, and an omitted note reads exactly like a copy that
  WAS checked. Four gaps, because each needs a different fix: `not_connected` (reconnect the source),
  `source_unreachable` (an outage, wait it out; the cause is on the operator's log line),
  `unversioned` (the source exposes no token, so nothing can be fixed and nothing may be claimed),
  and `credentials_unreadable` (the connection could not be READ, so the source was never asked).

The last one is not defensive: it is **mothership mode**, where a node runs the engine with no main
database and a document-source connection is sealed with the mothership's `ENCRYPTION_KEY`, so the
read fails permanently and by design. Reporting that as an outage would send an operator hunting a
Figma incident that does not exist (see
[`mothership-mode.md`](../../docs/initiatives/mothership-mode.md)).

Every gap also increments the `document.freshness_gap` operational counter, dimensioned by `reason`
and `source` (both closed vocabularies). A log line answers "what happened to this run"; these
conditions are per-dispatch and most of them are permanent while they last, so the line repeats with
no remedy anyone intends to apply and only the RATE says whether the deployment is serving more stale
context than it was.

The refresh is **best-effort by port contract**: it never throws, so a source outage costs the run a
stale body and a stated warning, never the run itself. The readability refusal
(`assertContextDocumentsReadable`) runs on the REFRESHED records, because a page emptied since import
is exactly the case worth refusing. With no refresher wired every document passes through with NO
verdict, which is byte-for-byte the prior behaviour: a deployment that does not refresh has not
concluded these bodies are unverifiable, it never asked.

**Every inline reader of a block's attachments goes through the same refresher**, not just the
container dispatch path: the initiative-planning interviewer, and the REQUIREMENTS REVIEW, which is
the first step of the default pipelines and the one a human signs off on. Reviewing the import-time
copy there would record an approval against a revision nobody built while the coder two steps later
receives the current one, and it would leave two readability verdicts about one document (this
review's and the first dispatch's) free to disagree.

## Figma

- **Auth:** whichever credential the workspace connected, sealed like Notion/Confluence. An OAuth
  grant (`Authorization: Bearer`, `file_content:read` + `file_variables:read`) or a personal access
  token (`X-Figma-Token`). Which header is sent is decided by which key the bag carries, and a
  grant WINS when both are present: it is the credential the platform can renew, and a PAT an
  earlier connect left behind must not outlive the rotation it was replaced by. The grant flow, the
  registered app it needs, and where renewal happens are in
  [`document-sources.md`](./document-sources.md).
- **Fetch (node link):** `GET /v1/files/:key/nodes` returns the referenced frame's subtree, bounded
  by the same `depth=` the whole-file path uses.
- **Fetch (whole file):** `GET /v1/files/:key?depth=2` is an OUTLINE read (pages plus their
  top-level frames, no grandchildren), so the content comes from chunked `/nodes` reads of the
  first `MAX_FILE_FRAMES` of those frames. **A bigger `depth=` cannot replace this**: the file
  endpoint jumps from "no children" to "the entire document", which blows the response cap on any
  real file. A frame whose chunk fails still renders from the outline, and both the frame cap and
  the failed reads are named in `### Notes`, the failures WITH their HTTP status, because a 403
  (token scope), a 429 (rate limit) and a 502 (oversize response) need three different fixes.
  Frames are flattened across pages, so the cap note names the per-page counts: a frame count alone
  cannot say whether the cap stopped mid-page or dropped a whole page of the design.
- **The requested `depth=` is DERIVED from `MAX_TREE_DEPTH`**, not a literal, so the fetch and the
  renderer cannot drift. Figma counts `depth=1` as the requested node alone, so the renderer's depth
  `d` needs `d + 2`, and ONE MORE level is requested on top: without it a node at the cap cannot see
  whether it has children, and a tree the FETCH truncated arrives identical to a complete one.
- **Layout fidelity:** each node's line carries its styling in brackets, the facts an agent would
  otherwise invent: `[fill #3366ff; Inter 16/600 lh 24; radius 8; auto-layout vertical gap 12
padding 16/24]`. Bounded by the same depth/node caps as the tree.
- **Tokens:** `GET /v1/files/:key/variables/local` when the plan serves it; a **403/404 is the
  Enterprise plan gate**, and the fallback is the file's **published styles** (the `styles` map
  joined to the fills/text styles of the nodes referencing them), which every plan serves. The two
  are never merged: `tokenOrigin` states which one produced the section, and states the gate itself
  when neither produced anything.
- **Components:** each instance contributes its component-set name plus the variants and properties
  the design actually uses (`variants: Size=Large | Size=Small; props: Icon=true, Label`), which is
  the signal "reuse the existing component" needs to match against repo code. The component cap
  ranks by INSTANCE COUNT, computed from what was observed, so what survives it is what the design
  leans on; dropping the most-used component is the one outcome that would make the section useless.
- **Preview:** `GET /v1/images/:key` → a best-effort short-lived rendered-preview URL on a
  `### References` line (no download: a non-multimodal agent ignores it).
- **Renders:** the same endpoint, downloaded. See [Renders](#renders) below.
- **Ref/auto-match:** `parseFigmaRef` canonicalises a `figma.com` share URL (dash node-ids, title
  segments, `&t=` params) to the stable `<fileKey>[:<nodeId>]` external id, matched by the
  `documentUrlResolver` seam regardless of URL-string differences.

The endpoint shapes were taken from the Figma REST docs and should be re-verified against the
current API when touched: treat them as the intended shape, not a frozen contract.

## Zeplin

- **Auth:** a per-workspace Zeplin PAT (`Authorization: Bearer`), sealed like Figma.
- **Fetch:** `GET /v1/projects/:id` (name), `/projects/:id/screens` (→ blocks), `/projects/:id/
components` (→ grouped components), `/projects/:id/design_tokens` (→ colours/typography/spacing).
  The components/tokens reads are best-effort (a single failing section is dropped, not fatal),
  exactly like Figma's variables, and the drop is NAMED in `### Notes` / `tokenOrigin` rather than
  left to read as a project that has none.
- **The screens read asks for `SCREEN_FETCH_LIMIT` (= `MAX_SCREENS + 1`)**, so that a project with
  more screens than we import is DETECTABLE. Requesting exactly `MAX_SCREENS` makes a full page and
  a truncated one identical, which silently drops the cap note in the one case it exists for. The
  extra row is a probe and is never rendered, and because the total is unknown the note says "more
  than N" rather than inventing a count.
- **Why Zeplin (and not just Figma):** Zeplin is the design→dev **handoff** tool, so its content
  model is _screens + a design system_, NOT Figma's node tree. Having a second provider with a
  genuinely different model is what proves the `DesignContext` abstraction isn't Figma-shaped. It
  rides the same provider port + shared renderer with zero engine changes.

The Zeplin endpoint paths are the documented REST shapes and are marked provisional/verify-at-build
(the deterministic mapping is unit-tested independent of the network).

## Claude Design: via Claude Code, not a backend connector

Anthropic's **Claude Design** (claude.ai/design) cannot be a backend document source. Its only
programmatic read path is **login-bound**: Claude Code's built-in **`DesignSync`** tool (paired with
the **`/design-sync`** skill) reads/writes design-system projects through the user's **claude.ai
login** (or a `/design-login` design authorization); `list_projects` / `list_files` / `get_file`.
There is **no per-workspace/per-user service token** a hosted, multi-tenant, headless backend could
store and use in async agent containers (which have no claude.ai login). Community "Claude design
studio" MCP servers are a different thing (local HTML/CSS generation), not a service-token read of
existing projects.

**The supported workflow** for getting Claude Design context to the agents is therefore:

1. In **Claude Code**, run **`/design-sync`** to pull a design-system project into the repo
   (component HTML + `_ds_manifest.json` + CSS), e.g. under `design/` or `docs/design/`.
2. **Commit** it. cat-factory's coding agents read the checkout natively, so the design system is
   already on disk for every run, no connector, no credential, no materialization step needed.

This is why the earlier per-user-PAT Claude Design provider (and its `user_document_connections`
store + `credentialScope` plumbing) was removed: it targeted a service-token API that does not exist.

## Next drop-in: Penpot

The Figma OAuth half is what makes connecting a designer-doable step rather than "go and mint a
personal access token": the PAT path stays for deployments that prefer it, and for one that has
registered no Figma app it remains the only way in.

The next provider to add is **Penpot** (open-source, self-hostable, personal access tokens, W3C-DTCG
design tokens). It's the natural stress-test of the remaining abstraction seam: being self-hosted, it
needs a **per-site `baseUrl` credential field**, exactly the model the existing **Confluence**
provider already uses. Mapping Penpot's boards/tokens into `DesignContext` is the only new code; the
table, link plumbing, controller, and renderer are all reused.

## Renders

The text half describes a screen; the render is the screen. An import now DOWNLOADS the pixels and
retains them, through the kernel `DocumentSourceProvider.fetchRenders` port, so the design's frames
land on the same shelf the visual-confirmation gate already reads from (`kind: 'reference'` binary
artifacts). Nothing consumes them yet: pairing them into the gate and handing them to image-capable
models are the later slices of the same track.

- **Separate from `fetchDocument`, on purpose.** The two are wanted at different moments and cost
  different things. A design file's version moves on ANY edit anywhere in it, so the dispatch-time
  freshness ladder re-fetches the text often and writes nothing but a token most of the time; the
  images are only re-downloaded when the body a reader sees actually CHANGED. Folded into one call,
  an unrelated edit on another page would put megabytes of PNGs on the critical path of a step
  dispatch.
- **What is rendered:** the linked frame for a node ref; the first `MAX_RENDERS` (6) top-level frames
  in document order for a whole-file ref. Deliberately fewer than the twelve frames the TEXT import
  covers, because the two bound different budgets: a frame's prose costs the ~256 KB context corpus
  a few KB, its PNG costs the account's blob storage a megabyte or two.
- **The `view` is the frame's NAME**, which is the pairing key a captured screenshot is matched
  against. An unnamed frame falls back to its id rather than a shared placeholder, or two screens
  would read as two captures of one.
- **The download is credential-free and host-pinned to Figma's signed-asset hosts**
  (`FIGMA_RENDER_HOSTS`). The URL arrives inside a response BODY, which is the shape an SSRF comes
  in, and the signature means no token is needed. Fail-closed: a bucket host Figma has not used
  before costs the deployment its renders, which the import states, rather than an open redirect.
- **Keyed to the DOCUMENT, not the block** (`binary_artifacts.document_source` /
  `document_external_id`): an import runs before the document is attached to anything, the
  attachment can move later, and only document-sourced artifacts may be replaced wholesale.
  A re-import that changes the body prunes the previous set BEFORE storing the new one, so a
  design's pictures are never a mix of two revisions.
- **`documents.render_status` says what became of them**, because every way of ending up with no
  images renders as the same absence: `stored` / `partial` / `none` / `failed` /
  `storage_unavailable`, and NULL for "the question does not apply" (a prose source, an `upload`, a
  row predating the column). The status is derived from what was RETAINED rather than downloaded, so
  a store that rejects half the bytes reads as `partial`. Three of the five name a different fix and
  are the ones the SPA's document row states; `stored` and `none` say nothing.
- **Best-effort throughout.** The text is the load-bearing half and an image is an enrichment, so a
  render failure never fails an import. Where no image storage is configured the download is not even
  attempted, and the row says `storage_unavailable`.

## Out of scope (deliberately)

- **Handing the pixels to an agent.** The renders are RETAINED, not yet delivered: context files are
  `utf8` strings by type and no harness can take an image content part today. That is the last slice
  of the pixel track, and it is an image-bumping change.
- **Code → canvas (the reverse flow).** Turning generated code _into_ editable design layers is
  design-authoring driven from an interactive client, the opposite direction from
  design→agent-context, and not something a headless backend consumes.

## See also

- [`document-sources.md`](./document-sources.md): the prose-document integration this design extends
  (provider port, connect/import/link surface, credential sealing).
- [`visual-confirmation.md`](./visual-confirmation.md): the binary-artifact store + Visual
  Confirmation gate (the image-capable surface this text path does not cover).
- `CLAUDE.md` → "Telemetry & agent-context observability": how to inspect, after a run, the exact
  `.cat-context/*` content an agent was given (the manual-verification surface for this feature).
