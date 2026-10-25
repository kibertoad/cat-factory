---
'@cat-factory/app': patch
---

A failed load no longer looks like an empty or switched-off feature. Only a 503 now means "not
enabled"; any other failure shows a new `LoadFailedState` with a retry in the consensus,
requirements-review and brainstorm windows, the foundational-services, skill-library,
observability, release-health and environment-handler surfaces, the account deployment settings,
the board members roster (whose skeleton no longer stays up for good), the service spec window
(which now reads the anchor diagnostics), the GitHub installation list and the repo tree browser.
The add-task modal reports a failed documents, issues or fragments load, and the operator
dashboard says when there is no active account instead of showing a blank body.
