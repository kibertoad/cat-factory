---
"@cat-factory/contracts": minor
"@cat-factory/executor-harness": minor
"@cat-factory/agents": minor
"@cat-factory/server": minor
---

Shard the in-repo `spec/` artifact by a module → feature taxonomy to kill merge churn.

The spec-writer no longer commits a single monolithic `spec/spec.json` (+ `overview.md`
/ `rules.md` / `version.json`); every spec run rewrote those whole files, so two task
branches that both touched the spec conflicted hard on merge. The spec is now SHARDED:
a tiny `spec/service.json`, an `spec/overview.md` index, and one canonical
`spec/modules/<module>/<group>.json` (+ a human `<group>.md`) per feature group, with
the Gherkin `spec/features/<module>/<group>.feature` files nested to match. A group's
file bytes depend only on that group, so concurrent branches editing different
features never touch the same file.

**Breaking (acceptable per pre-1.0 policy — no migration):**
- `@cat-factory/contracts`: `SpecDoc` gains a two-level taxonomy — `modules: SpecModule[]`
  where each module holds `groups`, and each group carries BOTH its `requirements` and the
  domain `rules` scoped to it. The top-level `SpecDoc.groups`/`SpecDoc.rules`,
  the `SpecVersion`/`version.json` manifest, and the `SPEC_JSON_PATH`/`SPEC_RULES_PATH`/
  `SPEC_VERSION_PATH` path constants are removed; `SPEC_SERVICE_PATH`/`SPEC_MODULES_DIR`
  are added. `renderSpecForReview` walks the new shape. Existing repos' monolithic
  `spec.json` is simply re-created on the next spec run.
- `@cat-factory/executor-harness`: sharded deterministic render + on-disk reassembly
  read-back + orphan-shard pruning (a removed/renamed module or group is deleted, not
  resurrected); `version.json` dropped (no-op detection is now per-file via the commit).
  Content-derived (not positional) rule ids keep a group file byte-stable. The spec-writer
  prompt + reassembled-baseline now carry an EXISTING-taxonomy inventory and steer the
  agent to slot new requirements/rules into the closest existing module + feature (reusing
  exact names) rather than spawning near-duplicate domains/groups. Ships in the **1.9.0**
  runner image already pinned in `deploy/backend` (no further tag move needed).
- `@cat-factory/agents`: the runtime-neutral `repo-ops/render.ts` mirror is reworked to
  the same sharded layout (`renderSpecVersionFile`/`nextSpecVersion`/`canonicalSpecJson`/
  `hashSpec` for the spec removed); `SPEC_AWARE_GUIDANCE` points readers at
  `spec/modules/<module>/<feature>.{md,json}`.
- `@cat-factory/server`: `SPEC_WRITER_SYSTEM_PROMPT` describes the module → feature →
  {requirements, rules} structure, the no-catch-all rule, and the taxonomy-reuse rule.
