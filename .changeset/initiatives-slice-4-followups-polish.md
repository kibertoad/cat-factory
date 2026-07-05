---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

feat(initiatives): slice 4 — follow-ups & polish

Complete the Initiatives feature: a settling spawned-task run's forward-looking
follow-ups (and, on failure, its real cause) are harvested onto the initiative
tracker at the terminal emit; a human promotes an open follow-up into a new
`pending` tracker item or dismisses it, retries/skips/re-scopes items, and retunes
the execution policy — all over the existing rev-CAS single-writer path. No new
persistence or facade wiring: the curation state rides the initiative `doc` blob
(D1 ⇄ Drizzle parity unchanged), and the harvest reuses the in-hand run instance
so it costs no extra read.
