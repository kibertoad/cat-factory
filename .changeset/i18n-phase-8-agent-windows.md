---
'@cat-factory/app': patch
---

Localize the agent-window surfaces (i18n phase 8).

Migrated all user-facing copy in the ten dedicated agent result/decision windows to
`@nuxtjs/i18n`: the requirements-review window, the clarity / brainstorm review loops,
the consensus session view, the service-spec window, the follow-up companion, the
human-test and visual-confirmation gates, the test-report window, and the block focus
view. New keys under `requirements.*`, `clarity.*`, `consensus.*`, `brainstorm.*`,
`spec.*`, `followUp.*`, `humanTest.*`, `testing.*`, `visualConfirm.*` and `focus.*` in
all five bundled locales (en/es/fr/pl/uk), in full parity. Count readouts use plural
forms (3-form for pl/uk), severity/status/category/strategy/outcome enums resolve via
exhaustive `Record` maps of literal `t()` keys to keep the typed-key drift guard live,
inline emphasis uses `<i18n-t>` slots, dates go through `d(...)` and percentages through
`n(..., 'percent')`.
