---
'@cat-factory/app': patch
---

Drop an unnecessary empty-object fallback in a spread in `ProviderConnectionPanel`
(`...(x ?? {})` → `...x`); spreading a falsy value is already a no-op, so this is a
behaviour-neutral lint fix (oxlint `no-useless-fallback-in-spread`).
