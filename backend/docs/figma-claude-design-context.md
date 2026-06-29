# Design-context sources (Figma, Zeplin) — and the Claude Design workflow

> How **design context** (component structure, layout, design tokens, visual intent) is fed
> into the UI/frontend coding agents.
>
> **Supported backend sources:** **Figma** (`FigmaProvider`, per-workspace PAT) and **Zeplin**
> (`ZeplinProvider`, per-workspace PAT). Both are real, server-fetchable REST integrations that
> ride the shared, **source-neutral** `DesignContext` model + `renderDesignContext` renderer, so
> the abstraction is not Figma-shaped.
>
> **Claude Design is NOT a backend source** — see "Claude Design: via Claude Code, not a backend
> connector" below.

## The problem

The UI agents (`coder`, `spec-writer`, `architect`, `playwright`) get task context today only from
**prose** — Notion / Confluence / GitHub docs and tracker issues (see
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
reusing the entire documents integration — the `document_connections` / `documents` tables, the
generic `DocumentConnectionService` / `DocumentImportService` / link plumbing, the controller, and
the `.cat-context/` materialization. The only per-source code is `normalizeConnection` + `parseRef`

- `fetchDocument`, and the fetched data is mapped into a **shared, source-neutral model** before
  rendering:

* `documents/design.logic.ts` — `DesignContext` (`blocks` = frames/screens, `components`, `tokens`,
  `references`) + `renderDesignContext`, which emits `## <block>` sections, a global `### Components`,
  `### Design tokens`, and optional `### References`. Each provider only maps its own API into this
  shape; the renderer is shared, so the output isn't Figma-shaped.
* `documents/http.ts` — the shared host-pinned fetch + SSRF guard + capped read every fixed-host
  provider reuses (`createHostPinnedFetch` / `assertHostPinned` / `readCappedText`).

One **best-practice prompt fragment** serves all design sources: `design.context`
(`prompt-fragments/src/collections/design.ts`, category `Design`, `appliesTo: {blockTypes:
['frontend']}`). Pin it on a frontend service (or a block) and a `code-aware` agent (`coder`) reads
the materialised structure, matches `### Components` to existing repo components, and honours
`### Design tokens`.

## Figma

- **Auth:** a per-workspace Figma PAT (`X-Figma-Token`), sealed like Notion/Confluence.
- **Fetch:** `GET /v1/files/:key/nodes` (frame subtree) or `/v1/files/:key` (whole file) → layout
  tree + text + components; `GET /v1/files/:key/variables/local` → design tokens (Enterprise-gated;
  dropped on 403/404, never fails the import); `GET /v1/images/:key` → a best-effort short-lived
  rendered-preview URL on a `### References` line (no download — a non-multimodal agent ignores it).
- **Ref/auto-match:** `parseFigmaRef` canonicalises a `figma.com` share URL (dash node-ids, title
  segments, `&t=` params) to the stable `<fileKey>[:<nodeId>]` external id, matched by the
  `documentUrlResolver` seam regardless of URL-string differences.

The endpoint shapes were taken from the Figma REST docs and should be re-verified against the
current API when touched — treat them as the intended shape, not a frozen contract.

## Zeplin

- **Auth:** a per-workspace Zeplin PAT (`Authorization: Bearer`), sealed like Figma.
- **Fetch:** `GET /v1/projects/:id` (name), `/projects/:id/screens` (→ blocks), `/projects/:id/
components` (→ grouped components), `/projects/:id/design_tokens` (→ colours/typography/spacing).
  The screens/components/tokens reads are best-effort (a single failing section is dropped, not
  fatal), exactly like Figma's variables.
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
login** (or a `/design-login` design authorization) — `list_projects` / `list_files` / `get_file`.
There is **no per-workspace/per-user service token** a hosted, multi-tenant, headless backend could
store and use in async agent containers (which have no claude.ai login). Community "Claude design
studio" MCP servers are a different thing (local HTML/CSS generation), not a service-token read of
existing projects.

**The supported workflow** for getting Claude Design context to the agents is therefore:

1. In **Claude Code**, run **`/design-sync`** to pull a design-system project into the repo
   (component HTML + `_ds_manifest.json` + CSS), e.g. under `design/` or `docs/design/`.
2. **Commit** it. cat-factory's coding agents read the checkout natively, so the design system is
   already on disk for every run — no connector, no credential, no materialization step needed.

This is why the earlier per-user-PAT Claude Design provider (and its `user_document_connections`
store + `credentialScope` plumbing) was removed: it targeted a service-token API that does not exist.

## Next drop-in: Penpot

The next provider to add is **Penpot** (open-source, self-hostable, personal access tokens, W3C-DTCG
design tokens). It's the natural stress-test of the remaining abstraction seam: being self-hosted, it
needs a **per-site `baseUrl` credential field** — exactly the model the existing **Confluence**
provider already uses. Mapping Penpot's boards/tokens into `DesignContext` is the only new code; the
table, link plumbing, controller, and renderer are all reused.

## Out of scope (deliberately)

- **Pixels / visual confirmation.** Inlining design _images_ is the separate binary-artifact +
  Visual Confirmation surface (#323; see [`visual-confirmation.md`](./visual-confirmation.md)) — a
  Figma frame's rendered PNG could land there as a `kind:'reference'` artifact. The textual context
  this doc covers does not depend on the agent ever fetching pixels.
- **Code → canvas (the reverse flow).** Turning generated code _into_ editable design layers is
  design-authoring driven from an interactive client, the opposite direction from
  design→agent-context, and not something a headless backend consumes.

## See also

- [`document-sources.md`](./document-sources.md) — the prose-document integration this design extends
  (provider port, connect/import/link surface, credential sealing).
- [`visual-confirmation.md`](./visual-confirmation.md) — the binary-artifact store + Visual
  Confirmation gate (the image-capable surface this text path does not cover).
- `CLAUDE.md` → "Telemetry & agent-context observability" — how to inspect, after a run, the exact
  `.cat-context/*` content an agent was given (the manual-verification surface for this feature).
