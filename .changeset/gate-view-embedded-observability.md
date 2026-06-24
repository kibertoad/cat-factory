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
run id or observability at all), and the observability rollup is embedded inline rather
than hidden behind a separate "Open observability" button (that link now only appears
when no helper has run, so there are no calls to show).
