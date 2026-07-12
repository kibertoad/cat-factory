---
'@cat-factory/kernel': patch
'@cat-factory/caching': patch
'@cat-factory/spend': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/workspaces': patch
---

perf(caching): route workspace-settings and spend budget reads through the app cache seam (perf-tracker items 7 & 9)

Replaces `SpendService`'s three homebrew `{ value, expiresAt }` TTL `Map`s (pricing /
account limit / user limit) and the uncached `WorkspaceSettingsService.get` with three new
`AppCaches` slices — `workspaceSettings`, `accountBudgetLimit`, `userBudgetLimit` — so these
slow-moving reads are coherent across a horizontally-scaled Node deployment (a budget/settings
edit invalidates every replica via the notification bus instead of leaving peers stale for the
TTL). The workspace-settings row is now read through a single shared slice by
`WorkspaceSettingsService`, `SpendService`'s pricing overlay, and
`LlmObservabilityService.bodiesEnabled`, so one invalidation on `WorkspaceSettingsService.update`
covers them all. The slices are pass-through on the Worker's isolate-safe profile (our own
mutable D1 state, no cross-isolate bus).
