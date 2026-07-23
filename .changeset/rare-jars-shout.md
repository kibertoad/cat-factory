---
'@cat-factory/app': minor
---

Surface the agent's effort self-assessment in every result window, not just the generic step-detail panel. `ResultWindowShell` now renders `step.effortReport` as a collapsible footer (difficulty + what reduced the agent's effectiveness, expanding to the full report), resolved from the active result view, so the merger / tester / PR-review / structured-output / follow-up / fork-decision windows all show it without per-window code.
