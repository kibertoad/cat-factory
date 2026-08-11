---
'@cat-factory/kernel': patch
---

Fix the singular form of the candidate-discard instruction, which read "the 1 candidate that were
not kept". Surfaced while pinning the second-phase brief against the mutation report, which is the
only reason anyone looked at the one-survivor case.
