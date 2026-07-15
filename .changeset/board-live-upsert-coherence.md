---
'@cat-factory/app': patch
---

Fix a real-time board coherence hazard where a run's terminal status (`pr_ready`/`done`)
could stay stuck showing `in_progress`. The status arrives as a targeted `execution`-event
`board.upsert`, but a full-snapshot `refresh()` whose fetch STARTED earlier (its block still
`in_progress`) could resolve afterward and, via the REPLACE-style `hydrate`, clobber the
newer live status back to the stale value — with no further event to restore it. Blocks
carry no server revision, so the board store now stamps each live `upsert` with a monotonic
sequence and `refresh()` captures a baseline before its fetch; `hydrate` preserves any block
upserted while the fetch was in flight. Pinned by a store-level regression test. (The
existing `refreshSeq` guard only ordered refreshes against each other, not against an
interleaved live upsert — reliably hit under CI latency, surfacing as e2e terminal-status
timeouts.)
