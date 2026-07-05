---
'@cat-factory/app': patch
---

Fix a retried run leaving its stale "Run failed" banner up (and its carried-forward failure history hidden). After a retry replaces a block's failed run with a fresh run under a new id, the execution store's snapshot reconcile was preserving the now-deleted predecessor, which then shadowed the running run in the by-block projection. Drop a cached-only run whose block the incoming snapshot already covers so the banner clears on restart and the "previous errors" history surfaces on the task inspector.
