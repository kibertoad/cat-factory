---
'@cat-factory/acceptance': patch
---

Pin the acceptance specs to file-name order.

The five specs are one narrative passing facts through the on-disk ledger, but nothing enforced the
order they ran in: `fileParallelism: false` prevents two running at once and vitest's default
sequencer was still free to reorder them from its results cache. With `bail: 1`, the slowest spec of
the previous pass ran first, failed on a ledger key nothing had written yet, and stopped the pass
before the spec that writes it had started.
