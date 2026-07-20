---
'@cat-factory/app': patch
---

PR review window: make the "reviewing" progress precise instead of a static "Reviewing the
pull request… / Slicing the diff into cohesive chunks and reviewing each one" that never
changed. The window now tells the two phases apart — SLICING (still grouping the diff into
chunks, no plan yet) vs REVIEWING (slicing done, working the chunks) — and once slicing is
done it lists every chunk with an explicit per-chunk status (Reviewed / Reviewing… / Queued),
plus a "Reviewing now" callout naming the chunk(s) being actively worked on.
