---
'@cat-factory/orchestration': patch
---

Record a container agent's effort self-assessment on the step for the kinds whose verdict drives run flow. It was written with the normal step completion, which every such kind returns before reaching: a `pr-reviewer` parking on its findings, a container-backed companion applying its verdict, the fork proposer, a Tester withholding its greenlight, a step raising a human decision. Those runs showed no report in run details at all. It is now recorded as soon as the result arrives, and a gate step (`ci` / `conflicts` / `human-review` / `post-release-health`) keeps its last helper's report instead of discarding it with the rest of the helper's result.
