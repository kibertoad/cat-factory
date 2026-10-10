---
---

Deflake the `redactSecrets` shape-parity timing test. It now times prose and every shape once per
round, over up to seven interleaved rounds with a rotating start, so a contention burst on a shared
CI runner can no longer inflate one body's samples and none of the baseline's. It stops early only
when a shape is over 2s and 50x its round's prose sample in two consecutive rounds, so a real
rescanning regression fails fast and one stall cannot. No package changes.
