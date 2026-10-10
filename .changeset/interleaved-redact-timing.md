---
---

Deflake the `redactSecrets` shape-parity timing test. It now times prose and every shape once per
round, over eight interleaved rounds that alternate forward and reverse order, so a contention
burst on a shared CI runner is much less likely to inflate one body's samples and none of the
baseline's. No package changes.
