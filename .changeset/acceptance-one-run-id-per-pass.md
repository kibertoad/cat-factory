---
'@cat-factory/acceptance': patch
---

Give an acceptance pass ONE run id and stop a refused attempt from hiding the pass worth resuming.

The run id was resolved per module graph, which is per spec FILE: five specs opened five ledgers a
second apart, so no fact spec 01 recorded reached spec 02. It is now settled once in `globalSetup`
and injected, and a spec handed none refuses rather than minting its own. The `latest` pointer moves
to the first FACT a pass records, so an attempt refused at preflight no longer overwrites the pointer
to the half-built pass whose leftovers caused the refusal, and the two checks that refuse over
leftover state name that pass's run id instead of offering `latest`.
