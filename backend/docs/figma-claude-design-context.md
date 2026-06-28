# Figma & Claude Design as design-context sources

> Investigation + design. This documents the chosen approach for feeding **design
> context** (component structure, layout, design tokens, visual intent) into the
> UI/frontend coding agents. It is a design record, not a shipped feature — the
> provider code is the follow-up implementation.

## The problem

The UI agents (`coder`, `spec-writer`, `architect`, `playwright`) get task context
today only from **prose** — Notion / Confluence / GitHub docs and tracker issues (see
[`document-sources.md`](./document-sources.md)). They have no view of the **design**: the
actual frames, the component tree, the spacing/colour tokens, or which design-system
component a screen is built from. So an agent implementing a frontend task guesses at
layout, reinvents components that already exist, and ignores the team's tokens.

We want to feed design context from **Figma** and from **Anthropic's Claude Design** into
those agents. This doc records what each source can actually offer a *headless* backend,
and the single design that serves both.

## The hard constraint: agents are headless

Agent jobs run inside containers with **no live external access** beyond the LLM proxy and
the optional web-search tools. The platform's one mechanism for getting external content to
an agent is the **`.cat-context/` materialization** pattern:

> backend fetches the content over HTTP → renders it to Markdown → writes
> `.cat-context/<slug>.md` into the checkout → the agent reads it on demand, and is told
> *not* to reach external systems (everything is already on disk).

See `backend/internal/executor-harness/src/pi.ts` (`materializeContextFiles`,
`contextGuidance`, `CONTEXT_DIR`) and the `buildContextFiles` helper in
`backend/packages/server/src/agents/ContainerAgentExecutor.ts` (a module-private function
called from `buildJobBody()` on the shared-server `ContainerAgentExecutor`, not a public
method — there is also a Cloudflare-facade class of the same name; the shared-server one is
meant). A design source therefore has to be **fetchable server-side and renderable to
text**. Two consequences fall out of this immediately:

- **No MCP path.** No MCP is wired in the harness. Figma's *local* Dev Mode MCP server is
  bound to the desktop app (useless in a container), and Figma's *remote* MCP server gates
  the `mcp:connect` OAuth scope to catalog clients only (VS Code, Cursor, Claude Code) — a
  backend integration can't obtain it. The realistic Figma surface is the **REST API**.
- **Text only on the document path.** `materializeContextFiles` writes the provider's
  `DocumentContent.body` as UTF-8 (`writeFile(..., 'utf8')`) and Pi reads text, so a
  rendered PNG can't ride the **document-provider** `.cat-context/<slug>.md` path that this
  design uses. Design context is therefore delivered as a **structured textual
  representation** (layout tree + text + components + tokens). The rendered-image **URL** is
  put on a reference line, but treat it as best-effort only: Figma's `/v1/images` URLs are
  **short-lived** (they can expire before the async run reaches the step), and most pipeline
  coding models are **not multimodal** and have no guaranteed `web_fetch` for these jobs. So
  v1 does **not** depend on the agent ever fetching the pixels.
- **Pixels now have a separate home (post-#323).** Inlining design *images* is out of scope
  for the document path above, but it is **no longer architecturally blocked**: PR #323
  landed runtime-neutral **binary-artifact storage** (`BinaryArtifactStore`, R2/S3/Postgres)
  and a **Visual Confirmation gate** whose UI tester materializes human-supplied
  **reference design screenshots** into `.cat-context/reference-screenshots/` (from
  `kind:'reference'` binary artifacts; see [`visual-confirmation.md`](./visual-confirmation.md)).
  A Figma frame's rendered PNG is exactly such a reference image, so the natural follow-up
  for visual design intent is to feed that render into the binary-artifact store as a
  `kind:'reference'` artifact for the visual-confirmation gate — a **distinct** surface from
  the textual document context this doc specifies, not a change to the text-only context-file
  path. Out of scope for v1, but called out so the two surfaces aren't conflated.

## One design serves both sources

The repo already has the machinery: the **documents integration**. Its
`DocumentSourceProvider` port (`backend/packages/kernel/src/ports/document-source.ts`) is
source-agnostic and already spans three different auth models — Notion (fixed-host token),
Confluence (per-site Basic + SSRF guard), GitHub docs (App installation; the discriminator
value is `'github'`, served by `GitHubDocsProvider`). Today `documentSourceKindSchema` is
`v.picklist(['confluence', 'notion', 'github'])`. Everything downstream is keyed off a
`source` text discriminator and needs no per-source code:

- the `document_connections` / `documents` tables (one pair serves every source);
- `DocumentConnectionService`, `DocumentImportService`, `DocumentLinkService`,
  `DocumentContentResolverService` (all generic over `DocumentSourceKind`);
- `AgentContextBuilder.resolveLinkedContext`
  (`backend/packages/orchestration/src/modules/execution/AgentContextBuilder.ts`) → the
  `buildContextFiles` helper in `ContainerAgentExecutor.ts`, which materializes **any**
  linked document into `.cat-context/<slug>.md`.

So both Figma and Claude Design become **new `DocumentSourceProvider`s**
(`source='figma'`, `source='claude-design'`). The only per-source code is inside
`normalizeConnection` + `fetchDocument`; the visual/token rendering is fully contained
there and its *output* is still Markdown text — exactly `DocumentContent.body`, exactly
what `.cat-context/` and Pi consume. A parallel `DesignSourceProvider` port/table was
rejected: it would duplicate the table, the cipher wiring, the link plumbing, the
controller, both runtimes' repos, the conformance assertion and the frontend connect
surface for zero behavioural gain.

This makes the two sources **architecturally equal**. Where they differ is **how buildable
each is today**.

## Source comparison (the investigation finding)

|                                  | **Figma**                                                                                 | **Claude Design**                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-fetchable API             | **Yes** — REST at `api.figma.com`, `X-Figma-Token` header                                 | **Partial** — design-system project files are readable (HTML/components), but the read is bound to a **claude.ai login**, not a service token                       |
| Per-workspace sealed credential  | **Yes** — a Figma PAT, sealed exactly like Notion/Confluence                              | **Not today** — no documented server-to-server token; works under a single login (e.g. local mode), not multi-tenant hosted                                         |
| Immediate no-API path            | n/a                                                                                       | **Yes** — an exported **handoff bundle** (HTML + design-system rules) / HTML / PDF, committed into the repo (agents read it natively) or attached as a document      |
| MVP verdict                      | **Build now** (PAT provider)                                                              | **Defer the provider** unless the export-bundle shell adds value over plain document upload (see §3); otherwise wire it when the credentialed live project-read API lands |

**Evidence for Claude Design's programmatic surface.** Claude Design exposes design-system
**projects** that are readable programmatically — list the paths, read a file's content
(HTML/component previews, capped at 256 KiB) — plus a `/design-sync` code↔canvas round-trip
and **handoff-bundle / HTML / PDF / PPTX exports**. Anthropic has stated that
build-your-own integrations with Claude Design are imminent. The blocker for a *hosted,
multi-tenant* backend is purely auth: that programmatic read authenticates as the user's
claude.ai login, not a per-workspace service token, so it doesn't yet fit the
sealed-per-workspace-credential model the way Figma's PAT does. Until that lands, Claude
Design's usable path is the **export bundle**: the design is already HTML/Markdown, so it
needs no live API at all.

> **Claude Code → Figma (the reverse flow) is out of scope.** Claude Design's Figma plugin
> / "Code to Canvas" turns generated code *into* editable Figma layers. That's
> design-*authoring* driven from an interactive client, the opposite direction from
> design→agent-context, and not something a headless backend consumes. Noted so it isn't
> conflated with this integration.

**Net:** one unified design. Figma is fully implemented in the MVP via a PAT. Claude Design
rides the **same** provider shape, but whether its provider ships in v1 is conditional (see
§3): only if the export-bundle path does real normalization work that plain document upload
doesn't. Either way the seam is marked so the live, credentialed project-read slots in with
no re-architecture the moment a workspace-scoped Claude Design credential exists.

## Implementation outline

Mirrors the documents pattern end-to-end. Runtime symmetry is mandatory — every change
lands in **both** facades and is asserted by the cross-runtime conformance suite.

1. **Contracts** — widen `documentSourceKindSchema`
   (`backend/packages/contracts/src/documents.ts`) to include `'figma'` and
   `'claude-design'`. Kernel re-exports, both repos, and the controller's `:source` param
   accept them for free. _(changeset)_

2. **Kernel** — no change; `ports/document-source.ts` is already generic.

3. **Providers** (`backend/packages/integrations/src/modules/documents/`, mirroring
   `NotionProvider` + `notion.logic`):
   - `figma.logic.ts` — `FIGMA_DESCRIPTOR` (kind `figma`, one secret PAT field,
     `searchable: false` → import-by-URL only); `parseFigmaRef(url)` encoding the composite
     external id `"<fileKey>:<nodeId>"` (`parseRef` returns a single string) and
     canonicalising `?node-id=` so the stored `url` is stable for auto-match;
     `figmaNodesToMarkdown` (`## Frame / ### Layout / ### Text content / ### Components
     used`); `figmaVariablesToMarkdown` (`### Design tokens`, `collection › mode › name =
     value`).
   - `FigmaProvider.ts` — `normalizeConnection` validates the PAT; `fetchDocument` applies
     the **same** manual-redirect + fixed-host-pin + capped-read SSRF pattern Notion uses.
     ⚠️ Note these helpers are **not directly reusable as-is**: in `NotionProvider.ts`,
     `safeFetch`/`assertSafeNotionUrl`/`readCappedText`/`NotionApiError` are module-private
     and hard-pinned to `api.notion.com`. So either (a) hoist a host-parameterized
     `safeFetch(host)` + capped-read + a generic `*ApiError` into a shared
     `documents/http.ts` and have both providers use it (the preferred cleanup), or
     (b) copy the pattern into Figma pinned to `api.figma.com`. Then call:
     1. `GET /v1/files/:key/nodes?ids=:nodeId&depth=N` (or `/v1/files/:key?depth=2` for a
        whole-file link) → the layout tree;
     2. `GET /v1/files/:key/variables/local` → tokens; on **403/404** (non-Enterprise plan)
        drop the section, don't fail;
     3. `GET /v1/images/:key?ids=:nodeId&format=png` → put the short-lived URL on a
        `Rendered preview:` line (no download).

     The exact endpoint paths, query params, header (`X-Figma-Token`) and the
     Enterprise-gating of `variables/local` above are taken from the Figma REST docs at
     investigation time and should be **re-verified against the current API** when the
     provider is built — treat them as the intended shape, not a frozen contract.
   - `claudeDesign.logic.ts` + `ClaudeDesignProvider.ts` — `CLAUDE_DESIGN_DESCRIPTOR`
     (kind `claude-design`); MVP `fetchDocument` renders an uploaded/pasted **handoff
     bundle / export** (HTML + design-system rules) to Markdown, with a clearly-marked TODO
     seam for the live project-read path; `normalizeConnection` documents that no server
     token exists yet.
     - ⚠️ **Decide whether the v1 shell earns its place.** On the export-bundle path there is
       no server credential, so the descriptor would have **empty `credentialFields`** (the
       generic connect modal renders nothing to fill in) and `fetchDocument` only reshapes an
       already-HTML/Markdown blob — which the *existing* document ingestion can already
       attach. The shell only pays off if it adds real value over plain document upload:
       e.g. a deterministic HTML→Markdown **design-system-rule normalizer**, or a
       `searchable:false` import-by-paste UX. If it would just pass the bundle through, do
       **not** ship the provider in v1 — list `claude-design` as a planned source and add the
       provider when the live, credentialed project-read API lands, so we don't ship a
       no-op connect surface.
   - Export both from `index.ts`; add pure `*.logic.test.ts` (render/parse, no network).
     _(changeset)_

4. **Storage** — **none**. `source` is an existing `text` column; the widened picklist is
   the only gate. No new tables, no migration, both document repos unchanged.

5. **Runtime wiring** — push the new providers in `selectNodeDocumentsDeps()`
   (`backend/runtimes/node/src/container.ts`) and the Cloudflare mirror
   `selectDocumentsDeps()`
   (`backend/runtimes/cloudflare/src/infrastructure/container.ts`), beside Confluence/Notion
   (no GitHub client needed), and widen the `documents.sources` allow-list in both.
   _(changesets: node, cloudflare; local re-exports Node)_

6. **Controller** — no change; `DocumentSourceController` is fully `:source`-parameterised.

7. **Linking to a block** — both existing mechanisms work unchanged: **import + link**
   (`POST /document-sources/figma/import {ref}` → `POST /documents/link
   {source,externalId,blockId}` → `DocumentLinkService.linkToBlock`), and **URL
   auto-extract** (`extractReferences(description).urls` already captures `figma.com` URLs
   via the generic URL regex — do **not** add a Figma-specific regex; `resolveLinkedContext`
   matches via `documents.getByUrl` iff the file was already imported, which the canonical
   `url` storage makes reliable).

8. **Prompt fragment** — `backend/packages/prompt-fragments/src/collections/figma.ts`,
   fragment `design.figma-context` (category `Design`, `appliesTo:{blockTypes:['frontend']}`):
   read the `.cat-context/*.md` layout tree as component structure; **match `Components
   used` to existing repo components before creating new ones**; honour `Design tokens`
   values; treat the preview URL as reference-only. Spread into `src/index.ts`'s
   `FRAGMENTS`. Reaches `coder` automatically (code-aware trait gate); a block/service pin
   for `spec-writer`/`architect`/`playwright`. _(changeset)_

9. **Conformance** — add a Figma connect → secret-free list → disconnect case to
   `describe('document sources')` in `backend/internal/conformance/src/suite.ts` (pure
   `normalizeConnection`, no network), so the D1⇄Drizzle parity is gated. Also add a pure
   unit assertion (in `figma.logic.test.ts`) that the host guard **rejects a redirect/URL
   off `api.figma.com`**, so the new provider's SSRF pin can't silently regress — mirroring
   the per-hop guard the Notion/Confluence providers already enforce. _(changeset)_

10. **Frontend** — reuse the generic documents surface; **no new settings panel**. (All four
    components below live under `frontend/app/app/components/documents/`.)
    `DocumentSourceConnectModal.vue` renders the connect form from the descriptor
    `credentialFields` (one PAT field for Figma); verify it handles `searchable:false`
    (import-by-URL only — Notion/Confluence already exercise both modes).
    `ContextDocumentPicker.vue` / `DocumentImportModal.vue` / `TaskContextDocs.vue` are
    source-generic — add Figma + Claude Design icons in the descriptors; optionally render
    the Figma preview thumbnail in `TaskContextDocs.vue`.

## Open questions for implementation

- Where the `documents.sources` allow-list is validated in each facade's config loader.
- **`getByUrl` auto-match is the most likely correctness trap — pin the canonicalisation
  rule before coding.** Figma share URLs carry the node as `?node-id=1-2` (**dash**
  delimiter), whereas the REST API and the stored composite external id use `1:2` (**colon**
  delimiter). `parseFigmaRef` must reconcile the two AND strip non-significant query params
  (e.g. `t=`, `m=`, `mode=`, `viewport=`) so that the `url` persisted at import time matches
  the `url` derived from a pasted task-description link at resolve time — otherwise
  `documents.getByUrl` silently fails to match and the design context never reaches the
  agent. Decide the exact significant-param set (file key + node id only, most likely) and
  cover it with a `figma.logic.test.ts` case for both URL spellings.
- Figma `/v1/files/:key/variables/local` is Enterprise-gated — handled by the drop-on-403
  fallback, but worth surfacing in the connect UI's help text.
- The shape of a Claude Design **handoff bundle** as ingested today (single HTML vs. a
  multi-file zip), and the credential model to watch for when the live project-read API
  ships.

## See also

- [`document-sources.md`](./document-sources.md) — the prose-document integration this
  design extends (the provider port, the connect/import/link surface, credential sealing).
- [`visual-confirmation.md`](./visual-confirmation.md) — the binary-artifact store + Visual
  Confirmation gate (#323). The separate, image-capable surface where a Figma frame's
  rendered PNG could land as a `kind:'reference'` artifact (the pixel path this doc's text
  path deliberately does not cover).
- `CLAUDE.md` → "Telemetry & agent-context observability" — how to inspect, after a run,
  the exact `.cat-context/*` content an agent was given (the manual-verification surface
  for this feature).
