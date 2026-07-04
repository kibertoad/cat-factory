# Initiative: documentation-type task improvements

**Status:** planned (tracker only — no code yet) · **Owner:** core · **Started:** 2026-07-04

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

Documentation-type tasks (a task whose deliverable IS a written document — PRD, RFC, ADR,
design doc, runbook, research report, …) should be a first-class, high-quality authoring
experience, not "a coder task that happens to write Markdown". The requested capabilities:

1. **Document type selection** — pick the document type up front, with per-type prompts,
   **templates**, and **linkable good-example documents** guiding the author agents.
2. **Universal stylistic recommendation fragments** — reusable style guidance folded into
   every document-authoring prompt, with two built-ins enabled by default:
   **anti-LLM-isms** and **concise & actionable**.
3. **Per-type specific fields** — the task form asks for the fields that matter for the
   chosen type (an ADR's considered options, a runbook's escalation path, …).
4. **Interactive review sessions** — flesh the document out **together with the user** in
   an iterative Q&A/review loop, not a single fire-and-forget gate.
5. **Store end results as Markdown documents on the repo** — the committed file is the
   durable artifact.
6. **Quality gates** — programmatic checks a document must pass before it ships.

**Important scoping fact:** a substantial forward document-authoring track ALREADY exists
(the `pl_document` / `pl_document_quick` pipelines, the `doc-*` agent kinds, the `DocKind`
taxonomy, doc fields on the task form, and the repo-committing PR lifecycle). This
initiative is therefore mostly **gap-closing on top of that track**, not a green-field
build. The "Current state" section below maps each requested item to what exists so a later
iteration doesn't re-implement what's already there.

## Current state (what already exists — do NOT rebuild)

| Requested capability        | What exists today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Verdict                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1. Type selection + prompts | `DOC_KINDS` picklist (10 kinds: prd/rfc/adr/design/technical/api/runbook/research/reference/other) in `backend/packages/contracts/src/primitives.ts`; per-kind one-line structure hints (`DOC_KIND_STRUCTURE`) + default target dirs (`DOC_KIND_DIR`) in `backend/packages/agents/src/agents/kinds/document.ts`; `docKind` select in `AddTaskModal.vue`.                                                                                                                                                 | **Partial** — no full templates, no exemplars |
| 2. Stylistic fragments      | The fragment machinery exists (`@cat-factory/prompt-fragments` `FRAGMENTS` + `registerPromptFragment`/`universalFragments()`; folding via `FragmentLibraryService.resolveBodiesForRun`) — but ALL four built-in collections are technical (node/react/acceptance/design), **and folding only fires for kinds carrying the `code-aware` trait**, which the `doc-*` kinds do not.                                                                                                                          | **Missing**                                   |
| 3. Per-type fields          | `taskTypeFieldsSchema` (`contracts/src/primitives.ts`) is the sparse, migration-free per-task-type field bag; documents already have `docKind`, `audience`, `targetPath` (validated by `isSafeDocPath`), `outlineHints`, read by `docFields()` in `document.ts` and rendered in `AddTaskModal.vue`. Fields are shared across ALL doc kinds — nothing kind-conditional.                                                                                                                                   | **Partial** — no kind-specific fields         |
| 4. Interactive review       | `pl_document` has two HUMAN GATES (approve the outline; approve the converged draft) — single approve/revise checkpoints, not a conversation. The platform HAS two reference interactive-loop patterns: the requirements-review parked loop (`RequirementReviewService` + `RequirementsReviewWindow.vue`) and the initiative interview (`InitiativeInterviewService` + `InitiativeInterviewController`, the `initiative-interviewer` step of `pl_initiative`). Neither is wired into the document track. | **Missing** (patterns exist, not applied)     |
| 5. Markdown stored on repo  | Fully implemented: `doc-writer` (container-coding, non-`pr` clone) writes `docs/<kind>/<slug>.md` and opens a PR; `doc-finalizer` polishes on the PR branch; the `conflicts → ci → merger` tail merges it. Nothing persisted to a table — the committed file is the artifact.                                                                                                                                                                                                                            | **Done**                                      |
| 6. Quality gates            | Quality is enforced only by the `doc-reviewer` **companion** (AI-to-AI rework loop, `agents/src/agents/kinds/companions.ts`) + a human gate. There is NO programmatic gate: nothing checks required sections per kind, link validity, target-path/kind agreement, or style-fragment compliance. The gate seam is ready: `registerGate` (`kernel/src/domain/gate-registry.ts`), built-ins in `@cat-factory/gates`, worked custom example (`license-check`) in `backend/internal/example-custom-agent`.    | **Missing**                                   |

Related but distinct (don't confuse): the `documents` module in
`backend/packages/integrations` is about **importing external docs** (Confluence/Notion/…)
as context, and `documenter`/`business-documenter`/`blueprints` are **reverse**
documentation of existing code. This initiative concerns only the FORWARD authoring track.

## Workstreams (the target pattern per gap)

### WS1 — per-type templates + linkable exemplar documents

Upgrade the per-kind guidance from a one-line structure hint to a real template + examples:

- **Template registry**: a per-`DocKind` Markdown skeleton (required + optional sections,
  with per-section guidance comments) living next to `DOC_KIND_STRUCTURE` in
  `@cat-factory/agents` (`agents/kinds/document.ts` or a sibling `doc-templates.ts`).
  Woven into the `doc-outliner` prompt (outline must cover the required sections) and the
  `doc-writer` prompt (start from the skeleton). Deployment-overridable through the same
  public seam pattern as `registerPromptFragment` (a `registerDocTemplate(kind, template)`
  registry — see the registry-DI initiative before adding another module-global Map). This
  code-defined skeleton is the **fallback** — see the workspace-linked override below.
- **Workspace-linked template override**: a workspace may instead point a `DocKind` at a
  real document it already owns — most commonly a Markdown file living in one of its own
  GitHub repos (e.g. `docs/templates/rfc.md`) — and have that become the effective template
  for the kind, in place of the built-in skeleton. This reuses the **existing `documents`
  integration end-to-end and adds no new fetch/content machinery**: the file is read through
  the already-shipped `github` `DocumentSourceKind` (`GitHubDocsProvider`, blob-URL/raw-URL/
  `owner/repo:path` ref parsing, installation-scoped `GitHubClient.getFileContent`) exactly
  like any other linked doc, and its body reaches the outliner/writer through the same
  `DocumentContentResolver` / `linkedContextSection` materialisation path a task-context link
  already uses. Because the mechanism is source-agnostic, the same override works unchanged
  for a template that instead lives in Confluence/Notion/Figma/Zeplin/Linear — GitHub is just
  the expected common case, not a special-cased path.
- **Exemplar links**: per-kind "good example" document URLs the author agents are pointed
  at. Two tiers: built-in curated exemplars (public classics per kind) + per-workspace
  overrides. Workspace exemplars ride the SAME existing linked-context path as the template
  override above — no new content-fetch machinery; the writer receives the exemplar body via
  `linkedContextSection`/materialised context like any linked doc.
- **One shared linking primitive, two roles.** A template link and an exemplar link are the
  same kind of thing — "a `SourceDocument`, scoped to a workspace + `DocKind` rather than to
  one block" — so they should NOT become two parallel tables/paths. Model it as a `role`
  discriminator (`'template' | 'exemplar'`) on a workspace+`DocKind`-scoped link, sitting
  alongside (not replacing) the existing block-scoped `linkedBlockId` anchor on `documents` /
  `sourceDocumentSchema`. `role: 'template'` is singular per kind (linking a new one replaces
  the prior override; unlinking falls back to the built-in skeleton); `role: 'exemplar'` stays
  multi-valued (additive list). Both resolve through the one `DocumentLinkService` /
  `DocumentRepository` read path — the only new surface is the `role`/`docKind` tagging, not a
  second fetch/registry mechanism.
- The required-section list from the template (built-in or workspace-linked) is ALSO the
  input to the WS4 quality gate (single source of truth — don't duplicate the section list
  in the gate).

### WS2 — universal stylistic fragments (anti-LLM-isms, concise & actionable)

- New collection `backend/packages/prompt-fragments/src/collections/style.ts`, spread into
  `FRAGMENTS`: `style.anti-llmisms` (ban the tells: "delve", "crucial", "it's important to
  note", em-dash overuse, hedging boilerplate, summary-that-restates, bullet-point
  inflation…) and `style.concise-actionable` (lead with the point, active voice, one idea
  per paragraph, cut throat-clearing, every recommendation names an actor + an action).
  Same `PromptFragment` shape (stable ids, semver `version`).
- **Folding for doc kinds**: fragment folding currently fires only for `code-aware` kinds.
  Add a `doc-aware` trait (mirroring `code-aware` in `agents/kinds/traits.ts`) carried by
  `doc-researcher`/`doc-outliner`/`doc-writer`/`doc-reviewer`/`doc-finalizer`, and teach the
  engine's fragment attachment to treat it like `code-aware` — do NOT bolt a parallel
  fragment path into `docBriefSection`.
- **Enabled by default**: the two style fragments are pre-selected for document tasks
  (default-on, user-deselectable), unlike the technical fragments which are
  relevance-selected. The selection default lives wherever the block's fragment selection
  is seeded, not hard-coded in the prompt.
- `doc-reviewer` (and the WS4 gate) receive the SAME fragment bodies as review criteria, so
  style guidance is both an instruction and a check.

### WS3 — per-type specific fields

- Extend `taskTypeFieldsSchema` with kind-specific optional fields (sparse JSON — no
  migration; this is exactly what the bag is for). Candidates: ADR — decision drivers +
  considered options; RFC — alternatives considered + rollout concerns; PRD — target users
  - success metrics; runbook — trigger/when-to-use + escalation path; research — the
    question + options to compare; api — endpoints/surface in scope.
- `AddTaskModal.vue` (and the inspector) renders the extra inputs **conditionally on the
  selected `docKind`** (the modal already branches on task type; this adds a per-kind
  branch). All labels through i18n.
- `docFields()`/`docBriefSection()` in `document.ts` fold the filled fields into the brief;
  the outliner treats them as required content for the relevant sections.
- Keep the shared quartet (`docKind`/`audience`/`targetPath`/`outlineHints`) as-is.

### WS4 — document quality gate

- New gate kind `doc-quality`, authored in `@cat-factory/gates` through the public
  `registerGate` seam (a `GateDefinition` — NOT a new evaluate/poll machine), inserted into
  `pl_document`/`pl_document_quick` after `doc-finalizer`/`doc-writer` (before
  `conflicts`); catalog `version` bumped so existing workspaces get the reseed offer.
- `probe()` runs **deterministic** checks against the PR head via `RepoFiles` (checkout-free
  reads): target file exists at `taskTypeFields.targetPath` and is Markdown; required
  sections for the `docKind` present (from the WS1 template — single source of truth);
  in-repo relative links resolve; heading hierarchy sane; no leftover template placeholder
  markers. Verdict `pass`/`fail` (no `pending` polling loop — the checks are instant; model
  after the `conflicts` gate's shape, with `pass` on the happy path so nothing spins up).
- `helperKind`: reuse `doc-finalizer`-style container fixing on the PR branch (a `doc-fixer`
  if the finalizer's contract doesn't fit), with the gate's finding list rendered into the
  helper prompt via the standard `gatherHelperPriorOutputs` path; `attemptBudget` from a
  merge-preset knob if a fixed default proves too rigid (start fixed, default 2).
- Optional LLM-graded style check (against the WS2 fragments) is a LATER slice — ship the
  deterministic gate first; the AI-quality loop already exists as `doc-reviewer`.

### WS5 — interactive review sessions

- Goal: between outline and final draft, the user can **converse** — answer the agents'
  open questions, request section-level changes, and iterate — instead of the current
  binary approve/revise human gates.
- **Reference patterns (pick, don't invent):** the requirements-review parked loop
  (`RequirementReviewService`, decision-wait park + iterate-with-cap +
  `RequirementsReviewWindow.vue`, opened via the `resultView` seam) and the initiative
  interview (`InitiativeInterviewService` — agent asks questions, user answers, loop
  continues). The expected shape: a `doc-interviewer`-style step (or an interactive mode of
  the outline/draft gates) that parks the run on the standard decision-wait, drives an
  inline LLM per exchange, persists the session transcript, and resumes the run when the
  user says "proceed" — with an iteration cap knob (merge-preset, like
  `maxRequirementIterations`).
- Design decision needed at slice start: extend the two existing human gates into
  conversational gates vs. add a dedicated interview step to `pl_document`. Decide against
  the `IterativeReviewService` base class the requirements loop already extends — reuse it
  if it fits.
- New UI is a dedicated window registered through the **universal result-view seam**
  (`resultView` on the kind's `presentation` + `STEP_RESULT_VIEWS`) — no hardcoded mounts.
  If the session needs persistence, the table mirrors D1 ⇄ Drizzle with a conformance
  assertion (runtime symmetry is mandatory).

## Per-item status checklist

Update at the end of every PR. Suggested slicing (one workstream ≈ one PR; WS5 may need
two: backend loop, then UI).

| #   | Work item                                                                                                                                                                                                                                 | Workstream | Status | PR        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | --------- |
| 0   | Tracker document (this file)                                                                                                                                                                                                              | —          | done   | (this PR) |
| 1   | Per-kind Markdown template registry (built-in fallback) + weave into outliner/writer prompts (+ prompt version bumps)                                                                                                                     | WS1        | todo   |           |
| 2   | `role`-tagged (`template`/`exemplar`) workspace+`DocKind` document link, reusing the documents integration's link/read path (`DocumentLinkService`/`DocumentRepository`, incl. the existing `github` doc source) — no new fetch machinery | WS1        | todo   |           |
| 3   | Workspace-linked template override resolution: outliner/writer prefer the `role:'template'` link's body over the built-in skeleton when one is linked for the kind                                                                        | WS1        | todo   |           |
| 4   | Built-in curated exemplar links per kind, surfaced alongside the `role:'exemplar'` workspace links from item 2                                                                                                                            | WS1        | todo   |           |
| 5   | `style.anti-llmisms` + `style.concise-actionable` fragments (new `collections/style.ts`)                                                                                                                                                  | WS2        | todo   |           |
| 6   | `doc-aware` trait + engine fragment folding for doc kinds; default-on selection for document tasks                                                                                                                                        | WS2        | todo   |           |
| 7   | Style fragments as review criteria for `doc-reviewer`                                                                                                                                                                                     | WS2        | todo   |           |
| 8   | Kind-specific `taskTypeFields` (contracts) + `docBriefSection` folding                                                                                                                                                                    | WS3        | todo   |           |
| 9   | `AddTaskModal.vue` / inspector per-kind conditional inputs (+ i18n keys in all locales)                                                                                                                                                   | WS3        | todo   |           |
| 10  | `doc-quality` gate in `@cat-factory/gates` (deterministic probe over `RepoFiles`) + helper wiring                                                                                                                                         | WS4        | todo   |           |
| 11  | Insert gate into `pl_document`/`pl_document_quick` + catalog version bump + conformance assertion                                                                                                                                         | WS4        | todo   |           |
| 12  | Interactive session backend: parked decision-wait loop + iteration cap + persistence (D1 ⇄ Drizzle) + conformance                                                                                                                         | WS5        | todo   |           |
| 13  | Interactive session UI window via the result-view seam + i18n                                                                                                                                                                             | WS5        | todo   |           |

## Conventions & gotchas carried between iterations

- **Don't rebuild what exists.** Item 5 of the original request (Markdown on the repo) is
  DONE; items 1/3 are partial. Extend `document.ts` / `taskTypeFieldsSchema` /
  `AddTaskModal.vue` in place — no parallel "doc task v2" path.
- **`taskTypeFields` is sparse JSON — kind-specific fields need NO migration.** Only WS5's
  session persistence (if any) touches schemas; that one mirrors D1 ⇄ Drizzle with a
  conformance assertion in the same PR (runtime symmetry is a showstopper, not a
  follow-up).
- **The doc kinds are registered through the public `registerAgentKind` seam** (they're
  deliberate dogfood, like `@cat-factory/gates`). Keep every addition on the public seams
  (`registerAgentKind` / `registerGate` / `registerPipeline` / `registerPromptFragment`);
  check the registry-DI initiative (`registry-di-migration.md`) before adding any new
  module-global registry — new registries should follow the app-owned pattern.
- **Single source of truth for per-kind sections**: the WS1 template feeds BOTH the
  outliner/writer prompts AND the WS4 gate's required-section check. Don't let the gate
  grow its own section list. When a `role:'template'` link overrides the built-in skeleton,
  its required sections (not the code-defined ones) become that source of truth for the
  kind, for both the prompts and the gate.
- **Templates and exemplars are ONE linking primitive, not two.** Both are a `SourceDocument`
  scoped to a workspace + `DocKind` (as opposed to the existing block-scoped link), tagged
  with a `role`. Reuse the `documents` integration's provider registry, link service, and
  repository as-is — GitHub repo documents work via the already-shipped `github`
  `DocumentSourceKind`, so this needs no new provider, no new fetch path, and no bespoke
  GitHub-only code. The only new surface is the `role`/`docKind` scoping on the link itself.
- **Fragment folding is trait-gated** (`code-aware` today). WS2 extends the trait mechanism
  (`doc-aware`); do not special-case doc kinds inside the prompt builders.
- **Editing a versioned prompt means bumping its number** (`agents/kinds/versions.ts` rule);
  any prompt-visible change to the `doc-*` kinds in WS1/WS2 bumps accordingly.
- **Pipeline catalog edits need a `version` bump** on the touched pipeline (the reseed-offer
  signal) — WS4 item 9.
- **Gate checks read via `RepoFiles`** (checkout-free GitHub reads, runtime-symmetric) —
  never a container spin-up for a deterministic check, and never point-reads in a loop
  (batch the file reads).
- **Frontend copy is i18n, always** — new fields/windows add keys to `en.json` AND all
  other locales in the same PR (the locale-parity CI check fails an `en`-only edit).
  Dynamic kind-keyed labels need the exhaustive-`Record` guard, not bare template keys.
- **Changesets**: every touched versioned package gets one; docs-only PRs (like this one)
  get an empty changeset.
- **`FINAL_ANSWER_IN_REPLY`**: any NEW inline kind whose deliverable is its reply (e.g. an
  interviewer/reviewer in WS5) must append the shared fragment; container kinds whose
  product is a pushed commit (writer/finalizer/fixer) must NOT.

## Out of scope

- Reverse documentation (`documenter` / `business-documenter` / `blueprints`) — separate
  track; only the forward-authoring pipeline is in scope.
- The external-document import integration (Confluence/Notion/GitHub/…) — its provider
  registry, fetch/link services, and repositories are reused as-is for both template and
  exemplar links in WS1; the only new surface is the `role`/`docKind` scoping tag on a link,
  not a new source, fetch path, or GitHub-specific mechanism.
- LLM-graded style scoring inside the quality gate (the deterministic gate ships first;
  AI quality already has the `doc-reviewer` loop).
- Migrating the built-in doc kinds' rendering into the manifest pre/post-op model — that's
  the existing custom-agents strangler work, not this initiative.
