---
'@cat-factory/acceptance': patch
---

Let `status` reach a pass that recorded nothing, and give a pass one identity.

Moving the `latest` pointer to a pass's first recorded FACT made the pass an operator most often
asks about unreportable: an attempt a prerequisite refused writes a journal saying why and never
opens a ledger, so `pnpm run status` with no run id followed a pointer that named an older pass, or
none at all. It now reports the pass that WROTE last, and a pass that created nothing closes its
report by naming the pass that did rather than offering to resume itself.

A pass is also identified by its file name now: a ledger whose stored `runId` disagrees is a copied
or renamed file, and both `WorldStore` and `status` refuse it instead of pointing `latest` at an id
with no ledger. The leftover-state refusals name the owning pass per service, so leftovers spanning
two passes say what resuming either one leaves behind, and the `status` command they offer names
that pass instead of resolving to whichever ran last.
