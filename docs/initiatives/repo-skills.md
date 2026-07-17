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
  fetched at the skill's immutable `pinned_commit` at dispatch. The run path never _depends_
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

| #   | Slice                                                                                                                                                                                                                                                                                                                                                                                                                        | Status | PR        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| 0   | Tracker (this doc)                                                                                                                                                                                                                                                                                                                                                                                                           | done   | —         |
| 1   | **Data + sync core**: shared `repo-source-sync` helper extraction + `FragmentSourceService` refactor; kernel ports (`SkillSourceRepository`, `AccountSkillRepository`); `skill_sources` + `account_skills` D1 ⇄ Drizzle + conformance; `SkillSourceService` / `SkillCatalogService`; `AppCaches.skillCatalog`; contracts + `SkillLibraryController` (account tier) + facade wiring                                           | done   | (this PR) |
| 2   | **Execution**: `stepOptionsSchema.skillId`; `registerSkillAgentKind` (surface `container-coding`, `noChangesTolerated`); `AgentRunContext.skill`; `skillResolver` in `AgentContextBuilder` + facade wiring; `ContainerAgentExecutor` harness-aware rendering (top-level `skill` job-body field); executor-harness native claude-code skills write + image-tag bump; pipeline-save validation; per-run `skillVersion` pinning | done   | (this PR) |
| 3   | **Frontend**: `skill` palette block + per-step skill picker bound to `stepOptions[i].skillId`; snapshot `skills` list; account-settings Skills management UI (link/sync/status); i18n in ALL locales                                                                                                                                                                                                                         | done   | (this PR) |
| 4   | **Freshness automation**: push-webhook `skill-source-resync` enqueue + queue handler (both runtimes); dispatch-time self-verifying probe on `skillCatalog` (per-source `latestCommitSha`, degrade to last-synced on failure)                                                                                                                                                                                                 | todo   | —         |

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

### Slice 1 notes (carried forward)

- **The shared sync engine lives in `@cat-factory/agents/src/repoSourceSync/`** —
  `repo-source-sync.ts` (`syncRepoSource` / `probeRepoSourceStatus` / `normalizeDirPath`) owns
  the commit-pin-before-read + id-keyed tombstone sweep + invalidate-only-on-change mechanics;
  `frontmatter.ts` is the shared small-YAML parser. Both `FragmentSourceService` and
  `SkillSourceService` inject a `reconcile` callback for their unit shape (a Markdown file vs a
  `<skill>/SKILL.md` directory). Reuse this seam for any future repo-sourced tier rather than
  copying the loop.
- **The whole-dir head commit IS the skill staleness signal.** `SkillSourceService.sync`
  short-circuits when the source dir's head commit hasn't advanced (`!commitMoved`) — nothing
  under it changed, so every skill is `unchanged` with zero per-directory reads. A resource-only
  edit advances that commit, so it lands in the `commitMoved` path and re-lists the manifest
  even though `SKILL.md`'s blob sha is untouched (the tracker's resource-only-change wrinkle).
- **Skills are ONE tier (account).** `skill_sources`/`account_skills` key on `account_id` (not
  the fragment `(owner_kind, owner_id)` pair); `SkillLibraryController` mounts only under
  `/accounts/:accountId`. Opt-in rides the existing `fragmentLibrary.enabled` flag (both are the
  repo-sourced prompt library) — no new env var.
- **Mothership mode: skills are OFF until the RPC surfaces them.** `buildNodeContainer` overrides
  the (db-less) Drizzle skill repos with `remoteRepos.*`, which are undefined today, leaving the
  module unassembled (the controller 503s) rather than assembling over a broken db — a clean
  follow-up, exactly like fragment repo-sync.
- **`RepoContentEntry.size`** is now optional on the kernel port, populated by the GitHub
  contents API path (`FetchGitHubClient.listDirectory`); GitLab/fakes leave it undefined.

### Slice 2 notes (carried forward)

- **One parametrized `skill` kind**, `SKILL_AGENT_KIND = 'skill'`
  (`@cat-factory/agents/src/agents/kinds/skill.ts`, in `defaultAgentKindRegistry`). It is
  `container-coding` + `noChangesTolerated` + a `pr-or-work` clone (amend the block's PR if one
  exists, else open its own), copying the `code-commenter` shape. Its prompt is deliberately
  SKILL-AGNOSTIC — the picked skill is injected around it by the executor, not baked in. Like
  every side-effect coding kind it does NOT carry `FINAL_ANSWER_IN_REPLY`.
- **`skillResolver` is a HARD dependency for a skill step, not a graceful degrade.** Unlike
  `fragmentResolver` (absent ⇒ static pool), a `skill` step dispatched with the resolver unwired
  throws a `ValidationError` in `AgentContextBuilder.resolveSkillForStep` — a skill step running
  against nothing is a silent wrong run. Only the RESOURCE-BODY fetch degrades (a transient GitHub
  failure / missing installation ⇒ the resource is referenced by repo path, no body).
- **The resolver assembles from the SAME slice-1 deps** (`SkillRunResolver` in the skill library
  module, built whenever `skillSourceRepository` + `githubClient` + `resolveSkillInstallationId`
  are wired), so BOTH facades pick it up through `createSkillLibraryModule` with zero per-facade
  code — no runtime-symmetry gap to guard (the skill EXECUTION path is runtime-neutral
  orchestration; the repos already have the slice-1 parity suite). Mothership stays off (the
  db-less remote repos leave the module unassembled), exactly like sync.
- **Harness-aware rendering lives in `ContainerAgentExecutor.renderSkillForHarness`**, keyed off
  the resolved `harness`. The skill payload ALWAYS travels as the dedicated top-level `skill`
  job-body field (never a context file — the agent-context snapshot copies context files verbatim
  but drops unknown top-level fields, the `JobPackageRegistrySpec` precedent). The harness
  materialises it: `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` (+ resources) for claude-code (the
  CLI loads it; the prompt is a short pointer), or `.cat-context/skill/<relPath>` for Pi/codex
  (whose prompt carries the full instructions). Resource `relPath`s are sanitised at the job
  boundary (subdirs kept, traversal/absolute rejected).
- **Per-run pinning** is `step.skillVersion = { skillId, commit, sha }`, set by the resolver. It
  rides the runtime step's `detail` JSON (spread raw in `rowToExecution`), so NO migration —
  exactly like `stepOptions.skillId` itself.
- **Pipeline-save (and run-start) validation**: `assertValidSkillSteps` rejects an enabled `skill`
  step with no `stepOptions[i].skillId`. Threaded through `PipelineShape.stepOptions` at every
  `validatePipelineShape` site (create / update / clone / `assertRunnable` via `runnableShapeOf`).
- **Harness image bump**: `@cat-factory/executor-harness` 1.45.0 → 1.46.0 (native claude-code
  skills write); `pnpm sync:image-tags` reconciled the three pins.
- **Robustness gotchas (review follow-up):**
  - The native `SKILL.md` frontmatter emits `name`/`description` as JSON-encoded (double-quoted)
    YAML scalars, not bare plain scalars — an authored description routinely contains `: `
    (colon-space) or a leading YAML indicator, which is invalid as a plain scalar and would make
    the CLI silently skip the skill (`writeNativeSkill`).
  - An unsafe/empty skill NAME falls back to a safe default (`'skill'`) at the harness job boundary
    rather than dropping the whole skill — a drop would leave the claude-code prompt pointing at a
    skill that was never installed (a blind run). Only a skill with no instructions is dropped
    (`parseSkillSpec`).
- **Observability trade-off (claude-code):** because the skill travels as a top-level job-body
  field (dropped from the agent-context snapshot) and the claude-code prompt is only a short
  pointer, the actual instructions a claude-code run executed are NOT captured in the agent-context
  telemetry — only `step.skillVersion` (skillId + commit + sha) traces it to source. The Pi/codex
  path DOES capture them (folded into the prompt). Acceptable; noted so it isn't mistaken for a bug.
- **External dependency:** the claude-code path relies on the CLI auto-loading skills from
  `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` (what the 1.46.0 image bump is for). If a future CLI
  version changes skill discovery, the run loses its guidance silently — keep the harness image's
  claude-code version in step with this contract.

### Slice 3 notes (carried forward)

- **The `skill` palette block needs NO bespoke frontend registration.** Because the `skill` kind
  is a default registered kind carrying `presentation`, it already flows through the snapshot's
  `customAgentKinds` → `useAgentsStore().registerCustomKinds`, so it lands as a first-class palette
  block (category `build`) with no per-kind SPA code. Slice 3's builder work is purely the SKILL
  PICKER around it.
- **Snapshot carries a LIGHTWEIGHT skill summary, not the full `AccountSkill`.** A new
  `skillSummarySchema` (`{ id, name, description }`) is attached to `workspaceSnapshotSchema` as
  `skills`, read via the account catalog CACHE in one read (per "No N+1") and fault-isolated
  (`snapshotSkills` degrades to `undefined` on any failure so it never 500s the board). The full
  `instructions`/resource manifest stays off the board load — the management surface fetches it
  on demand via `GET /accounts/:accountId/skills`. Two stores: the snapshot-hydrated
  `useSkillsStore` (picker catalog) and the on-demand account-keyed `useSkillLibrary(accountId)`
  (management), the latter pushing updated summaries back into the former after a sync so the
  picker stays in step without a board reload.
- **Skills are account-tier, so the API prefix is `/accounts/:id` (`acct` helper), NOT the
  fragment two-tier `scope`.** The management store gates on two 503s: the catalog read
  (`available`) toggles the whole panel, while the finer `sourcesAvailable` hides only the
  link/sync form when the GitHub integration is off (the catalog still lists).
- **Builder validation mirrors the backend.** An enabled `skill` step with no `stepOptions.skillId`
  shows an inline "needs a skill" hint (like `gatingNeedsEstimator`); the backend
  `assertValidSkillSteps` remains the hard gate on save/start. A picked-but-missing id
  (renamed/unlinked source) shows an amber "pick another" note.
- **i18n:** new `skills.*` namespace + `settings.account.tabs.skills` + `layout.accountSkills.intro`
  - `pipeline.builder.skill*`, translated for real in all 10 locales. The resource-count line is
    phrased to avoid plural forms (no pl/uk `pluralRules` dependency).
