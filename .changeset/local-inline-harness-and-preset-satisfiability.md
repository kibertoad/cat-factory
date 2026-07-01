---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/consensus': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Run inline LLM steps through the ambient Claude Code / Codex CLI in local mode, and refuse to
start a pipeline whose model preset can't satisfy every step.

- **Local inline harness execution**: with native agents enabled (`LOCAL_NATIVE_AGENTS`), the
  inline steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) now run
  on the developer's ambient `claude`/`codex` subscription CLI as a host subprocess — the inline
  analogue of the existing container ambient-auth path. Previously a subscription-only preset
  (e.g. Claude Opus) degraded these inline steps to the routing default and failed against an
  unconfigured provider (the confusing "requirements reviewer (qwen:qwen3-max) failed" error).
  Implemented via a new AI-SDK `CliInlineLanguageModel` (`@cat-factory/agents`) wired into the
  local model provider; `inlineModelRef` now keeps an ambient-eligible harness ref instead of
  degrading it. The consensus executor (an inline path) threads the same predicate, so a
  subscription-only consensus participant model is kept inline in local mode too.
- **Preset satisfiability guard**: the pipeline-start guard now checks INLINE steps against
  inline-usability, not just container-usability. A subscription-only model that satisfies the
  container agents but can't run the inline reviewers (and this deployment has no inline harness)
  is refused up front with a new `preset_unsatisfiable` conflict reason and an actionable message,
  instead of failing mid-run. The SPA maps the new reason to a translated toast.

Breaking: `inlineModelRef` gains an optional third `opts` argument; the `ConflictReason` wire
union gains `preset_unsatisfiable`.
