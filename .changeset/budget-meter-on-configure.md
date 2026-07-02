---
'@cat-factory/app': patch
---

Show the spend/budget meter in the board toolbar as soon as a workspace budget is
configured (previously it only appeared once tokens had been metered, so setting a
budget at zero spend left the limit and usage hidden). Saving a budget now also
refreshes the workspace snapshot so the meter reflects the new limit/currency
immediately.
