---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

feat: repo-sourced Claude Skills — executable pipeline step (slice 2)

Make a synced repo-sourced Claude Skill runnable as a pipeline step
(docs/initiatives/repo-skills.md):

- **One generic `skill` agent kind** (`container-coding`, `noChangesTolerated`,
  `pr-or-work` clone), parametrized per step by a new `stepOptions.skillId` — not a
  dynamic kind per skill. Pipeline save (and run-start re-validation) rejects a `skill`
  step that names no skill.
- **`SkillRunResolver`** resolves the picked skill at dispatch: the persisted
  instructions from the account catalog plus the sibling resource bodies fetched at the
  skill's immutable pinned commit (per-file + total caps; oversized/binary files are
  referenced by repo path instead). The run never depends on a live GitHub fetch — a
  fetch failure degrades a resource to a path reference rather than failing the run.
  Wired into the engine as `skillResolver` in `AgentContextBuilder` (a skill step
  dispatched with the library unconfigured fails loudly rather than running blank), and
  the run step is pinned with `skillVersion: { skillId, commit, sha }`.
- **Harness-aware rendering** in `ContainerAgentExecutor`: the resolved skill travels as
  a dedicated top-level `skill` job-body field (never a context file). The
  executor-harness materialises it natively into `CLAUDE_CONFIG_DIR/skills/<name>/` for
  the claude-code subscription harness (so the CLI loads it), and under
  `.cat-context/skill/` for the Pi/codex harnesses (whose prompt carries the folded-in
  instructions).
- Bumps `@cat-factory/executor-harness` (native claude-code skills write) and the pinned
  runner image tag in the Node/local facades.
