# @cat-factory/prompt-fragments

## 0.10.11

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
  - @cat-factory/contracts@0.105.0

## 0.10.10

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0

## 0.10.9

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0

## 0.10.8

### Patch Changes

- Updated dependencies [076d02f]
  - @cat-factory/contracts@0.102.0

## 0.10.7

### Patch Changes

- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1

## 0.10.6

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0

## 0.10.5

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0

## 0.10.4

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0

## 0.10.3

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/contracts@0.98.0

## 0.10.2

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0

## 0.10.1

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0

## 0.10.0

### Minor Changes

- 8eaa3f2: Universal writing-style fragments for document-authoring tasks (WS2 of the
  documentation-type task initiative). Two built-in fragments — `style.anti-llmisms`
  (cut the machine-written tells: filler intensifiers, hedging, throat-clearing,
  summary-that-restates, bullet inflation) and `style.concise-actionable` (lead with
  the point, active voice, one idea per paragraph, every recommendation names an actor
  and an action) — now guide the document-authoring agents.

  They reach those agents through a new `doc-aware` capability trait, the document
  analogue of `code-aware`: the `doc-researcher` / `doc-outliner` / `doc-writer` /
  `doc-finalizer` kinds carry it on their definitions and the `doc-reviewer` companion
  carries it too, so the execution engine folds the block's selected style fragments
  into each one's system prompt via the same `AgentContextBuilder` path `code-aware`
  uses — no parallel fragment path in the prompt builders. Because the reviewer sees
  the same bodies, the style guidance is both the writer's instruction and the
  reviewer's criteria (an explicit clause in the companion prompt says so).

  A new document task is pre-seeded with both style fragments (default-on,
  user-removable like any block pin) via `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`, seeded
  onto the task's `fragmentIds` in `BoardService.addTask` — the selection default lives
  at task creation, not hard-coded in a prompt.

  The fragment "add" pickers (service, task, and workspace-default) now render their
  options as labelled per-category sections instead of one flat list, so the catalog
  stays navigable now that a block can pin across two tracks at once — the technical
  collections (Node / React / …) and the Writing-style fragments.

## 0.9.55

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0

## 0.9.54

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0

## 0.9.53

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0

## 0.9.52

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0

## 0.9.51

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0

## 0.9.50

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0

## 0.9.49

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0

## 0.9.48

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0

## 0.9.47

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0

## 0.9.46

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/contracts@0.86.0

## 0.9.45

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0

## 0.9.44

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0

## 0.9.43

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0

## 0.9.42

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0

## 0.9.41

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3

## 0.9.40

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2

## 0.9.39

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1

## 0.9.38

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0

## 0.9.37

### Patch Changes

- Updated dependencies [d7f6e1c]
  - @cat-factory/contracts@0.80.1

## 0.9.36

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0

## 0.9.35

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0

## 0.9.34

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1

## 0.9.33

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0

## 0.9.32

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0

## 0.9.31

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0

## 0.9.30

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/contracts@0.75.0

## 0.9.29

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0

## 0.9.28

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0

## 0.9.27

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0

## 0.9.26

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0

## 0.9.25

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1

## 0.9.24

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0

## 0.9.23

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/contracts@0.69.0

## 0.9.22

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0

## 0.9.21

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0

## 0.9.20

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1

## 0.9.19

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0

## 0.9.18

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0

## 0.9.17

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0

## 0.9.16

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0

## 0.9.15

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/contracts@0.62.0

## 0.9.14

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/contracts@0.61.0

## 0.9.13

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/contracts@0.60.0

## 0.9.12

### Patch Changes

- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0

## 0.9.11

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0

## 0.9.10

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0

## 0.9.9

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1

## 0.9.8

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0

## 0.9.7

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0

## 0.9.6

### Patch Changes

- Updated dependencies [915861c]
  - @cat-factory/contracts@0.54.0

## 0.9.5

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/contracts@0.53.0

## 0.9.4

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0

## 0.9.3

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0

## 0.9.2

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/contracts@0.50.1

## 0.9.1

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0

## 0.9.0

### Minor Changes

- e0f1149: Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

  - **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
    REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
    workspace connects it.
  - **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
    `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
    The per-source prompt fragments collapse into a single `design.context` fragment.
  - **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
    (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
    multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
    descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
    (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
    removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
    now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
    `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
    pre-1.0 policy there is no data migration.

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0

## 0.8.9

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0

## 0.8.8

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0

## 0.8.7

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0

## 0.8.6

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1

## 0.8.5

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/contracts@0.45.0

## 0.8.4

### Patch Changes

- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/contracts@0.44.0

## 0.8.3

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3

## 0.8.2

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2

## 0.8.1

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1

## 0.8.0

### Minor Changes

- eab73b8: feat(documents): add Claude Design as a per-user design-context document source

  Implements the Claude Design half of the design record in
  `backend/docs/figma-claude-design-context.md`. Claude Design becomes a new
  `DocumentSourceProvider` (`source='claude-design'`) that reuses the whole documents
  integration (link plumbing, controller, `.cat-context/` materialization, prompt
  fragment), with a deterministic design-system normalizer that turns a project's
  `_ds_manifest.json` / `@dsCard`-marked component HTML + CSS custom properties into the
  same `### Components` / `### Design tokens` Markdown shape the Figma provider emits — so
  it earns its place over a plain HTML upload.

  Auth is a **personal per-user PAT**, supported on every runtime: a new descriptor flag
  `credentialScope: 'user'` routes such a source to a new per-user
  `user_document_connections` store (D1 ⇄ Drizzle, encrypted at rest under a distinct HKDF
  info), keyed by the acting user and never shared with the workspace. `DocumentConnectionService`
  becomes scope-aware; the import path threads the acting user. Workspace-scoped sources
  (Notion/Confluence/GitHub/Figma/Linear) are unchanged. The acting user falls back to the
  empty user id ONLY when auth is disabled (dev-open / single-user local mode) so those
  deployments still connect; when auth is enabled the controller fails closed with a 401
  rather than silently using the shared empty-user bucket.

  Claude Design is **opt-in**, not on by default: its credentialed project-read API is
  still provisional (the read is claude.ai-login-bound, no per-user service token yet), so
  it is excluded from the default `DOCUMENT_SOURCES` set and must be enabled explicitly
  (`DOCUMENT_SOURCES=…,claude-design`) once the API is real — every other source stays on
  by default.

  Also hoists the host-pinned `safeFetch`/SSRF guard/capped-read into a shared
  `documents/http.ts` reused by Figma and Claude Design. Wired symmetrically into both
  facades and gated by a new cross-runtime conformance case (per-user connect → list →
  disconnect).

- eab73b8: feat(documents): add Figma as a design-context document source

  Implements the Figma half of the design record in
  `backend/docs/figma-claude-design-context.md`. Figma becomes a new
  `DocumentSourceProvider` (`source='figma'`) authenticated by a per-workspace
  personal access token, reusing the whole documents integration (connection table,
  sealing, link plumbing, controller, `.cat-context/` materialization). `fetchDocument`
  renders a frame/file's layout tree, text, components-used and (Enterprise-gated)
  design tokens to Markdown, with a best-effort rendered-preview URL on a reference
  line. Wired symmetrically into both the Cloudflare and Node facades (and the
  `DOCUMENT_SOURCES` allow-list), gated by a cross-runtime conformance case. Adds the
  `design.figma-context` prompt fragment for frontend agents. (Claude Design ships in a
  companion changeset.)

  Also makes a URL pasted into a block description auto-match its imported document by the
  document's stable `(source, externalId)` — canonicalised through the providers'
  `parseRef` (`AgentContextBuilder.documentUrlResolver`) — instead of by exact URL-string
  equality, which silently failed for a real Figma share link (title path segment, dash
  node id, `&t=` tracking params) whose canonical stored `url` omits that noise.

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0

## 0.7.41

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0

## 0.7.40

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0

## 0.7.39

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1

## 0.7.38

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/contracts@0.40.0

## 0.7.37

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0

## 0.7.36

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0

## 0.7.35

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0

## 0.7.34

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0

## 0.7.33

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0

## 0.7.32

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/contracts@0.34.0

## 0.7.31

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0

## 0.7.30

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0

## 0.7.29

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0

## 0.7.28

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0

## 0.7.27

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0

## 0.7.26

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/contracts@0.28.0

## 0.7.25

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/contracts@0.27.0

## 0.7.24

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/contracts@0.26.0

## 0.7.23

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1

## 0.7.22

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0

## 0.7.21

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0

## 0.7.20

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0

## 0.7.19

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0

## 0.7.18

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0

## 0.7.17

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0

## 0.7.16

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0

## 0.7.15

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0

## 0.7.14

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1

## 0.7.13

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0

## 0.7.12

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/contracts@0.16.0

## 0.7.11

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0

## 0.7.10

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0

## 0.7.9

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1

## 0.7.8

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0

## 0.7.7

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/contracts@0.12.0

## 0.7.6

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0

## 0.7.5

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0

## 0.7.4

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0

## 0.7.3

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/contracts@0.8.0

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/contracts@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/contracts@0.7.1

## 0.7.0

### Minor Changes

- 8d11833: Companion agents + acceptance-test rework (the structured spec replaces the
  client-only scenario surface), plus a vocabulary split so "requirements" (the
  linked-prose context review) and "spec" (the structured in-repo document) are no
  longer the same word.

  - **Companion agents.** A companion grades a prior producer step's output, returns
    an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
    loops the producer back for automatic rework BEFORE a human is asked, failing the
    run (`companion_rejected`) once the rework budget is spent. Companions declare an
    allow-list of target kinds and are placed as their own chain step in the pipeline
    builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
    `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
    companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
    revision path shared with the human "request changes" flow).
  - **Companion-gated requirements rework.** The per-block requirements review's
    rework step is now gated by a quality companion: below threshold the reworked doc
    is NOT accepted (the review stays `ready`), and the companion's challenge is
    surfaced in the review window and fed into the next rework. Persisted on
    `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
  - **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
    the structured Given/When/Then acceptance scenarios live in the service spec
    (authored by the `spec-writer`, reviewed on its gated step) and are derived into
    Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
    writes the runnable tests. `spec-writer`'s prompt now treats complete
    acceptance-scenario coverage as a first-class deliverable.
  - **`architect` is now a container agent** that explores the repo (read-only, like
    `analysis`) before proposing. Both read-only kinds share one reusable execution
    path: a new harness `/explore` endpoint (dispatch kind `explore`) clones the branch,
    runs the agent read-only and returns its prose report/proposal — making no commit,
    opening no PR, and (unlike `/run`) NOT treating an edit-free run as a failure. A
    shared read-only guardrail is appended to their system prompts.
  - **Companion rework correctness.** When a companion loops a producer back, EVERY step
    between the producer and the companion is now reset and re-run (clearing stale
    container job handles), so an intermediate container step re-dispatches fresh work
    instead of re-attaching to its evicted job. The automatic rework budget now counts
    only automatic attempts (`companion.attempts`); a human "request changes" on a
    companion's gate re-runs the producer without consuming it.
  - **Rename: requirements → spec** for the structured family. In-repo `requirements/`
    → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
    relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
    `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
    `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
    `requirement_reviews`) keeps the `requirements` name.

  The harness image changed (the `/requirements` endpoint + `requirements/` paths
  became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
  `deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.

- 88b3170: Separate reusable libraries from deployment. The libraries now publish to npm
  (`main`/`exports` point at built `dist`, with `files` + `publishConfig`); the
  worker is no longer private and exposes its handler + Durable Object / Workflow
  classes for deployments to re-export, and ships its D1 migrations. The frontend
  SPA is now the `@cat-factory/app` Nuxt layer. Deployments live in `deploy/backend`
  and `deploy/frontend`; the runner image publishes to GHCR. Releases are managed
  with changesets.
- 8eed95b: Service-scoped best-practice prompt fragments, delivered by agent traits.

  A service (frame block) now owns an explicit selection of best-practice / guideline
  fragments — its programming standards — chosen from the **universal fragment pool**.
  That pool is the built-in catalog plus any fragments a deployment registers at startup
  via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
  `registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
  merged pool. A workspace can also configure a **default set new services inherit**
  (`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
  `serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

  Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
  standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
  to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

  - **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
    selected fragments are folded into the agent's system prompt, unioned with the block's
    own manual pins. Other kinds keep only their block pins.
  - **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
    read the in-repo `spec/` artifact (overview.md → rules.md → features/\*.feature →
    spec.json) and treat it as the source of truth for required behaviour.

  This **replaces the automatic per-run relevance selector**: fragment delivery is now
  explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
  run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
  The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
  management surface but no longer feeds the run path.

  Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
  and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
  `D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
  `DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
  asserting the workspace-default round-trip, new-service inheritance, and the
  code-aware-only folding on both facades. The UI adds a per-service "Service best
  practices" picker in the inspector and a "Default service best practices" workspace
  settings panel.

  BREAKING (Node facade dev/test only): the Drizzle migration lineage under
  `runtimes/node/drizzle/` was squashed into a single fresh baseline migration — the prior
  incremental migrations had a forked, non-commutative history (left by merging two
  branches) that broke `drizzle-kit generate`/`check`. There are no production Postgres
  deployments, so existing dev/test databases should be dropped and re-created from the
  new baseline rather than migrated. CI now runs `db:check` to keep the lineage honest.

### Patch Changes

- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- Updated dependencies [fe53445]
- Updated dependencies [d94e75c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [0972696]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [8eed38c]
- Updated dependencies [268c15d]
- Updated dependencies [157cd02]
- Updated dependencies [db77061]
- Updated dependencies [57d70fa]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [553a67d]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [de5a9d7]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
