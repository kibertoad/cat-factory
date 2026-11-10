---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
---

Add the generic project-definition and project-outcome contracts (the definition envelope with an
opaque kind-owned `spec`, the pin, the outcome revision envelope and the outcome-storage policy),
kernel's `ProjectDefinitionRegistry` with per-kind spec validators, the definition content hash
and the storage-policy resolver, plus the research kind's own spec, findings body, fold and
coverage built on them. Nothing reads them yet.
