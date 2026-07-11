---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Prune resolved notifications on the retention sweep. The `notifications` table was
never pruned on either facade (upsert/escalate only, no delete), so resolved
(acted/dismissed) cards accumulated without bound on a table read on the snapshot hot
path. A new `NotificationRepository.deleteResolvedOlderThan(cutoff)` port method
(mirrored D1 ⇄ Drizzle) is wired into both facades' retention sweeps under a new
`RetentionConfig.notificationsMs` window (`NOTIFICATION_RETENTION_DAYS`, default 90
days). Only terminal rows past the window are deleted — `open` cards (the actionable
inbox) are never touched. Covered by a new cross-runtime notification conformance
suite. (system-audit-improvements initiative, item 1.)
