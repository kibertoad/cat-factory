---
'@cat-factory/agents': patch
'@cat-factory/server': patch
---

Fix a cross-tenant access hole on the fragment-source routes: `unlink`/`status`/`sync`
resolved the source by its id alone, so an authenticated member of one account/workspace
could read, resync or delete another tenant's fragment source by addressing its id under
their own prefix. `FragmentSourceService.unlink/sync/status` now take the addressed
`(ownerKind, ownerId)` and 404 when the source belongs to a different owner (breaking
signature change for direct callers of those three methods).
