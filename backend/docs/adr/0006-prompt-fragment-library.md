# ADR 0006: Tenant-scoped prompt-fragment library with repo sources and relevance selection

- **Status:** Accepted (implemented)
- **Date:** 2026-06-16
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/core`,
  `@cat-factory/worker`, `@cat-factory/prompt-fragments`), frontend (`app/`)

## Context

Agents compose a system prompt from a **catalog of best-practice prompt
fragments**. Today that catalog is build-static code: hand-authored collections
(`node`, `react`, `acceptance`) live in `@cat-factory/prompt-fragments`, are
served read-only via `GET /prompt-fragments`, and a block selects a subset by
storing `fragmentIds[]`. At run time `composeSystemPrompt(baseSystem,
fragmentIds)` folds the chosen bodies into the agent system prompt
(`core/src/modules/agents/prompt-fragments.ts`). Selection is entirely manual —
a human picks ids on a block — and the catalog is the same for every tenant.

The reviewer agent (the `review` phase in `standard-prompts.ts`) consumes the
same fragments. We want the reviewer's guidance to be **smart**: a PR that only
touches the frontend should not be reviewed against database or backend
guidelines, and vice-versa. Concretely we want three things the static catalog
cannot give us:

1. **A managed library, not code.** Teams curate their own guidelines and edit
   them without a deploy.
2. **Two-level ownership with inheritance.** A guideline library is defined at
   the **account** level and at the **workspace** level; a workspace can read
   everything from its parent account (per ADR 0001 / migration 0017, an account
   owns many workspaces and workspaces already inherit account-bound things like
   the GitHub installation).
3. **Guidelines that live in a repo.** Most teams already keep engineering
   guidelines as Markdown in a repo. We must be able to **link** such a repo,
   **preserve the source** (so the catalog entry remembers where it came from),
   and offer a **check-for-changes / resync** action — mirroring how
   `github_repos` projections track an upstream with a sync cursor.

On top of curation, the catalog must be **selected from intelligently per run**:
given the PR/diff at hand, pick the relevant fragments rather than injecting all
of them.

This ADR proposes the data model, ports, services, sync flow, and selection
strategy. It deliberately **does not** change how a composed prompt is folded
into an agent (`composeSystemPrompt` stays); it changes where fragments come
from and how the relevant subset is chosen.

## Decisions

### 1. Promote the catalog to a tenant-scoped projection; keep code fragments as a built-in tier

Introduce a persisted `prompt_fragments` table. A resolved catalog for a
workspace is the merge of **three tiers**, later tiers overriding earlier ones by
the fragment's stable `id`:

1. **built-in** — the existing `@cat-factory/prompt-fragments` collections,
   unchanged. They remain the source of truth for the shipped defaults and the
   seed for new accounts; they are never written to D1.
2. **account** — fragments owned by the workspace's parent account.
3. **workspace** — fragments owned by the workspace itself.

Override-by-id means a workspace (or account) can **shadow** a built-in or
account fragment by defining one with the same id, and can **suppress** one with
a tombstone row (`deleted_at`). This is the same "inherit-then-override"
behaviour the GitHub installation/repo linkage already uses: account-bound by
default, refined per workspace.

`composeSystemPrompt` is unchanged — it still takes a base prompt and a list of
fragment **bodies/ids**. The only change downstream is that ids now resolve
against the merged tenant catalog (a `FragmentCatalog` resolver) instead of the
static `FRAGMENTS_BY_ID` map. Unknown ids are still skipped so stale selections
never break a run.

### 2. One table, an `(owner_kind, owner_id)` scope, with provenance columns

```sql
-- migration 00NN_prompt_fragments.sql
CREATE TABLE prompt_fragments (
  -- Stable, globally-unique fragment id (e.g. 'react.state-management' for a
  -- built-in shadow, or 'src:<sourceId>:<path>' for a repo-sourced one).
  fragment_id  TEXT    NOT NULL,
  owner_kind   TEXT    NOT NULL,            -- 'account' | 'workspace'
  owner_id     TEXT    NOT NULL,            -- account id or workspace id
  version      TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  category     TEXT,
  summary      TEXT    NOT NULL,            -- used by the relevance selector
  body         TEXT    NOT NULL,            -- folded into the system prompt
  applies_to   TEXT,                        -- JSON { blockTypes?, agentKinds? }
  tags         TEXT,                        -- JSON string[]: 'backend','frontend','state','db',…
  -- Provenance (null for hand-authored fragments)
  source_id    TEXT,                        -- → fragment_sources.id
  source_path  TEXT,                        -- file path within the source repo
  source_sha   TEXT,                        -- blob sha last synced; powers "changed?"
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,                     -- tombstone (suppress / removed upstream)
  PRIMARY KEY (owner_kind, owner_id, fragment_id)
);
CREATE INDEX idx_prompt_fragments_owner  ON prompt_fragments (owner_kind, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_prompt_fragments_source ON prompt_fragments (source_id)            WHERE deleted_at IS NULL;
```

This keeps the existing `PromptFragment` contract shape (`id`, `version`,
`title`, `category`, `summary`, `body`, `appliesTo`) and **adds** `tags` (for
relevance), and a `source` provenance block (`{ sourceId, path, sha }`). The
`appliesTo.blockTypes/agentKinds` hints are retained as the deterministic
fallback (Decision 5).

### 3. Repo-sourced fragments: a `fragment_sources` linkage with a sync cursor

Guidelines that live in a repo are modelled like a document source / repo
projection. A new `fragment_sources` table records the link and the last-synced
state so "check for changes" is a cheap comparison, not a re-read:

```sql
CREATE TABLE fragment_sources (
  id           TEXT    NOT NULL PRIMARY KEY,
  owner_kind   TEXT    NOT NULL,            -- 'account' | 'workspace'
  owner_id     TEXT    NOT NULL,
  repo_owner   TEXT    NOT NULL,            -- GitHub owner/login
  repo_name    TEXT    NOT NULL,
  git_ref      TEXT    NOT NULL DEFAULT 'HEAD',
  dir_path     TEXT    NOT NULL DEFAULT '', -- subtree to read (e.g. 'guidelines')
  last_synced_sha  TEXT,                     -- tree/commit sha at last successful sync
  last_synced_at   INTEGER,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  UNIQUE (owner_kind, owner_id, repo_owner, repo_name, git_ref, dir_path)
);
```

A source can be linked at **either tier** (account or workspace), so an account
can publish an org-wide guidelines repo that every workspace inherits, while a
workspace can add its own. We reuse the account-bound GitHub installation and
the existing `GitHubClient` for reads — no new credential store (guidelines are
read from repos the account already connected; nothing is persisted encrypted,
unlike document-sources).

### 4. Source format: Markdown files with YAML frontmatter

Each fragment is **one Markdown file** in the source directory. Frontmatter
carries the metadata; the Markdown body is the guidance text injected into the
prompt:

```markdown
---
id: backend.error-handling          # optional; defaults to a slug of the path
title: Backend error handling
category: Node
summary: Fail fast, wrap external errors, never swallow.   # required; feeds the selector
tags: [backend, db]
appliesTo:
  blockTypes: [backend]
  agentKinds: [reviewer, coder]
---

- Validate inputs at the boundary; reject early with a typed error.
- Wrap third-party/SDK errors so call sites see one error vocabulary.
- Never catch-and-ignore; log with context or rethrow.
```

This is the most git-friendly choice (each guideline is a reviewable file, diffs
are meaningful) and keeps body authoring in plain Markdown. A file's **blob sha**
is stored as `source_sha`; the directory tree sha is the source's
`last_synced_sha`. Parsing lives in pure core logic
(`fragment-source.logic.ts`) so it is unit-testable without I/O.

### 5. Relevance selection: LLM-picked from summaries, with a deterministic fallback

Add a `FragmentSelector` port. At run time, for the agent on a block (the
reviewer especially), the selector is given:

- the **resolved catalog** reduced to `{ id, title, summary, tags, appliesTo }`
  (bodies are *not* sent — summaries keep the call cheap), and
- the **PR context**: changed file paths + diff stat from the coder's push, the
  block type, and the agent kind.

It asks the configured agent model to return the **relevant id set**, which is
then unioned with any ids the user explicitly pinned on the block
(`block.fragmentIds` stays an authoritative manual override) and handed to
`composeSystemPrompt`. The selection is recorded on the execution step so it is
observable and replay-stable.

Mirroring the `DOCUMENT_PLANNER` `llm`/`headings` pattern, selection degrades
gracefully: if no model credential is usable or the response can't be parsed, it
falls back to **deterministic matching** on `tags` + `appliesTo.blockTypes/
agentKinds` against the block type / changed-path heuristics. So review never
blocks on the selector, and an offline/test run is fully deterministic
(integration tests fake the model, per the repo's testing convention).

### 6. Async, observable resync that mirrors the projection-sync precedent

`POST …/fragment-sources/:id/sync` triggers a sync that, per source: resolves
the ref via `GitHubClient`, lists the directory tree, and for each Markdown file
whose blob sha differs from the stored `source_sha`, re-reads + re-parses it and
**upserts** the fragment row (owner = the source's owner); files removed upstream
are **tombstoned**; `last_synced_sha/at` are updated on success. "Check for
changes" (`GET …/fragment-sources/:id/status`) compares the remote ref/tree sha
to `last_synced_sha` and returns a changed-count without writing — that powers
the resync button's badge.

For the first cut sync runs inline (bounded directory, a handful of small files),
following the synchronous projection-sync calls rather than standing up a
Workflow. If guideline repos grow large this can adopt the
dispatch→durable-poll→push-events pattern (ExecutionWorkflow/BootstrapWorkflow)
later; the idempotent sha-keyed upsert makes that migration safe.

### 7. Opt-in module, assembled only when configured

Following the document-sources / GitHub precedent, the whole feature is an
opt-in module wired in `createCore` / `selectFragmentLibraryDeps` only when
enabled (`PROMPT_LIBRARY_ENABLED`, selector mode `PROMPT_LIBRARY_SELECTOR =
llm|deterministic`). When off, the static `@cat-factory/prompt-fragments`
catalog and today's manual `fragmentIds` flow are **untouched** — the resolver
simply returns the built-in tier and selection is the existing manual list.

### 8. HTTP surface: account-scoped and workspace-scoped, resolution stays one read

```
# Library CRUD (both tiers; :scope = accounts/:accountId | workspaces/:workspaceId)
GET    /:scope/prompt-fragments                 # this tier's fragments (raw, not merged)
POST   /:scope/prompt-fragments                 # create a hand-authored fragment
PATCH  /:scope/prompt-fragments/:fragmentId     # edit body/metadata/suppress
DELETE /:scope/prompt-fragments/:fragmentId     # tombstone

# Repo sources
GET    /:scope/fragment-sources                 # linked sources + last-synced state
POST   /:scope/fragment-sources                 # link a repo dir { repo, ref, dirPath }
DELETE /:scope/fragment-sources/:id             # unlink (tombstones its fragments)
GET    /:scope/fragment-sources/:id/status      # check-for-changes (no writes)
POST   /:scope/fragment-sources/:id/sync        # resync now

# Resolution (what an agent actually sees) — supersedes today's GET /prompt-fragments
GET    /workspaces/:workspaceId/prompt-fragments/resolved   # merged builtin∪account∪workspace
```

The merged read is the only one the run path needs; the per-tier reads back the
management UI. Account-scoped routes guard on account membership (the existing
`AccountService.isMember` gate); workspace routes use the existing per-workspace
authorization gate in `app.ts`.

## Layout (proposed)

- Wire contracts: extend `packages/contracts/src/entities.ts`
  (`promptFragmentSchema` gains `tags`, `source`); new
  `packages/contracts/src/fragment-library.ts` (sources, create/patch inputs,
  resolved-catalog + selection types).
- Built-ins: `@cat-factory/prompt-fragments` unchanged (now the "built-in tier").
- Core module: `packages/core/src/modules/fragmentLibrary/`
  (`FragmentLibraryService`, `FragmentSourceService`, `FragmentSelector` usage,
  pure `fragment-source.logic.ts` frontmatter parser + `fragment-catalog.ts`
  merge/resolve logic) + ports `fragment-repositories.ts`,
  `fragment-selector.ts`; assembled by `createFragmentLibraryModule` in
  `core/src/container.ts`.
- Worker infra: `D1PromptFragmentRepository`, `D1FragmentSourceRepository`,
  an `LlmFragmentSelector` (over the existing `ModelProvider`) with a
  `DeterministicFragmentSelector` fallback, `selectFragmentLibraryDeps` in
  `infrastructure/container.ts`, and `FragmentLibraryController.ts`.
- Schema: migration `00NN_prompt_fragments.sql` (the two tables above).
- Frontend: a library manager (list/edit fragments per tier, link/sync sources
  with a "changes available" badge) and surfacing the auto-selected set on the
  execution/review view.
- Tests: `test/integration/fragment-library-*.spec.ts` with a
  `FakeFragmentSelector` and a fixture guidelines repo, plus pure unit tests for
  frontmatter parsing and tier-merge resolution.

## Consequences

- The catalog becomes data: teams curate guidelines without a deploy, at account
  scope (org-wide) or workspace scope (board-specific), with workspace overriding
  account overriding built-in by stable id.
- Guidelines kept as Markdown in a repo are first-class: linked, source-preserved
  (`source_id/path/sha`), and resyncable with a cheap change check — the same
  upstream-tracking model as `github_repos`.
- Reviews get sharper and cheaper: only the fragments relevant to the PR's diff
  are injected, chosen by the model from summaries, with a deterministic
  tag/`appliesTo` fallback so runs never block and tests stay deterministic.
- `composeSystemPrompt` and the manual `block.fragmentIds` override are
  unchanged; auto-selection unions with manual pins.
- Cost: a new migration (two tables), a new opt-in module wired through the
  hexagonal stack, an extra (cheap, summaries-only) model call per agent run when
  the selector is in `llm` mode, and new HTTP surface at both scopes.
- **Open questions / deferred:** (a) no dedicated sweeper for an evicted large
  resync — acceptable while sync is inline; (b) whether `appliesTo.agentKinds`
  should hard-gate a fragment to specific agents *before* the selector sees it,
  or only inform it; (c) fragment **versioning/pinning** for reproducible replays
  (today resolution is "latest"); (d) frontmatter `id` collisions across two
  sources in the same tier (last-sync-wins vs. error) — proposed: namespace
  sourced ids as `src:<sourceId>:<path>` so they cannot collide, with the
  optional frontmatter `id` only used to *shadow* a built-in.
```
