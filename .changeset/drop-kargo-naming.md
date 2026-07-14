---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
---

chore(environments): drop the proprietary "Kargo" name from shared custom-deployment-provider code and UI

"Kargo" is one specific proprietary deployment provider and should not appear as the
canonical example in the framework's shared code or UI. Replaced every illustrative
reference (comments, the `manifestId` placeholder/help text, config-file examples) with
neutral wording (`.deploy.yml`, `my-preview-template`, "a native custom env backend").
Behaviour is unchanged.
