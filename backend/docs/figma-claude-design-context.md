# Figma & Claude Design as design-context sources

> Investigation + design. This documents the chosen approach for feeding **design
> context** (component structure, layout, design tokens, visual intent) into the
> UI/frontend coding agents.
>
> **Status:** **both** providers described here are now **implemented**.
> **Figma** — `FigmaProvider` + `figma.logic.ts`, `source='figma'`, per-workspace PAT.
> **Claude Design** — `ClaudeDesignProvider` + `claudeDesign.logic.ts`,
> `source='claude-design'`, authenticated by a **personal per-user PAT** rather than a
> shared workspace credential (a product decision: the token authenticates as an
> individual). Both reuse the documents integration (link plumbing, controller,
> `.cat-context/` materialization, a `design.*-context` prompt fragment each, pure logic
> tests, and a cross-runtime conformance case) and share a hoisted host-pinned
> `documents/http.ts` (the SSRF guard + capped read). The per-user credential lands in a
> new `user_document_connections` store (D1 ⇄ Drizzle), selected by a new descriptor flag
> `credentialScope: 'user'` — see "Per-user credential scope" below. The login-bound live
> project-read this doc originally anticipated is superseded by the per-user-PAT model;
> the API endpoint shapes in `ClaudeDesignProvider` are PROVISIONAL (host-pinned,
> verify-at-build), but the design-system normalizer they feed is solid and fully tested.

## The problem

The UI agents (`coder`, `spec-writer`, `architect`, `playwright`) get task context
today only from **prose** — Notion / Confluence / GitHub docs and tracker issues (see
[`document-sources.md`](./document-sources.md)). They have no view of the **design**: the
actual frames, the component tree, the spacing/colour tokens, or which design-system
component a screen is built from. So an agent implementing a frontend task guesses at
layout, reinvents components that already exist, and ignores the team's tokens.

We want to feed design context from **Figma** and from **Anthropic's Claude Design** into
those agents. This doc records what each source can actually offer a _headless_ backend,
and the single design that serves both.

## The hard constraint: agents are headless

Agent jobs run inside containers with **no live external access** beyond the LLM proxy and
the optional web-search tools. The platform's one mechanism for getting external content to
an agent is the **`.cat-context/` materialization** pattern:

> backend fetches the content over HTTP → renders it to Markdown → writes
> `.cat-context/<slug>.md` into the checkout → the agent reads it on demand, and is told
> _not_ to reach external systems (everything is already on disk).

See `backend/internal/executor-harness/src/pi.ts` (`materializeContextFiles`,
`contextGuidance`, `CONTEXT_DIR`) and the `buildContextFiles` helper in
`backend/packages/server/src/agents/ContainerAgentExecutor.ts` (a module-private function
called from `buildJobBody()` on the shared-server `ContainerAgentExecutor`, not a public
method — there is also a Cloudflare-facade class of the same name; the shared-server one is
meant). A design source therefore has to be **fetchable server-side and renderable to
text**. Two consequences fall out of this immediately:

- **No MCP path.** No MCP is wired in the harness. Figma's _local_ Dev Mode MCP server is
  bound to the desktop app (useless in a container), and Figma's _remote_ MCP server gates
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
- **Pixels now have a separate home (post-#323).** Inlining design _images_ is out of scope
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
there and its _output_ is still Markdown text — exactly `DocumentContent.body`, exactly
what `.cat-context/` and Pi consume. A parallel `DesignSourceProvider` port/table was
rejected: it would duplicate the table, the cipher wiring, the link plumbing, the
controller, both runtimes' repos, the conformance assertion and the frontend connect
surface for zero behavioural gain.

This makes the two sources **architecturally equal**. Where they differ is **how buildable
each is today**.

## Source comparison (the investigation finding)

|                       | **Figma**                                                          | **Claude Design**                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-fetchable API  | **Yes** — REST at `api.figma.com`, `X-Figma-Token` header          | **Partial** — design-system project files are readable (HTML/components), but the read is bound to a **claude.ai login**, not a service token                                                                                                        |
| Sealed credential     | **Yes** — a Figma PAT, sealed per workspace like Notion/Confluence | **Yes** — a **personal per-user PAT**, sealed per user (`credentialScope: 'user'`); never shared with the workspace                                                                                                                                  |
| Immediate no-API path | n/a                                                                | **Yes** — an exported **handoff bundle** (HTML + design-system rules) / HTML / PDF, committed into the repo (agents read it natively) or attached as a document                                                                                      |
| MVP verdict           | **Built** (per-workspace PAT)                                      | **Built** (per-user PAT). The credentialed project-read replaces the deferred login-bound read; the API endpoint shapes are provisional/verify-at-build, but the deterministic normalizer they feed earns the provider its place over a plain upload |

**Evidence for Claude Design's programmatic surface.** Claude Design exposes design-system
**projects** that are readable programmatically — list the paths, read a file's content
(HTML/component previews, capped at 256 KiB) — plus a `/design-sync` code↔canvas round-trip
and **handoff-bundle / HTML / PDF / PPTX exports**. Anthropic has stated that
build-your-own integrations with Claude Design are imminent. The blocker for a _hosted,
multi-tenant_ backend is purely auth: that programmatic read authenticates as the user's
claude.ai login, not a per-workspace service token, so it doesn't yet fit the
sealed-per-workspace-credential model the way Figma's PAT does. Until that lands, Claude
Design's usable path is the **export bundle**: the design is already HTML/Markdown, so it
needs no live API at all.

> **Claude Code → Figma (the reverse flow) is out of scope.** Claude Design's Figma plugin
> / "Code to Canvas" turns generated code _into_ editable Figma layers. That's
> design-_authoring_ driven from an interactive client, the opposite direction from
> design→agent-context, and not something a headless backend consumes. Noted so it isn't
> conflated with this integration.

**Net:** one unified design, both halves now built. Figma rides a per-workspace PAT; Claude
Design rides the **same** provider shape but a **per-user** PAT (see "Per-user credential
scope" below) and a deterministic design-system normalizer that earns it its place over a
plain document upload (it turns a project's `_ds_manifest.json` / `@dsCard`-marked component
HTML + CSS custom properties into the `### Components` / `### Design tokens` Markdown shape
the Figma renderer also emits). The provider's REST endpoint shapes are provisional and
host-pinned (verify-at-build); the normalizer they feed is fully unit-tested independent of
the network.

## Per-user credential scope

Most document sources (Notion, Confluence, GitHub docs, Figma, Linear) store **one shared
credential per workspace**. Claude Design is different: its PAT authenticates as an
**individual's** account, so it must be stored **per user** and never shared. Rather than
fork the documents machinery, this is a small, source-declared generalization:

- The provider descriptor gains an optional **`credentialScope: 'workspace' | 'user'`**
  (absent ⇒ `'workspace'`, so every existing source is unchanged). Claude Design sets
  `'user'`.
- A new per-user store **`user_document_connections`** (D1 ⇄ Drizzle, keyed by
  `(user_id, source)`, encrypted at rest under a distinct HKDF info) mirrors the existing
  per-user precedents (`local_model_endpoints`, `personal_subscriptions`,
  `user_secrets`). It is wired into both facades beside the workspace store.
- `DocumentConnectionService` becomes **scope-aware**: it reads the acting source's
  `credentialScope` and routes connect / list / disconnect / `requireConnection` to the
  workspace or the per-user store. The import path threads the acting user; the cached
  `documents` projection stays workspace-scoped (only the _credential_ is personal, so an
  imported Claude Design page is still shared with the workspace once fetched).
- The acting user is `c.get('user')?.id`, falling back to the **empty user id** when auth
  is disabled — so single-user / local-mode deployments connect a personal source without a
  sign-in wall, exactly as runs fall back for `initiatedBy`.
- Live re-resolution of a _document-backed prompt fragment_ (the `DocumentContentResolver`
  seam) is intentionally left workspace-scoped: a personal source can't back a run-time
  live fragment yet (it throws a clear error), because that path doesn't thread the run
  initiator. The primary path — import + link + `.cat-context/` — is fully per-user.

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
     ✅ **Done (option a).** The host-parameterized `createHostPinnedFetch(host)` +
     `readCappedText` + `assertHostPinned` + `DocumentHttpError` now live in a shared
     `documents/http.ts`; Figma and Claude Design both use it (Figma keeps
     `assertSafeFigmaUrl` as a thin delegating wrapper so its SSRF unit test is unchanged).
     Notion/Confluence keep their own copies (their tested code is left untouched). Then call:
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
     (kind `claude-design`, **`credentialScope: 'user'`**, one secret PAT field,
     `searchable: false`). `normalizeConnection` validates the per-user PAT; `fetchDocument`
     lists a project's files, reads the manifest + bounded component HTML/CSS, and renders
     `renderClaudeDesignProject` → `## <project>` / `### Components` (grouped) /
     `### Design tokens`. The REST endpoints are PROVISIONAL/host-pinned (verify-at-build).
     - ✅ **The shell earns its place (the normalizer is real).** This is NOT a pass-through:
       `parseDsManifest` / `parseDsCardComment` / `extractCssTokens` deterministically pull
       the component inventory (from `_ds_manifest.json` or `@dsCard` markers) and design
       tokens (CSS custom properties) out of raw component HTML into the same Markdown shape
       the Figma renderer emits — work the generic document ingestion does **not** do. The
       connect surface is a real PAT field, not an empty form, because auth is the per-user
       PAT (see "Per-user credential scope"), not the credential-less export bundle the
       original investigation assumed.
   - Export both from `index.ts`; add pure `claudeDesign.logic.test.ts` (parse/render +
     SSRF host-pin, no network). _(changeset)_

4. **Storage** — a new **per-user** `user_document_connections` table (D1 ⇄ Drizzle),
   because Claude Design's `credentialScope: 'user'` credential can't live in the
   per-workspace `document_connections`. Workspace-scoped sources are unchanged (no
   migration touches their table); the widened picklist is the only gate for them. See
   "Per-user credential scope". _(changesets: worker, node-server)_

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
