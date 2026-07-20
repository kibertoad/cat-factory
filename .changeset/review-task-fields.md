---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Streamline the Add-task form. Review tasks no longer require a Title (one is derived
from the target pull request when left blank) and no longer show the Risk (merge)
policy selector — a review merges nothing, so the policy was meaningless there. The
form also gains a Best-practices picker: any task can pin prompt fragments from the
resolved catalog (scoped to the enclosing frame's block type) at creation, via the new
optional `fragmentIds` on the add-task contract (unioned with the document
writing-style defaults for document tasks).
