---
'@cat-factory/kernel': patch
'@cat-factory/spend': patch
---

Simplify three predicates the nightly mutation run showed nothing could distinguish: the OpenRouter
slug's vendor prefix is sliced rather than split-and-guarded, the family policy's unclassified case
is an explicit early return, and `effectiveTierLimit` drops a branch `Math.min()` already answers.
Behaviour is unchanged; the rest of the change is tests.
