---
'@cat-factory/app': patch
---

Fix the initiative-preset create form so a default-ON checkbox (`default: 'true'`, e.g. the
tech-migration "Review each change before it merges" toggle) can persist an explicit `false` when
unchecked. Previously the shared renderer dropped a `false` checkbox value as "unset" (correct for a
default-OFF box, where absent === unchecked), which for a default-ON field was indistinguishable from
"untouched, still on" — so a consumer reading the opt-out as `humanReview !== false` (`seedMigrationPlan`)
could never observe the unchecked state and the toggle was dead. A default-OFF checkbox keeps the
drop-when-false behaviour, so it never freezes a redundant `false`.
