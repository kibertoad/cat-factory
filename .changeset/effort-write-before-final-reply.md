---
'@cat-factory/agents': patch
---

Order both container sentinel writes BEFORE the agent's final reply instead of "at the end". The old wording made a faithful agent answer first and write `.cat-effort.json` second, and that trailing tool call forces one more closing turn whose short remark is what every harness then keeps as the reply. A kind whose deliverable is its reply (the architect) lost its entire design to that afterthought three rework rounds in a row, with its companion correctly rejecting each round for a missing design body. `PR_DESCRIPTION_GUIDANCE` takes the same ordering, because a PR-opening coding dispatch receives it AFTER the effort report and its timing sentence is therefore the last one the agent reads. The ordering rule states what the platform keeps rather than what the reply is for, so it stays true for the side-effect coding kinds that legitimately end with no answer.
