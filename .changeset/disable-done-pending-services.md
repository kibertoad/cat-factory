---
'@cat-factory/app': patch
---

Add-service-from-repo modal: disable the footer "Done" button while there are monorepo directories selected but not yet added. Previously a user could pick several service directories and click "Done" without first pressing "Add N services", silently discarding the selection. Done is now disabled (with an explanatory tooltip) until the pending picks are added or cleared.
