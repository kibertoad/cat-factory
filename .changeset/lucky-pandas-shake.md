---
'@cat-factory/app': patch
---

Fix five P1 UX papercuts: a friction-dialog "Create anyway" that double-submitted into two tasks and
two pipeline runs, unsubmitted drafts discarded on close across every result window, a
binary-candidates gate that could not be completed by keyboard and rendered a blank body on a failed
load, an unconfirmed irreversible pipeline delete, and index-keyed test-secret rows that could save
one secret's value under another's key.
