---
'@cat-factory/contracts': minor
'@cat-factory/prompt-fragments': minor
'@cat-factory/agents': minor
'@cat-factory/executor-harness': minor
'@cat-factory/server': minor
'@cat-factory/kernel': minor
'@cat-factory/consensus': patch
'@cat-factory/orchestration': patch
---

Cut coder token/quota burn and fix subscription usage attribution.

- **Two-tier best-practice fragments.** `PromptFragment` gains an optional `brief` body; a new `brief-standards` trait marks the high-turn code-writing implementer kinds (coder, fixer, ci-fixer, conflict-resolver) so their system prompt — re-sent on every turn of a long agentic loop — folds the condensed standard instead of the full body. Reviewer/planner kinds keep the full text. The brief is resolved ALONGSIDE the body it condenses and never re-looked-up by id, so a workspace/account-tier row that overrides a built-in id folds its own full body rather than the built-in's condensed text. Backward-safe: no `brief` / unmarked kind ⇒ the full body, unchanged. `brief` authored for every built-in fragment that can reach an implementer kind (node, react, design, migration).
- **No-progress guard on the claude-code path.** The `ProgressGuard` that killed rabbit-holing Pi runs (no-edit probing, error-retry loops, web rabbit-holes) now also runs on the claude-code subscription harness, which previously had only the wall-clock watchdog. Its no-edit exploration allowance scales with the task-estimator's complexity when an estimator ran (conservative default otherwise), so it only ever catches absolute spiralling and never truncates a productively-editing run. Subagent dispatches (`Agent`/`Task`) are neutral to the no-edit bound, since the edits they make are invisible on the parent stream.
- **Trimmed always-on prompt bloat.** The harness no longer appends its own spec-reading block (deduped — it now comes solely from the backend `spec-aware` trait, so a spec-aware Pi run stops carrying it twice); the blueprint orientation note is included only when the checkout (or, for a multi-repo run, one of its legs) actually ships `blueprints/`; and the spec-reading guidance now steers agents to the overview index and the relevant-and-adjacent shards in one line.
- **Fix subscription token-usage attribution.** A container/subscription step's `token_usage` row recorded `provider='unknown'` / `model=''` because the durable poll path rebuilt a stripped job handle without the dispatch model. It now forwards `step.model`, so the row records the real provider + model.
