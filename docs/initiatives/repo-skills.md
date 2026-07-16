# Repo-sourced Claude Skills — account library + executable pipeline step

## Goal & rationale

Teams author **Claude Skills** in their repositories — a directory (conventionally
`.claude/skills/<skill>/`) containing a `SKILL.md` (YAML frontmatter `name`/`description` +
a markdown body of procedural instructions) plus optional sibling resource files (templates,
scripts, checklists). Today the platform cannot discover these, hold them anywhere, or run
one as part of a delivery pipeline.

**End state:**

1. **Loading** — skills defined in repos are synced into the **account tier** (shared across
   the account's workspaces): a `skill_sources` link (repo + dir) is synced into
   `account_skills` rows, mirroring the repo-sourced prompt-fragment machinery (ADR 0006).
2. **Execution** — a loaded skill runs as a pipeline step via **ONE generic parametrized
   `skill` agent kind** (`container-coding`, selected per step through
   `stepOptions[i].skillId`) — NOT a dynamic agent kind per skill.
3. **Freshness** — layered staleness handling so the platform never executes a stale skill:
   push-webhook-triggered targeted resync + a dispatch-time head-commit probe (self-verifying
   cache slice) + per-run version pinning (`skillVersion: { skillId, commit, sha }` on the
   run step).
4. **Harness** — native `~/.claude/skills` materialisation for the `claude-code` subscription
   harness (the job body carries the resolved skill payload; the harness writes
   `CLAUDE_CONFIG_DIR/skills/<name>/` before launching the CLI); prompt + `.cat-context/skill/*`
   injection for the Pi / codex harnesses. Skills are **step-only** — they are NOT a second
   fragment-like passive-context surface (fragments already cover passive guidance).

### Key decisions (settled — do not re-litigate per slice)

- **One parametrized kind, not kind-per-skill.** `AgentKindRegistry` is deployment-static
  composition-root data; skills are tenant runtime data. Per-tenant dynamic kinds would leak
  tenant state into an app-owned registry and break the snapshot/palette contract.
  `stepOptions` is the designated extensible per-step params seam
  (`docs/initiatives/pipeline-step-options.md`).
- **Dedicated tables, not a discriminator on `prompt_fragments`.** Skills differ in
  consumption (an executable step vs prompt garnish folded into other agents), shape
  (directory-per-skill + a resource manifest vs file-per-fragment) and cache lifecycle. The
  shared **sync mechanics** are instead extracted into a reusable helper (see target
  pattern) and `FragmentSourceService` is refactored onto it — shared design over
  copy-the-shape.
- **Instructions + resource manifest are persisted on our side**; resource bodies are
  fetched at the skill's immutable `pinned_commit` at dispatch. The run path never *depends*
  on a live GitHub fetch — a probe/GitHub failure degrades to the last-synced content.

## Target pattern

The reference implementations to copy per slice:

- **Sync**: `FragmentSourceService` (`backend/packages/agents/src/fragmentLibrary/`) — link a
  repo dir per tier, pin the dir's head commit via `githubClient.latestCommitSha` BEFORE
  reading, blob-sha-keyed idempotent upserts, id-keyed tombstone sweep, `status()` = one
  commit probe. Skill ids are namespaced `src:<sourceId>:<dirName>`.
- **Per-step param**: `stepOptionsSchema.autoRecommend`
  (`docs/initiatives/pipeline-step-options.md`) — a field on the JSON bag, no column, copied
  onto the run step in `ExecutionService`, read as `step.stepOptions`.
- **Registered kind**: `code-commenter` / `repro-test` (`backend/packages/agents/src/agents/kinds/`)
  — `container-coding` with `noChangesTolerated: true` so an analysis-only skill run still
  succeeds.
- **Cache slice**: `fragmentDocumentBody` (`backend/packages/caching/src/appCaches.ts`) — a
  self-verifying version-probed slice; the new `skillCatalog` slice (grouped by account id) is
  **pass-through in `ISOLATE_SAFE_APP_CACHES_PROFILE`** (own mutable D1 state, like
  `repoProjection`).
- **Webhook fan-out**: `WebhookService` `case 'push'` — the existing `repoFilesCache`
  invalidation shows where the skill-source resync enqueue goes (via the shared queue paths:
  Worker queue ⇄ Node pg-boss `github.sync`).
- **Optional engine dep**: `fragmentResolver` in `AgentContextBuilder` — the new
  `skillResolver` mirrors it (unwired ⇒ a clear `ValidationError`, never a silent wrong run).

## Slice checklist

| # | Slice                                                                                                                                                                                                                                                                                                                                       | Status | PR  |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 0 | Tracker (this doc)                                                                                                                                                                                                                                                                                                                          | done   | —   |
| 1 | **Data + sync core**: shared `repo-source-sync` helper extraction + `FragmentSourceService` refactor; kernel ports (`SkillSourceRepository`, `AccountSkillRepository`); `skill_sources` + `account_skills` D1 ⇄ Drizzle + conformance; `SkillSourceService` / `SkillCatalogService`; `AppCaches.skillCatalog`; contracts + `SkillLibraryController` (account tier) + facade wiring | todo   | —   |
| 2 | **Execution**: `stepOptionsSchema.skillId`; `registerSkillAgentKind` (surface `container-coding`, `noChangesTolerated`); `AgentRunContext.skill`; `skillResolver` in `AgentContextBuilder` + facade wiring; `ContainerAgentExecutor` harness-aware rendering (top-level `skill` job-body field); executor-harness native claude-code skills write + image-tag bump; pipeline-save validation; per-run `skillVersion` pinning | todo   | —   |
| 3 | **Frontend**: `skill` palette block + per-step skill picker bound to `stepOptions[i].skillId`; snapshot `skills` list; account-settings Skills management UI (link/sync/status); i18n in ALL locales                                                                                                                                          | todo   | —   |
| 4 | **Freshness automation**: push-webhook `skill-source-resync` enqueue + queue handler (both runtimes); dispatch-time self-verifying probe on `skillCatalog` (per-source `latestCommitSha`, degrade to last-synced on failure)                                                                                                                  | todo   | —   |

Wrap-up: convert this tracker into an ADR under `backend/docs/adr/` and delete it (repo rule).

## Conventions & gotchas carried between iterations

- **Keep the runtimes symmetric.** Every table/repo/queue-handler lands D1 ⇄ Drizzle together
  with a conformance assertion; the facade wiring (skill controller deps, `skillResolver`)
  lands in ALL THREE facades (Worker / Node / local) in the same slice.
- **Sync semantics** (mirror fragments exactly): pin the head commit BEFORE reading; a
  malformed / transiently unreadable `SKILL.md` keeps the prior row alive (never retire a
  skill over a transient error); tombstone-sweep by skill id, not path. One extra wrinkle vs
  fragments: a **resource-only change** advances the dir head without changing `SKILL.md`'s
  blob sha — re-list the resource manifest whenever the pinned commit moved, not only when
  `SKILL.md` changed.
- **Resource bounds**: manifest stores `{path, sha, size}` only (no bodies); dispatch fetches
  text files at `pinned_commit`, capped (~48 KB/file, ~200 KB total); oversized/binary files
  are referenced by repo path in the prompt instead of materialised.
- **Rename = new identity.** A renamed skill directory produces a new `src:<sourceId>:<dir>`
  id and tombstones the old one; pipeline steps referencing the old id fail cleanly at
  dispatch (typed error through the normal step-failure path) and show a warning badge in the
  builder. Acceptable pre-1.0; no alias table.
- **`skill` job-body field is top-level, never a context file** — the agent-context snapshot
  copies `contextFiles` verbatim, and harness-side handling (native skills write) keys off the
  dedicated field (the `JobPackageRegistrySpec` precedent).
- **Harness change ⇒ image-tag bump ritual** (slice 2): bump `@cat-factory/executor-harness` +
  the three pins (`deploy/backend/package.json`, `deploy/backend/wrangler.toml`,
  `RECOMMENDED_HARNESS_IMAGE` in `runtimes/local/src/harnessImage.ts`) — `pnpm sync:image-tags`
  reconciles; `check-runner-image-tag` is the CI guard.
- **Worker cache profile**: `skillCatalog` MUST be pass-through in
  `ISOLATE_SAFE_APP_CACHES_PROFILE` (no cross-isolate invalidation bus for our own mutable D1
  state).
- **No N+1**: one installation resolve per sync; per-source (not per-skill) freshness probes;
  the webhook lookup rides an index on `skill_sources(repo_owner, repo_name)`; snapshot skills
  come from the account catalog cache in one read.
