---
"@cat-factory/kernel": patch
"@cat-factory/orchestration": patch
"@cat-factory/app": patch
---

Tag 409 conflicts with a distinct, machine-readable `reason` (kernel `ConflictReason`, surfaced under `error.details`) so the SPA can tell run-control conflicts apart. The "no configured provider" start refusal now shows an actionable toast naming the model(s) with a "Configure AI" jump (same remedy as the no-AI startup banner); the other run/bootstrap conflicts get worded toasts. The toast handling is centralised in the execution/agentRuns stores, so every start/restart/retry/merge surface (including the fire-and-forget board menus) gets it.
