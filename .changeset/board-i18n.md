---
'@cat-factory/app': patch
---

Localize the board surface (phase 1 of the app i18n migration).

All user-facing copy in the board components — the canvas empty state and drop
toasts, the toolbar (level-of-detail readout, spend indicator, decision/service
controls), the add-task and recurring-pipeline modals, the service/module frames,
task cards, epic nodes, the decision/approval badges, and the shared agent
failure/stop controls — now resolves through `@nuxtjs/i18n` under the `board.*`
namespace instead of hard-coded strings. New keys ship in all five bundled locales
(en/es/fr/pl/uk), with correct plural forms for task/module counts and the
attachment-link warning. Spend is now formatted via vue-i18n's number formatter.
