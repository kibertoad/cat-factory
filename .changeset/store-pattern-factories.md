---
'@cat-factory/app': patch
---

Extract two shared store patterns the SPA stores were hand-rolling.

- `useUpsertList()` — a keyed list with find-by-key `upsert` / `remove` / `get` / `hydrate`,
  replacing the per-store `findIndex → replace-or-(un)shift` boilerplate. Adopted in the
  `notifications`, `documents`, and `tasks` stores.
- `useSourceIntegration()` — the document-source / task-source integration lifecycle
  (`available` gate, `connections` list, `descriptorFor` / `connectionFor` / `isConnected`,
  and `probe()`), so both stores share one implementation. This also standardizes probe-error
  handling: the documents store now records _why_ a probe failed (`probeError`) like the tasks
  store already did, instead of swallowing it.

Behaviour is unchanged for existing consumers; the helpers are additive and adopted
store-by-store.
