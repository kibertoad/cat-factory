---
---

Deflake the `redactSecrets` shape-parity timing test. It now times prose and every shape once per
round, over seven interleaved rounds with a rotating start, so a contention burst on a shared CI
runner can no longer inflate one body's samples and none of the baseline's. No package changes.
