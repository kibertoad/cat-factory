---
'@cat-factory/app': patch
---

Unify the step-backed result windows (CI/conflicts gate, tester report) with the agent
step detail. Extracted two shared embeddable pieces — `StepModelActivity` (the LLM
model-activity rollup + "View all calls →" link) and `StepRunMeta` (run id, model,
timing, step position, and the embedded observability rollup) — and wired them into the
gate view, the tester report window, and the canonical `StepMetadataCard`. The gate and
tester windows now show the run id, live duration, and embedded model-activity exactly
like every other step instead of hand-rolling partial sidebars (the tester window had no
run id or observability at all).

Every step window now reaches observability the same way: `StepModelActivity` shows the
"Model activity" header + "View all calls →" link for any step that belongs to a run, and
renders the metrics bar only when the step itself recorded LLM calls. This drops the
bespoke "Open observability" fallback button the gate view used to show (a gate's
programmatic precheck records no per-step calls, so it always hit that fallback) — the
"View all calls →" link is run-scoped and reaches the helper agents' calls just the same.

Also raised the observability drill-down above the result windows (`z-[60]` vs the
windows' `z-50`) so opening "View all calls →" from a gate/tester window no longer renders
the panel behind the still-open window (the panel mounts once at app init, so on-demand
windows that mount later were winning the equal-z-index stack).
