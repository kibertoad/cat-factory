---
'@cat-factory/app': patch
---

Localize the inspector + step/observability panels (phase 2 of the app i18n migration).

All user-facing copy in the panel surface now resolves through `@nuxtjs/i18n`
instead of hard-coded strings:

- **Inspector** (`inspector.*`): container/service summary, epic children, recurring
  schedule settings, service fragments, release-health config, test-infrastructure
  config, agent config, dependencies, estimate, the task execution pipeline list,
  run settings, and task structure.
- **Step / result panels** (`panels.*`): the step-detail overlay (review/approve and
  conclusion-editing flows), decision modal, generic structured result view, test
  report, step metadata/run-meta cards, restart control, and the inspector panel
  chrome.
- **Observability** (`observability.*`): the model-activity / provided-context panel,
  the per-call metrics bar, and the step metrics bar.

New keys ship in all five bundled locales (en/es/fr/pl/uk) with correct plural forms
(3-form for pl/uk) for call/error/warning/truncation/correction counts. Dates use
the vue-i18n datetime formatter and percentages the number formatter; enum/status →
key lookups use exhaustive `Record` maps (the tier-2 drift guard).
