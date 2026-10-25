---
'@cat-factory/app': patch
---

Seven selects no longer throw when they render or open. Each gave its "no value" row (inherit, not set, the default) the value `''`, which Reka's `SelectItem` and `ComboboxItem` refuse. The row now carries a non-empty sentinel from `utils/selectNone.ts`, mapped back to the empty value at each component's boundary, so what is stored and sent does not change. A new guard, `scripts/check-frontend-select-values.mjs`, refuses a select item with `value: ''`.
