---
'@cat-factory/agents': patch
---

Fold the selected best-practice fragments into every repo-reading agent that was silently missing them, and guard against the class of bug.

The engine's fragment fold (`AgentContextBuilder.resolveFragments`) only runs for kinds carrying the `code-aware` or `doc-aware` trait. Several container (repo-cloning) kinds were registered with no context trait, so a task's chosen best-practice fragments were dropped: tenant-managed fragments never resolved, and the "Provided context" telemetry snapshot recorded 0 fragments. The standalone "Review" task (`pr-reviewer`) was the reported case.

Added `code-aware` to `pr-reviewer`, `ralph`, `repro-test`, `skill`, `bug-investigator`, `fork-proposer`, `initiative-analyst`, `initiative-planner`, `spike`, and `conflict-resolver` (which previously had only `spec-aware`). A new guard test asserts every registered repo-cloning kind actually folds fragments (carries `code-aware` or `doc-aware` — the only traits `resolveFragments` acts on; `spec-aware` alone does not fold), or is on an explicit, justified opt-out list (today `spec-writer`, `environment-analyst`, and `blueprints`), so a future kind that forgets its trait fails a test instead of silently dropping fragments.
