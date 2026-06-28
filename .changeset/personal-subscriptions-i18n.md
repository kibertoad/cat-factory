---
'@cat-factory/app': patch
---

Move the Personal Subscriptions settings copy into i18n.

Every hardcoded label, hint, button, toast, renewal notice and vendor onboarding step in
`PersonalSubscriptionSection.vue` now resolves through `@nuxtjs/i18n` under a new
`personalSubscriptions` namespace, with full translations for all supported locales
(en, es, fr, pl, uk). Literal token-format placeholders (the `sk-ant-…` / Codex `auth.json`
examples) and brand names stay verbatim; the day-count renewal notice uses pluralized forms
(3-form for Polish/Ukrainian).
