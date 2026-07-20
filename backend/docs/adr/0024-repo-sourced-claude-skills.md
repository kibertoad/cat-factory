# ADR 0024: Repo-sourced Claude Skills — account library + executable pipeline step

- **Status:** Accepted (implemented)
- **Date:** 2026-07-17
- **Context layer:** backend (`@cat-factory/kernel`, `@cat-factory/contracts`, `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/server`, `@cat-factory/caching`, both runtime facades) + frontend (`@cat-factory/app`) + `@cat-factory/executor-harness`

## Context

Teams author **Claude Skills** in their repositories — a directory (conventionally
`.claude/skills/<skill>/`) containing a `SKILL.md` (YAML frontmatter `name`/`description` + a
markdown body of procedural instructions) plus optional sibling resource files (templates,
scripts, checklists). The platform could not discover these, hold them anywhere, or run one as
part of a delivery pipeline. We wanted skills to be a first-class, repo-authored capability that a
pipeline step can execute — reusing the repo-sourced prompt-fragment machinery (ADR 0006) rather
than inventing a parallel one, and never executing a stale skill.

## Decision

A skill is synced from a repo directory into the **account tier** (shared across the account's
workspaces) and run as a pipeline step through **one generic parametrized `skill` agent kind**.

- **Loading.** A `skill_sources` link (repo + dir, keyed on `account_id`) is synced into
  `account_skills` rows. The sync unit is a **directory** (`<skill>/SKILL.md` + its sibling
  resources); the manifest persists `{ path, sha, size }` only (resource bodies are fetched at
  dispatch). The shared sync mechanics — pin the dir head commit BEFORE reading, blob-sha-keyed
  idempotent upserts, id-keyed tombstone sweep, one-commit-probe `status()` — live in a reusable
  `@cat-factory/agents/src/repoSourceSync/` engine (`syncRepoSource`/`probeRepoSourceStatus`),
  onto which `FragmentSourceService` was also refactored. Skill ids are namespaced
  `src:<sourceId>:<dirName>`. Opt-in rides the existing `fragmentLibrary.enabled` flag. Reads go
  through the account's existing GitHub installation — no new credential store.
- **Execution.** A loaded skill runs via `SKILL_AGENT_KIND = 'skill'` — a `container-coding`
  kind with `noChangesTolerated` and a `pr-or-work` clone, selected per step through
  `stepOptions[i].skillId` (the extensible per-step param bag, not a dynamic kind-per-skill). The
  kind's prompt is SKILL-AGNOSTIC; the picked skill is injected around it by
  `renderSkillForHarness` (server `agents/contextFiles.ts`), harness-aware: the skill payload always travels
  as a dedicated top-level `skill` job-body field (never a context file), materialised as
  `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` (+ resources) for the claude-code CLI to auto-load,
  or `.cat-context/skill/<relPath>` for Pi/codex (whose prompt carries the full instructions).
- **Freshness (layered).** Three cooperating mechanisms keep a run from executing a stale skill:
  (1) a **push-webhook fan-out** — a `push` to a linked repo enqueues a targeted
  `skill-source-resync` job per affected source (found via `SkillSourceRepository.listByRepo`)
  onto the GitHub-sync queue, applied by the async consumer; (2) a **dispatch-time self-verifying
  probe** in `SkillRunResolver` — it probes the source dir's head commit and re-syncs on change
  before running, degrading to the last-synced record on any failure; (3) **per-run version
  pinning** (`step.skillVersion = { skillId, commit, sha }`). The `AppCaches.skillCatalog` slice
  (per account) is invalidation-driven and pass-through on the Worker isolate profile.

`skillResolver` is a HARD dependency for a `skill` step (unwired ⇒ `ValidationError`, never a
silent wrong run); only the resource-body fetch degrades. Pipeline-save/run-start validation
(`assertValidSkillSteps`) rejects an enabled `skill` step with no `skillId`.

## Rationale

- **One parametrized kind, not kind-per-skill.** `AgentKindRegistry` is deployment-static
  composition-root data; skills are tenant runtime data. Per-tenant dynamic kinds would leak
  tenant state into an app-owned registry and break the snapshot/palette contract. `stepOptions`
  is the designated per-step params seam (ADR-adjacent `pipeline-step-options`).
- **Dedicated tables, shared mechanics.** Skills differ from fragments in consumption (an
  executable step vs prompt garnish), shape (directory-per-skill + resource manifest vs
  file-per-fragment) and cache lifecycle — so they get their own tables, but the sync loop is
  extracted and shared rather than copied (shared design over copy-the-shape). Skills are ONE
  tier (account), keyed on `account_id`, not the fragment `(owner_kind, owner_id)` pair.
- **Persist instructions + manifest; fetch bodies at dispatch.** The run path never DEPENDS on a
  live GitHub fetch — instructions come from our synced store; a resource fetch failure degrades
  to "reference by path, no body" (bounded ~48 KB/file, ~200 KB total; oversized/binary referenced
  by path). A resource-only edit advances the dir head without touching `SKILL.md`'s blob sha, so
  the manifest is re-listed whenever the pinned commit moved.
- **Layered freshness, each independently safe.** The webhook fan-out keeps the catalog warm but
  is a best-effort optimisation (skipped where no sync queue exists — local/dev — or on a missed
  delivery); the dispatch probe is the correctness backstop and is a one-read no-op on the
  unchanged path. Neither can wedge a run: the worst case is running one push behind. The whole-dir
  head commit is the exact staleness signal, so an unchanged source costs zero per-directory reads.
- **Harness-aware, top-level job-body field.** The agent-context snapshot copies context files
  verbatim but drops unknown top-level fields, so carrying the skill as a dedicated top-level field
  (the `JobPackageRegistrySpec` precedent) keeps native claude-code skills write off the snapshot
  while Pi/codex fold instructions into the prompt.

## Consequences

- **Runtime symmetry.** Every table/repo/port/queue-job lands D1 ⇄ Drizzle (+ Node/local)
  together with a cross-runtime conformance assertion; the `listByRepo` lookup, the
  `skill-source-resync` job kind, and the `queueSkillResync` gateway seam are mirrored across both
  facades. Mothership mode leaves skills OFF until the persistence RPC surfaces them (the db-less
  remote repos leave the module unassembled — the controller 503s — rather than assembling over a
  broken db), a clean follow-up exactly like fragment repo-sync.
- **Observability trade-off (claude-code).** Because the skill travels as a top-level job-body
  field (dropped from the agent-context snapshot) and the claude-code prompt is only a pointer, the
  actual instructions a claude-code run executed are NOT captured in agent-context telemetry — only
  `step.skillVersion` traces it to source. The Pi/codex path DOES capture them. Accepted.
- **Rename = new identity.** A renamed skill directory produces a new `src:<sourceId>:<dir>` id and
  tombstones the old one; steps referencing the old id fail cleanly at dispatch and show a builder
  warning. No alias table (acceptable pre-1.0).
- **Deliberately not pursued.** Skills are step-only, NOT a second passive-context surface
  (fragments already cover passive guidance). No skill table beyond the account catalog — the
  in-repo `SKILL.md` files are the source of truth. The built-in agents were not migrated to the
  skill/custom-agent model (that remains the separate strangler work).
- **External dependency.** The claude-code path relies on the harness image's CLI auto-loading
  skills from `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`; keep the harness image's claude-code
  version in step with that contract.
