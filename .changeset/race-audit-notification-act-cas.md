---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

fix(notifications): claim a notification atomically before acting (race-audit 3.1)

Acting on a human-actionable notification (confirm+merge a `merge_review`/`pipeline_complete`,
retry a `ci_failed`/`test_failed`) now atomically claims the open card (`open` → `acted`)
BEFORE running its side effect, so two concurrent acts — a double-click, two members' inboxes,
an HTTP retry — can no longer both fire the merge/retry. The new
`NotificationRepository.claimForAction` is a single conditional `UPDATE … WHERE status='open'
RETURNING *` (the `PasswordResetTokenRepository.consume` shape) mirrored on both runtimes
(D1 ⇄ Drizzle); only the writer that wins the flip runs the side effect. A failing side effect
reverts the card to `open` so the action stays retryable, without the double-fire window.
