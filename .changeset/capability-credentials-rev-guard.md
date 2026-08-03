---
'@cat-factory/kernel': minor
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

The capability-credential row is rev-guarded, closing two holes the per-key write opened. The row
is ONE sealed blob holding the whole set, so a per-key save is read-modify-write over it; blind,
two operators saving DIFFERENT keys would silently destroy each other's, with the loser's save
still returning success. `put`/`remove` now ride a `compareAndSwap`/`deleteIfRev` pair (a new
`rev` column on `capability_credentials`, both runtimes), reloading and re-applying on the
winner's snapshot, 409 only on a pathologically hot row. The whole-set PUT stays a blind write:
replacing whatever is stored is its semantics, and it bumps the stored rev in SQL so a concurrent
per-key save's guard still trips.

Also: a per-key save now stamps `updatedAt` on the touched key ONLY. "Last set" is a per-key fact
the checklist renders per row, and the previous write re-stamped the whole set, falsifying every
neighbour's date whenever any one key was saved.
