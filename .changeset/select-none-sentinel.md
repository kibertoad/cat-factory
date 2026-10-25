---
'@cat-factory/app': patch
---

Seven selects no longer throw when they render or open. Each gave its "no value" row (inherit, not set, the default) the value `''`, which Reka's `SelectItem` and `ComboboxItem` refuse. The row now carries a non-empty sentinel from `utils/selectNone.ts`, and each select binds through `selectNoneModel`, which maps it back to the empty value, so what is stored and sent does not change. `DescribeWorkModal` and `ConsensusGroupsSection` move from their own sentinels to the shared one. A workspace metadata `select` field whose options include `''` or `__none__` is dropped and named in the console, like a malformed key. The task module picker's unused placeholder copy is removed. A new guard, `scripts/check-frontend-select-values.mjs`, refuses a select item with `value: ''`.
