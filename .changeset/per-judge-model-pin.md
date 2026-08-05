---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Per-judge model pin: a rubric names the model it was written for

A judge registration could state its rubric and its verdict schema but not its model, and every
judge assessment resolved under the constant agent kind `judge`. That was wrong in both
directions. The deployment is the only party that knows scoring a security rubric is not the same
ask as scoring doc completeness, and had no way to say so. And a registered judge is already its
own row in the model-defaults panel (it reaches the palette through `customAgentKinds`), so a
workspace could author a per-judge default that the engine then read under a different key and
never applied.

`JudgeDefinition.modelId` now names the CATALOG MODEL ID the rubric was authored for, and an
assessment resolves under the judge's OWN kind. Precedence, most specific first: the task's pinned
model, a workspace preset override NAMING the judge's kind, the registration's pin, the preset's
base model, the deployment's routing default. A catalog id rather than a `ModelRef` on purpose, so
the id still resolves through the deployment's catalog under the route order the task's preset
states: a pinned judge in a residency-constrained workspace stays on that workspace's routes.

The pin's POSITION is the design. Above the preset's base model, because a base is a blanket
statement about every kind and a pin under it could never be reached; below an override naming the
kind, for the reason the threshold lives on the merge preset rather than the registration, that a
deployment-global constant no workspace can relax is not a policy. Keeping those two apart is why
`PresetRouting` now reports `pinnedForKind` beside the id, and why kernel gains
`presetOverrideForKind` next to the `modelForKindFromPreset` that collapses them.

A pin this deployment cannot serve is stated, not swapped: `step.judge.modelPin` records
`applied` / `overridden` / `unavailable`, the judge window shows the unavailable case, and the PR
verification report's rubric line calls it out beside the model that actually ran. A rubric scored
by a model its author rejected otherwise reads exactly like one it approved, which is the failure
the whole report exists to remove. Telemetry keys the same way, so each rubric's spend is its own
line in the `(agentKind, phase)` rollup instead of every judge's landing together.

Watch for: `JUDGE_AGENT_KIND` is gone from `@cat-factory/agents` rather than left as a constant
that would silently re-collapse every rubric onto one model default. `PresetRouting.pinnedForKind`
is required, so any producer of that shape must state it. Public API addition only: an optional
`modelPin` on the report's judge verdicts, spec `1.14.0`.

Design: `docs/initiatives/judge-registry.md` (D9); resolution chain:
`backend/docs/model-support.md`.
